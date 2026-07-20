/**
 * Native better-sqlite3 backend — real index + queries (skipped when unavailable).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src';
import { isNativeSqliteAvailable } from '../src/db/sqlite-adapter';
import { removeTempDir } from './helpers/fs';

describe.skipIf(!isNativeSqliteAvailable())('native better-sqlite3 backend — real index + queries', () => {
  let dir: string;
  let cg: HomeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-sqlite-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function helper(): number { return 1; }\n');
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      "import { helper } from './a';\nexport function main(): number { return helper(); }\n"
    );
    cg = await HomeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg?.close();
    removeTempDir(dir);
  });

  it('uses the native backend', () => {
    expect(cg.getBackend()).toBe('native');
  });

  it('runs in WAL mode', () => {
    expect(cg.getJournalMode()).toBe('wal');
  });

  it('indexed the project', () => {
    const stats = cg.getStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.nodeCount).toBeGreaterThan(0);
  });

  it('FTS5 search returns the indexed symbol', () => {
    const results = cg.searchNodes('helper');
    expect(results.map(r => r.node.name)).toContain('helper');
  });

  it('graph traversal resolves the cross-file caller', () => {
    const helper = cg.searchNodes('helper').find(r => r.node.name === 'helper');
    expect(helper).toBeTruthy();
    expect(cg.getCallers(helper!.node.id).map(c => c.node.name)).toContain('main');
  });
});
