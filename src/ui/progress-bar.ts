/**
 * Pure progress-bar geometry, factored out of the shimmer worker so it can be
 * unit-tested. The worker script starts a render interval and a message port at
 * module scope, which makes it un-importable from a test; the arithmetic that
 * decides how many filled/empty cells to draw has no such dependency.
 *
 * The clamping here is load-bearing, not cosmetic: an upstream percent outside
 * [0, 100] used to produce a negative empty-cell count, and
 * `String.prototype.repeat` throws `RangeError: Invalid count value` on a
 * negative argument — from inside a UI timer, which killed the entire indexing
 * process (Spec 0072).
 */

/** Width of the bar in cells. */
export const BAR_WIDTH = 25;

export interface BarGeometry {
  /** Cells to draw filled, clamped to [0, barWidth]. */
  filled: number;
  /** Cells to draw empty, clamped to [0, barWidth]. */
  empty: number;
  /** The percent to display, clamped to [0, 100]. */
  percent: number;
}

/**
 * Split a bar of `barWidth` cells into filled and empty parts for `percent`.
 *
 * Total: any finite or non-finite input yields a geometry that is safe to
 * render. `percent` below 0 reads as 0%, above 100 as 100% — a progress source
 * that overshoots is a bug in the caller, never a reason to crash the process.
 */
export function barGeometry(percent: number, barWidth: number = BAR_WIDTH): BarGeometry {
  const width = Number.isFinite(barWidth) ? Math.max(0, Math.floor(barWidth)) : BAR_WIDTH;
  const raw = Number.isFinite(percent) ? percent : 0;
  const pct = Math.min(100, Math.max(0, raw));
  const filled = Math.min(width, Math.max(0, Math.round(width * pct / 100)));
  return { filled, empty: Math.max(0, width - filled), percent: pct };
}

/**
 * Clamp a filled/empty pair to non-negative integers.
 *
 * `renderBar` applies this itself so that a future caller which computes its
 * own geometry can never hand `repeat()` a negative count.
 *
 * `Number.isFinite` is checked explicitly rather than relying on `|| 0`:
 * `Infinity` is truthy, so `Math.floor(Infinity) || 0` is still `Infinity` —
 * and `repeat(Infinity)` throws just as `repeat(-22)` does.
 */
export function clampCellCount(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}
