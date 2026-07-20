/**
 * Relation CRUD — persistence operations for the three relation tables:
 *
 *   - ``spec_commit_relations``   (Spec ↔ Commit)
 *   - ``commit_fragment_relations`` (Commit ↔ CodeFragment)
 *   - ``spec_spec_relations``     (Spec ↔ Spec)
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { RelationType, SpecCommitRelation } from '../types';

// ===========================================================================
// Spec ↔ Commit Relations
// ===========================================================================

/**
 * Insert a relation between a Spec and a Commit.
 * `INSERT OR IGNORE` — duplicates are silently skipped.
 */
export function insertSpecCommitRelation(
  db: SqliteDatabase,
  specId: string,
  commitHash: string,
  relationType: RelationType
): void {
  db.prepare(`
    INSERT OR IGNORE INTO spec_commit_relations
      (spec_id, commit_hash, relation_type)
    VALUES (@specId, @commitHash, @relationType)
  `).run({ specId, commitHash, relationType });
}

/**
 * Find all commits linked to a spec, ordered by commit timestamp
 * (oldest first — matches Commit4Spec's mining pipeline sort).
 */
export function findCommitsBySpec(
  db: SqliteDatabase,
  specId: string
): Array<SpecCommitRelation & { message: string; author: string; timestamp: number }> {
  const rows = db.prepare(`
    SELECT r.commit_hash, r.relation_type,
           c.message, c.author, c.timestamp
    FROM spec_commit_relations r
    JOIN commit_nodes c ON c.hash = r.commit_hash
    WHERE r.spec_id = ?
    ORDER BY c.timestamp ASC
  `).all(specId) as Array<{
    commit_hash: string;
    relation_type: string;
    message: string;
    author: string;
    timestamp: number;
  }>;

  return rows.map(r => ({
    specId,
    commitHash: r.commit_hash,
    relationType: r.relation_type as RelationType,
    message: r.message,
    author: r.author,
    timestamp: r.timestamp,
  }));
}

/**
 * Transfer all spec–commit relations from one spec to another.
 * Used during self-evolve when a spec is versioned:
 * old active spec's relations move to the deprecated record.
 */
export function transferSpecCommitRelations(
  db: SqliteDatabase,
  fromSpecId: string,
  toSpecId: string
): void {
  db.prepare(`
    UPDATE spec_commit_relations
    SET spec_id = @toSpecId
    WHERE spec_id = @fromSpecId
  `).run({ fromSpecId, toSpecId });
}

// ===========================================================================
// Commit ↔ CodeFragment Relations
// ===========================================================================

/**
 * Link a commit to a code fragment.
 * `INSERT OR IGNORE` — duplicates are silently skipped.
 */
export function insertCommitFragmentRelation(
  db: SqliteDatabase,
  commitHash: string,
  fragmentId: string,
  relationType: RelationType
): void {
  db.prepare(`
    INSERT OR IGNORE INTO commit_fragment_relations
      (commit_hash, fragment_id, relation_type)
    VALUES (@commitHash, @fragmentId, @relationType)
  `).run({ commitHash, fragmentId, relationType });
}

// ===========================================================================
// Spec ↔ Spec Relations
// ===========================================================================

/**
 * Insert a relation between two specs (SIMILAR_TO or EVOLVED_FROM).
 * `INSERT OR IGNORE` — duplicates are silently skipped.
 */
export function insertSpecSpecRelation(
  db: SqliteDatabase,
  sourceId: string,
  targetId: string,
  relationType: RelationType
): void {
  db.prepare(`
    INSERT OR IGNORE INTO spec_spec_relations
      (source_id, target_id, relation_type)
    VALUES (@sourceId, @targetId, @relationType)
  `).run({ sourceId, targetId, relationType });
}

/**
 * Remove all SIMILAR_TO relations involving a spec.
 * Called when a spec is deprecated (similarity links become stale).
 */
export function deleteSimilarToRelations(db: SqliteDatabase, specId: string): void {
  db.prepare(`
    DELETE FROM spec_spec_relations
    WHERE relation_type = 'SIMILAR_TO'
      AND (source_id = ? OR target_id = ?)
  `).run(specId, specId);
}

/**
 * Transfer all spec–spec relations from one spec to another.
 * Used during self-evolve versioning (old spec's relations move to
 * the deprecated record).
 */
export function transferSpecSpecRelations(
  db: SqliteDatabase,
  fromSpecId: string,
  toSpecId: string
): void {
  // No transaction wrapper — callers (e.g. applyUpdate) manage
  // their own explicit BEGIN/COMMIT boundaries.

  // Delete rows at `toSpecId` that would collide with the rows being
  // transferred, so the UPDATE below cannot trigger a PRIMARY KEY conflict.
  db.prepare(`
    DELETE FROM spec_spec_relations
    WHERE source_id = @toSpecId
      AND (target_id, relation_type) IN (
        SELECT target_id, relation_type FROM spec_spec_relations
        WHERE source_id = @fromSpecId
      )
  `).run({ fromSpecId, toSpecId });
  db.prepare(`
    DELETE FROM spec_spec_relations
    WHERE target_id = @toSpecId
      AND (source_id, relation_type) IN (
        SELECT source_id, relation_type FROM spec_spec_relations
        WHERE target_id = @fromSpecId
      )
  `).run({ fromSpecId, toSpecId });

  db.prepare(`
    UPDATE spec_spec_relations SET source_id = @toSpecId WHERE source_id = @fromSpecId
  `).run({ fromSpecId, toSpecId });
  db.prepare(`
    UPDATE spec_spec_relations SET target_id = @toSpecId WHERE target_id = @fromSpecId
  `).run({ fromSpecId, toSpecId });
}

// ===========================================================================
// Stats
// ===========================================================================

/**
 * Count total rows across all three relation tables.
 */
export function countAllRelations(db: SqliteDatabase): number {
  let total = 0;
  for (const table of [
    'spec_commit_relations',
    'commit_fragment_relations',
    'spec_spec_relations',
  ]) {
    const row = db
      .prepare(`SELECT COUNT(*) as cnt FROM ${table}`)
      .get() as { cnt: number } | undefined;
    total += row?.cnt ?? 0;
  }
  return total;
}
