/**
 * Coding-agent LLM client — fulfils the `LlmClient` contract by spawning
 * a coding agent (Claude Code / Codex) in headless mode.
 *
 * The client owns only the subprocess lifecycle: spawn, stdin delivery,
 * stdout/stderr capture, hard timeout with process kill, and bounded retry
 * of transient failures. Everything agent-specific (flags, system-prompt
 * strategy, output extraction, failure classification) lives in the
 * injected {@link AgentAdapter}.
 *
 * Retry semantics differ from the HTTP world: there is no 429/Retry-After,
 * so classification is delegated to the adapter (exit code + stderr/stdout
 * patterns — Codex `--json` reports errors as structured stdout events)
 * and backoff reuses the generic {@link computeDelay}. Timeouts are
 * client-level, always retryable, and kill the whole process group.
 *
 * @module spec/llm/agent-client
 */

import { spawn } from 'child_process';
import { LlmClient, parseJsonResponse } from './client';
import { AgentAdapter, AgentInvocation, AgentRunResult } from './agents/types';
import { computeDelay, sleep } from './retry';
import { logDebug } from '../../errors';

/** Default per-call hard timeout: 10 minutes (git-hook friendly). */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Default retry budget for transient subprocess failures. */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000;

/**
 * Default cap on accumulated stdout/stderr per invocation. Legitimate
 * responses are far below this (spec prompts/responses are ~50K chars);
 * a runaway agent spewing unbounded output would otherwise exhaust memory.
 */
const DEFAULT_MAX_OUTPUT_CHARS = 8 * 1024 * 1024;

export interface CodingAgentClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxOutputChars?: number;
}

/** A finished-but-failed headless invocation (non-zero exit or timeout). */
export class AgentCallError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string = '',
    /** True when the failure is a client-side timeout — always retryable. */
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = 'AgentCallError';
  }
}

export class CodingAgentLlmClient implements LlmClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxOutputChars: number;

  constructor(
    private readonly adapter: AgentAdapter,
    options: CodingAgentClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.retryBaseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.retryMaxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  // ---------------------------------------------------------------------------
  // Subprocess lifecycle
  // ---------------------------------------------------------------------------

  /** Run one headless invocation; rejects with AgentCallError on failure. */
  private runOnce(invocation: AgentInvocation): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.adapter.binary, invocation.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // Own process group (POSIX) so the timeout path can kill the
          // whole tree — an orphaned grandchild inheriting our pipes would
          // otherwise delay the 'close' event by its own lifetime and turn
          // a fast kill into a full-timeout stall.
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Kill the process group (POSIX) so subprocesses the agent spawned
      // die with it; fall back to killing the direct child only.
      const killTree = (): void => {
        try {
          if (process.platform !== 'win32' && child.pid !== undefined) {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          child.kill('SIGKILL');
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree();
        reject(new AgentCallError(
          `${this.adapter.displayName} headless call timed out after ${this.timeoutMs}ms`,
          null,
          stderr,
          stdout,
          true,
        ));
      }, this.timeoutMs);

      // Accumulate with a hard cap: a runaway agent must not exhaust
      // memory. Exceeding the cap kills the call and rejects as a
      // spawn-level failure (exitCode null → terminal per the adapters).
      const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
        if (settled) return;
        if (stream === 'stdout') stdout += chunk.toString();
        else stderr += chunk.toString();
        if (stdout.length > this.maxOutputChars || stderr.length > this.maxOutputChars) {
          settled = true;
          clearTimeout(timer);
          killTree();
          reject(new AgentCallError(
            `${this.adapter.displayName} headless call exceeded the ${this.maxOutputChars}-char ${stream} limit`,
            null,
            stderr,
            stdout,
          ));
        }
      };
      child.stdout.on('data', onData('stdout'));
      child.stderr.on('data', onData('stderr'));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AgentCallError(
          `Failed to spawn ${this.adapter.binary}: ${err.message}`,
          null,
          stderr,
          stdout,
        ));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new AgentCallError(
            `${this.adapter.displayName} exited with code ${code}`,
            code,
            stderr,
            stdout,
          ));
        }
      });

      child.stdin.on('error', () => { /* EPIPE when child exits early — close handler reports it */ });
      child.stdin.write(invocation.stdin);
      child.stdin.end();
    });
  }

  // ---------------------------------------------------------------------------
  // LlmClient
  // ---------------------------------------------------------------------------

  /**
   * Send one chat call through the agent's headless mode. Retries
   * transient failures (per the adapter's classification) with exponential
   * backoff; terminal failures (auth/quota, spawn errors) throw
   * immediately so callers can fall back.
   */
  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const invocation = this.adapter.buildInvocation(systemPrompt, userPrompt);
      try {
        const result = await this.runOnce(invocation);
        return this.adapter.extractOutput(result);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Timeouts are client-level and transient — always retryable.
        // exitCode null after this check means a spawn-level failure
        // (ENOENT etc.), which the adapters classify as terminal.
        const classification = lastError instanceof AgentCallError
          ? lastError.timedOut
            ? 'retryable'
            : this.adapter.classifyFailure({
                exitCode: lastError.exitCode,
                stdout: lastError.stdout,
                stderr: lastError.stderr,
              })
          : 'terminal';

        if (classification === 'terminal' || attempt >= this.maxRetries) {
          throw lastError;
        }

        const delay = computeDelay(undefined, this.baseDelayMs, this.maxDelayMs, attempt);
        logDebug(`Coding-agent retry ${attempt + 1}/${this.maxRetries}`, {
          agent: this.adapter.id,
          delayMs: delay,
          error: lastError.message,
        });
        await sleep(delay);
      }
    }

    throw lastError ?? new Error('unreachable: agent retry loop exited without returning');
  }

  /** Same as `chat()`, parsed as JSON via the shared extraction chain. */
  async chatJson(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<Record<string, unknown>> {
    const raw = await this.chat(systemPrompt, userPrompt);
    return parseJsonResponse(raw);
  }
}
