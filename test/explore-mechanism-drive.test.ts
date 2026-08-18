/**
 * Cross-Type drive / state-change asks must not compact hard-ANSWER-NOW
 * on abstract base names (spec 0012).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('homegraph_explore — cross-Type drive (0012)', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-drive-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'Machine.ts'),
      `export abstract class Machine {
  onStateChange() { return 1; }
}
`,
    );
    fs.writeFileSync(
      path.join(src, 'Engine.ts'),
      `export class Engine {
  recomputeLayout() { return 2; }
}
`,
    );
    cg = HomeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('Machine→Engine drive query is Partial / coarse, never hard ANSWER NOW from this response', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: 'Machine 的状态变化如何驱动 Engine 重新计算布局？',
    });
    const text = res.content[0].text;
    expect(text).not.toMatch(/\*\*ANSWER NOW from this response\.\*\*/);
    // Either light/full mechanism Partial, or coarse-locate without fake-complete.
    expect(text).toMatch(/Partial locator|Coarse locate|Mechanism|Machine|Engine/i);
  });
});
