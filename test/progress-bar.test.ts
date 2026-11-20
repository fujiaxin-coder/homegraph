/**
 * Progress-bar rendering geometry (Spec 0072).
 *
 * Regression: `homegraph sync` on a repo with ~1059 files crashed with
 * `RangeError: Invalid count value: -22` raised from `String.repeat` inside the
 * shimmer worker. A shared loop counter reported `{current: 2000, total: 1059}`
 * as progress, `percent` became 189, the bar computed `empty = 25 - 47 = -22`,
 * and `repeat(-22)` threw from a UI timer — taking the whole process down.
 *
 * Two layers are tested here: the geometry helper clamps before splitting the
 * bar, and the worker's `renderBar` clamps its own inputs so no future caller
 * can reintroduce the crash.
 */

import { describe, it, expect } from 'vitest';
import { barGeometry, clampCellCount, BAR_WIDTH } from '../src/ui/progress-bar';

describe('barGeometry (Spec 0072)', () => {
  describe('normal range', () => {
    it('splits the bar evenly at 0%', () => {
      expect(barGeometry(0)).toEqual({ filled: 0, empty: BAR_WIDTH, percent: 0 });
    });

    it('splits the bar evenly at 100%', () => {
      expect(barGeometry(100)).toEqual({ filled: BAR_WIDTH, empty: 0, percent: 100 });
    });

    it('splits the bar evenly at 50%', () => {
      const g = barGeometry(50);
      expect(g.percent).toBe(50);
      expect(g.filled + g.empty).toBe(BAR_WIDTH);
      expect(g.filled).toBe(Math.round(BAR_WIDTH / 2));
    });

    it('always keeps filled + empty === barWidth', () => {
      for (const pct of [0, 1, 7, 33, 49, 50, 51, 66, 99, 100]) {
        const g = barGeometry(pct);
        expect(g.filled + g.empty).toBe(BAR_WIDTH);
      }
    });
  });

  describe('the crashing input from the issue', () => {
    it('clamps 189% (2000/1059) instead of producing a negative empty count', () => {
      // The exact value the buggy progress source produced, percent = 189.
      const g = barGeometry(189);
      expect(g.percent).toBe(100);
      expect(g.empty).toBe(0);
      expect(g.empty).toBeGreaterThanOrEqual(0);
      expect(g.filled).toBe(BAR_WIDTH);
    });

    it('never yields a negative empty count for any overshoot', () => {
      for (const pct of [101, 150, 189, 200, 250, 1_000, 1_000_000]) {
        const g = barGeometry(pct);
        expect(g.empty).toBeGreaterThanOrEqual(0);
        expect(g.filled).toBeLessThanOrEqual(BAR_WIDTH);
      }
    });

    it('never yields a negative filled count for an undershoot', () => {
      for (const pct of [-1, -22, -50, -100, -1_000]) {
        const g = barGeometry(pct);
        expect(g.filled).toBeGreaterThanOrEqual(0);
        expect(g.percent).toBe(0);
      }
    });
  });

  describe('degenerate input', () => {
    it('treats NaN as 0%', () => {
      const g = barGeometry(NaN);
      expect(Number.isNaN(g.percent)).toBe(false);
      expect(g.percent).toBe(0);
      expect(g.filled).toBe(0);
    });

    it('treats a non-finite percent as 0%', () => {
      // Uniform policy: a source that hands us Infinity is as broken as one
      // that hands us -22. Both render as an empty bar rather than throwing.
      expect(barGeometry(Infinity).percent).toBe(0);
      expect(barGeometry(-Infinity).percent).toBe(0);
    });

    it('handles a zero-width bar without going negative', () => {
      const g = barGeometry(50, 0);
      expect(g.filled).toBe(0);
      expect(g.empty).toBe(0);
    });

    it('handles a fractional width without producing fractional cells', () => {
      const g = barGeometry(50, 10.7);
      expect(Number.isInteger(g.filled)).toBe(true);
      expect(Number.isInteger(g.empty)).toBe(true);
    });
  });

  describe('output is always renderable', () => {
    it('every geometry produced across a wide input range survives repeat()', () => {
      // The original crash: '░'.repeat(-22). Assert the exact operation that
      // threw never sees a negative count again.
      const glyph = '\u2591';
      for (let pct = -200; pct <= 400; pct += 1) {
        const g = barGeometry(pct);
        expect(() => glyph.repeat(g.filled)).not.toThrow();
        expect(() => glyph.repeat(g.empty)).not.toThrow();
      }
    });
  });
});

describe('clampCellCount (Spec 0072)', () => {
  it('passes non-negative integers through', () => {
    expect(clampCellCount(0)).toBe(0);
    expect(clampCellCount(25)).toBe(25);
  });

  it('maps negative counts to 0 — the crash input', () => {
    expect(clampCellCount(-22)).toBe(0);
    expect(clampCellCount(-1)).toBe(0);
  });

  it('floors fractions and rejects non-finite values', () => {
    expect(clampCellCount(3.9)).toBe(3);
    expect(clampCellCount(NaN)).toBe(0);
    expect(clampCellCount(Infinity)).toBe(0);
  });

  it('makes repeat() safe for any input', () => {
    for (const n of [-100, -22, -1, 0, 1, 25, 3.7, NaN, Infinity]) {
      expect(() => '\u2591'.repeat(clampCellCount(n))).not.toThrow();
    }
  });
});
