import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import HomeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX } from '../src/mcp/server-instructions';

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
    vi.unstubAllEnvs();
    if (cg) cg.destroy();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('honors explicitly selected specialized tools on an indexed small repo', async () => {
    vi.stubEnv('HOMEGRAPH_MCP_TOOLS', 'explore,usages,modules,native');
    expect(cg.getStats().fileCount).toBeLessThan(500);
    expect(handler.getTools().map(tool => tool.name).sort()).toEqual([
      'homegraph_explore', 'homegraph_modules', 'homegraph_native', 'homegraph_usages',
    ]);
    const result = await handler.execute('homegraph_usages', { query: 'COLOR_MODE_DARK' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('consumer/theme.ts');
  });

  it('keeps default small-repo tool trimming when no surface is selected', () => {
    vi.stubEnv('HOMEGRAPH_MCP_TOOLS', '');
    const names = handler.getTools().map(tool => tool.name);
    expect(names).toContain('homegraph_explore');
    expect(names).not.toContain('homegraph_usages');
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
      expect(definition!.annotations?.title, name).toBeTruthy();
      expect(definition!.description, name).toMatch(/^PRIMARY first tool/);
      expect(definition!.description, name).toContain('instead of homegraph_explore');
      expect(definition!.inputSchema.required).toContain('query');
    }
  });

  it('presents one exclusive first-tool decision in indexed and no-root guidance', () => {
    for (const instructions of [SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX]) {
      expect(instructions).toContain('homegraph_usages');
      expect(instructions).toContain('homegraph_modules');
      expect(instructions).toContain('homegraph_native');
      expect(instructions).toMatch(/exactly (?:ONE|one) first tool/);
      expect(instructions).toContain('Do not call explore after a focused');
      expect(instructions).not.toMatch(/Must explore-first:[^\n]*(?:usages|deps\/cycles|NAPI)/i);
    }
    const explore = tools.find((tool) => tool.name === 'homegraph_explore')!;
    expect(explore.annotations?.title).toBe('HomeGraph General Explore');
    expect(explore.description).toContain('homegraph_usages, homegraph_modules, or homegraph_native instead');
    const exploreIndex = tools.findIndex((tool) => tool.name === 'homegraph_explore');
    for (const name of ['homegraph_usages', 'homegraph_modules', 'homegraph_native']) {
      expect(tools.findIndex((tool) => tool.name === name), name).toBeLessThan(exploreIndex);
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
