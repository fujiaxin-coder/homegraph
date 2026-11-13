/**
 * Spec 0069 — tool-deadline leak paths.
 *
 * Background: the MCP tool deadline (`CODEGRAPH_QUERY_BUSY_TIMEOUT_MS`,
 * default 15s, clamp [1s, 45s]) is enforced with a `setTimeout` +
 * `Promise.race`. Timers cannot fire while the event loop is blocked by
 * synchronous work, so three pre-race / on-loop paths could outrun the
 * deadline and surface as ~60s+ tool calls (client hard timeout):
 *
 *   1. `homegraph_project`'s on-demand map build ran inline — a synchronous
 *      full-repo scan on the transport thread (minutes on 100k-file monorepos).
 *   2. The explore/search pre-dispatch fast-path block (inventory / mechanism /
 *      compact-local surveys) ran real DB/IO work on the main thread BEFORE the
 *      deadline race started.
 *   3. Stale documentation claimed the default soft timeout was 20s/30s-clamped.
 *
 * These tests pin the fixes: background map build + immediate syncing
 * guidance, fast-path skip when the query pool is warm, and the 15s default.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HomeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { productIndexGuidance } from '../src/mcp/index-availability';
import {
  resolveBusyTimeoutMs,
  resolveToolDeadlineMs,
  DEFAULT_BUSY_TIMEOUT_MS,
  MAX_BUSY_TIMEOUT_MS,
} from '../src/mcp/query-pool';

describe('Spec 0069: busy-timeout default is 15s (docs said 20s)', () => {
  const prev = process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS;
    else process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS = prev;
  });

  it('resolves the documented 15s default when env is unset', () => {
    delete process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS;
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(15_000);
    expect(resolveBusyTimeoutMs()).toBe(15_000);
    // ToolHandler shares the same deadline source for every read tool.
    expect(resolveToolDeadlineMs()).toBe(15_000);
  });

  it('clamps a mistaken 60s into 45s so the soft timeout cannot race the ~60s MCP client hard timeout', () => {
    process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS = '60000';
    expect(resolveBusyTimeoutMs()).toBe(MAX_BUSY_TIMEOUT_MS);
    expect(MAX_BUSY_TIMEOUT_MS).toBe(45_000);
  });
});

describe('Spec 0069: homegraph_project on-demand build is backgrounded', () => {
  let tempDir: string;
  let cg: HomeGraph | null;
  let handler: ToolHandler | null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0069-'));
    cg = null;
    handler = null;
  });

  afterEach(() => {
    cg?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('first call on an unbuilt map returns syncing guidance immediately (no inline scan)', async () => {
    // A repo with files but no project map rows — the legacy "index exists,
    // fast path never ran" state that used to trigger the inline
    // buildProjectMap() scan.
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"demo"}\n');

    cg = await HomeGraph.init(tempDir, { index: false });
    // Phase 'full' so the empty-state gate does not short-circuit; modules
    // empty because buildProjectMap() was never run.
    cg.setBuildPhase('full');
    handler = new ToolHandler(cg);

    // The old code ran the synchronous scan here; a slow scan would block the
    // loop past the deadline. The new code must answer promptly.
    const buildSpy = vi.spyOn(cg, 'buildProjectMap');
    const t0 = Date.now();
    const res = await handler.execute('homegraph_project', {});
    const elapsed = Date.now() - t0;

    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { text: string }).text;
    // The reply carries the project-root hint prefix (Spec 0038 decoration);
    // assert on the guidance body, not strict equality.
    expect(text).toContain(productIndexGuidance('syncing'));
    // Prompt: no inline scan happened before the reply (the background build
    // may fire right after; that is the point).
    expect(elapsed).toBeLessThan(2_000);

    // Give the background build a beat to land, then the retry serves the map.
    await vi.waitFor(() => expect(buildSpy).toHaveBeenCalled(), { timeout: 10_000 });
    const retry = await handler.execute('homegraph_project', {});
    const retryText = (retry.content[0] as { text: string }).text;
    expect(retryText).toContain('Project map');
  });

  it('concurrent first calls fan out to one background build, not N scans', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;\n');

    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('full');
    handler = new ToolHandler(cg);
    const buildSpy = vi.spyOn(cg, 'buildProjectMap');

    const [a, b, c] = await Promise.all([
      handler.execute('homegraph_project', {}),
      handler.execute('homegraph_project', {}),
      handler.execute('homegraph_project', {}),
    ]);
    for (const res of [a, b, c]) {
      expect(res.isError).toBeFalsy();
    }
    await vi.waitFor(() => expect(buildSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    // The single-flight guard persists until the build lands.
    await new Promise((r) => setTimeout(r, 50));
    expect(buildSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('a built map still serves immediately (no behavior change for the warm path)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"demo"}\n');

    cg = await HomeGraph.init(tempDir, { index: false });
    cg.buildProjectMap();
    cg.setBuildPhase('fast');
    handler = new ToolHandler(cg);

    const res = await handler.execute('homegraph_project', {});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Project map');
    expect(text).not.toContain(productIndexGuidance('syncing'));
  });
});

describe('Spec 0069: pre-dispatch fast paths are skipped when the pool is warm', () => {
  it('skips the in-process fast-path block for explore once the pool reports healthy+ready', async () => {
    // Pin the gating predicate rather than a full MCP session: the fast-path
    // block in execute() must not run explore/search surveys on the transport
    // thread when a warm worker can serve them under the soft deadline.
    // We drive a real ToolHandler with a stub pool surface.
    const handler = new ToolHandler(null) as unknown as {
      queryPool: { healthy: boolean; ready: boolean } | null;
      shouldRunInProcessFastPaths: (toolName: string) => boolean;
    };
    // The method under test is introduced by Spec 0069; reach it via the
    // prototype so this test fails loudly if it is renamed/removed.
    const proto = ToolHandler.prototype as unknown as {
      shouldRunInProcessFastPaths?: (this: ToolHandler, toolName: string) => boolean;
    };
    expect(typeof proto.shouldRunInProcessFastPaths).toBe('function');
    handler.queryPool = null;
    expect(handler.shouldRunInProcessFastPaths('homegraph_explore')).toBe(true);
    expect(handler.shouldRunInProcessFastPaths('homegraph_search')).toBe(true);
    expect(handler.shouldRunInProcessFastPaths('homegraph_node')).toBe(false);

    handler.queryPool = { healthy: true, ready: true };
    expect(handler.shouldRunInProcessFastPaths('homegraph_explore')).toBe(false);
    expect(handler.shouldRunInProcessFastPaths('homegraph_search')).toBe(false);

    // Cold pool (worker still starting) keeps the fast paths — that is the
    // existing trade: serve named-member queries on the warm main connection
    // instead of queuing behind a cold worker.
    handler.queryPool = { healthy: true, ready: false };
    expect(handler.shouldRunInProcessFastPaths('homegraph_explore')).toBe(true);

    // Unhealthy pool (crash budget spent) also keeps them.
    handler.queryPool = { healthy: false, ready: true };
    expect(handler.shouldRunInProcessFastPaths('homegraph_search')).toBe(true);
  });
});
