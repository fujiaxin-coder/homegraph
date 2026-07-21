/**
 * Relation CRUD — persistence operations for the three relation tables:
 *
 *   - ``spec_commit_relations``   (Spec ↔ Commit)
 *   - ``commit_fragment_relations`` (Commit ↔ CodeFragment)
 *   - ``spec_spec_relations``     (Spec ↔ Spec)
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { RelationType, SpecCommitRelation } from '../types';
import { escapeLike } from './sql-utils';

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

// ===========================================================================
// Cross-table traversal primitives
//
// Join queries that walk Spec → Commit → CodeFragment. These are the ONLY
// home for this SQL — higher layers (graph/queries, evolve/impact-locator)
// compose these primitives instead of writing their own joins.
// ===========================================================================

/**
 * Find all spec IDs related to code fragments whose file path matches
 * the given substring (unescaped LIKE `%filePath%`).
 */
export function findSpecIdsByFragmentPath(
  db: SqliteDatabase,
  filePath: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.spec_id
       FROM spec_commit_relations r
       JOIN commit_fragment_relations cfr ON cfr.commit_hash = r.commit_hash
       JOIN code_fragment_nodes cf ON cf.id = cfr.fragment_id
       WHERE cf.file_path LIKE ?`
    )
    .all(`%${filePath}%`) as Array<{ spec_id: string }>;

  return rows.map((r) => r.spec_id);
}

/** Result container returned by findSpecsByFilePath. */
export interface FindSpecsByFilePathResult {
  /** Matching spec entries (capped at maxResults). */
  results: Array<{
    id: string;
    title: string;
    status: string;
    version: number;
    filePath: string;
  }>;
  /** Number of results actually returned (<= maxResults). */
  matched_count: number;
  /** True when more results exist beyond the cap. */
  truncated: boolean;
}

/** Default max results returned by findSpecsByFilePath. */
const DEFAULT_MAX_SPEC_FIND_RESULTS = 100;

/**
 * Find specs whose code fragments reference the given file path.
 *
 * Traverses: filePath -> code_fragment_nodes -> commit_fragment_relations
 * -> commit_nodes -> spec_commit_relations -> spec_nodes.
 *
 * Uses LIKE matching against code_fragment_nodes.file_path, so partial
 * paths work (e.g. `src/auth.ts` matches `src/auth/login.ts` and
 * `app/src/auth.ts`).  LIKE metacharacters (`%`, `_`, `\`) in the
 * filePath are automatically escaped.
 *
 * An empty or whitespace-only filePath is rejected with an error
 * (it would match every spec in the graph).
 */
export function findSpecsByFilePath(
  db: SqliteDatabase,
  filePath: string,
  maxResults: number = DEFAULT_MAX_SPEC_FIND_RESULTS,
): FindSpecsByFilePathResult {
  // Guard against empty input that would match every spec
  if (!filePath || filePath.trim().length === 0) {
    throw new Error(
      'Empty file path is not allowed -- it would match every spec in the knowledge graph. ' +
      'Provide a concrete file path (e.g. "src/auth.ts") or a partial path (e.g. "src/auth").',
    );
  }

  const pattern = `%${escapeLike(filePath)}%`;

  const rows = db
    .prepare(
      `SELECT DISTINCT s.id, s.title, s.status, s.version, s.file_path
       FROM spec_nodes s
       JOIN spec_commit_relations scr ON scr.spec_id = s.id
       JOIN commit_fragment_relations cfr ON cfr.commit_hash = scr.commit_hash
       JOIN code_fragment_nodes cf ON cf.id = cfr.fragment_id
       WHERE cf.file_path LIKE ? ESCAPE '\\'
       ORDER BY s.id
       LIMIT ?`,
    )
    .all(pattern, maxResults + 1) as Array<{
      id: string;
      title: string;
      status: string;
      version: number;
      file_path: string;
    }>;

  const truncated = rows.length > maxResults;
  const slice = truncated ? rows.slice(0, maxResults) : rows;

  return {
    results: slice.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      version: r.version,
      filePath: r.file_path,
    })),
    matched_count: slice.length,
    truncated,
  };
}

/**
 * A candidate spec for code-entity matching, with aggregate signals
 * computed in SQL (line overlap, fragment/commit counts, path match level).
 */
export interface SpecCandidate {
  id: string;
  title: string;
  status: string;
  version: number;
  filePath: string;
  timestamp: number;
  /** Overlapping line count between the entity range and the best fragment. */
  overlapLines: number;
  /** Number of distinct fragments linking this spec to the entity's file. */
  fragmentCount: number;
  /** Number of distinct commits linking this spec to the entity's file. */
  commitCount: number;
  /** 3 = exact path, 2 = suffix match, 1 = substring LIKE match. */
  filePathMatchLevel: number;
}

/**
 * Gather candidate specs whose fragments touch the given file path, with
 * per-spec aggregate signals for downstream scoring. Only active specs are
 * considered.
 */
export function findSpecCandidatesByFilePath(
  db: SqliteDatabase,
  params: { filePath: string; startLine: number; endLine: number; maxCandidates: number },
): SpecCandidate[] {
  const pathEscaped = escapeLike(params.filePath);

  const rows = db
    .prepare(`
      SELECT
          s.id, s.title, s.status, s.version, s.file_path, s.timestamp,
          MAX(
            MIN(cf.end_line, @entityEnd) - MAX(cf.start_line, @entityStart) + 1,
            0
          ) AS overlap_lines,
          COUNT(DISTINCT cf.id) AS fragment_count,
          COUNT(DISTINCT scr.commit_hash) AS commit_count,
          MAX(CASE
            WHEN cf.file_path = @exactFilePath THEN 3
            WHEN cf.file_path LIKE @suffixLikePattern ESCAPE '\\' THEN 2
            ELSE 1
          END) AS file_path_match_level
      FROM spec_nodes s
      JOIN spec_commit_relations scr ON scr.spec_id = s.id
      JOIN commit_fragment_relations cfr ON cfr.commit_hash = scr.commit_hash
      JOIN code_fragment_nodes cf ON cf.id = cfr.fragment_id
      WHERE s.status = 'active'
        AND cf.file_path LIKE @likePattern ESCAPE '\\'
      GROUP BY s.id
      ORDER BY s.timestamp DESC
      LIMIT @maxCandidates
    `)
    .all({
      entityEnd: params.endLine,
      entityStart: params.startLine,
      exactFilePath: params.filePath,
      suffixLikePattern: `%${pathEscaped}`,
      likePattern: `%${pathEscaped}%`,
      maxCandidates: params.maxCandidates,
    }) as Array<{
      id: string;
      title: string;
      status: string;
      version: number;
      file_path: string;
      timestamp: number;
      overlap_lines: number;
      fragment_count: number;
      commit_count: number;
      file_path_match_level: number;
    }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    version: r.version,
    filePath: r.file_path,
    timestamp: r.timestamp,
    overlapLines: r.overlap_lines,
    fragmentCount: r.fragment_count,
    commitCount: r.commit_count,
    filePathMatchLevel: r.file_path_match_level,
  }));
}

/**
 * Find all spec IDs linked (via commits) to any of the given fragment IDs.
 */
export function findSpecIdsByFragmentIds(
  db: SqliteDatabase,
  fragmentIds: string[],
): string[] {
  if (fragmentIds.length === 0) return [];

  const placeholders = fragmentIds.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT DISTINCT scr.spec_id
      FROM commit_fragment_relations cfr
      JOIN spec_commit_relations scr ON scr.commit_hash = cfr.commit_hash
      WHERE cfr.fragment_id IN (${placeholders})
    `)
    .all(...fragmentIds) as Array<{ spec_id: string }>;

  return rows.map((r) => r.spec_id);
}

/**
 * Return the distinct fragment file paths associated with a spec (via its
 * commits' fragments).
 */
export function findFragmentPathsBySpec(
  db: SqliteDatabase,
  specId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT cf.file_path
       FROM spec_commit_relations scr
       JOIN commit_fragment_relations cfr ON cfr.commit_hash = scr.commit_hash
       JOIN code_fragment_nodes cf ON cf.id = cfr.fragment_id
       WHERE scr.spec_id = ?`,
    )
    .all(specId) as Array<{ file_path: string }>;

  return rows.map((r) => r.file_path);
}

/**
 * Filter a list of spec IDs down to those with status = 'active'.
 */
export function findActiveSpecIds(
  db: SqliteDatabase,
  specIds: string[],
): string[] {
  if (specIds.length === 0) return [];

  const placeholders = specIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id FROM spec_nodes WHERE status = 'active' AND id IN (${placeholders})`,
    )
    .all(...specIds) as Array<{ id: string }>;

  return rows.map((r) => r.id);
}
