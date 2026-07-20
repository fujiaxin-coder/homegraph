/**
 * LLM retry helper — error classification and delay calculation.
 *
 * OpenAI SDK v4 throws typed `APIError` subclasses. This module classifies
 * them as retryable (transient) or terminal (bad request, auth failure, etc.)
 * and computes exponential-backoff delays with jitter and Retry-After support.
 *
 * @module spec/llm/retry
 */

import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryDecision {
  /** Whether the error is safe to retry. */
  retryable: boolean;
  /**
   * Recommended delay in milliseconds (from Retry-After header, if present).
   * `undefined` means the caller should calculate backoff.
   */
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** HTTP status codes that indicate a transient server error. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Node.js error codes that indicate a transient network failure. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * Classify an error thrown by the OpenAI SDK as retryable or terminal.
 *
 * Classification rules (first match wins):
 *
 * 1. Non-`Error` throwables → NOT retryable (safety).
 * 2. `RateLimitError` (429) → RETRYABLE; parse Retry-After if available.
 * 3. `InternalServerError` (500) → RETRYABLE.
 * 4. Other `APIError` subclasses with status in `RETRYABLE_STATUSES` →
 *    RETRYABLE.
 * 5. `APIConnectionError` / `APIConnectionTimeoutError` → RETRYABLE.
 * 6. Generic `Error` with `.code` in `RETRYABLE_CODES` → RETRYABLE.
 * 7. Everything else → NOT retryable (conservative).
 */
export function classifyError(err: unknown): RetryDecision {
  if (!(err instanceof Error)) {
    return { retryable: false };
  }

  // 1. RateLimitError (429)
  if (err instanceof OpenAI.RateLimitError) {
    const retryAfterMs = parseRetryAfter(err.headers);
    return { retryable: true, retryAfterMs };
  }

  // 2. InternalServerError (500)
  if (err instanceof OpenAI.InternalServerError) {
    return { retryable: true };
  }

  // 3. Other APIError with known transient status
  if (err instanceof OpenAI.APIError) {
    if (err.status !== undefined && RETRYABLE_STATUSES.has(err.status)) {
      return { retryable: true };
    }
    // Explicit client errors (400, 401, 403, 404, 409, 422, etc.) → terminal
    return { retryable: false };
  }

  // 4. Connection-level errors
  if (
    err instanceof OpenAI.APIConnectionError ||
    err instanceof OpenAI.APIConnectionTimeoutError
  ) {
    return { retryable: true };
  }

  // 5. Generic Node.js network errors
  if (RETRYABLE_CODES.has((err as NodeJS.ErrnoException).code ?? '')) {
    return { retryable: true };
  }

  // 6. Everything else — don't guess, just fail
  return { retryable: false };
}

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `Retry-After` header value to milliseconds.
 *
 * Supports both delta-seconds (`"5"`) and HTTP-date (`"Wed, 21 Oct 2015 ..."`).
 * Returns `undefined` if the header is missing, unparseable, or unacceptably
 * large (> 5 minutes to avoid hiding a systemic outage).
 */
function parseRetryAfter(
  headers: Record<string, string | null | undefined> | undefined,
): number | undefined {
  if (!headers) return undefined;

  const raw = headers['retry-after'];
  if (!raw || typeof raw !== 'string') return undefined;

  // Delta-seconds: "5" or "5.5"
  const delta = Number(raw);
  if (!isNaN(delta) && delta > 0) {
    const ms = Math.round(delta * 1000);
    return ms > 300_000 ? undefined : ms; // cap at 5 min
  }

  // HTTP-date
  const date = new Date(raw).getTime();
  if (!isNaN(date)) {
    const ms = Math.max(0, date - Date.now());
    return ms > 300_000 ? undefined : ms;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Delay computation
// ---------------------------------------------------------------------------

/**
 * Compute the delay before the next retry attempt.
 *
 * Strategy:
 * 1. If `retryAfterMs` is available from the server (429 Retry-After), use it
 *    as a minimum, then add jitter up to 25% of the computed backoff.
 * 2. Otherwise: exponential backoff = `baseDelay * 2^attempt` with full-range
 *    random jitter (`random(0, backoff)`).
 * 3. Cap at `maxDelay`.
 *
 * @param retryAfterMs  - Server-suggested delay from Retry-After (optional).
 * @param baseDelay     - Base delay in ms for backoff calculation.
 * @param maxDelay      - Hard upper bound in ms.
 * @param attempt       - Zero-based retry attempt index.
 * @returns Delay in milliseconds (integer).
 */
export function computeDelay(
  retryAfterMs: number | undefined,
  baseDelay: number,
  maxDelay: number,
  attempt: number,
): number {
  const backoff = baseDelay * Math.pow(2, attempt);

  let delay: number;
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    // Use Retry-After as floor, add up to 25% jitter
    const jitter = Math.random() * Math.min(backoff * 0.25, 5000);
    delay = retryAfterMs + jitter;
  } else {
    // Full exponential backoff with jitter
    delay = Math.random() * backoff;
  }

  // Clamp
  delay = Math.max(0, Math.min(delay, maxDelay));

  return Math.round(delay);
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
