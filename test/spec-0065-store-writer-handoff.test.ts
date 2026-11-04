/**
 * Spec 0065 — exclusive store-writer DB handoff + flush-failure guard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/db/queries';
import { throwIfStoreFlushFailed } from '../src/extraction/store-flush-guard';

describe('Spec 0065 store-writer exclusive handoff', () => {
  let dir: string;

  afterEach(() => {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closeForExclusiveWriter lets a second connection write; reopen reads it back', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0065-handoff-'));
    const dbPath = path.join(dir, 'test.db');
    const main = DatabaseConnection.initialize(dbPath);
    try {
      main.getDb().pragma('journal_mode = MEMORY');
      main.getDb().pragma('synchronous = OFF');
      main.getDb().exec(
        `CREATE TABLE IF NOT EXISTS handoff_probe (id INTEGER PRIMARY KEY, v TEXT);
         INSERT INTO handoff_probe (v) VALUES ('from-main');`
      );

      main.closeForExclusiveWriter();
      expect(main.isOpen()).toBe(false);

      // Mimic store-worker: exclusive second connection while main is closed.
      const { db: workerDb } = createDatabase(dbPath);
      try {
        workerDb.pragma('busy_timeout = 5000');
        workerDb.pragma('journal_mode = MEMORY');
        workerDb.pragma('synchronous = OFF');
        workerDb.exec(`INSERT INTO handoff_probe (v) VALUES ('from-worker');`);
      } finally {
        workerDb.close();
      }

      main.reopenAfterExclusiveWriter({ fastInit: true });
      expect(main.isOpen()).toBe(true);
      const rows = main
        .getDb()
        .prepare('SELECT v FROM handoff_probe ORDER BY id')
        .all() as Array<{ v: string }>;
      expect(rows.map((r) => r.v)).toEqual(['from-main', 'from-worker']);
    } finally {
      if (main.isOpen()) main.close();
    }
  });

  it('reopenAfterExclusiveWriter rebind keeps QueryBuilder usable', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0065-rebind-'));
    const dbPath = path.join(dir, 'test.db');
    const main = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(main.getDb());
    try {
      main.closeForExclusiveWriter();
      const { db: workerDb } = createDatabase(dbPath);
      try {
        workerDb.pragma('busy_timeout = 1000');
        // Touch the file so reopen has a live DB.
        workerDb.exec('SELECT 1');
      } finally {
        workerDb.close();
      }
      main.reopenAfterExclusiveWriter({ fastInit: true });
      queries.rebind(main.getDb());
      expect(queries.getNodeAndEdgeCount().nodes).toBe(0);
    } finally {
      if (main.isOpen()) main.close();
    }
  });

  it('reopen without prior release throws', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0065-bad-reopen-'));
    const dbPath = path.join(dir, 'test.db');
    const main = DatabaseConnection.initialize(dbPath);
    try {
      expect(() => main.reopenAfterExclusiveWriter({ fastInit: false })).toThrow(
        /was not released/
      );
    } finally {
      main.close();
    }
  });

  it('throwIfStoreFlushFailed surfaces flushError (no busy-spin)', () => {
    const err = new Error('store worker: SQLITE_BUSY: database is locked');
    expect(() => throwIfStoreFlushFailed(false, err)).toThrow(/SQLITE_BUSY/);
    expect(() => throwIfStoreFlushFailed(true, null)).toThrow(/Aborted/);
    expect(() => throwIfStoreFlushFailed(false, null)).not.toThrow();
  });
});
