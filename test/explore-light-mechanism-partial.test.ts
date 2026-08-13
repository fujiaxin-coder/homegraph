/**
 * Light-mechanism without a connected spine must Partial-locator, not hard ANSWER NOW.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('homegraph_explore — light-mechanism Partial', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-lm-'));
    const mgr = path.join(testDir, 'feature', 'notification', 'src');
    fs.mkdirSync(mgr, { recursive: true });
    fs.writeFileSync(
      path.join(mgr, 'NotificationSubscribeManager.ts'),
      `export class NotificationSubscribeManager {
  init() { this.subscribe(); }
  subscribe() { return 1; }
}
`,
    );
    cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('domain how-implemented with Manager inventory is Partial without closed spine', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: '项目中是如何实现通知订阅管理的，涉及的多线程或多进程是怎样的？',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/NotificationSubscribeManager|Partial locator|Locator partial/i);
    expect(text).not.toMatch(/Mechanism explore complete — \*\*ANSWER NOW\*\*/);
  });
});
