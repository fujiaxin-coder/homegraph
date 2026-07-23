/**
 * Generic progress-reporting types shared by the spec pipelines
 * (build / mine / evolve).
 *
 * Each phase callback reports current/total progress with an optional
 * human-readable message. The callback is purely advisory — `onProgress`
 * is always optional and a missing callback just means "no output."
 *
 * @module spec/ui/progress
 */

/** One progress tick from any phase of a pipeline. */
export interface ProgressTick<P extends string = string> {
  /** Current pipeline phase (pipeline-defined). */
  phase: P;
  /** Current item index (1-based).  0 means the phase just started. */
  current: number;
  /** Total items in this phase.  0 means the total is unknown / not meaningful. */
  total: number;
  /** Optional human-readable label (e.g. commit hash, specId). */
  message?: string;
}

/** Callback signature for progress reporting. */
export type ProgressCallback<P extends string = string> = (tick: ProgressTick<P>) => void;
