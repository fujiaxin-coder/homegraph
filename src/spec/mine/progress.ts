/**
 * Progress reporting callback type for the `spec mine` pipeline.
 *
 * Each phase callback reports current/total progress with an optional
 * human-readable message. The callback is purely advisory — `onProgress`
 * is always optional and a missing callback just means "no output."
 *
 * @module spec/mine/progress
 */

/** One progress tick from any phase of the pipeline. */
export interface MineProgress {
  /** Current pipeline phase. */
  phase: 'scanning' | 'clustering' | 'generating' | 'persisting' | 'done';
  /** Current item index (1-based).  0 means the phase just started. */
  current: number;
  /** Total items in this phase.  0 means the total is unknown / not meaningful. */
  total: number;
  /** Optional human-readable label (e.g. commit hash, specId). */
  message?: string;
}

/** Callback signature for progress reporting. */
export type MineProgressCallback = (progress: MineProgress) => void;
