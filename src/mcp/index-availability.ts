/**
 * Product-facing index availability for MCP tool results (Spec 0032).
 *
 * Internal `build_phase` stays as-is; this layer maps it (+ write-lock / busy)
 * to the four states hosts and agents should see in tool text.
 */

import type HomeGraph from '../index';
import type { BuildPhase } from '../project-map';

/** Agent-visible index readiness (tool return copy — not tools/list gating). */
export type ProductIndexState = 'empty' | 'fast' | 'full' | 'syncing';

const EMPTY_LINES = [
  'HomeGraph status=empty — project map is not ready yet.',
  'Retry in a few seconds (or call `homegraph_project` once the fast build completes).',
];

const FAST_LINES = [
  'HomeGraph status=fast — module/file map is ready; full symbol index is still building.',
  'Use `homegraph_project` for the module/file map now, then retry this tool once indexing finishes.',
];

const SYNCING_LINES = [
  'HomeGraph status=syncing — the index is being written (lock held or local index/sync in progress).',
  'Retry this tool shortly; do not busy-loop.',
];

export function productIndexGuidance(state: Exclude<ProductIndexState, 'full'>): string {
  switch (state) {
    case 'empty':
      return EMPTY_LINES.join('\n');
    case 'fast':
      return FAST_LINES.join('\n');
    case 'syncing':
      return SYNCING_LINES.join('\n');
  }
}

/**
 * Resolve the product state from a live HomeGraph handle.
 *
 * - empty: fast map not ready (`none` / `building_fast`)
 * - fast: map ready, full index not done (`fast` / `indexing`)
 * - full: symbol index ready
 * - syncing: full (or empty-while-contended-init) and a writer holds the lock /
 *   this process is indexing — reads may fail or see a moving target
 */
export function resolveProductIndexState(cg: HomeGraph): ProductIndexState {
  let phase: BuildPhase;
  try {
    phase = cg.getBuildPhase();
  } catch {
    return 'syncing';
  }

  if (phase === 'building_fast' || phase === 'none') {
    try {
      if (cg.isWriteLockedByOther()) return 'syncing';
    } catch {
      return 'syncing';
    }
    return 'empty';
  }

  if (phase === 'fast' || phase === 'indexing') {
    return 'fast';
  }

  // full
  try {
    if (cg.isWriteLockedByOther() || cg.isIndexing()) return 'syncing';
  } catch {
    return 'syncing';
  }
  return 'full';
}

/** True when an error message indicates SQLite writer contention. */
export function isSqliteBusyMessage(message: string): boolean {
  return /SQLITE_BUSY|database is locked/i.test(message);
}
