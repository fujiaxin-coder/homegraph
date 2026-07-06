/**
 * Graph traversal queries for the Spec→Commit→CodeFragment knowledge graph.
 *
 * Replaces `commit4spec/graph/queries.py`. Provides spec context retrieval,
 * stats, and search+traverse functionality.
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import {
  SpecNode,
  CommitNode,
  CodeFragmentNode,
  SpecContext,
  SpecCommitContext,
  SpecStats,
} from '../types';
import { searchSpecs, searchCodeFragments } from '../db/fts';

// ===========================================================================
// Row shapes from SQLite (snake_case column names)
// ===========================================================================

interface SpecNodeRow {
  id: string;
  title: string;
  subtitles: string;
  status: string;
  version: number;
  file_path: string;
  timestamp: number;
}

interface CommitRow {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
  relation_type: string;
}

interface FragmentRow {
  id: string;
  change_type: string;
  file_path: string;
  start_line: number;
  end_line: number;
  code_diff: string;
}

// ===========================================================================
// Private helpers
// ===========================================================================

/**
 * Parse a JSON string into a string array, returning [] on any failure.
 */
function _parseSubtitles(raw: string): string[] {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

/**
 * Convert a DB row (snake_case keys) to a SpecNode (camelCase).
 */
function _rowToSpecNode(row: SpecNodeRow): SpecNode {
  return {
    id: row.id,
    title: row.title,
    subtitles: _parseSubtitles(row.subtitles),
    status: row.status as SpecNode['status'],
    version: row.version,
    filePath: row.file_path,
    timestamp: row.timestamp,
  };
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Retrieve full context for a Spec — the spec node itself, all linked
 * commits (with their relation types), and optionally the code fragments
 * each commit touched.
 *
 * Commits are ordered by relation-type priority (GENERATE first, then
 * SUMMARIZED_FROM, then others) and then by timestamp descending within
 * each priority tier.
 *
 * @param db           Active SQLite database handle.
 * @param specId       Spec identifier to look up.
 * @param maxCommits   Maximum number of linked commits to return (default 5).
 * @param includeFragments  Whether to load code fragments for each commit (default true).
 * @returns SpecContext on success, or null when the spec is not found.
 */
export function getSpecContext(
  db: SqliteDatabase,
  specId: string,
  maxCommits: number = 5,
  includeFragments: boolean = true
): SpecContext | null {
  // 1. Look up the spec by id
  const specRow = db
    .prepare(
      `SELECT id, title, subtitles, status, version, file_path, timestamp
       FROM spec_nodes
       WHERE id = ?`
    )
    .get(specId) as SpecNodeRow | undefined;

  if (!specRow) return null;

  const spec = _rowToSpecNode(specRow);

  // 2. Query linked commits with priority ordering
  const commitRows = db
    .prepare(
      `SELECT c.hash, c.message, c.author, c.timestamp, r.relation_type
       FROM spec_commit_relations r
       JOIN commit_nodes c ON c.hash = r.commit_hash
       WHERE r.spec_id = ?
       ORDER BY
         CASE r.relation_type
           WHEN 'GENERATE' THEN 0
           WHEN 'SUMMARIZED_FROM' THEN 1
           ELSE 2
         END,
         c.timestamp DESC
       LIMIT ?`
    )
    .all(specId, maxCommits) as CommitRow[];

  // 3. Build commit contexts (with optional fragments)
  const commits: SpecCommitContext[] = [];
  for (const crow of commitRows) {
    const commit: CommitNode = {
      hash: crow.hash,
      message: crow.message,
      author: crow.author,
      timestamp: crow.timestamp,
    };

    let fragments: CodeFragmentNode[] = [];
    if (includeFragments) {
      const fragRows = db
        .prepare(
          `SELECT f.id, f.change_type, f.file_path, f.start_line,
                  f.end_line, f.code_diff
           FROM commit_fragment_relations r
           JOIN code_fragment_nodes f ON f.id = r.fragment_id
           WHERE r.commit_hash = ?
           ORDER BY f.file_path, f.start_line`
        )
        .all(crow.hash) as FragmentRow[];

      fragments = fragRows.map((fr) => ({
        id: fr.id,
        changeType: fr.change_type as CodeFragmentNode['changeType'],
        filePath: fr.file_path,
        startLine: fr.start_line,
        endLine: fr.end_line,
        codeDiff: fr.code_diff,
      }));
    }

    commits.push({
      commit,
      relationType: crow.relation_type as SpecCommitContext['relationType'],
      fragments,
    });
  }

  return { spec, commits };
}

/**
 * Find all spec IDs related to code fragments whose file path matches
 * the given substring.
 *
 * @param db       Active SQLite database handle.
 * @param filePath  File path substring to search for (LIKE-wrapped).
 * @returns Array of distinct spec IDs.
 */
export function findSpecsByFragmentPath(
  db: SqliteDatabase,
  filePath: string
): string[] {
  const pattern = `%${filePath}%`;
  const rows = db
    .prepare(
      `SELECT DISTINCT r.spec_id
       FROM spec_commit_relations r
       JOIN commit_fragment_relations cfr ON cfr.commit_hash = r.commit_hash
       JOIN code_fragment_nodes cf ON cf.id = cfr.fragment_id
       WHERE cf.file_path LIKE ?`
    )
    .all(pattern) as Array<{ spec_id: string }>;

  return rows.map((r) => r.spec_id);
}

// ===========================================================================
// findSpecsByFilePath
// ===========================================================================

/** Default max results returned by findSpecsByFilePath. */
const DEFAULT_MAX_SPEC_FIND_RESULTS = 100;

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
 *
 * @param db         Active SQLite database handle.
 * @param filePath   File path to search for (substring LIKE match).
 * @param maxResults Maximum number of results to return (default 100).
 * @returns FindSpecsByFilePathResult with .results, .matched_count, and .truncated.
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

  // Escape LIKE metacharacters (SQLite ESCAPE '\' is used in the query)
  const escaped = filePath
    .replace(/\\/g, '\\\\') // literal backslash
    .replace(/%/g, '\\%')   // percent wildcard
    .replace(/_/g, '\\_');  // underscore wildcard

  const pattern = `%${escaped}%`;

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
 * Compute statistics about the Spec knowledge graph.
 *
 * @param db  Active SQLite database handle.
 * @returns SpecStats with entity counts and relation totals.
 */
export function getSpecStats(db: SqliteDatabase): SpecStats {
  const specCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM spec_nodes').get() as { cnt: number }
  ).cnt;

  const commitCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM commit_nodes').get() as { cnt: number }
  ).cnt;

  const fragmentCount = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM code_fragment_nodes')
      .get() as { cnt: number }
  ).cnt;

  const scrCount = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM spec_commit_relations')
      .get() as { cnt: number }
  ).cnt;

  const cfrCount = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM commit_fragment_relations')
      .get() as { cnt: number }
  ).cnt;

  const ssrCount = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM spec_spec_relations')
      .get() as { cnt: number }
  ).cnt;

  const activeSpecCount = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM spec_nodes WHERE status = 'active'")
      .get() as { cnt: number }
  ).cnt;

  const deprecatedSpecCount = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM spec_nodes WHERE status = 'deprecated'")
      .get() as { cnt: number }
  ).cnt;

  return {
    specCount,
    commitCount,
    fragmentCount,
    relationCount: scrCount + cfrCount + ssrCount,
    activeSpecCount,
    deprecatedSpecCount,
  };
}

