/**
 * Provider-agnostic LLM client for spec
 *
 * Supports OpenAI-compatible chat completions API. No mock mode — callers
 * that need test doubles inject their own stubs implementing the interface.
 *
 * @module spec/llm/client
 */
import OpenAI from 'openai';
import { LLMConfig } from '../config';
import { logDebug } from '../../errors';

// =============================================================================
// Interface
// =============================================================================

export interface LlmClient {
  chat(systemPrompt: string, userPrompt: string): Promise<string>;
  chatJson(systemPrompt: string, userPrompt: string): Promise<Record<string, unknown>>;
}

// =============================================================================
// OpenAiLlmClient
// =============================================================================

export class OpenAiLlmClient implements LlmClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  // ===========================================================================
  // chat
  // ===========================================================================

  /**
   * Send a chat completion request and return the message content string.
   *
   * Calls the OpenAI-compatible chat completions API and returns
   * `choices[0].message.content`.  Throws on API or network errors so
   * callers (e.g. the spec mine generator) can count failures reliably.
   */
  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    const baseURL = this.config.baseUrl
      ? this.config.baseUrl
      : this.config.provider === 'anthropic'
        ? 'https://api.anthropic.com/v1'
        : undefined;

    const client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL,
    });

    const completion = await client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    return content ?? '';
  }

  // ===========================================================================
  // chatJson
  // ===========================================================================

  /**
   * Same as `chat()`, but parses the response as JSON.
   *
   * Parsing strategy (tried in order):
   * 1. Direct `JSON.parse(content)`.
   * 2. Extract from `` ```json ... ``` `` fenced block.
   * 3. Extract from `` ``` ... ``` `` fenced block.
   * 4. Fallback: log a debug warning and return `{}`.
   *
   * Empty or null content from `chat()` also returns `{}`.
   */
  async chatJson(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<Record<string, unknown>> {
    const raw = await this.chat(systemPrompt, userPrompt);

    if (!raw) return {};

    // 1. Direct parse
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to fence extraction
    }

    // 2. ```json ... ``` fence
    const jsonFenceMatch = /```json\s*([\s\S]*?)```/.exec(raw);
    if (jsonFenceMatch) {
      try {
        const parsed = JSON.parse(jsonFenceMatch[1]!.trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through
      }
    }

    // 3. ``` ... ``` fence
    const fenceMatch = /```\s*([\s\S]*?)```/.exec(raw);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1]!.trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through
      }
    }

    // 4. Fallback
    logDebug('chatJson: could not parse response as JSON', {
      raw: raw.length > 200 ? raw.slice(0, 200) + '…' : raw,
    });
    return {};
  }
}
