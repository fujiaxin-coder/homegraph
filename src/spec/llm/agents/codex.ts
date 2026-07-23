/**
 * Codex CLI headless adapter (`codex exec`).
 *
 * Invocation design:
 *   - `codex exec`             — non-interactive one-shot mode
 *   - `--sandbox read-only`    — no file writes or command side effects
 *   - `--skip-git-repo-check`  — allow running outside/inside any repo
 *   - `--json`                 — stdout is a JSONL event stream; the final
 *                                assistant message is the last
 *                                `item.completed` event whose item type is
 *                                `agent_message`
 *   - `-`                      — read the prompt from stdin (prompts can
 *                                reach ~60K chars; stdin avoids OS argv
 *                                length limits)
 *
 * Codex has no native system-prompt flag, so the system prompt is embedded
 * into the user prompt inside an <instructions> block.
 *
 * @module spec/llm/agents/codex
 */

import * as os from 'os';
import * as path from 'path';
import { AgentAdapter, AgentFailure, AgentInvocation, AgentRunResult } from './types';
import { isExecutable, isOnPath } from './detect-utils';

/** Signatures of auth/quota failures — retrying is pointless. */
const TERMINAL_PATTERNS = [
  /not\s+logged\s+in/i,
  /please\s+(run\s+)?\/?login/i,
  /unauthorized|invalid\s+api\s+key|authentication/i,
  /usage\s+limit|quota\s+(exceeded|exhausted)|rate\s+limit\s+reached/i,
];

/** Footer line Codex prints after the final message in plain-text mode. */
const STDOUT_NOISE = /^tokens used\b/i;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly binary = 'codex';

  detect(): boolean {
    // Executable-based detection only: an uninstalled Codex leaves
    // ~/.codex behind, so the config directory is NOT a valid signal.
    // Fall back to a well-known manual-install location for setups that
    // never added the binary to PATH.
    return isOnPath(this.binary)
      || isExecutable(path.join(os.homedir(), '.local', 'bin', 'codex'));
  }

  buildInvocation(systemPrompt: string, userPrompt: string): AgentInvocation {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--json',
      '-',
    ];

    // No native system-prompt flag — embed it in the prompt body.
    const stdin = systemPrompt
      ? `<instructions>\n${systemPrompt}\n</instructions>\n\n${userPrompt}`
      : userPrompt;

    return { args, stdin };
  }

  extractOutput(result: AgentRunResult): string {
    // JSONL event stream (codex exec --json): the model text is the LAST
    // `item.completed` event whose item is an agent message. Verified
    // shape: {"type":"item.completed","item":{"type":"agent_message","text":...}}
    let lastMessage = '';
    let sawEvent = false;

    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        sawEvent = true;
        if (
          event?.type === 'item.completed'
          && event?.item?.type === 'agent_message'
        ) {
          // `text` is the documented field; tolerate `message` for
          // cross-version robustness at this external boundary.
          const text = event.item.text ?? event.item.message;
          if (typeof text === 'string') lastMessage = text;
        }
      } catch {
        // Non-JSON line — ignore.
      }
    }

    if (lastMessage) return lastMessage.trim();
    if (sawEvent) return ''; // events parsed but no agent message

    // Fallback for CLI versions without JSONL support: strip known noise.
    return result.stdout
      .split('\n')
      .filter((line) => !STDOUT_NOISE.test(line.trim()))
      .join('\n')
      .trim();
  }

  classifyFailure(failure: AgentFailure): 'retryable' | 'terminal' {
    if (failure.exitCode === null) return 'terminal'; // spawn-level failure (e.g. ENOENT)
    // Auth/quota errors surface on stderr (Rust logs) AND as JSONL error
    // events on stdout — check both.
    const haystack = `${failure.stderr}\n${failure.stdout}`;
    if (TERMINAL_PATTERNS.some((re) => re.test(haystack))) return 'terminal';
    return 'retryable';
  }
}

export const codexAdapter = new CodexAdapter();
