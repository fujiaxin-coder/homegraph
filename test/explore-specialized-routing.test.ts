import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import HomeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';

describe('specialized explore routing', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-specialized-'));
    const app = path.join(testDir, 'src', 'app');
    const consumer = path.join(testDir, 'src', 'consumer');
    const launcher = path.join(testDir, 'src', 'launchercommon');
    const service = path.join(testDir, 'src', 'servicecommon');
    const native = path.join(testDir, 'native', 'renderer');
    for (const dir of [app, consumer, launcher, service, native]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(path.join(app, 'colors.ts'),
      'export const COLOR_MODE_DARK = 2;\nexport const selected = COLOR_MODE_DARK;\n');
    fs.writeFileSync(path.join(consumer, 'theme.ts'),
      "import { COLOR_MODE_DARK } from '../app/colors';\nexport const active = COLOR_MODE_DARK;\n");
    fs.writeFileSync(path.join(app, 'flow.ts'),
      'export function finishJob(): string { return "done"; }\n' +
      'export function startJob(): string { return finishJob(); }\n');

    fs.writeFileSync(path.join(launcher, 'oh-package.json5'),
      '{ "name": "launchercommon", "dependencies": { "servicecommon": "file:../servicecommon" } }\n');
    fs.writeFileSync(path.join(service, 'oh-package.json5'),
      '{ "name": "servicecommon", "dependencies": { "launchercommon": "file:../launchercommon" } }\n');
    fs.writeFileSync(path.join(testDir, 'code-linter.json5'),
      '{ "rules": { "@security/no-cycle": "error" } }\n');
    fs.writeFileSync(path.join(native, 'bridge.cpp'),
      'void Draw() {}\nvoid Export() {\n' +
      '  napi_property_descriptor props[] = { { "draw", nullptr, Draw } };\n}\n');

    cg = HomeGraph.initSync(testDir, {
      config: { include: ['**/*.ts', '**/*.cpp'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function text(tool: string, query: string): Promise<string> {
    const result = await handler.execute(tool, { query });
    expect(result.isError).toBeFalsy();
    return result.content[0]!.text;
  }

  it('exposes all focused tools as read-only', () => {
    for (const name of ['homegraph_usages', 'homegraph_modules', 'homegraph_native']) {
      const definition = tools.find((tool) => tool.name === name);
      expect(definition, name).toBeDefined();
      expect(definition!.annotations?.readOnlyHint).toBe(true);
      expect(definition!.inputSchema.required).toContain('query');
    }
  });

  it('runs usages directly and auto-routes a constant-only explore', async () => {
    const direct = await text('homegraph_usages', 'COLOR_MODE_DARK');
    const routed = await text('homegraph_explore', 'COLOR_MODE_DARK');
    for (const output of [direct, routed]) {
      expect(output).toContain('HomeGraph specialized route: usages');
      expect(output).toContain('consumer/theme.ts');
    }
  });

  it('keeps call-flow and mechanism shapes on general explore', async () => {
    expect(await text('homegraph_explore', 'startJob finishJob'))
      .not.toContain('HomeGraph specialized route');
    expect(await text('homegraph_explore', 'COLOR_MODE_DARK 的实现机制是如何工作的'))
      .not.toContain('HomeGraph specialized route: usages');
  });

  it('can disable constant-shape routing', async () => {
    const previous = process.env.HOMEGRAPH_EXPLORE_SHAPE_ROUTING;
    process.env.HOMEGRAPH_EXPLORE_SHAPE_ROUTING = '0';
    try {
      expect(await text('homegraph_explore', 'COLOR_MODE_DARK'))
        .not.toContain('HomeGraph specialized route: usages');
    } finally {
      if (previous === undefined) delete process.env.HOMEGRAPH_EXPLORE_SHAPE_ROUTING;
      else process.env.HOMEGRAPH_EXPLORE_SHAPE_ROUTING = previous;
    }
  });

  it('reports not_surveyed when a direct usage call has no symbol', async () => {
    const output = await text('homegraph_usages', '这个功能是如何实现的');
    expect(output).toContain('Status: not_surveyed');
    expect(output).toContain('No survey ran');
  });

  it('runs and auto-routes only the module dependency family', async () => {
    const query = 'staticcommon/launchercommon 和 servicecommon 是否循环依赖，构建系统如何检测？';
    for (const output of [
      await text('homegraph_modules', query),
      await text('homegraph_explore', query),
    ]) {
      expect(output).toContain('HomeGraph specialized route: modules');
      expect(output).toContain('Named module manifest dependencies');
      expect(output).toContain('Detected **1** cycle');
      expect(output).toContain('@security/no-cycle');
      expect(output).not.toContain('NAPI / native export survey');
    }
  });

  it('runs and auto-routes only the native export family', async () => {
    const query = 'native/renderer NAPI exports which APIs';
    for (const output of [
      await text('homegraph_native', query),
      await text('homegraph_explore', query),
    ]) {
      expect(output).toContain('HomeGraph specialized route: native');
      expect(output).toContain('NAPI / native export survey');
      expect(output).toContain('draw');
      expect(output).not.toContain('Module dependency / cycle survey');
    }
  });
});
