/**
 * Store-phase flush / backpressure guards (Spec 0065).
 *
 * When `flushOrdered` records a store failure in `flushError` but returns a
 * resolved promise, the feed backpressure `while` would otherwise spin on
 * `await Promise.resolve()` forever (100% CPU hang). Call this at the top of
 * that loop (and anywhere else that waits on flush progress).
 */

/** Throw if the ordered store flush already failed or the run was aborted. */
export function throwIfStoreFlushFailed(aborted: boolean, flushError: unknown): void {
  if (flushError) throw flushError;
  if (aborted) throw new Error('Aborted');
}
