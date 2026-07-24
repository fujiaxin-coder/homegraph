/**
 * Coding-agent registry, installation detection, and resolution.
 *
 * Resolution is fully automatic and deterministic (spec evolve is mostly
 * triggered by git hooks, so interactive selection is impossible):
 *
 *   - exactly one agent installed → use it
 *   - both installed              → prefer Claude Code (registry order)
 *   - none installed              → null (caller falls back to LLMConfig)
 *
 * There is intentionally no user-facing way to pick an agent. The
 * HOMEGRAPH_SPEC_AGENT environment variable exists ONLY as a test escape
 * hatch ('none' disables agent usage; an adapter id forces that adapter)
 * and is not documented for end users.
 *
 * @module spec/llm/agents
 */

import { AgentAdapter } from './types';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { devecoCodeAdapter } from './deveco-code';

export type { AgentAdapter, AgentInvocation, AgentRunResult } from './types';
export { claudeCodeAdapter } from './claude-code';
export { codexAdapter } from './codex';
export { devecoCodeAdapter } from './deveco-code';

/**
 * Registry in priority order — the first installed adapter wins.
 * Claude Code ranks first: its headless mode offers native system-prompt
 * support, a clean JSON output envelope, and reliable tool disabling.
 */
const REGISTRY: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, devecoCodeAdapter];

let cachedResolution: AgentAdapter | null | undefined;

/**
 * Resolve the coding agent to use for LLM tasks, or null when none is
 * installed. Result is cached for the process lifetime — detection is
 * repeated only after {@link resetAgentResolutionCache} (tests).
 */
export function resolveAgent(): AgentAdapter | null {
  if (cachedResolution !== undefined) return cachedResolution;

  const override = process.env.HOMEGRAPH_SPEC_AGENT?.trim().toLowerCase();
  let resolved: AgentAdapter | null = null;

  if (override === 'none') {
    resolved = null;
  } else if (override) {
    resolved = REGISTRY.find((a) => a.id === override) ?? null;
  } else {
    resolved = REGISTRY.find((a) => a.detect()) ?? null;
  }

  cachedResolution = resolved;
  return resolved;
}

/** Test-only: clear the cached resolution after mutating PATH/HOME/env. */
export function resetAgentResolutionCache(): void {
  cachedResolution = undefined;
}
