/**
 * ≥3 named Types + dependency ask → lean location/edge inventory (D60),
 * not a fat multi-body compact that hits the soft deadline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('homegraph_explore — multi-Type dependency inventory', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-mtd-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });

    fs.writeFileSync(
      path.join(src, 'ThemePackManager.ts'),
      `import { ThemePackInstaller } from './ThemePackInstaller';
export class ThemePackManager {
  install() { return new ThemePackInstaller().run(); }
}
`,
    );
    fs.writeFileSync(
      path.join(src, 'ThemePackInstaller.ts'),
      `import { ThemePackParser } from './ThemePackParser';
export class ThemePackInstaller {
  run() { return new ThemePackParser().parse(); }
}
`,
    );
    fs.writeFileSync(
      path.join(src, 'ThemePackParser.ts'),
      `export class ThemePackParser { parse() { return 1; } }
`,
    );
    fs.writeFileSync(
      path.join(src, 'ThemePackService.ts'),
      `export class ThemePackService { start() { return true; } }
`,
    );
    fs.writeFileSync(
      path.join(src, 'ThemePackController.ts'),
      `import { ThemePackManager } from './ThemePackManager';
export class ThemePackController {
  go() { return new ThemePackManager().install(); }
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

  it('returns location inventory without dumping every Type body', async () => {
    const res = await handler.execute('homegraph_explore', {
      query:
        'ThemePackManager ThemePackInstaller ThemePackParser ThemePackService ThemePackController 之间的依赖关系',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/Named-Type dependency inventory/i);
    expect(text).toMatch(/ThemePackManager/);
    expect(text).toMatch(/ThemePackInstaller/);
    // Lean inventory — not a multi-file source dump.
    expect(text).not.toMatch(/```/);
    expect(text.length).toBeLessThan(8000);
  });
});
