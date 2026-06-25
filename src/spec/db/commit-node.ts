/**
 * CommitNode CRUD — persistence operations for ``commit_nodes``.
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { CommitNode } from '../types';

// ---------------------------------------------------------------------------
// Row shape from SQLite
// ---------------------------------------------------------------------------

interface CommitNodeRow {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToCommit(row: CommitNodeRow): CommitNode {
  return {
    hash: row.hash,
    message: row.message,
    author: row.author,
    timestamp: row.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Insert or replace a CommitNode.
 */
export function insertCommitNode(db: SqliteDatabase, node: CommitNode): CommitNode {
  db.prepare(`
    INSERT OR REPLACE INTO commit_nodes
      (hash, message, author, timestamp)
    VALUES (@hash, @message, @author, @timestamp)
  `).run({
    hash: node.hash,
    message: node.message,
    author: node.author,
    timestamp: node.timestamp,
  });
  return node;
}

/**
 * Look up a CommitNode by its full commit hash (40-char hex).
 * Returns null when not found.
 */
export function findCommitByHash(db: SqliteDatabase, commitHash: string): CommitNode | null {
  const row = db.prepare(
    'SELECT hash, message, author, timestamp FROM commit_nodes WHERE hash = ?'
  ).get(commitHash) as CommitNodeRow | undefined;

  return row ? rowToCommit(row) : null;
}

/**
 * List all commits, most recent first.
 */
export function listAllCommits(db: SqliteDatabase): CommitNode[] {
  const rows = db.prepare(
    'SELECT hash, message, author, timestamp FROM commit_nodes ORDER BY timestamp DESC'
  ).all() as CommitNodeRow[];
  return rows.map(rowToCommit);
}

/**
 * Count total commits.
 */
export function countCommits(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM commit_nodes').get() as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}
