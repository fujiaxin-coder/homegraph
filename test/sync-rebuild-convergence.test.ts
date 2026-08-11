/**
 * Incremental sync must converge to a full rebuild (definitionDelta / rebind).
 *
 * When a file gains or loses a symbol, resolution may pick a different winner
 * for references in UNCHANGED files. Sync must re-open those edges so the
 * orphan sweep rebinds them — otherwise a long-lived auto-synced index drifts
 * from a clean rebuild.
 *
 * Kill switch: HOMEGRAPH_NO_REBIND=1 must make the add-competing-definition
 * case diverge (that is the suite's own regression check for the rebind half).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { createDatabase } from '../src/db/sqlite-adapter';
import { removeTempDir } from './helpers/fs';

describe('Incremental sync converges to a full rebuild', () => {
  let testDir: string;
  let hg: HomeGraph;

  const write = (rel: string, content: string) => {
    const full = path.join(testDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const edgeSet = (): Set<string> => {
    const { db } = createDatabase(path.join(testDir, '.homegraph', 'homegraph.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT source, target, kind FROM edges').all() as Array<{
        source: string;
        target: string;
        kind: string;
      }>;
      return new Set(rows.map((r) => `${r.source}|${r.target}|${r.kind}`));
    } finally {
      db.close();
    }
  };

  const withDb = <T>(fn: (db: ReturnType<typeof createDatabase>['db']) => T): T => {
    const { db } = createDatabase(path.join(testDir, '.homegraph', 'homegraph.db'));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const describeDiff = (synced: Set<string>, rebuilt: Set<string>): string => {
    const missing = [...rebuilt].filter((e) => !synced.has(e));
    const stale = [...synced].filter((e) => !rebuilt.has(e));
    return `missing from synced: ${missing.length}, stale in synced: ${stale.length}`;
  };

  /** Must go through recreate — indexAll on a live handle is not a rebuild. */
  const rebuildEdgeSet = async (): Promise<Set<string>> => {
    hg.destroy();
    hg = await HomeGraph.recreate(testDir);
    await hg.indexAll();
    return edgeSet();
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-rebind-'));
  });

  afterEach(() => {
    hg?.destroy();
    if (fs.existsSync(testDir)) removeTempDir(testDir);
  });

  it('rebinds references in UNCHANGED files when a sync adds a competing definition', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    hg = HomeGraph.initSync(testDir);
    await hg.indexAll();

    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    const result = await hg.sync();
    expect(result.filesAdded).toBe(1);
    expect(result.definitionDelta).toContain('pct');

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  it('rebinds references in UNCHANGED files when a sync removes a competing definition', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/alpha.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    hg = HomeGraph.initSync(testDir);
    await hg.indexAll();

    fs.rmSync(path.join(testDir, 'src', 'alpha.ts'));
    const result = await hg.sync();
    expect(result.filesRemoved).toBe(1);

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  it('flags a name added in one changed file even when another changed file already defines it', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write(
      'src/zeta.ts',
      `export function pct(n: number): number {\n  return n;\n}\nexport function keep(): number {\n  return 0;\n}\n`
    );
    hg = HomeGraph.initSync(testDir);
    await hg.indexAll();

    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    write(
      'src/zeta.ts',
      `export function pct(n: number): number {\n  return n + 1;\n}\nexport function keep(): number {\n  return 0;\n}\n`
    );
    const result = await hg.sync();
    expect(result.definitionDelta).toContain('pct');

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  it('body-only edits produce no definitionDelta', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    hg = HomeGraph.initSync(testDir);
    await hg.indexAll();

    write('src/zeta.ts', `export function pct(n: number): number {\n  return n + 1;\n}\n`);
    const result = await hg.sync();
    expect(result.filesModified).toBe(1);
    expect(result.definitionDelta).toBeUndefined();
  });

  it('never deletes an edge it cannot reconstruct — no refName stamp, or synthesized', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/other.ts', `export function other(): number {\n  return 0;\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    hg = HomeGraph.initSync(testDir);
    await hg.indexAll();

    const planted = withDb((db) => {
      const pct = db.prepare("SELECT id FROM nodes WHERE name = 'pct'").get() as { id: string };
      const other = db.prepare("SELECT id FROM nodes WHERE name = 'other'").get() as { id: string };

      db.prepare(
        `UPDATE edges SET metadata = json_remove(metadata, '$.refName')
         WHERE target = ? AND kind = 'calls'`
      ).run(pct.id);

      db.prepare(
        `INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
         VALUES (?, ?, 'calls', ?, 1, 0, 'heuristic')`
      ).run(other.id, pct.id, JSON.stringify({ refName: 'pct', synthesizedBy: 'rebind-test' }));

      return {
        unstamped: `${(db.prepare("SELECT source FROM edges WHERE target = ? AND provenance IS NULL AND kind = 'calls'").get(pct.id) as { source: string }).source}|${pct.id}|calls`,
        synthesized: `${other.id}|${pct.id}|calls`,
      };
    });

    const before = edgeSet();
    expect(before.has(planted.unstamped)).toBe(true);
    expect(before.has(planted.synthesized)).toBe(true);

    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    const result = await hg.sync();
    expect(result.definitionDelta).toContain('pct');

    const after = edgeSet();
    expect(after.has(planted.unstamped)).toBe(true);
    expect(after.has(planted.synthesized)).toBe(true);
  });

  it('HOMEGRAPH_NO_REBIND=1 disables the pass without corrupting the index', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    hg = HomeGraph.initSync(testDir);
    await hg.indexAll();
    const before = edgeSet();

    process.env.HOMEGRAPH_NO_REBIND = '1';
    try {
      write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
      await hg.sync();
    } finally {
      delete process.env.HOMEGRAPH_NO_REBIND;
    }

    const after = edgeSet();
    for (const edge of before) expect(after.has(edge)).toBe(true);
  });

  it('getNodesByName orders by (file_path, start_line) even when rows were written in another order', async () => {
    write('src/mid.ts', `export function pad(): void {}\nexport function dup(): number {\n  return 2;\n}\n`);
    write('src/zeta.ts', `export function dup(): number {\n  return 1;\n}\n`);
    hg = HomeGraph.initSync(testDir);
    await hg.indexAll();

    write('src/alpha.ts', `export function dup(): number {\n  return 3;\n}\n`);
    await hg.sync();

    const keys = hg.getNodesByName('dup').map((n) => `${n.filePath}:${String(n.startLine).padStart(6, '0')}`);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toContain('src/alpha.ts');
  });
});
