/**
 * Progress handler factory for the spec pipelines.
 *
 * Provides two rendering strategies for `ProgressCallback`:
 *
 * - **bar** — ANSI-based single-line progress bar with phase label and
 *   item-level detail.  Intended for interactive TTY sessions.
 * - **verbose** — plain-text lines with elapsed timestamps.  Identical in
 *   style to `createVerboseProgress()` used by the indexing pipeline.
 *   Intended for `--verbose` mode and non-TTY (pipe) output.
 *
 * Phase label tables for the known pipelines live here too — labels are a
 * presentation concern and belong with the renderer.
 *
 * @module spec/ui/progress-handler
 */

import type { ProgressCallback, ProgressTick } from './progress';

// ---------------------------------------------------------------------------
// Phase labels (presentation concern — owned by the UI layer)
// ---------------------------------------------------------------------------

/** Phase labels for `spec mine`. */
export const MINE_PHASE_LABELS: Record<string, string> = {
  scanning:   'Scanning commits  ',
  clustering: 'Clustering        ',
  generating: 'Generating specs  ',
  persisting: 'Persisting to DB  ',
  done:       '                  ',
};

/** Phase labels for `spec build`. */
export const BUILD_PHASE_LABELS: Record<string, string> = {
  scanning:   'Scanning commits  ',
  persisting: 'Building graph    ',
  done:       '                  ',
};

// ---------------------------------------------------------------------------
// Bar mode
// ---------------------------------------------------------------------------

/** Width of the progress bar portion (excluding label and counters). */
const BAR_WIDTH = 20;

function createBarHandler(labels: Record<string, string>): ProgressCallback {
  let lastPhase = '';

  return (p) => {
    if (p.phase === 'done') {
      // Print a trailing newline so the last progress bar stays visible
      // and subsequent CLI output (success/info lines) starts on a fresh line.
      if (process.stdout.isTTY) process.stdout.write('\n');
      return;
    }

    if (p.phase !== lastPhase) {
      lastPhase = p.phase;
      // Print a newline when phase changes (previous bar stays visible briefly)
      if (process.stdout.isTTY) process.stdout.write('\n');
    }

    const label = labels[p.phase] || p.phase;
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

function createVerboseHandler(): ProgressCallback {
  const startTime = Date.now();
  let lastPhase = '';
  let lastPct = -1;

  return (p: ProgressTick) => {
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
 * Create a progress handler for a spec pipeline.
 *
 * @param mode - `'bar'` for ANSI progress bar (TTY), `'verbose'` for text lines.
 * @param labels - phase → padded label map used by bar mode.
 */
export function createProgressHandler(
  mode: 'bar' | 'verbose',
  labels: Record<string, string>,
): ProgressCallback {
  if (mode === 'bar' && process.stdout.isTTY) {
    return createBarHandler(labels);
  }
  return createVerboseHandler();
}

/** Create a progress handler with the `spec mine` phase labels. */
export function createMineProgressHandler(mode: 'bar' | 'verbose'): ProgressCallback {
  return createProgressHandler(mode, MINE_PHASE_LABELS);
}

/** Create a progress handler with the `spec build` phase labels. */
export function createBuildProgressHandler(mode: 'bar' | 'verbose'): ProgressCallback {
  return createProgressHandler(mode, BUILD_PHASE_LABELS);
}
