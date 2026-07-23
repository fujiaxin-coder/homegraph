import { SqliteDatabase } from '../../db/sqlite-adapter';
import {
  findSpecIdsByFragmentPath,
  findFragmentPathsBySpec,
  findActiveSpecIds,
} from '../db/relations';

// =============================================================================
// AffectedSpecEntry + locateAffectedSpecsWithCommits
// =============================================================================

export interface AffectedSpecEntry {
  /** The affected historical spec ID. */
  specId: string;
  /** New commit hashes that affect this spec (file path overlap). */
  affectingCommits: string[];
}

/**
 * Locate historical (pre-existing) specs affected by new commits, grouped
 * by spec → affecting commit list in one pass.
 *
 * Two-phase query strategy:
 *
 * Phase A: For each file path in the new commits, find all spec IDs whose
 *   code fragments share the same file path (reusing findSpecIdsByFragmentPath).
 *   Exclude specIds in excludeSpecIds (phase 1 newly inserted specs).
 *
 * Phase B: For each candidate spec, determine which new commits' file paths
 *   overlap with the spec's known fragment file paths.  File paths are
 *   considered overlapping when one contains the other (substring match).
 *
 * @param db                Active SQLite database handle.
 * @param commitFilePaths   Map of new commit hash → file paths (from phase 1).
 * @param excludeSpecIds    Spec IDs to exclude (phase 1 newly inserted specs).
 * @param onlyActive        If true (default), filter to specs with status = 'active'.
 * @returns Sorted array of AffectedSpecEntry.
 */
export function locateAffectedSpecsWithCommits(
  db: SqliteDatabase,
  commitFilePaths: Map<string, string[]>,
  excludeSpecIds: Set<string>,
  onlyActive: boolean = true,
): AffectedSpecEntry[] {
  // --- Phase A: find candidate spec IDs ---
  const allFilePaths = [...new Set(
    Array.from(commitFilePaths.values()).flat(),
  )];

  const candidateSpecIds = new Set<string>();
  for (const fp of allFilePaths) {
    const matches = findSpecIdsByFragmentPath(db, fp);
    for (const specId of matches) {
      if (!excludeSpecIds.has(specId)) {
        candidateSpecIds.add(specId);
      }
    }
  }

  if (candidateSpecIds.size === 0) return [];

  // Filter to active specs
  const activeSpecIds = onlyActive
    ? findActiveSpecIds(db, [...candidateSpecIds])
    : [...candidateSpecIds];

  if (activeSpecIds.length === 0) return [];

  // --- Phase B: group new commits by spec ---
  const results: AffectedSpecEntry[] = [];

  for (const specId of activeSpecIds) {
    const specPathSet = new Set(findFragmentPathsBySpec(db, specId));

    // Find new commits whose file paths overlap with spec's fragment paths
    const affectingCommits: string[] = [];
    for (const [commitHash, filePaths] of commitFilePaths) {
      const overlaps = filePaths.some((fp) => {
        for (const sfp of specPathSet) {
          if (sfp.includes(fp) || fp.includes(sfp)) return true;
        }
        return false;
      });
      if (overlaps) {
        affectingCommits.push(commitHash);
      }
    }

    if (affectingCommits.length > 0) {
      results.push({ specId, affectingCommits });
    }
  }

  return results.sort((a, b) => a.specId.localeCompare(b.specId));
}
