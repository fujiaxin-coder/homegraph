/**
 * MCP tool input-size limits
 *
 * Regression coverage for the DoS vector: MCP clients can ship
 * unbounded payloads (`query`, `task`, `symbol`, `projectPath`,
 * `path`, `pattern`). Before the cap, a 100MB string would hit
 * the FTS5 layer and pin the server. These tests assert that the
 * tool layer rejects oversize inputs early — SUCCESS-shaped guidance
 * (no isError), so agents retry with shorter args instead of abandoning
 * the toolset.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';

describe('MCP input size limits', () => {
  let tempDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-mcp-limits-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `export function alpha(): number { return 1; }\n`
    );
    cg = await HomeGraph.init(tempDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function expectRejectedGuidance(result: { content: Array<{ text: string }>; isError?: boolean }, needle: RegExp) {
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(needle);
    expect(result.content[0]!.text).toMatch(/fix the arguments and retry/i);
  }

  it('accepts a normal-sized query', async () => {
    const result = await handler.execute('homegraph_search', { query: 'alpha' });
    expect(result.isError).toBeFalsy();
  });

  it('rejects an oversize query on homegraph_search', async () => {
    const huge = 'a'.repeat(20_000);
    const result = await handler.execute('homegraph_search', { query: huge });
    expectRejectedGuidance(result, /maximum length/i);
  });

  it('rejects an oversize query on homegraph_explore', async () => {
    const huge = 'b'.repeat(50_000);
    const result = await handler.execute('homegraph_explore', { query: huge });
    expectRejectedGuidance(result, /maximum length/i);
  });

  it('rejects an oversize symbol on homegraph_callers', async () => {
    const huge = 'c'.repeat(15_000);
    const result = await handler.execute('homegraph_callers', { symbol: huge });
    expectRejectedGuidance(result, /maximum length/i);
  });

  it('rejects an oversize symbol on homegraph_impact', async () => {
    const huge = 'd'.repeat(11_000);
    const result = await handler.execute('homegraph_impact', { symbol: huge });
    expectRejectedGuidance(result, /maximum length/i);
  });

  it('rejects an oversize projectPath', async () => {
    const hugePath = '/tmp/' + 'x'.repeat(5_000);
    const result = await handler.execute('homegraph_search', {
      query: 'alpha',
      projectPath: hugePath,
    });
    expectRejectedGuidance(result, /projectPath/);
  });

  it('rejects an oversize path filter on homegraph_files', async () => {
    const hugePath = 'src/' + 'y'.repeat(5_000);
    const result = await handler.execute('homegraph_files', { path: hugePath });
    expectRejectedGuidance(result, /path/);
  });

  it('rejects an oversize glob pattern on homegraph_files', async () => {
    const hugePattern = '*'.repeat(5_000);
    const result = await handler.execute('homegraph_files', { pattern: hugePattern });
    expectRejectedGuidance(result, /pattern/);
  });

  it('rejects a non-string projectPath', async () => {
    const result = await handler.execute('homegraph_search', {
      query: 'alpha',
      projectPath: 12345 as unknown as string,
    });
    expectRejectedGuidance(result, /projectPath/);
  });
});
