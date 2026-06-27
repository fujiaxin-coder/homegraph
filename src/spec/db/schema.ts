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
export const CURRENT_SPEC_SCHEMA_VERSION = 1;

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
 * Run pending migrations (stub — none yet, version 1 is the initial schema).
 */
export function runSpecMigrations(_db: SqliteDatabase, _fromVersion: number): void {
  // No migrations beyond version 1 yet.
}
