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
import { searchSpecs } from '../db/fts';

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
