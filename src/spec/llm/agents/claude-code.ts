/**
 * Claude Code headless adapter (`claude -p`).
 *
 * Invocation design:
 *   - `-p`                    — print mode (non-interactive, one-shot)
 *   - `--output-format json`  — stdout is a JSON envelope; the model text
 *                               lives in the `result` field
 *   - `--system-prompt`       — native system-prompt support
 *   - `--allowedTools ""`     — empty allow-list disables every tool, so
 *                               the agent performs pure text reasoning with
 *                               no file/shell side effects (and with no
 *                               tools, print mode is single-response by
 *                               nature — `--max-turns` is not universally
 *                               available across CLI versions and is
 *                               deliberately omitted)
 *   - prompt via stdin        — prompts can reach ~60K chars; stdin avoids
 *                               OS argv length limits
 *
 * @module spec/llm/agents/claude-code
 */

import * as os from 'os';
import * as path from 'path';
import { AgentAdapter, AgentFailure, AgentInvocation, AgentRunResult } from './types';
import { isExecutable, isOnPath } from './detect-utils';

/** stderr signatures of auth/quota failures — retrying is pointless. */
const TERMINAL_PATTERNS = [
  /not\s+logged\s+in/i,
  /please\s+(run\s+)?\/?login/i,
  /unauthorized|invalid\s+api\s+key|authentication/i,
  /usage\s+limit|quota\s+(exceeded|exhausted)|credit\s+balance/i,
];

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly binary = 'claude';

  detect(): boolean {
    // Executable-based detection only: an uninstalled Claude Code leaves
    // ~/.claude behind, so the config directory is NOT a valid signal.
    // Fall back to well-known native-installer locations for setups that
    // never added the binary to PATH.
    const home = os.homedir();
    return isOnPath(this.binary)
      || isExecutable(path.join(home, '.claude', 'local', 'claude'))
      || isExecutable(path.join(home, '.local', 'bin', 'claude'));
  }

  buildInvocation(systemPrompt: string, userPrompt: string): AgentInvocation {
    const args = [
      '-p',
      '--output-format', 'json',
      '--allowedTools', '',
      '--system-prompt', systemPrompt,
    ];
    return { args, stdin: userPrompt };
  }

  extractOutput(result: AgentRunResult): string {
    const stdout = result.stdout.trim();
    if (!stdout) return '';

    // Expected shape: a JSON envelope with a `result` string field.
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object') {
        if (parsed.is_error === true) {
          throw new Error(
            `Claude Code returned an error result: ${String(parsed.result ?? stdout).slice(0, 300)}`,
          );
        }
        if (typeof parsed.result === 'string') {
          return parsed.result;
        }
      }
    } catch (err) {
      // Re-throw envelope-level errors; fall through to raw stdout only
      // when the payload simply was not JSON.
      if (err instanceof SyntaxError) return stdout;
      throw err;
    }

    return stdout;
  }

  classifyFailure(failure: AgentFailure): 'retryable' | 'terminal' {
    if (failure.exitCode === null) return 'terminal'; // spawn-level failure (e.g. ENOENT)
    if (TERMINAL_PATTERNS.some((re) => re.test(failure.stderr))) return 'terminal';
    return 'retryable';
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
