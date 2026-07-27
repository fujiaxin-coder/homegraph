/**
 * Graph traversal queries for the Spec→Commit→CodeFragment knowledge graph.
 *
 * Replaces `commit4spec/graph/queries.py`. Provides spec context retrieval,
 * stats, and search+traverse functionality.
 *
 * This is a pure COMPOSITION layer — following the HomeGraph convention of
 * `src/graph` (zero SQL outside the db layer), every function here is built
 * by composing the primitives in `../db`. Scoring, sorting, and result
 * assembly live here; data access does not.
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import {
  SpecNode,
  SpecContext,
  SpecCommitContext,
  SpecStats,
  RelationType,
} from '../types';
import { findSpecById, countSpecsByStatus } from '../db/spec-node';
import { countCommits } from '../db/commit-node';
import { countFragments, findFragmentsByCommit } from '../db/fragment-node';
import {
  findCommitsBySpec,
  countAllRelations,
  findSpecIdsByFragmentPath,
  findSpecCandidatesByFilePath,
  findSpecIdsByFragmentIds,
} from '../db/relations';
import { searchSpecs, searchCodeFragments } from '../db/fts';

// Re-export so existing consumers of the graph layer keep their imports.
export {
  findSpecsByFilePath,
  FindSpecsByFilePathResult,
} from '../db/relations';

// ===========================================================================
// getSpecContext
// ===========================================================================

/** Relation-type priority for commit ordering (lower = earlier). */
function relationPriority(relationType: RelationType): number {
  if (relationType === 'GENERATE') return 0;
  if (relationType === 'SUMMARIZED_FROM') return 1;
  return 2;
}

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
  const spec: SpecNode | null = findSpecById(db, specId);
  if (!spec) return null;

  const linked = findCommitsBySpec(db, specId);

  // Order by relation-type priority, then timestamp descending.
  const sorted = [...linked].sort((a, b) => {
    const pa = relationPriority(a.relationType);
    const pb = relationPriority(b.relationType);
    if (pa !== pb) return pa - pb;
    return b.timestamp - a.timestamp;
  });

  const commits: SpecCommitContext[] = sorted.slice(0, maxCommits).map((row) => ({
    commit: {
      hash: row.commitHash,
      message: row.message,
      author: row.author,
      timestamp: row.timestamp,
    },
    relationType: row.relationType,
    fragments: includeFragments ? findFragmentsByCommit(db, row.commitHash) : [],
  }));

  return { spec, commits };
}

// ===========================================================================
// findSpecsByFragmentPath
// ===========================================================================

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
  return findSpecIdsByFragmentPath(db, filePath);
}

// ===========================================================================
// getSpecStats
// ===========================================================================

/**
 * Compute statistics about the Spec knowledge graph.
 *
 * @param db  Active SQLite database handle.
 * @returns SpecStats with entity counts and relation totals.
 */
export function getSpecStats(db: SqliteDatabase): SpecStats {
  const { active, deprecated } = countSpecsByStatus(db);

  return {
    specCount: active + deprecated,
    commitCount: countCommits(db),
    fragmentCount: countFragments(db),
    relationCount: countAllRelations(db),
    activeSpecCount: active,
    deprecatedSpecCount: deprecated,
  };
}

// ===========================================================================
// searchAndGetContext
// ===========================================================================

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
  // -----------------------------------------------------------------------
  // 1. Gather candidates: all specs whose fragments touch the entity's file
  // -----------------------------------------------------------------------
  const candidateRows = findSpecCandidatesByFilePath(specDb, {
    filePath: entity.filePath,
    startLine: entity.startLine,
    endLine: entity.endLine,
    maxCandidates: MAX_CANDIDATES,
  });

  // -----------------------------------------------------------------------
  // 2. Content-match signal: search code_fragments_fts for the entity name
  // -----------------------------------------------------------------------
  const contentFragmentIds = searchCodeFragments(specDb, entity.name, 50);
  const contentSpecIds = new Set(findSpecIdsByFragmentIds(specDb, contentFragmentIds));

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
    // (computed in SQL as filePathMatchLevel: 3=exact, 2=suffix, 1=LIKE)
    const filePathScore = row.filePathMatchLevel === 3 ? 1.0
      : row.filePathMatchLevel === 2 ? 0.8
      : 0.6;

    // 4b. Content score
    const contentScore = contentSpecIds.has(row.id) ? 1.0 : 0;

    // 4c. Name score
    const nameScore = nameScoreMap.get(row.id) ?? 0;

    // 4d. Recency score — decays to 0.5 after ~180 days
    const daysSinceUpdate = (now - row.timestamp) / (1000 * 60 * 60 * 24);
    const recencyScore = 1 / (1 + Math.max(0, daysSinceUpdate) / 180);

    // 4e. Overlap score
    const overlapScore = Math.min(1.0, row.overlapLines / entityLength);

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
        filePath: row.filePath,
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
      fragmentCount: row.fragmentCount,
      commitCount: row.commitCount,
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
