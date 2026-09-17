/**
 * SQLite backend: node:sqlite → wasm.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildWasmFallbackBanner,
  WASM_FALLBACK_FIX_RECIPE,
  createDatabase,
  isNodeSqliteAvailable,
  isNodeSqliteFts5Available,
} from '../src/db/sqlite-adapter';
import { DatabaseConnection } from '../src/db';
import { HomeGraph } from '../src';
import { removeTempDir } from './helpers/fs';

describe('buildWasmFallbackBanner — fix-recipe content', () => {
  it('includes Node 22.5+ recovery path', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).toContain('WASM SQLite fallback active');
    expect(banner).toContain('Node.js 22.5');
    expect(banner).toContain('homegraph status');
    expect(banner).not.toContain('better-sqlite3');
  });

  it('appends prior load errors when provided', () => {
    const banner = buildWasmFallbackBanner('node:sqlite is not available');
    expect(banner).toContain('Prior load errors: node:sqlite is not available');
  });

  it('omits the load-error block when none is supplied', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).not.toContain('Prior load errors:');
  });
});

describe('WASM_FALLBACK_FIX_RECIPE', () => {
  it('mentions Node upgrade only', () => {
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('22.5');
    expect(WASM_FALLBACK_FIX_RECIPE).not.toContain('better-sqlite3');
  });
});

describe('DatabaseConnection — backend reporting', () => {
  let dir: string;
  const prevBackend = process.env.HOMEGRAPH_SQLITE_BACKEND;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-backend-'));
    delete process.env.HOMEGRAPH_SQLITE_BACKEND;
  });

  afterEach(() => {
    if (prevBackend === undefined) delete process.env.HOMEGRAPH_SQLITE_BACKEND;
    else process.env.HOMEGRAPH_SQLITE_BACKEND = prevBackend;
    removeTempDir(dir);
  });

  it('reports a known backend for an initialized DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(['node-sqlite', 'wasm']).toContain(conn.getBackend());
    if (conn.getBackend() === 'node-sqlite') {
      expect(conn.getJournalMode()).toBe('wal');
    }
    conn.close();
  });

  it('prefers node:sqlite when available with FTS5', () => {
    if (!isNodeSqliteFts5Available()) return;
    const conn = DatabaseConnection.initialize(path.join(dir, 'pref-node.db'));
    expect(conn.getBackend()).toBe('node-sqlite');
    conn.close();
  });

  it('falls through to wasm when node:sqlite lacks FTS5', () => {
    if (!isNodeSqliteAvailable() || isNodeSqliteFts5Available()) return;
    const conn = DatabaseConnection.initialize(path.join(dir, 'no-fts5.db'));
    expect(conn.getBackend()).toBe('wasm');
    conn.close();
  });

  it('selected auto backend can create FTS5 virtual tables', () => {
    const { db, backend } = createDatabase(path.join(dir, 'fts-probe.db'));
    expect(['node-sqlite', 'wasm']).toContain(backend);
    expect(() => db.exec('CREATE VIRTUAL TABLE t USING fts5(content)')).not.toThrow();
    db.close();
  });

  it('ignores legacy HOMEGRAPH_SQLITE_BACKEND=native', () => {
    process.env.HOMEGRAPH_SQLITE_BACKEND = 'native';
    const conn = DatabaseConnection.initialize(path.join(dir, 'legacy-native.db'));
    expect(['node-sqlite', 'wasm']).toContain(conn.getBackend());
    expect(conn.getBackend()).not.toBe('native' as never);
    conn.close();
  });

  it('can force wasm via HOMEGRAPH_SQLITE_BACKEND', () => {
    process.env.HOMEGRAPH_SQLITE_BACKEND = 'wasm';
    const conn = DatabaseConnection.initialize(path.join(dir, 'force-wasm.db'));
    expect(conn.getBackend()).toBe('wasm');
    conn.close();
  });

  it('HomeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await HomeGraph.init(dir, { index: true });
    try {
      expect(['node-sqlite', 'wasm']).toContain(cg.getBackend());
    } finally {
      cg.destroy();
    }
  });
});
