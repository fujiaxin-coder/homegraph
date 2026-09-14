/** 同时检查初始化前静态工具、无默认项目和已索引 tools/list 的实际描述。 */
import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../src';
import { getStaticTools, ToolHandler } from '../src/mcp/tools';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const forbidden = /CALL FIRST|GENERAL PRIMARY|PRIMARY first tool|before you edit or answer/i;
const originalAllowlist = process.env.HOMEGRAPH_MCP_TOOLS;
let graph: HomeGraph | undefined;
let directory: string | undefined;
afterEach(() => {
  graph?.close(); graph = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  if (originalAllowlist === undefined) delete process.env.HOMEGRAPH_MCP_TOOLS;
  else process.env.HOMEGRAPH_MCP_TOOLS = originalAllowlist;
});

describe('bash-first MCP tool surface', () => {
  it('has no compulsory graph-first description on any tools/list path', async () => {
    process.env.HOMEGRAPH_MCP_TOOLS = 'explore,usages,modules,native,node,callers,callees,files';
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bash-first-'));
    fs.writeFileSync(path.join(directory, 'state.ts'), 'export function update(value: number) { return value + 1; }');
    graph = await HomeGraph.init(directory, { index: true });
    const surfaces = [getStaticTools(), new ToolHandler(null).getTools(), new ToolHandler(graph).getTools()];
    for (const surface of surfaces) {
      for (const tool of surface) expect(tool.description, tool.name).not.toMatch(forbidden);
      const explore = surface.find(t => t.name === 'homegraph_explore')!;
      expect(explore.description).toContain('Optional graph evidence');
      expect(explore.description).toContain('ordinary bash/search/read');
      expect(explore.description).toContain('unresolved cross-symbol');
      expect(explore.inputSchema.required).toContain('query');
      expect(explore.annotations?.readOnlyHint).toBe(true);
      for (const name of ['homegraph_usages', 'homegraph_modules', 'homegraph_native']) {
        expect(surface.find(t => t.name === name)?.description).toMatch(/^Optional focused tool/);
      }
    }
  });
});
