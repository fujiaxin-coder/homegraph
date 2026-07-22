/**
 * Provider-agnostic LLM client for spec
 *
 * Supports OpenAI-compatible chat completions API with automatic retry on
 * transient errors (rate limits, server errors, network failures). No mock
 * mode — callers that need test doubles inject their own stubs implementing
 * the interface.
 *
 * @module spec/llm/client
 */
import OpenAI from 'openai';
import { LLMConfig } from '../config';
import { logDebug } from '../../errors';
import { classifyError, computeDelay, sleep } from './retry';

// =============================================================================
// Interface
// =============================================================================

export interface LlmClient {
  chat(systemPrompt: string, userPrompt: string): Promise<string>;
  chatJson(systemPrompt: string, userPrompt: string): Promise<Record<string, unknown>>;
}

// =============================================================================
// Shared JSON extraction
// =============================================================================

/**
 * Parse an LLM text response as a JSON object.
 *
 * Parsing strategy (tried in order):
 * 1. Direct `JSON.parse(content)`.
 * 2. Extract from `` ```json ... ``` `` fenced block.
 * 3. Extract from `` ``` ... ``` `` fenced block.
 * 4. Fallback: log a debug warning and return `{}`.
 *
 * Shared by OpenAiLlmClient and CodingAgentLlmClient so the chatJson
 * contract is identical regardless of provider.
 */
export function parseJsonResponse(raw: string): Record<string, unknown> {
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
  logDebug('parseJsonResponse: could not parse response as JSON', {
    raw: raw.length > 200 ? raw.slice(0, 200) + '…' : raw,
  });
  return {};
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
  // Helpers
  // ===========================================================================

  /** Resolve the baseURL for the OpenAI SDK. */
  private resolveBaseURL(): string | undefined {
    if (this.config.baseUrl) return this.config.baseUrl;
    if (this.config.provider === 'anthropic') return 'https://api.anthropic.com/v1';
    return undefined;
  }

  /**
   * Build a fresh OpenAI client suitable for one call (no SDK-level retry —
   * we handle retries ourselves with proper visibility).
   */
  private buildClient(): OpenAI {
    return new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.resolveBaseURL(),
      maxRetries: 0, // disable SDK retry
    });
  }

  // ===========================================================================
  // chat
  // ===========================================================================

  /**
   * Send a chat completion request and return the message content string.
   *
   * Automatically retries on transient errors (429, 5xx, connection failures)
   * with exponential backoff and jitter.  Retry-After headers on 429 responses
   * are honoured as a floor for the delay.
   *
   * Retry configuration is in {@link LLMConfig}: `maxRetries` (default 3),
   * `retryBaseDelayMs` (default 1000), `retryMaxDelayMs` (default 30000).
   *
   * Once all retries are exhausted the last error is re-thrown so callers
   * (e.g. the spec mine generator) can count failures reliably.
   */
  async chat(systemPrompt: string, userPrompt: string): Promise<string> {
    // Build once per call — the OpenAI client is stateless so we can reuse it
    // across retry attempts.
    const client = this.buildClient();

    const maxRetries = this.config.maxRetries;
    const baseDelay = this.config.retryBaseDelayMs;
    const maxDelay = this.config.retryMaxDelayMs;

    // We track the cumulative attempt number for logging (1-based),
    // and the zero-based index for backoff calculation.
    for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex++) {
      const callIndex = attemptIndex + 1; // 1-based for logging

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
      } catch (err) {
        // No more retries left — re-throw the raw error so callers can
        // inspect its type (e.g. RateLimitError) if needed.
        if (attemptIndex >= maxRetries) throw err;

        const decision = classifyError(err);
        if (!decision.retryable) throw err;

        const delay = computeDelay(
          decision.retryAfterMs,
          baseDelay,
          maxDelay,
          attemptIndex,
        );

        logDebug(`LLM retry ${callIndex}/${maxRetries}`, {
          attempt: callIndex,
          maxRetries,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });

        await sleep(delay);
      }
    }

    // Unreachable — the loop returns or throws in every branch.
    throw new Error('unreachable: retry loop exited without returning');
  }

  // ===========================================================================
  // chatJson
  // ===========================================================================

  /**
   * Same as `chat()`, but parses the response as JSON via
   * {@link parseJsonResponse}. Empty content returns `{}`.
   */
  async chatJson(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<Record<string, unknown>> {
    const raw = await this.chat(systemPrompt, userPrompt);
    return parseJsonResponse(raw);
  }
}
