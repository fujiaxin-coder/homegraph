/**
 * DevEco Code headless adapter (`deveco run`).
 *
 * Invocation design:
 *   - `deveco run`             — non-interactive one-shot mode, exits when
 *                                the session goes idle
 *   - `--agent explore`        — read-only agent: only read/grep/glob/
 *                                webfetch/websearch are allowed; all write
 *                                and shell tools are denied at agent level
 *   - `--format json`          — stdout is a JSONL event stream; model text
 *                                arrives in `{"type":"text","part":{...}}`
 *                                events
 *   - prompt via stdin         — spec prompts can reach ~60K chars; stdin
 *                                avoids OS argv length limits
 *
 * DevEco Code has no native system-prompt flag on `deveco run`, so the
 * system prompt is embedded into the user prompt inside an <instructions>
 * block — same strategy as the Codex adapter.
 *
 * @module spec/llm/agents/deveco-code
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
  /rate\s+limit/i,
];

export class DevecoCodeAdapter implements AgentAdapter {
  readonly id = 'deveco-code' as const;
  readonly displayName = 'DevEco Code';
  readonly binary = 'deveco';

  detect(): boolean {
    // Executable-based detection only. DevEco Code config directories
    // (`.deveco/`, `~/.config/deveco/`) persist after uninstall, so they
    // are NOT valid detection signals.
    //
    // DevEco Code is built on OpenCode and follows similar install patterns.
    // Common install paths:
    //   - System PATH (via installer)
    //   - ~/.local/bin/deveco (manual install, same pattern as codex/claude)
    //
    // DevEco Studio IDE installs its own copy to an IDE-private location;
    // we don't attempt to locate that — PATH + ~/.local/bin covers the
    // CLI-first workflows this adapter targets.
    const home = os.homedir();
    return isOnPath(this.binary)
      || isExecutable(path.join(home, '.local', 'bin', 'deveco'));
  }

  buildInvocation(systemPrompt: string, userPrompt: string): AgentInvocation {
    const args = [
      'run',
      '--agent', 'explore',          // Read-only: no file writes or shell commands
      '--format', 'json',            // JSONL event stream for reliable parsing
    ];

    // No native system-prompt flag — embed it in the prompt body, same
    // strategy as Codex. The agent processes the combined prompt as a
    // single user message.
    const prompt = systemPrompt
      ? `<instructions>\n${systemPrompt}\n</instructions>\n\n${userPrompt}`
      : userPrompt;

    // Deliver via stdin to avoid OS argv length limits (spec prompts are
    // ~50-60K chars). `deveco run` reads from stdin when no positional
    // message is provided and stdin is not a TTY — both hold when spawned.
    return { args, stdin: prompt };
  }

  extractOutput(result: AgentRunResult): string {
    // JSONL event stream (`deveco run --format json`).
    //
    // Events of interest:
    //   {"type":"text","timestamp":...,"sessionID":"...",
    //    "part":{"type":"text","text":"actual content","time":{...}}}
    //
    // We extract all `type: "text"` events and concatenate them. Text
    // parts can arrive incrementally (streaming); each event contains the
    // latest content delta.
    //
    // Other event types we ignore:
    //   "tool_use"  — tool invocations (empty with explore agent anyway)
    //   "reasoning" — thinking traces
    //   "error"     — session errors
    //   "step_start" / "step_finish" — turn boundaries
    let output = '';
    let sawJsonlEvent = false;

    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        sawJsonlEvent = true;
        if (
          event?.type === 'text'
          && event?.part?.type === 'text'
          && typeof event.part.text === 'string'
        ) {
          output += event.part.text;
        }
      } catch {
        // Non-JSON line — ignore (diagnostic output, warnings, etc.)
      }
    }

    if (output) return output.trim();
    if (sawJsonlEvent) return ''; // events parsed but no text content

    // Fallback for CLI versions that may not produce JSONL (unlikely with
    // --format json, but safe). Strip anything that looks like noise.
    return result.stdout
      .split('\n')
      .filter((line) => !/^(deveco|warning|info)[:\s]/i.test(line.trim()))
      .join('\n')
      .trim();
  }

  classifyFailure(failure: AgentFailure): 'retryable' | 'terminal' {
    if (failure.exitCode === null) return 'terminal'; // spawn-level failure (e.g. ENOENT)
    // Auth/quota errors surface on stderr.
    if (TERMINAL_PATTERNS.some((re) => re.test(failure.stderr))) return 'terminal';
    return 'retryable';
  }
}

export const devecoCodeAdapter = new DevecoCodeAdapter();
