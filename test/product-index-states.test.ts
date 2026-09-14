/**
 * Product index states + cold-start (Spec 0032).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HomeGraph } from '../src';
import { getHomeGraphDir } from '../src/directory';
import { ToolHandler } from '../src/mcp/tools';
import {
  productIndexGuidance,
  resolveProductIndexState,
  isSqliteBusyMessage,
} from '../src/mcp/index-availability';

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

describe('product index states (Spec 0032)', () => {
  let tempDir: string;
  let cg: HomeGraph | null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0031-'));
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

  it('full + foreign write lock → syncing', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('full');
    const lockPath = path.join(getHomeGraphDir(tempDir), 'homegraph.lock');
    const holder = await holdLockWithChild(lockPath);
    try {
      expect(cg.isWriteLockedByOther()).toBe(true);
      expect(resolveProductIndexState(cg)).toBe('syncing');
    } finally {
      holder.kill();
    }
  });

  it('deep tools return status=empty / fast / syncing guidance (success-shaped)', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('building_fast');
    const handler = new ToolHandler(cg);

    const empty = await handler.execute('homegraph_explore', { query: 'Foo' });
    expect(empty.isError).toBeFalsy();
    expect(empty.content[0]).toMatchObject({ type: 'text' });
    expect((empty.content[0] as { text: string }).text).toContain('status=empty');

    cg.setBuildPhase('fast');
    const fast = await handler.execute('homegraph_explore', { query: 'Foo' });
    expect(fast.isError).toBeFalsy();
    expect((fast.content[0] as { text: string }).text).toContain('status=fast');
    expect((fast.content[0] as { text: string }).text).toContain('homegraph_project');

    cg.setBuildPhase('full');
    const lockPath = path.join(getHomeGraphDir(tempDir), 'homegraph.lock');
    const holder = await holdLockWithChild(lockPath);
    try {
      const syncing = await handler.execute('homegraph_explore', { query: 'Foo' });
      expect(syncing.isError).toBeFalsy();
      expect((syncing.content[0] as { text: string }).text).toContain('status=syncing');
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

  it('isSqliteBusyMessage matches lock contention errors', () => {
    expect(isSqliteBusyMessage('SQLITE_BUSY: database is locked')).toBe(true);
    expect(isSqliteBusyMessage('database is locked')).toBe(true);
    expect(isSqliteBusyMessage('no such table')).toBe(false);
  });

  it('productIndexGuidance always names status=', () => {
    for (const s of ['empty', 'fast', 'syncing'] as const) {
      expect(productIndexGuidance(s)).toContain(`status=${s}`);
    }
  });
});

describe('cold-start init lock (Spec 0032)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0031-init-'));
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
