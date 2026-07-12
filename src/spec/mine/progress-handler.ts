/**
 * Progress handler factory for `spec mine`.
 *
 * Provides two rendering strategies for `MineProgressCallback`:
 *
 * - **bar** — ANSI-based single-line progress bar with phase label and
 *   item-level detail.  Intended for interactive TTY sessions.
 * - **verbose** — plain-text lines with elapsed timestamps.  Identical in
 *   style to `createVerboseProgress()` used by the indexing pipeline.
 *   Intended for `--verbose` mode and non-TTY (pipe) output.
 *
 * @module spec/mine/progress-handler
 */

import type { MineProgress, MineProgressCallback } from './progress';

// ---------------------------------------------------------------------------
// Bar mode
// ---------------------------------------------------------------------------

/** Width of the progress bar portion (excluding label and counters). */
const BAR_WIDTH = 20;

const PHASE_LABELS: Record<MineProgress['phase'], string> = {
  scanning:   'Scanning commits  ',
  clustering: 'Clustering        ',
  generating: 'Generating specs  ',
  persisting: 'Persisting to DB  ',
  done:       '                  ',
};

function createBarHandler(): MineProgressCallback {
  let lastPhase = '';

  return (p) => {
    if (p.phase === 'done') {
      // Clear progress line
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      return;
    }

    if (p.phase !== lastPhase) {
      lastPhase = p.phase;
      // Print a newline when phase changes (previous bar stays visible briefly)
      if (process.stdout.isTTY) process.stdout.write('\n');
    }

    const label = PHASE_LABELS[p.phase] || p.phase;
    const total = p.total > 0 ? p.total : 0;
    const current = p.current;

    let bar: string;
    if (total === 0) {
      // Indeterminate — spinner-like effect
      bar = '—'.repeat(BAR_WIDTH);
    } else {
      const filled = Math.round((current / total) * BAR_WIDTH);
      bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    }

    const counter = total > 0 ? ` ${String(current).padStart(String(total).length, ' ')}/${total}` : '';
    const msg = p.message ? `  ${p.message}` : '';

    const line = `${label} [${bar}]${counter}${msg}`;
    process.stdout.write(`\r\x1b[K${line}`);
  };
}

// ---------------------------------------------------------------------------
// Verbose mode
// ---------------------------------------------------------------------------

function createVerboseHandler(): MineProgressCallback {
  const startTime = Date.now();
  let lastPhase = '';
  let lastPct = -1;

  return (p) => {
    if (p.phase === 'done') return;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (p.phase !== lastPhase) {
      lastPhase = p.phase;
      lastPct = -1;
      console.log(`[${elapsed}s] Phase: ${p.phase}`);
    }

    if (p.total > 0) {
      const pct = Math.floor((p.current / p.total) * 100);
      if (pct >= lastPct + 5 || p.current === p.total) {
        lastPct = pct;
        const msg = p.message ? ` · ${p.message}` : '';
        console.log(`[${elapsed}s]   ${p.current}/${p.total} (${pct}%)${msg}`);
      }
    } else if (p.message) {
      // Phase-level message without item counts (clustering, etc.)
      console.log(`[${elapsed}s]   ${p.message}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a progress handler for `spec mine`.
 *
 * @param mode - `'bar'` for ANSI progress bar (TTY), `'verbose'` for text lines.
 * @returns A `MineProgressCallback` or `undefined` for silent mode.
 */
export function createMineProgressHandler(
  mode: 'bar' | 'verbose',
): MineProgressCallback {
  if (mode === 'bar' && process.stdout.isTTY) {
    return createBarHandler();
  }
  return createVerboseHandler();
}
