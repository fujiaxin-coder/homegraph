/**
 * Recoverable bad MCP args must be SUCCESS-shaped (no isError) with a retry
 * example — matching NotIndexedError policy. Early isError teaches agents to
 * abandon the whole HomeGraph toolset for the session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';

describe('MCP bad-arg guidance (success-shaped)', () => {
  let tempDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-mcp-badargs-'));
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

  function expectGuidance(result: { content: Array<{ text: string }>; isError?: boolean }, arg: string) {
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toMatch(new RegExp(arg, 'i'));
    expect(text).toMatch(/fix the arguments and retry/i);
    expect(text).toMatch(/```json/);
    expect(text).not.toMatch(/^Error:/);
  }

  it('missing query on homegraph_search is success-shaped with example', async () => {
    const result = await handler.execute('homegraph_search', {});
    expectGuidance(result, 'query');
  });

  it('empty symbol on homegraph_callers is success-shaped with example', async () => {
    const result = await handler.execute('homegraph_callers', { symbol: '' });
    expectGuidance(result, 'symbol');
  });

  it('homegraph_node with neither symbol nor file is success-shaped', async () => {
    const result = await handler.execute('homegraph_node', {});
    expectGuidance(result, 'symbol');
    expect(result.content[0]!.text).toMatch(/file/i);
  });

  it('non-string projectPath is success-shaped', async () => {
    const result = await handler.execute('homegraph_search', {
      query: 'alpha',
      projectPath: 12345 as unknown as string,
    });
    expectGuidance(result, 'projectPath');
  });

  it('oversize query is success-shaped (still rejected before work)', async () => {
    const result = await handler.execute('homegraph_search', {
      query: 'a'.repeat(20_000),
    });
    expectGuidance(result, 'query');
    expect(result.content[0]!.text).toMatch(/maximum length/i);
  });
});

describe('MCP tool descriptions name required args', () => {
  it('each tool with required fields mentions Required in description or param docs', () => {
    for (const tool of tools) {
      const required = tool.inputSchema.required ?? [];
      if (required.length === 0) continue;
      for (const name of required) {
        const prop = tool.inputSchema.properties[name] as { description?: string } | undefined;
        expect(prop?.description, `${tool.name}.${name}`).toBeTruthy();
        const blob = `${tool.description}\n${prop!.description}`;
        expect(blob.toLowerCase()).toMatch(/required/);
      }
    }
  });
});
