/**
 * SpecNode CRUD — persistence operations for ``spec_nodes``.
 *
 * Every insert also updates the standalone FTS5 index with CJK-segmented
 * text (see `fts.ts` for the segmentation logic).
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { SpecNode } from '../types';
import { segmentCjk } from './fts';

// ---------------------------------------------------------------------------
// Row shape from SQLite
// ---------------------------------------------------------------------------

interface SpecNodeRow {
  id: string;
  title: string;
  subtitles: string;        // JSON array
  status: string;
  version: number;
  file_path: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-encoded subtitles array, returning [] on any failure.
 * Shared by every query that reads `spec_nodes.subtitles`.
 */
export function parseSubtitlesJson(raw: string): string[] {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function rowToSpec(row: SpecNodeRow): SpecNode {
  return {
    id: row.id,
    title: row.title,
    subtitles: parseSubtitlesJson(row.subtitles),
    status: row.status as SpecNode['status'],
    version: row.version,
    filePath: row.file_path,
    timestamp: row.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Insert or replace a SpecNode. Also updates the standalone FTS5 index
 * with CJK-segmented text.
 */
export function insertSpecNode(db: SqliteDatabase, node: SpecNode): SpecNode {
  const subtitlesJson = JSON.stringify(node.subtitles);

  db.prepare(`
    INSERT OR REPLACE INTO spec_nodes
      (id, title, subtitles, status, version, file_path, timestamp)
    VALUES (@id, @title, @subtitles, @status, @version, @filePath, @timestamp)
  `).run({
    id: node.id,
    title: node.title,
    subtitles: subtitlesJson,
    status: node.status,
    version: node.version,
    filePath: node.filePath,
    timestamp: node.timestamp,
  });

  // Update FTS5 index with CJK-segmented text
  const segmentedTitle = segmentCjk(node.title);
  const segmentedSubtitles = segmentCjk(subtitlesJson);

  db.prepare('DELETE FROM specs_fts WHERE id = ?').run(node.id);
  db.prepare(
    'INSERT INTO specs_fts(id, title, subtitles) VALUES (?, ?, ?)'
  ).run(node.id, segmentedTitle, segmentedSubtitles);

  return node;
}

/**
 * Look up a SpecNode by primary key. Returns null when not found.
 */
export function findSpecById(db: SqliteDatabase, specId: string): SpecNode | null {
  const row = db.prepare(
    'SELECT id, title, subtitles, status, version, file_path, timestamp FROM spec_nodes WHERE id = ?'
  ).get(specId) as SpecNodeRow | undefined;

  return row ? rowToSpec(row) : null;
}

/**
 * Update the status of a Spec (e.g. mark as deprecated).
 */
export function updateSpecStatus(db: SqliteDatabase, specId: string, status: SpecNode['status']): void {
  db.prepare('UPDATE spec_nodes SET status = ? WHERE id = ?').run(status, specId);
}

/**
 * Update the version field of a Spec.
 */
export function updateSpecVersion(db: SqliteDatabase, specId: string, version: number): void {
  db.prepare('UPDATE spec_nodes SET version = ? WHERE id = ?').run(version, specId);
}

/**
 * Delete a Spec and its FTS5 entry.
 */
export function deleteSpec(db: SqliteDatabase, specId: string): void {
  db.prepare('DELETE FROM spec_nodes WHERE id = ?').run(specId);
  db.prepare('DELETE FROM specs_fts WHERE id = ?').run(specId);
}

/**
 * List every spec, ordered by id.
 */
export function listAllSpecs(db: SqliteDatabase): SpecNode[] {
  const rows = db.prepare(
    'SELECT id, title, subtitles, status, version, file_path, timestamp FROM spec_nodes ORDER BY id'
  ).all() as SpecNodeRow[];
  return rows.map(rowToSpec);
}

/**
 * Count specs by status.
 */
export function countSpecsByStatus(db: SqliteDatabase): { active: number; deprecated: number } {
  const rows = db.prepare(
    'SELECT status, COUNT(*) as cnt FROM spec_nodes GROUP BY status'
  ).all() as Array<{ status: string; cnt: number }>;

  const counts = { active: 0, deprecated: 0 };
  for (const row of rows) {
    if (row.status === 'active') counts.active = row.cnt;
    else if (row.status === 'deprecated') counts.deprecated = row.cnt;
  }
  return counts;
}
