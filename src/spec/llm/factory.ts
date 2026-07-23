/**
 * LLM client factory for the spec pipelines — the single resolution point
 * that decides WHERE LLM calls go:
 *
 *   1. A locally installed coding agent (Claude Code preferred, then
 *      Codex) in headless mode — no API key required;
 *   2. The user-configured LLM (configs.json "llm" section) — used alone
 *      when no agent is installed, and as an automatic fallback when the
 *      agent's headless call fails;
 *   3. undefined — neither available; callers keep their existing
 *      no-LLM degradation paths.
 *
 * Coding-agent resolution is fully automatic (spec evolve is mostly
 * git-hook triggered, so interactive selection is impossible) and the
 * LLMConfig surface is deliberately untouched.
 *
 * @module spec/llm/factory
 */

import { LLMConfig } from '../config';
import { LlmClient, OpenAiLlmClient } from './client';
import { CodingAgentLlmClient } from './agent-client';
import { resolveAgent } from './agents';
import { logDebug, logWarn } from '../../errors';

/**
 * Composite client: try the coding agent first; on ANY failure of the
 * primary, delegate the same call to the configured LLM. Terminal agent
 * failures (auth/quota) therefore degrade seamlessly to the API path.
 */
export class FallbackLlmClient implements LlmClient {
  constructor(
    private readonly primary: LlmClient,
    private readonly secondary: LlmClient,
  ) {}

  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      return await this.primary.chat(systemPrompt, userPrompt);
    } catch (err) {
      logWarn('Coding-agent LLM call failed — falling back to configured LLM', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.secondary.chat(systemPrompt, userPrompt);
    }
  }

  async chatJson(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.primary.chatJson(systemPrompt, userPrompt);
    } catch (err) {
      logWarn('Coding-agent LLM call failed — falling back to configured LLM', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.secondary.chatJson(systemPrompt, userPrompt);
    }
  }
}

/**
 * Resolve the LLM client for a spec pipeline run.
 *
 * @param llmConfig - The configs.json "llm" section (may be null).
 * @returns A ready client, or undefined when neither a coding agent nor
 *   an LLM configuration is available.
 */
export function createSpecLlmClient(llmConfig: LLMConfig | null): LlmClient | undefined {
  const agent = resolveAgent();
  const api = llmConfig ? new OpenAiLlmClient(llmConfig) : undefined;

  if (agent) {
    logDebug(`Using ${agent.displayName} (headless) for LLM tasks`, { agent: agent.id });
    const primary = new CodingAgentLlmClient(agent);
    return api ? new FallbackLlmClient(primary, api) : primary;
  }

  return api;
}
