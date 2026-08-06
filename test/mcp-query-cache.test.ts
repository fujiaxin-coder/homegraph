/**
 * MCP query cache — key normalization, memory index, persistence, invalidation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import {
  buildMcpQueryCacheFingerprint,
  buildMcpQueryCacheKey,
  getMcpQueryCacheIndex,
  normalizeExploreQueryTerms,
  QUERY_CACHE_FORMAT_VERSION,
  resetMcpQueryCacheIndices,
} from '../src/mcp/query-cache';

function hasSqliteBindings(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('better-sqlite3');
    return true;
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node-sqlite3-wasm');
      return true;
    } catch {
      return false;
    }
  }
}

describe.skipIf(!hasSqliteBindings())('MCP query cache', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    resetMcpQueryCacheIndices();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-mcp-cache-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'widget.ets'),
      `@Component
struct CountDown {
  @Prop count: number = 0;
  build() {
    Text(\`\${this.count}\`)
  }
}
`,
    );

    cg = HomeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    try { cg.close(); } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.HOMEGRAPH_MCP_CACHE;
    resetMcpQueryCacheIndices();
  });

  it('normalizes explore queries to an order-independent symbol bag', () => {
    const a = normalizeExploreQueryTerms('ParentPage count build CountDown');
    const b = normalizeExploreQueryTerms('build CountDown ParentPage.count');
    expect(a).toEqual(b);
    expect(a).toContain('count');
    expect(a).toContain('parentpage');
    expect(a).toContain('countdown');
  });

  it('produces stable SHA-256 cache keys from fingerprints', () => {
    const args = { query: 'CountDown count @Prop' };
    const fp = buildMcpQueryCacheFingerprint('homegraph_explore', args, 1);
    expect(fp).toMatch(/^explore\|terms:/);
    const key1 = buildMcpQueryCacheKey('homegraph_explore', args, 1);
    const key2 = buildMcpQueryCacheKey('homegraph_explore', args, 1);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns cached explore responses on the second identical call', async () => {
    process.env.HOMEGRAPH_MCP_CACHE = '1';
    const args = { query: 'CountDown count build' };
    const first = await handler.execute('homegraph_explore', args);
    const second = await handler.execute('homegraph_explore', args);
    expect(first.content[0]?.text).toBe(second.content[0]?.text);

    const queries = cg.getQueryBuilder();
    const key = buildMcpQueryCacheKey('homegraph_explore', args, cg.getStats().fileCount);
    const row = queries.getMcpQueryCache(key);
    expect(row).not.toBeNull();
    expect(row!.tool).toBe('explore');
    expect(row!.response).toContain('CountDown');

    const index = getMcpQueryCacheIndex(cg.getProjectRoot());
    expect(index.has(key)).toBe(true);
  });

  it('skips database read on cache miss when key is absent from memory index', () => {
    process.env.HOMEGRAPH_MCP_CACHE = '1';
    const queries = cg.getQueryBuilder();
    const index = getMcpQueryCacheIndex(cg.getProjectRoot());
    index.ensureValid(queries, () => cg.getLastIndexedAt());

    const missKey = buildMcpQueryCacheKey('homegraph_explore', { query: 'never cached' }, 1);
    expect(index.has(missKey)).toBe(false);

    const spy = vi.spyOn(queries, 'getMcpQueryCache');
    expect(index.getEntry(queries, missKey)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reloads memory index from database when stamp is unchanged (daemon restart)', () => {
    process.env.HOMEGRAPH_MCP_CACHE = '1';
    const queries = cg.getQueryBuilder();
    const args = { query: 'CountDown count build' };
    const key = buildMcpQueryCacheKey('homegraph_explore', args, cg.getStats().fileCount);

    indexWarmAndWrite(queries, cg, key, args);

    resetMcpQueryCacheIndices();
    const reloaded = getMcpQueryCacheIndex(cg.getProjectRoot());
    expect(reloaded.has(key)).toBe(false);

    reloaded.ensureValid(queries, () => cg.getLastIndexedAt());
    expect(reloaded.has(key)).toBe(true);
    expect(reloaded.getEntry(queries, key)).not.toBeNull();
  });

  it('clears cache and memory index when index stamp changes', async () => {
    process.env.HOMEGRAPH_MCP_CACHE = '1';
    const args = { query: 'CountDown count' };
    await handler.execute('homegraph_explore', args);

    const queries = cg.getQueryBuilder();
    const index = getMcpQueryCacheIndex(cg.getProjectRoot());
    const cacheKey = buildMcpQueryCacheKey('homegraph_explore', args, cg.getStats().fileCount);
    expect(queries.getMcpQueryCache(cacheKey)).not.toBeNull();
    expect(index.has(cacheKey)).toBe(true);

    // First explore stamps metadata with the current MAX(files.indexed_at).
    // Simulate a re-index (stamp advanced) by leaving a stale stamp — the next
    // ensureValid must wipe cached rows. Avoids flaky same-ms MAX() under sync().
    queries.setMetadata('query_cache_index_stamp', '1');

    index.ensureValid(queries, () => cg.getLastIndexedAt());
    expect(queries.getMcpQueryCache(cacheKey)).toBeNull();
    expect(index.has(cacheKey)).toBe(false);
    expect(queries.getMetadata('query_cache_index_stamp')).toBe(String(cg.getLastIndexedAt()));
    expect(queries.getMetadata('query_cache_format_version')).toBe(String(QUERY_CACHE_FORMAT_VERSION));
  });

  it('does not cache homegraph_status', async () => {
    await handler.execute('homegraph_status', {});
    const queries = cg.getQueryBuilder();
    const key = buildMcpQueryCacheKey('homegraph_status', {}, cg.getStats().fileCount);
    expect(queries.getMcpQueryCache(key)).toBeNull();
  });

  it('is disabled by default (no cache rows written)', async () => {
    const args = { query: 'CountDown' };
    await handler.execute('homegraph_explore', args);
    await handler.execute('homegraph_explore', args);
    const queries = cg.getQueryBuilder();
    const key = buildMcpQueryCacheKey('homegraph_explore', args, cg.getStats().fileCount);
    expect(queries.getMcpQueryCache(key)).toBeNull();
  });
});

/** Write a cache row directly to DB (bypassing handler) for restart-simulation tests. */
function indexWarmAndWrite(
  queries: ReturnType<HomeGraph['getQueryBuilder']>,
  cg: HomeGraph,
  key: string,
  args: { query: string },
): void {
  const index = getMcpQueryCacheIndex(cg.getProjectRoot());
  index.ensureValid(queries, () => cg.getLastIndexedAt());
  index.setEntry(
    queries,
    key,
    'homegraph_explore',
    { content: [{ type: 'text', text: `cached:${args.query}` }] },
  );
}
