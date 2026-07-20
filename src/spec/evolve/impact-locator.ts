import { SqliteDatabase } from '../../db/sqlite-adapter';
import { findSpecsByFragmentPath } from '../graph/queries';

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
 *   code fragments share the same file path (reusing findSpecsByFragmentPath).
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
    const matches = findSpecsByFragmentPath(db, fp);
    for (const specId of matches) {
      if (!excludeSpecIds.has(specId)) {
        candidateSpecIds.add(specId);
      }
    }
  }

  if (candidateSpecIds.size === 0) return [];

  // Filter to active specs
  let activeSpecIds = [...candidateSpecIds];
  if (onlyActive) {
    const placeholders = activeSpecIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id FROM spec_nodes WHERE status = 'active' AND id IN (${placeholders})`,
      )
      .all(...activeSpecIds) as Array<{ id: string }>;
    activeSpecIds = rows.map((r) => r.id);
  }

  if (activeSpecIds.length === 0) return [];

  // --- Phase B: group new commits by spec ---
  const results: AffectedSpecEntry[] = [];

  for (const specId of activeSpecIds) {
    // Get all fragment file paths for this spec
    const specFragmentPaths = db
      .prepare(
        `SELECT DISTINCT cf.file_path
         FROM spec_commit_relations scr
         JOIN commit_fragment_relations cfr ON cfr.commit_hash = scr.commit_hash
         JOIN code_fragment_nodes cf ON cf.id = cfr.fragment_id
         WHERE scr.spec_id = ?`,
      )
      .all(specId) as Array<{ file_path: string }>;

    const specPathSet = new Set(specFragmentPaths.map((r) => r.file_path));

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
