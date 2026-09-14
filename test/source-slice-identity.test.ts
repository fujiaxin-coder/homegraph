import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { sourceSliceIdentity } from '../src/mcp/source-slice-identity';

describe('源码片段身份', () => {
  it('保留真实相对路径及范围，明确不是整个文件版本', () => {
    const value = sourceSliceIdentity('entry/src/Page.ets', 12, '中文\nnext');
    expect(value).toContain('entry/src/Page.ets:12-13');
    expect(value).toContain('Excerpt only; refresh after edits');
    expect(value).toMatch(/excerpt-sha256=[a-f0-9]{16}/);
  });
  it('即使位置相同，源码变化也更换片段身份', () => {
    expect(sourceSliceIdentity('Page.ets', 1, 'a')).not.toEqual(sourceSliceIdentity('Page.ets', 1, 'b'));
  });
  it('真实 node 输出只在启用时附加身份，源码正文保持一致', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-identity-'));
    let graph: HomeGraph | undefined;
    try {
      fs.writeFileSync(path.join(root, 'example.ts'), 'export function greet(): string { return "hello"; }\n');
      graph = HomeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
      await graph.indexAll();
      graph.setBuildPhase('full');
      const handler = new ToolHandler(graph);
      vi.stubEnv('HOMEGRAPH_MCP_CACHE', '0');
      vi.stubEnv('HOMEGRAPH_SOURCE_RECEIPTS', '0');
      const original = await handler.execute('homegraph_node', { symbol: 'greet', includeCode: true });
      vi.stubEnv('HOMEGRAPH_SOURCE_RECEIPTS', '1');
      const measured = await handler.execute('homegraph_node', { symbol: 'greet', includeCode: true });
      const plain = original.content.map(p => p.text).join('\n');
      const text = measured.content.map(p => p.text).join('\n');
      expect(measured.isError).toBeFalsy();
      expect(text).toContain('excerpt-sha256=');
      expect(plain).not.toContain('excerpt-sha256=');
      expect(text.match(/```[\s\S]*?```/g)).toEqual(plain.match(/```[\s\S]*?```/g));
    } finally {
      graph?.destroy();
      fs.rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
});
