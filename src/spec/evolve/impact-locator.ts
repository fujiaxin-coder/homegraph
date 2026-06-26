import { SqliteDatabase } from '../../db/sqlite-adapter';
import { findSpecsByFragmentPath } from '../graph/queries';

/**
 * Find specs affected by the given list of file paths.
 *
 * Each file path should already be clean (no `a/` or `b/` prefix) — paths
 * sourced from `DiffFragment.filePath` via diff-parser already have prefixes
 * stripped.
 *
 * Queries the spec knowledge graph for specs whose code fragments match the
 * path, returns deduplicated, alphabetically sorted spec IDs.
 */
export function locateAffectedSpecs(
  db: SqliteDatabase,
  filePaths: string[],
): string[] {
  const specIds = new Set<string>();

  for (const fp of filePaths) {
    const matches = findSpecsByFragmentPath(db, fp);
    for (const specId of matches) {
      specIds.add(specId);
    }
  }

  return Array.from(specIds).sort();
}
