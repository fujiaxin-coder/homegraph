/**
 * CodeFragmentNode CRUD — persistence operations for ``code_fragment_nodes``.
 */

import * as crypto from 'crypto';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { CodeFragmentNode } from '../types';

// ---------------------------------------------------------------------------
// Row shape from SQLite
// ---------------------------------------------------------------------------

interface FragmentNodeRow {
  id: string;
  change_type: string;
  file_path: string;
  start_line: number;
  end_line: number;
  code_diff: string;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a 12-character hex identifier (first 12 chars of a UUID v4).
 * Matches the Python `uuid.uuid4().hex[:12]` convention from Commit4Spec.
 */
function makeId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToFragment(row: FragmentNodeRow): CodeFragmentNode {
  return {
    id: row.id,
    changeType: row.change_type as CodeFragmentNode['changeType'],
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    codeDiff: row.code_diff,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Insert a CodeFragmentNode, auto-generating an ID if the `id` field is empty.
 * Also writes to the code_fragments_fts index for content-based search.
 */
export function insertCodeFragment(
  db: SqliteDatabase,
  node: CodeFragmentNode
): CodeFragmentNode {
  const fragment = { ...node };
  if (!fragment.id) {
    fragment.id = makeId();
  }

  db.prepare(`
    INSERT OR REPLACE INTO code_fragment_nodes
      (id, change_type, file_path, start_line, end_line, code_diff)
    VALUES (@id, @changeType, @filePath, @startLine, @endLine, @codeDiff)
  `).run({
    id: fragment.id,
    changeType: fragment.changeType,
    filePath: fragment.filePath,
    startLine: fragment.startLine,
    endLine: fragment.endLine,
    codeDiff: fragment.codeDiff,
  });

  // Sync to FTS5 index for content-based search.
  // DELETE + INSERT (not INSERT OR REPLACE) because code_fragments_fts is a
  // standalone FTS5 table without UNIQUE constraints — INSERT OR REPLACE has
  // no conflict to trigger on and would accumulate stale index entries.
  db.prepare('DELETE FROM code_fragments_fts WHERE id = ?').run(fragment.id);
  db.prepare('INSERT INTO code_fragments_fts (id, file_path, code_diff) VALUES (?, ?, ?)')
    .run(fragment.id, fragment.filePath, fragment.codeDiff);

  return fragment;
}

/**
 * Look up a CodeFragmentNode by primary key.
 * Returns null when not found.
 */
export function findFragmentById(
  db: SqliteDatabase,
  fragmentId: string
): CodeFragmentNode | null {
  const row = db.prepare(
    'SELECT id, change_type, file_path, start_line, end_line, code_diff FROM code_fragment_nodes WHERE id = ?'
  ).get(fragmentId) as FragmentNodeRow | undefined;

  return row ? rowToFragment(row) : null;
}

/**
 * Find all fragments for a given commit hash, via the join table.
 */
export function findFragmentsByCommit(
  db: SqliteDatabase,
  commitHash: string
): CodeFragmentNode[] {
  const rows = db.prepare(`
    SELECT f.id, f.change_type, f.file_path, f.start_line, f.end_line, f.code_diff
    FROM code_fragment_nodes f
    JOIN commit_fragment_relations r ON r.fragment_id = f.id
    WHERE r.commit_hash = ?
    ORDER BY f.file_path, f.start_line
  `).all(commitHash) as FragmentNodeRow[];

  return rows.map(rowToFragment);
}

/**
 * Count total fragments.
 */
export function countFragments(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM code_fragment_nodes').get() as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}
