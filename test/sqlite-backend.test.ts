/**
 * SQLite backend: node:sqlite → better-sqlite3 → wasm.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildWasmFallbackBanner,
  WASM_FALLBACK_FIX_RECIPE,
  isNativeSqliteAvailable,
  isNodeSqliteAvailable,
} from '../src/db/sqlite-adapter';
import { DatabaseConnection } from '../src/db';
import { HomeGraph } from '../src';
import { removeTempDir } from './helpers/fs';

describe('buildWasmFallbackBanner — fix-recipe content', () => {
  it('includes Node 22.5+ and better-sqlite3 recovery paths', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).toContain('WASM SQLite fallback active');
    expect(banner).toContain('Node.js 22.5');
    expect(banner).toContain('xcode-select --install');
    expect(banner).toContain('apt install build-essential');
    expect(banner).toContain('npm rebuild better-sqlite3');
    expect(banner).toContain('homegraph status');
  });

  it('appends prior load errors when provided', () => {
    const banner = buildWasmFallbackBanner("Cannot find module 'better-sqlite3'");
    expect(banner).toContain("Prior load errors: Cannot find module 'better-sqlite3'");
  });

  it('omits the load-error block when none is supplied', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).not.toContain('Prior load errors:');
  });
});

describe('WASM_FALLBACK_FIX_RECIPE', () => {
  it('mentions Node upgrade and better-sqlite3 rebuild', () => {
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('22.5');
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('npm rebuild better-sqlite3');
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
    expect(['node-sqlite', 'native', 'wasm']).toContain(conn.getBackend());
    if (conn.getBackend() === 'node-sqlite' || conn.getBackend() === 'native') {
      expect(conn.getJournalMode()).toBe('wal');
    }
    conn.close();
  });

  it('prefers node:sqlite when available', () => {
    if (!isNodeSqliteAvailable()) return;
    const conn = DatabaseConnection.initialize(path.join(dir, 'pref-node.db'));
    expect(conn.getBackend()).toBe('node-sqlite');
    conn.close();
  });

  it('prefers better-sqlite3 when forced and the native binding is available', () => {
    if (!isNativeSqliteAvailable()) return;
    process.env.HOMEGRAPH_SQLITE_BACKEND = 'native';
    const conn = DatabaseConnection.initialize(path.join(dir, 'pref-native.db'));
    expect(conn.getBackend()).toBe('native');
    conn.close();
  });

  it('HomeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await HomeGraph.init(dir, { index: true });
    try {
      expect(['node-sqlite', 'native', 'wasm']).toContain(cg.getBackend());
    } finally {
      cg.destroy();
    }
  });
});
