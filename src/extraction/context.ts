/**
 * Extraction-scoped bindings set once per HomeGraph session.
 * Language extractors read these instead of threading rootDir/queries
 * through the orchestrator.
 */

import type { QueryBuilder } from '../db/queries';

let projectRoot: string | null = null;
let queries: QueryBuilder | null = null;

export function bindExtractionContext(rootDir: string, qb: QueryBuilder): void {
  projectRoot = rootDir;
  queries = qb;
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
}
