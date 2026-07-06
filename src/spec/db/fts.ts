/**
 * FTS5 Full-Text Search for Specs — with CJK tokenisation,
 * weighted ranking, and multi-stage LIKE fallback.
 *
 * FTS5's ``unicode61`` tokeniser treats consecutive CJK characters as a
 * single token. To support single-character / phrase queries we insert
 * a space between each CJK codepoint before indexing *and* before
 * searching.
 *
 * Weighting strategy:
 *   Title matches are boosted over subtitle matches via post-scoring.
 *   Both FTS5 and LIKE stages use the same score semantics:
 *
 *     =====  ====================
 *     Score  Meaning
 *     =====  ====================
 *     3.0    exact title match
 *     2.5    title starts with query
 *     2.0    title contains query
 *     1.0    keyword match in subtitles only
 *     =====  ====================
 *
 *   FTS5 returns ``limit * 3`` candidates; they are re-ranked and the
 *   top *limit* are returned.
 *
 * Fallback strategy (3 stages):
 *   1. FTS5 weighted search (primary)
 *   2. LIKE tiered scoring (same score semantics as FTS5)
 *   3. If still no results, return most-recently-added specs as a
 *      "discovery" fallback.
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { SpecSearchResult } from '../types';

// ===========================================================================
// CJK Segmentation
// ===========================================================================

/** Regex matching a CJK Unified Ideograph (U+4E00–U+9FFF). */
const CJK_RANGE = /[\u4e00-\u9fff]+/g;

/**
 * Insert a space between adjacent CJK characters so FTS5's unicode61
 * tokeniser can index them individually.
 */
export function segmentCjk(text: string): string {
  return text.replace(CJK_RANGE, (m) => m.split('').join(' '));
}

/**
 * Escape / pre-process a user query for FTS5.
 *
 * 1. Segment CJK runs by inserting spaces.
 * 2. Quote each token so FTS5 treats it as a literal term.
 */
export function escapeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '""';

  const segmented = segmentCjk(trimmed);
  const tokens = segmented.split(/\s+/).filter(Boolean);
  // Escape embedded double-quotes: inside FTS5 quoted phrases, " is escaped as ""
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ') || '""';
}

// ===========================================================================
// Weighted Scoring
// ===========================================================================

/**
 * Compute a title-match boost factor.
 *
 *   3.0 — exact match
 *   2.5 — title starts with query
 *   2.0 — title contains query
 *   1.0 — no title match (subtitles only)
 */
function scoreTitleMatch(title: string, query: string): number {
  const q = query.toLowerCase().trim();
  const t = title.toLowerCase();
  if (q === t) return 3.0;
  if (t.startsWith(q)) return 2.5;
  if (t.includes(q)) return 2.0;
  return 1.0;
}

/**
 * LIKE tiered scoring.
 *
 * Returns ``[score, tierLabel]`` where higher score = more relevant.
 * Score semantics are aligned with ``scoreTitleMatch`` so cross-stage
 * re-ranking works correctly.
 */
function likeScore(title: string, query: string): [number, string] {
  const t = title.toLowerCase().trim();
  const q = query.toLowerCase().trim();
  if (t === q) return [3.0, 'exact_title'];
  if (t.startsWith(q)) return [2.5, 'starts_with_title'];
  if (t.includes(q)) return [2.0, 'contains_title'];
  return [1.0, 'contains_subtitle'];
}

// ===========================================================================
// Row shapes
// ===========================================================================

interface SpecFtsRow {
  id: string;
  title: string;
  subtitles: string;
}

// ===========================================================================
// Stage 1: FTS5 Weighted Search
// ===========================================================================

/**
 * Weighted FTS5 search with title boost.
 *
 * Fetches ``limit * oversample`` candidates from FTS5, re-ranks by
 * weighted score, and returns the top *limit*.
 */
