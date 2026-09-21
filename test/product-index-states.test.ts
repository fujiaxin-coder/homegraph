/**
 * Product index states + cold-start (Spec 0032), five-state status footer (Spec 0035),
 * and MCP project-root path hint (Spec 0038).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HomeGraph } from '../src';
import { getHomeGraphDir } from '../src/directory';
import { ToolHandler } from '../src/mcp/tools';
import {
  PRODUCT_STATUS_GLOSSARY,
  PROJECT_ROOT_HINT_MARKER,
  formatProductStatusLine,
  formatProjectRootPathHint,
  productIndexGuidance,
  resolveProductIndexState,
  isSqliteBusyMessage,
  textAlreadyHasProductStatus,
  textAlreadyHasProjectRootHint,
} from '../src/mcp/index-availability';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';

async function holdLockWithChild(lockPath: string): Promise<{ pid: number; kill: () => void }> {
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(lockPath)}, String(process.pid)); setInterval(()=>{}, 1000)`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  await new Promise((r) => setTimeout(r, 250));
  if (!holder.pid) throw new Error('lock holder failed to start');
  return {
    pid: holder.pid,
    kill: () => {
      try { process.kill(holder.pid!); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    },
  };
}

describe('product index states (Spec 0032 / 0035)', () => {
  let tempDir: string;
  let cg: HomeGraph | null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0035-'));
    cg = null;
  });

  afterEach(() => {
    cg?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps building_fast/none → empty, fast/indexing → fast, full → full', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    expect(cg.getBuildPhase()).toBe('none');
    expect(resolveProductIndexState(cg)).toBe('empty');

    cg.setBuildPhase('building_fast');
    expect(resolveProductIndexState(cg)).toBe('empty');

    cg.setBuildPhase('fast');
    expect(resolveProductIndexState(cg)).toBe('fast');

    cg.setBuildPhase('indexing');
    expect(resolveProductIndexState(cg)).toBe('fast');

    cg.setBuildPhase('full');
    expect(resolveProductIndexState(cg)).toBe('full');
  });

  it('full + pending files → dirty; write lock still → syncing', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('full');
    vi.spyOn(cg, 'getPendingFiles').mockReturnValue([
      { path: 'entry/src/main/ets/Index.ets', firstSeenMs: Date.now(), lastSeenMs: Date.now(), indexing: false },
    ]);
    expect(resolveProductIndexState(cg)).toBe('dirty');

    const lockPath = path.join(getHomeGraphDir(tempDir), 'homegraph.lock');
    const holder = await holdLockWithChild(lockPath);
    try {
      expect(cg.isWriteLockedByOther()).toBe(true);
      expect(resolveProductIndexState(cg)).toBe('syncing');
    } finally {
      holder.kill();
    }
  });

  it('deep tools return short status=empty / fast / syncing guidance', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('building_fast');
    const handler = new ToolHandler(cg);

    const empty = await handler.execute('homegraph_explore', { query: 'Foo' });
    expect(empty.isError).toBeFalsy();
    expect((empty.content[0] as { text: string }).text).toBe(productIndexGuidance('empty'));

    cg.setBuildPhase('fast');
    const fast = await handler.execute('homegraph_explore', { query: 'Foo' });
    expect(fast.isError).toBeFalsy();
    expect((fast.content[0] as { text: string }).text).toBe(productIndexGuidance('fast'));
    expect((fast.content[0] as { text: string }).text).toContain('homegraph_project');

    cg.setBuildPhase('full');
    const lockPath = path.join(getHomeGraphDir(tempDir), 'homegraph.lock');
    const holder = await holdLockWithChild(lockPath);
    try {
      const syncing = await handler.execute('homegraph_explore', { query: 'Foo' });
      expect(syncing.isError).toBeFalsy();
      expect((syncing.content[0] as { text: string }).text).toBe(productIndexGuidance('syncing'));
    } finally {
      holder.kill();
    }
  });

  it('homegraph_project returns empty guidance while building_fast', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('building_fast');
    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_project', {});
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toContain('status=empty');
  });

  it('homegraph_project map ends with status=fast footer (no long prose)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"demo"}\n');

    cg = await HomeGraph.init(tempDir, { index: false });
    cg.buildProjectMap();
    cg.setBuildPhase('fast');
    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_project', {});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Project map');
    expect(text).toMatch(/HomeGraph status=fast — map only/);
    expect(text).not.toMatch(/Full symbol index still building/);
    // Spec 0038: absolute root preamble when reply goes through status decoration
    expect(text.startsWith(PROJECT_ROOT_HINT_MARKER)).toBe(true);
    expect(text).toContain(path.resolve(tempDir));
  });

  it('successful tool body keeps content and appends status=full footer', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;\n');
    cg = await HomeGraph.init(tempDir, { index: false });
    await cg.indexAll();
    cg.setBuildPhase('full');
    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_search', { query: 'a' });
    const text = (res.content[0] as { text: string }).text;
    expect(text.startsWith(PROJECT_ROOT_HINT_MARKER)).toBe(true);
    expect(text).toContain(path.resolve(tempDir));
    expect(text).toMatch(/Pass them to Read\/Grep as-is/);
    expect(text).toMatch(/HomeGraph status=full — complete and up to date\.\s*$/);
    // Idempotent: marker appears once
    expect(text.split(PROJECT_ROOT_HINT_MARKER).length - 1).toBe(1);
  });

  it('dirty footer lists pending paths without long ⚠️ banner', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;\n');
    cg = await HomeGraph.init(tempDir, { index: false });
    await cg.indexAll();
    cg.setBuildPhase('full');
    vi.spyOn(cg, 'getPendingFiles').mockReturnValue([
      { path: 'src/a.ts', firstSeenMs: Date.now(), lastSeenMs: Date.now(), indexing: false },
    ]);
    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_search', { query: 'a' });
    const text = (res.content[0] as { text: string }).text;
    expect(text.startsWith(PROJECT_ROOT_HINT_MARKER)).toBe(true);
    expect(text).toContain('HomeGraph status=dirty — outdated: src/a.ts');
    expect(text).not.toContain('⚠️ Some files referenced');
  });

  it('isSqliteBusyMessage matches lock contention errors', () => {
    expect(isSqliteBusyMessage('SQLITE_BUSY: database is locked')).toBe(true);
    expect(isSqliteBusyMessage('database is locked')).toBe(true);
    expect(isSqliteBusyMessage('no such table')).toBe(false);
  });

  it('productIndexGuidance / formatProductStatusLine stay one line', () => {
    for (const s of ['empty', 'fast', 'syncing'] as const) {
      const g = productIndexGuidance(s);
      expect(g).toContain(`status=${s}`);
      expect(g.includes('\n')).toBe(false);
    }
    expect(formatProductStatusLine('full')).toBe(
      'HomeGraph status=full — complete and up to date.'
    );
    expect(formatProductStatusLine('dirty', { pendingPaths: ['a.ts', 'b.ts'] })).toBe(
      'HomeGraph status=dirty — outdated: a.ts, b.ts'
    );
    expect(
      formatProductStatusLine('dirty', {
        pendingPaths: ['1.ts', '2.ts', '3.ts', '4.ts', '5.ts', '6.ts'],
      })
    ).toContain('…+1');
  });

  it('glossary is short and embedded in server instructions', () => {
    expect(PRODUCT_STATUS_GLOSSARY.length).toBeLessThan(200);
    expect(SERVER_INSTRUCTIONS).toContain(PRODUCT_STATUS_GLOSSARY);
    expect(textAlreadyHasProductStatus('HomeGraph status=full — ok')).toBe(true);
    expect(textAlreadyHasProductStatus('no status here')).toBe(false);
  });

  it('formatProjectRootPathHint is short, includes abs root and join rules (Spec 0038)', () => {
    const root =
      process.platform === 'win32' ? 'D:\\code\\demo' : '/tmp/demo';
    const hint = formatProjectRootPathHint(root);
    expect(hint.startsWith(PROJECT_ROOT_HINT_MARKER)).toBe(true);
    expect(hint).toContain(root);
    expect(hint).toMatch(/Read\/Grep as-is/);
    expect(hint).toMatch(/<root>\/<relative>/);
    expect(hint).toMatch(/experiment\/result/);
    expect(hint.split('\n').length).toBeLessThanOrEqual(3);
    expect(textAlreadyHasProjectRootHint(hint)).toBe(true);
    expect(textAlreadyHasProjectRootHint('no root here')).toBe(false);
  });

  it('server-instructions mention project root join base (Spec 0038)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('HomeGraph project root:');
    expect(SERVER_INSTRUCTIONS).toMatch(/<root>\/<relative>/);
  });
});

describe('cold-start init lock (Spec 0032)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0035-init-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('init sets an empty db and second init throws already-initialized', async () => {
    const a = await HomeGraph.init(tempDir, { index: false });
    a.setBuildPhase('building_fast');
    expect(a.getBuildPhase()).toBe('building_fast');
    a.close();

    await expect(HomeGraph.init(tempDir, { index: false })).rejects.toThrow(/already initialized/i);
    const b = await HomeGraph.open(tempDir);
    expect(b.getBuildPhase()).toBe('building_fast');
    b.close();
  });

  it('concurrent init: one wins, loser path can open', async () => {
    const results = await Promise.allSettled([
      HomeGraph.init(tempDir, { index: false }),
      HomeGraph.init(tempDir, { index: false }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<HomeGraph>[];
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length + rejected.length).toBe(2);
    for (const r of fulfilled) r.value.close();

    const opened = await HomeGraph.open(tempDir);
    expect(opened.getStats().nodeCount).toBe(0);
    opened.close();
  });
});
