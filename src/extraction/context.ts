/**
 * Extraction-scoped bindings set once per HomeGraph session.
 * Language extractors read these instead of threading rootDir/queries
 * through the orchestrator.
 */

import type { QueryBuilder } from '../db/queries';

let projectRoot: string | null = null;
let queries: QueryBuilder | null = null;

/** Progress from ArkTS batch indexing (scene build + per-file persist). */
export interface ArkTSBatchProgress {
  subphase: 'scene' | 'persist';
  current: number;
  total: number;
  currentFile?: string;
}

let arktsBatchProgress: ((progress: ArkTSBatchProgress) => void) | null = null;
let arktsBatchRunning = false;

export function bindExtractionContext(rootDir: string, qb: QueryBuilder): void {
  projectRoot = rootDir;
  queries = qb;
}

export function setArkTSBatchProgressCallback(
  cb: ((progress: ArkTSBatchProgress) => void) | null
): void {
  arktsBatchProgress = cb;
}

export function reportArkTSBatchProgress(progress: ArkTSBatchProgress): void {
  arktsBatchProgress?.(progress);
}

export function setArktsBatchRunning(running: boolean): void {
  arktsBatchRunning = running;
}

export function isArktsBatchRunning(): boolean {
  return arktsBatchRunning;
}

export function getExtractionProjectRoot(): string | null {
  return projectRoot;
}

export function getExtractionQueries(): QueryBuilder | null {
  return queries;
}

/** Test helper — clears bound context between cases. */
export function resetExtractionContext(): void {
  projectRoot = null;
  queries = null;
  arktsBatchProgress = null;
  arktsBatchRunning = false;
}
