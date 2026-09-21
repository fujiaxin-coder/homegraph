/**
 * Product-facing index availability for MCP tool results (Spec 0032 + 0035).
 *
 * Internal `build_phase` stays as-is; this layer maps it (+ write-lock / busy /
 * pending dirty files) to the five states hosts and agents should see.
 */

import type HomeGraph from '../index';
import type { BuildPhase } from '../project-map';

/** Agent-visible index readiness (tool return copy — not tools/list gating). */
export type ProductIndexState = 'empty' | 'fast' | 'full' | 'dirty' | 'syncing';

/** One-line glossary for MCP initialize / tool surface (Spec 0035). */
export const PRODUCT_STATUS_GLOSSARY =
  'status: empty=not ready · fast=map only (homegraph_project) · full=fresh · dirty=usable but listed paths outdated · syncing=write lock, retry';

const MAX_DIRTY_PATHS = 5;

/** Whole-response guidance when the tool cannot usefully answer yet. */
export function productIndexGuidance(
  state: Extract<ProductIndexState, 'empty' | 'fast' | 'syncing'>
): string {
  switch (state) {
    case 'empty':
      return 'HomeGraph status=empty — not ready; retry shortly.';
    case 'fast':
      return 'HomeGraph status=fast — map only; use homegraph_project; retry other tools later.';
    case 'syncing':
      return 'HomeGraph status=syncing — locked; retry shortly, do not loop.';
  }
}

/**
 * Single status line for tool footers (and for guidance-only replies).
 * `pendingPaths` only used when `state === 'dirty'`.
 */
export function formatProductStatusLine(
  state: ProductIndexState,
  opts?: { pendingPaths?: string[] }
): string {
  switch (state) {
    case 'empty':
    case 'fast':
    case 'syncing':
      return productIndexGuidance(state);
    case 'full':
      return 'HomeGraph status=full — complete and up to date.';
    case 'dirty': {
      const paths = opts?.pendingPaths ?? [];
      if (paths.length === 0) {
        return 'HomeGraph status=dirty — outdated: pending files';
      }
      const shown = paths.slice(0, MAX_DIRTY_PATHS);
      const more = paths.length > MAX_DIRTY_PATHS ? `, …+${paths.length - MAX_DIRTY_PATHS}` : '';
      return `HomeGraph status=dirty — outdated: ${shown.join(', ')}${more}`;
    }
  }
}

/**
 * Resolve the product state from a live HomeGraph handle.
 *
 * Priority: syncing > empty > fast > dirty > full
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

  let pendingCount = 0;
  try {
    pendingCount = cg.getPendingFiles?.()?.length ?? 0;
  } catch {
    pendingCount = 0;
  }
  if (pendingCount > 0) return 'dirty';
  return 'full';
}

/** True when an error message indicates SQLite writer contention. */
export function isSqliteBusyMessage(message: string): boolean {
  return /SQLITE_BUSY|database is locked/i.test(message);
}

/** True when text is already a pure (or leading) HomeGraph status line. */
export function textAlreadyHasProductStatus(text: string): boolean {
  return /^\s*HomeGraph status=/m.test(text);
}

/** Marker line for Spec 0038 project-root path hint (idempotent prepend). */
export const PROJECT_ROOT_HINT_MARKER = 'HomeGraph project root:';

/**
 * Short preamble: absolute project root + how to join repo-relative paths (Spec 0038).
 * `absRoot` should already be resolved (platform-native absolute path).
 */
export function formatProjectRootPathHint(absRoot: string): string {
  const root = absRoot.trim();
  return (
    `${PROJECT_ROOT_HINT_MARKER} \`${root}\`\n` +
    'Paths below are repo-relative to that root. Pass them to Read/Grep as-is, or join as `<root>/<relative>` (use `/`). Do not invent experiment/result directory prefixes.'
  );
}

/** True when text already carries a Spec 0038 project-root hint. */
export function textAlreadyHasProjectRootHint(text: string): boolean {
  return text.includes(PROJECT_ROOT_HINT_MARKER);
}