function searchSpecsFts(
  db: SqliteDatabase,
  query: string,
  limit: number,
  oversample: number = 3
): SpecSearchResult[] {
  const escaped = escapeFtsQuery(query);
  const rawLimit = limit * oversample;

  let rows: SpecFtsRow[];
  try {
    rows = db
      .prepare(
        `SELECT s.id, s.title, s.subtitles
         FROM specs_fts f
         JOIN spec_nodes s ON s.id = f.id
         WHERE specs_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(escaped, rawLimit) as SpecFtsRow[];
  } catch {
    return [];
  }

  const scored: Array<{ score: number; result: SpecSearchResult }> = [];
  for (const row of rows) {
    let subtitles: string[];
    try {
      subtitles = JSON.parse(row.subtitles || '[]');
    } catch {
      subtitles = [];
    }

    const boost = scoreTitleMatch(row.title, query);
    scored.push({
      score: boost,
      result: {
        id: row.id,
        title: row.title,
        subtitles,
        _score: boost,
        _method: 'fts5',
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.result);
}

// ===========================================================================
// Stage 2: LIKE Tiered Fallback
// ===========================================================================

/**
 * LIKE fallback search with tiered scoring.
 *
 * Skips any spec whose id appears in *excludeIds* (to avoid
 * duplicating FTS5 results).
 */
function searchSpecsLike(
  db: SqliteDatabase,
  query: string,
  limit: number,
  excludeIds: Set<string>
): SpecSearchResult[] {
  // Escape LIKE metacharacters so '%' and '_' are treated as literals
  const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const likePat = `%${escaped}%`;

  const rows = db
    .prepare(
      `SELECT id, title, subtitles FROM spec_nodes
       WHERE title LIKE ? ESCAPE '\\' OR subtitles LIKE ? ESCAPE '\\'
       ORDER BY id LIMIT ?`
    )
    .all(likePat, likePat, limit * 3) as SpecFtsRow[];

  const scored: Array<{ score: number; tier: string; result: SpecSearchResult }> = [];
  for (const row of rows) {
    if (excludeIds.has(row.id)) continue;

    let subtitles: string[];
    try {
      subtitles = JSON.parse(row.subtitles || '[]');
    } catch {
      subtitles = [];
    }

    const [score, tier] = likeScore(row.title, query);
    scored.push({
      score,
      tier,
      result: {
        id: row.id,
        title: row.title,
        subtitles,
        _score: score,
        _method: 'like',
        _tier: tier as SpecSearchResult['_tier'],
      },
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.tier.localeCompare(b.tier);
  });
  return scored.slice(0, limit).map((s) => s.result);
}

// ===========================================================================
// Stage 3: Discovery Fallback
// ===========================================================================

/**
 * Return the most-recently-added specs when all searches produce
 * no results — so the caller always gets something.
 */
function discoveryFallback(db: SqliteDatabase, limit: number): SpecSearchResult[] {
  const rows = db
    .prepare(
      'SELECT id, title, subtitles FROM spec_nodes ORDER BY timestamp DESC LIMIT ?'
    )
    .all(limit) as SpecFtsRow[];

  return rows.map((row) => {
    let subtitles: string[];
    try {
      subtitles = JSON.parse(row.subtitles || '[]');
    } catch {
      subtitles = [];
    }
    return {
      id: row.id,
      title: row.title,
      subtitles,
      _score: 0.0,
      _method: 'discovery' as const,
    };
  });
}

// ===========================================================================
// Combined Search (public API)
// ===========================================================================

/**
 * Combined FTS5 + LIKE fallback search for specs.
 *
 * Strategy:
 *   1. FTS5 weighted search (title 3× boost).
 *   2. If fewer than *limit* results, backfill with LIKE tiered scoring.
 *   3. If still no results, return most-recently-added specs as a
 *      discovery fallback.
 *
 * Every result contains ``id, title, subtitles, _score`` and
 * optionally ``_method`` (``"fts5"`` | ``"like"`` | ``"all"`` | ``"discovery"``)
 * and ``_tier`` (for LIKE matches).
 */
export function searchSpecs(
  db: SqliteDatabase,
  query: string,
  limit: number = 10
): SpecSearchResult[] {
  // Empty query — return all specs (recent first)
  if (!query.trim()) {
    const rows = db
      .prepare('SELECT id, title, subtitles FROM spec_nodes ORDER BY id LIMIT ?')
      .all(limit) as SpecFtsRow[];

    return rows.map((row) => {
      let subtitles: string[];
      try {
        subtitles = JSON.parse(row.subtitles || '[]');
      } catch {
        subtitles = [];
      }
      return {
        id: row.id,
        title: row.title,
        subtitles,
        _score: 0.0,
        _method: 'all' as const,
      };
    });
  }

  // Stage 1: FTS5 weighted search
  const ftsResults = searchSpecsFts(db, query, limit);

  if (ftsResults.length >= limit) {
    return ftsResults;
  }

  // Stage 2: LIKE fallback
  const seenIds = new Set(ftsResults.map((r) => r.id));
  const needed = limit - ftsResults.length;
  const likeResults = searchSpecsLike(db, query, needed, seenIds);

  // Cross-stage re-sort: LIKE and FTS5 share the same score semantics
  const combined = [...ftsResults, ...likeResults];
  combined.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

  // Stage 3: discovery fallback — no matches at all
  if (combined.length === 0) {
    return discoveryFallback(db, limit);
  }

  return combined.slice(0, limit);
}

// ===========================================================================
// Code Fragment FTS5 Search
// ===========================================================================

/**
 * Search code fragment diffs by entity name or keyword.
 *
 * Uses FTS5 on the ``code_fragments_fts`` virtual table to find fragments
 * whose ``code_diff`` text matches the query. This is used to bridge
 * code-entity names (e.g. ``validatePassword``) to Specs when the entity
 * name does not appear in the Spec's title/subtitles.
 *
 * @param db     Active SQLite database handle.
 * @param query  Entity name or keyword to search for in code diffs.
 * @param limit  Maximum number of fragment IDs to return (default 50).
 * @returns Array of matching fragment IDs, ordered by FTS5 rank.
 */
export function searchCodeFragments(
  db: SqliteDatabase,
  query: string,
  limit: number = 50
): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Escape FTS5 special characters and quote each token for literal matching
  const escaped = escapeFtsQuery(trimmed);

  let rows: Array<{ id: string }>;
  try {
    rows = db
      .prepare(
        `SELECT id FROM code_fragments_fts
         WHERE code_fragments_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(escaped, limit) as Array<{ id: string }>;
  } catch {
    return [];
  }

  return rows.map((r) => r.id);
}
