/**
 * Spec Schema — DDL Initialisation
 *
 * Reads `schema.sql` and executes all statements idempotently
 * (`CREATE IF NOT EXISTS`). Follows the same pattern as HomeGraph's
 * `DatabaseConnection.initialize()` in `src/db/index.ts`.
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The latest schema version this module knows about.
 * Bump this when adding migrations.
 */
export const CURRENT_SPEC_SCHEMA_VERSION = 2;

/**
 * Execute all DDL statements from `schema.sql`.
 *
 * Idempotent — can be called multiple times safely (every statement
 * uses `CREATE IF NOT EXISTS`).
 */
export function initSpecSchema(db: SqliteDatabase): void {
  db.pragma('foreign_keys = ON');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
}

/**
 * Get the current spec schema version from the database.
 * Returns 0 if the table doesn't exist yet.
 */
export function getCurrentSpecVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM spec_schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Run pending migrations.
 *
 * NOTE: migration DDL mirrors statements in `schema.sql` (fresh databases
 * get everything from the .sql file; migrations only patch pre-existing
 * databases). Keep the two in sync when adding future migrations.
 *
 * v1 → v2: Create code_fragments_fts virtual table and populate it
 * from existing code_fragment_nodes data.
 */
export function runSpecMigrations(db: SqliteDatabase, fromVersion: number): void {
  if (fromVersion < 2) {
    // Create the FTS5 virtual table — the IF NOT EXISTS in schema.sql
    // handles the case where DDL already ran, but we explicitly run it
    // here for databases that existed before this migration was added.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_fragments_fts USING fts5(
          id,
          file_path,
          code_diff
      );
    `);

    // Populate FTS from existing code_fragment_nodes data
    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM code_fragments_fts').get() as { cnt: number }
    ).cnt;
    if (count === 0) {
      const rows = db
        .prepare('SELECT id, file_path, code_diff FROM code_fragment_nodes')
        .all() as Array<{ id: string; file_path: string; code_diff: string }>;

      if (rows.length > 0) {
        const insert = db.prepare(
          'INSERT INTO code_fragments_fts (id, file_path, code_diff) VALUES (?, ?, ?)'
        );
        const insertMany = db.transaction((fragments: Array<{ id: string; file_path: string; code_diff: string }>) => {
          for (const f of fragments) {
            insert.run(f.id, f.file_path, f.code_diff);
          }
        });
        insertMany(rows);
      }
    }

    // Record migration
    db.prepare(
      "INSERT OR IGNORE INTO spec_schema_versions (version, applied_at, description) VALUES (2, strftime('%s', 'now') * 1000, 'Add code_fragments_fts for content-based fragment search')"
    ).run();
  }
}
