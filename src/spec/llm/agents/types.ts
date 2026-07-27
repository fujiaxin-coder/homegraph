/**
 * Coding-agent adapter abstraction for headless LLM access.
 *
 * Each supported coding agent (Claude Code, Codex) implements this
 * interface so the spec pipelines can fulfil their LLM tasks through the
 * agent's non-interactive CLI mode — no API key required. Every adapter
 * owns its own input construction (flags, system-prompt strategy, tool
 * disabling) and output extraction, guaranteeing the I/O contract matches
 * what `OpenAiLlmClient` produces.
 *
 * @module spec/llm/agents/types
 */

/** A prepared headless invocation: argv for execFile + stdin payload. */
export interface AgentInvocation {
  /** Argument array — passed to spawn as-is (never shell-concatenated). */
  args: string[];
  /** Prompt payload written to the child's stdin. */
  stdin: string;
}

/** Result of a finished headless invocation. */
export interface AgentRunResult {
  stdout: string;
  stderr: string;
}

/** Context of a failed invocation, for failure classification. */
export interface AgentFailure {
  /**
   * Process exit code; null for spawn-level failures (e.g. ENOENT).
   * Timeouts never reach the adapters — the client owns the timer and
   * always classifies them as retryable.
   */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Per-agent adapter: detection, invocation construction, output extraction,
 * and failure classification.
 */
export interface AgentAdapter {
  /** Stable id, also used by the HOMEGRAPH_SPEC_AGENT test override. */
  readonly id: 'claude-code' | 'codex' | 'deveco-code';
  /** Human-readable name for log lines. */
  readonly displayName: string;
  /** CLI binary name resolved against PATH. */
  readonly binary: string;

  /**
   * Detect whether the agent is installed. Cheap checks only — PATH scan
   * plus config-directory hint (mirrors the installer targets pattern).
   * Must NOT spawn the agent itself.
   */
  detect(): boolean;

  /**
   * Build a non-interactive invocation for one chat call. The adapter is
   * responsible for disabling all tool/file side effects and for its
   * system-prompt strategy (native flag vs. prompt embedding).
   */
  buildInvocation(systemPrompt: string, userPrompt: string): AgentInvocation;

  /**
   * Extract the model's text from raw stdout (e.g. unwrap a JSON envelope,
   * strip log noise). The returned string must be shaped like an
   * OpenAI chat-completion content string so downstream `chatJson`
   * parsing behaves identically across providers.
   */
  extractOutput(result: AgentRunResult): string;

  /**
   * Classify a failed invocation (non-zero exit or spawn-level error).
   * 'terminal' covers auth/quota problems — retrying is pointless and the
   * caller should fall back to the configured LLM. Anything transient
   * (crashes, timeouts, unexpected exits) is 'retryable'. Both stdout and
   * stderr are provided: some CLIs (e.g. Codex `--json`) report errors as
   * structured stdout events rather than on stderr.
   */
  classifyFailure(failure: AgentFailure): 'retryable' | 'terminal';
}