/**
 * Full-text search for specs and return full context for each match.
 *
 * Combines FTS5 + LIKE fallback search with graph traversal so callers
 * get everything in one call: spec metadata, linked commits, and
 * optionally code fragments.
 *
 * Results are sorted by `_score` descending, then by spec timestamp
 * descending as a tiebreaker.
 *
 * @param db                Active SQLite database handle.
 * @param query             Search query string.
 * @param topK              Maximum number of results to return (default 10).
 * @param includeFragments  Whether to load code fragments per commit (default true).
 * @returns Array of SpecContext (null results filtered out).
 */
export function searchAndGetContext(
  db: SqliteDatabase,
  query: string,
  topK: number = 10,
  includeFragments: boolean = true
): SpecContext[] {
  // 1. Search specs via FTS5 + LIKE fallback
  const results = searchSpecs(db, query, topK);

  // 2. Get full context for each result
  const scored: Array<{ score: number; timestamp: number; context: SpecContext }> = [];
  for (const result of results) {
    const context = getSpecContext(db, result.id, 5, includeFragments);
    if (context !== null) {
      scored.push({
        score: result._score ?? 0,
        timestamp: context.spec.timestamp,
        context,
      });
    }
  }

  // 3. Sort by _score descending, then by spec timestamp descending
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.timestamp - a.timestamp;
  });

  return scored.map((c) => c.context);
}

