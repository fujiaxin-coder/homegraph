/**
 * Per-file freshness on MCP tool responses (issue #403 → Spec 0035).
 *
 * Pending edits used to prepend a long ⚠️ banner. Spec 0035 folds that into a
 * one-line `HomeGraph status=dirty — outdated: …` footer (body unchanged).
 * Whole-index watcher degradation (#876) still uses the degraded banner.
 *
 * **Event delivery uses a synthetic seam** (`__emitWatchEventForTests`): the
 * real native fs.watch delivery is non-deterministic under parallel vitest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { __emitWatchEventForTests, __setFsWatchForTests } from '../src/sync/watcher';

function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('MCP status=dirty footer (Spec 0035)', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-stale-banner-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha-only.ts'),
      'export function alphaOnly() { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'bravo-only.ts'),
      'export function bravoOnly() { return 2; }\n',
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'charlie-only.ts'),
      'export function charlieOnly() { return 3; }\n',
    );

    cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.setBuildPhase('full');
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    __setFsWatchForTests(null);
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const degradeWatcher = () => {
    __setFsWatchForTests(() => {
      const err = new Error('too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    });
    const started = cg.watch({ debounceMs: 1000 });
    expect(started).toBe(false);
    expect(cg.isWatcherDegraded()).toBe(true);
  };

  it('appends status=dirty with pending path (no long ⚠️ banner)', async () => {
    cg.watch({ debounceMs: 4000, inertForTests: true });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha-only.ts'),
      'export function alphaOnly() { return 99; }\n',
    );
    __emitWatchEventForTests(testDir, 'src/alpha-only.ts');
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/alpha-only.ts'));

    const res = await handler.execute('homegraph_search', { query: 'alphaOnly' });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;

    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).toMatch(/alphaOnly/);
    expect(text).toContain('HomeGraph status=dirty — outdated: src/alpha-only.ts');
  });

  it('lists unreferenced pending paths in the same dirty footer', async () => {
    cg.watch({ debounceMs: 4000, inertForTests: true });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'bravo-only.ts'),
      'export function bravoOnly() { return 22; }\n',
    );
    __emitWatchEventForTests(testDir, 'src/bravo-only.ts');
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/bravo-only.ts'));

    const res = await handler.execute('homegraph_search', { query: 'alphaOnly' });
    const text = res.content[0].text;

    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).not.toMatch(/elsewhere in this project are pending index sync/);
    expect(text).toContain('HomeGraph status=dirty — outdated: src/bravo-only.ts');
  });

  it('uses status=full once sync clears pending', async () => {
    cg.watch({ debounceMs: 200, inertForTests: true });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'alpha-only.ts'),
      'export function alphaOnly() { return 7; }\n',
    );
    __emitWatchEventForTests(testDir, 'src/alpha-only.ts');
    await waitFor(() => cg.getPendingFiles().length === 0, 3000);

    const res = await handler.execute('homegraph_search', { query: 'alphaOnly' });
    const text = res.content[0].text;
    expect(text.startsWith('⚠️')).toBe(false);
    expect(text).toMatch(/HomeGraph status=full — complete and up to date\.\s*$/);
  });

  it('lists pending files under "Pending sync" in homegraph_status', async () => {
    cg.watch({ debounceMs: 4000, inertForTests: true });
    await cg.waitUntilWatcherReady();

    fs.writeFileSync(
      path.join(testDir, 'src', 'charlie-only.ts'),
      'export function charlieOnly() { return 33; }\n',
    );
    __emitWatchEventForTests(testDir, 'src/charlie-only.ts');
    await waitFor(() => cg.getPendingFiles().some((p) => p.path === 'src/charlie-only.ts'));

    const res = await handler.execute('homegraph_status', {});
    const text = res.content[0].text;
    expect(text).toContain('**Pending sync:');
    expect(text).toContain('src/charlie-only.ts');
    expect(text.startsWith('⚠️')).toBe(false);
  });

  it('returns zero pending files when no watcher is active', () => {
    expect(cg.getPendingFiles()).toEqual([]);
  });

  it('prepends a whole-index degraded banner once live watching has permanently stopped (#876)', async () => {
    degradeWatcher();

    const res = await handler.execute('homegraph_search', { query: 'alphaOnly' });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;

    expect(text.startsWith('⚠️')).toBe(true);
    expect(text).toMatch(/auto-sync is DISABLED/i);
    expect(text).toMatch(/Read files directly/i);
    expect(text).toContain('OS watch/file limit exhausted');
    expect(text).toMatch(/alphaOnly/);
  });

  it('surfaces the degraded state as its own section in homegraph_status (#876)', async () => {
    degradeWatcher();

    const res = await handler.execute('homegraph_status', {});
    const text = res.content[0].text;
    expect(text).toContain('**Auto-sync disabled:');
    expect(text).toContain('OS watch/file limit exhausted');
    expect(text.startsWith('⚠️')).toBe(false);
  });
});
