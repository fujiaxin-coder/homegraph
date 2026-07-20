/**
 * SQLite backend: prefer better-sqlite3 (native); wasm when unavailable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildWasmFallbackBanner,
  WASM_FALLBACK_FIX_RECIPE,
  isNativeSqliteAvailable,
} from '../src/db/sqlite-adapter';
import { DatabaseConnection } from '../src/db';
import { HomeGraph } from '../src';
import { removeTempDir } from './helpers/fs';

describe('buildWasmFallbackBanner — fix-recipe content', () => {
  it('includes the macOS / Linux / cross-platform fix commands', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).toContain('WASM SQLite fallback active');
    expect(banner).toContain('better-sqlite3 unavailable');
    expect(banner).toContain('xcode-select --install');
    expect(banner).toContain('apt install build-essential');
    expect(banner).toContain('npm rebuild better-sqlite3');
    expect(banner).toContain('homegraph status');
  });

  it('appends the native load error when provided', () => {
    const banner = buildWasmFallbackBanner("Cannot find module 'better-sqlite3'");
    expect(banner).toContain("Native load error: Cannot find module 'better-sqlite3'");
  });

  it('omits the load-error block when none is supplied', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).not.toContain('Native load error:');
  });
});

describe('WASM_FALLBACK_FIX_RECIPE', () => {
  it('mentions the recovery commands', () => {
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('xcode-select --install');
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('npm rebuild better-sqlite3');
  });
});

describe('DatabaseConnection — backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-backend-'));
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it('reports native or wasm for an initialized DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(['native', 'wasm']).toContain(conn.getBackend());
    if (conn.getBackend() === 'native') {
      expect(conn.getJournalMode()).toBe('wal');
    }
    conn.close();
  });

  it('prefers better-sqlite3 when the native binding is available', () => {
    if (!isNativeSqliteAvailable()) return;
    const conn = DatabaseConnection.initialize(path.join(dir, 'pref.db'));
    expect(conn.getBackend()).toBe('native');
    conn.close();
  });

  it('HomeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await HomeGraph.init(dir, { index: true });
    try {
      expect(['native', 'wasm']).toContain(cg.getBackend());
    } finally {
      cg.destroy();
    }
  });
});