// ===========================================================================
// findSpecsByCodeSymbol — code entity → Spec (reverse trace)
// ===========================================================================

/**
 * Metadata about a code entity for which we want to find associated Specs.
 * Typically sourced from a homegraph.db ``nodes`` row.
 */
export interface CodeEntityInfo {
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/** A single scored match between a code entity and a Spec. */
export interface CodeEntitySpecMatch {
  spec: {
    id: string;
    title: string;
    status: string;
    version: number;
    filePath: string;
    timestamp: number;
  };
  /** Five-dimension weighted score (0.0–1.0). */
  score: number;
  /** Score breakdown for transparency. */
  scoreDetail: {
    filePathScore: number;
    contentScore: number;
    nameScore: number;
    recencyScore: number;
    overlapScore: number;
  };
  /** Number of overlapping code fragments for this spec. */
  fragmentCount: number;
  /** Total commits linking this spec to the entity's file. */
  commitCount: number;
}

/** Result container for findSpecsByCodeSymbol. */
export interface FindSpecsByCodeSymbolResult {
  entity: CodeEntityInfo;
  matches: CodeEntitySpecMatch[];
  totalCandidates: number;
}

/** Weight constants for the five scoring dimensions. */
const WEIGHTS = {
  filePath: 0.30,
  content: 0.25,
  name: 0.15,
  recency: 0.20,
  overlap: 0.10,
};

/** Maximum candidates to consider from the initial file-path JOIN. */
const MAX_CANDIDATES = 200;

/**
 * Escape LIKE metacharacters in a string, also escaping the escape character.
 */
function escapeLike(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Find Specs associated with a code entity by multi-dimensional scoring:
 *
 * 1. File path match (weight 0.30) — most stable anchor; function rarely changes file
 * 2. Code-diff content match via FTS5 (weight 0.25) — catches entity names in diff text
 *    that never appear in Spec titles
 * 3. Spec title/subtitle name match via FTS5 (weight 0.15) — semantic alignment
 * 4. Recency (weight 0.20) — newer Specs are more likely to describe current code
 * 5. Line-range overlap (weight 0.10) — soft signal; code drifts over time
 *
 * All five dimensions contribute even when some are zero — a spec without line
 * overlap can still rank first if its content/name/recency scores are high.
 *
 * @param specDb       commit4spec.db connection
 * @param entity       Code entity info (from homegraph.db nodes)
 * @param topK         Maximum matches to return (default 10)
 * @returns Ranked, scored matches with score breakdowns
 */
export function findSpecsByCodeSymbol(
  specDb: SqliteDatabase,
  entity: CodeEntityInfo,
  topK: number = 10,
): FindSpecsByCodeSymbolResult {
  const pathEscaped = escapeLike(entity.filePath);
  const likePattern = `%${pathEscaped}%`;
  const suffixLikePattern = `%${pathEscaped}`; // cf.file_path ends with entity's path

  // -----------------------------------------------------------------------
  // 1. Gather candidates: all specs whose fragments touch the entity's file
  // -----------------------------------------------------------------------

  const candidateRows = specDb
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
      entityEnd: entity.endLine,
      entityStart: entity.startLine,
      exactFilePath: entity.filePath,
      suffixLikePattern,
      likePattern,
      maxCandidates: MAX_CANDIDATES,
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

  // -----------------------------------------------------------------------
  // 2. Content-match signal: search code_fragments_fts for the entity name
  // -----------------------------------------------------------------------
  const contentFragmentIds = new Set(
    searchCodeFragments(specDb, entity.name, 50),
  );

  // Map from spec_id → whether any of its fragments matched in content search
  const contentSpecIds = new Set<string>();
  if (contentFragmentIds.size > 0) {
    const fragsIn = [...contentFragmentIds].map(() => '?').join(',');
    const contentSpecRows = specDb
      .prepare(`
        SELECT DISTINCT scr.spec_id
        FROM commit_fragment_relations cfr
        JOIN spec_commit_relations scr ON scr.commit_hash = cfr.commit_hash
        WHERE cfr.fragment_id IN (${fragsIn})
      `)
      .all(...contentFragmentIds) as Array<{ spec_id: string }>;
    for (const r of contentSpecRows) {
      contentSpecIds.add(r.spec_id);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Name-match signal: search specs_fts for the entity name
  // -----------------------------------------------------------------------
  const nameResults = searchSpecs(specDb, entity.name, topK * 3);
  const nameScoreMap = new Map<string, number>();
  const nameMaxScore = Math.max(1, ...nameResults.map((r) => r._score ?? 0));
  for (const r of nameResults) {
    nameScoreMap.set(r.id, (r._score ?? 0) / nameMaxScore); // normalize to [0, 1]
  }

  // -----------------------------------------------------------------------
  // 4. Compute weighted score for each candidate
  // -----------------------------------------------------------------------
  const now = Date.now();
  const entityLength = Math.max(1, entity.endLine - entity.startLine + 1);

  const scored = candidateRows.map((row) => {
    // 4a. File-path score — derived from the best-matching fragment's file_path
    // (computed in SQL as file_path_match_level: 3=exact, 2=suffix, 1=LIKE)
    const filePathScore = row.file_path_match_level === 3 ? 1.0
      : row.file_path_match_level === 2 ? 0.8
      : 0.6;

    // 4b. Content score
    const contentScore = contentSpecIds.has(row.id) ? 1.0 : 0;

    // 4c. Name score
    const nameScore = nameScoreMap.get(row.id) ?? 0;

    // 4d. Recency score: MapSpec(timestamp, 0, maxTs)MapSpec => [0, 1]
    const daysSinceUpdate = (now - row.timestamp) / (1000 * 60 * 60 * 24);
    const recencyScore = 1 / (1 + Math.max(0, daysSinceUpdate) / 180);

    // 4e. Overlap score
    const overlapRatio = Math.min(1.0, row.overlap_lines / entityLength);
    const overlapScore = overlapRatio;

    const score =
      filePathScore * WEIGHTS.filePath +
      contentScore * WEIGHTS.content +
      nameScore * WEIGHTS.name +
      recencyScore * WEIGHTS.recency +
      overlapScore * WEIGHTS.overlap;

    return {
      spec: {
        id: row.id,
        title: row.title,
        status: row.status,
        version: row.version,
        filePath: row.file_path,
        timestamp: row.timestamp,
      },
      score,
      scoreDetail: {
        filePathScore,
        contentScore,
        nameScore,
        recencyScore,
        overlapScore,
      },
      fragmentCount: row.fragment_count,
      commitCount: row.commit_count,
    };
  });

  // -----------------------------------------------------------------------
  // 5. Sort and trim
  // -----------------------------------------------------------------------
  scored.sort((a, b) => b.score - a.score);

  return {
    entity,
    matches: scored.slice(0, topK),
    totalCandidates: candidateRows.length,
  };
}
