/**
 * Presentation layer for the spec module — progress types and renderers
 * shared by the build / mine / evolve pipelines and the CLI.
 *
 * @module spec/ui
 */

export type { ProgressTick, ProgressCallback } from './progress';
export {
  createProgressHandler,
  createMineProgressHandler,
  createBuildProgressHandler,
  MINE_PHASE_LABELS,
  BUILD_PHASE_LABELS,
} from './progress-handler';
