/**
 * Provider-agnostic LLM client for spec self-evolution.
 *
 * Replaces `commit4spec/utils/llm_client.py`. Supports OpenAI-compatible chat
 * completions API with mock mode for testing. Mock responses are consumed
 * FIFO: each `setMockResponse` call adds one response, each `chat` call
 * consumes one. When the mock queue is empty, pattern-based fallback responses
 * are returned.
 *
 * @module spec/evolve/llm-client
 */
import OpenAI from 'openai';
import { LLMConfig } from '../config';
import { logDebug } from '../../errors';

// =============================================================================
// Results
// =============================================================================

export interface ChatResult {
  content: string;
  json: Record<string, unknown> | null;
}

// =============================================================================
// LLMClient
// =============================================================================

export class LLMClient {
  private config: LLMConfig;
  private mockResponses: Map<string, string>;

  constructor(config: LLMConfig) {
    this.config = config;
    this.mockResponses = new Map();
  }

  /**
   * Set a mock response for a specific user prompt key.
   *
   * When provider is `"mock"`, `chat()` checks the mockResponses Map before
   * falling back to pattern-based defaults. Responses are consumed FIFO —
   * each call to `chat()` removes and returns the first stored response.
   */
  setMockResponse(key: string, response: string): void {
    this.mockResponses.set(key, response);
  }

  /**
   * Clear all mock responses.
   */
  clearMockResponses(): void {
    this.mockResponses.clear();
  }

  // ===========================================================================
  // chat
  // ===========================================================================

  /**
   * Send a chat completion request and return the message content string.
   *
   * **Mock mode** (`provider === "mock"`):
   * 1. If mockResponses has entries, consumes the first one (FIFO).
   * 2. Otherwise matches `userPrompt` against known patterns (case-insensitive):
   *    - `"logic change"` or `"logic_change"` → no-op JSON.
   *    - `"spec evolution"` or `"evolve"` → UNCHANGED JSON.
   *    - Default → UNCHANGED JSON.
   *
   * **OpenAI / Anthropic mode**:
   * Calls the OpenAI-compatible chat completions API and returns
   * `choices[0].message.content`. On any error, returns an empty string.
   */
  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    // --- Mock mode -------------------------------------------------------
    if (this.config.provider === 'mock') {
      if (this.mockResponses.size > 0) {
        const key = this.mockResponses.keys().next().value;
        if (key !== undefined) {
          const response = this.mockResponses.get(key)!;
          this.mockResponses.delete(key);
          return response;
        }
      }

      const lower = userPrompt.toLowerCase();

      if (lower.includes('logic change') || lower.includes('logic_change')) {
        return JSON.stringify({
          is_logic_change: false,
          reason: 'Mock: no logic change detected',
        });
      }

      if (lower.includes('spec evolution') || lower.includes('evolve')) {
        return JSON.stringify({
          action: 'UNCHANGED',
          reason: 'Mock: no changes needed',
        });
      }

      return JSON.stringify({
        action: 'UNCHANGED',
        reason: 'Mock: default no-op response',
      });
    }

    // --- OpenAI / Anthropic mode -----------------------------------------
    const baseURL = this.config.baseUrl
      ? this.config.baseUrl
      : this.config.provider === 'anthropic'
        ? 'https://api.anthropic.com/v1'
        : undefined;

    const client = new OpenAI({
      apiKey: this.config.apiKey || 'sk-placeholder',
      baseURL,
    });

    try {
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
    } catch {
      return '';
    }
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
