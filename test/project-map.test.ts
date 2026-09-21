import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import HomeGraph from '../src/index';
import {
  buildProjectMapScan,
  listHarmonyRouteProfilesUnderModule,
  readHarmonyAppBundleName,
  scanHarmonyResourceInventory,
  formatHarmonyResourceInventory,
} from '../src/project-map';
import { ToolHandler, tools } from '../src/mcp/tools';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';

describe('project map / homegraph_project', () => {
  let tmp: string;
  let cg: HomeGraph | null = null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-project-map-'));
    cg = null;
  });

  afterEach(() => {
    try {
      cg?.close();
    } catch {
      /* ignore */
    }
    cg = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('scans Harmony build-profile modules and assigns files', () => {
    fs.writeFileSync(
      path.join(tmp, 'build-profile.json5'),
      `{
  modules: [
    { name: "entry", srcPath: "./entry" },
    { name: "common", srcPath: "./common" },
  ]
}`
    );
    fs.mkdirSync(path.join(tmp, 'entry', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'common', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'entry', 'src', 'Index.ets'), 'export struct Index {}\n');
    fs.writeFileSync(path.join(tmp, 'common', 'src', 'Util.ets'), 'export function util() {}\n');
    fs.writeFileSync(path.join(tmp, 'orphan.ts'), 'export const x = 1;\n');

    const built = buildProjectMapScan(tmp);
    expect(built.modules.some((m) => m.name === 'entry' && m.kind === 'harmony')).toBe(true);
    expect(built.modules.some((m) => m.name === 'common')).toBe(true);
    const entryFiles = built.files.filter((f) => f.path.includes('entry/'));
    expect(entryFiles.length).toBeGreaterThan(0);
    expect(built.files.some((f) => f.path === 'orphan.ts')).toBe(true);
  });

  it('scans Harmony modules when build-profile uses single quotes (incl. 2in1)', () => {
    fs.writeFileSync(
      path.join(tmp, 'build-profile.json5'),
      `{
  app: {
    products: [{ name: 'default', deviceTypes: ['phone', '2in1'], }],
  },
  modules: [
    { name: 'entry', srcPath: './entry', },
  ],
}
`
    );
    fs.mkdirSync(path.join(tmp, 'entry', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'entry', 'src', 'Index.ets'), 'export struct Index {}\n');

    const built = buildProjectMapScan(tmp);
    expect(built.modules.some((m) => m.name === 'entry' && m.kind === 'harmony')).toBe(true);
    expect(built.files.some((f) => f.path.startsWith('entry/'))).toBe(true);
  });

  it('persists map and homegraph_project returns it before full index', async () => {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"demo"}\n');

    cg = await HomeGraph.init(tmp, { index: false });
    cg.setBuildPhase('building_fast');
    const built = cg.buildProjectMap();
    expect(built.files.length).toBeGreaterThan(0);
    cg.setBuildPhase('fast');
    expect(cg.getBuildPhase()).toBe('fast');

    const map = cg.getProjectMap();
    expect(map.phase).toBe('fast');
    expect(map.fileCount).toBeGreaterThan(0);

    const handler = new ToolHandler(cg);
    const result = await handler.execute('homegraph_project', {});
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('Project map');
    expect(text).toContain('phase=fast');
    expect(text).toMatch(/a\.ts/);

    const explore = await handler.execute('homegraph_explore', { query: 'a' });
    const exploreText = explore.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(exploreText).toMatch(/status=fast|homegraph_project/i);
  });

  it('homegraph_project prints Harmony skeleton bundle + route profile paths (Spec 0040)', async () => {
    fs.writeFileSync(
      path.join(tmp, 'build-profile.json5'),
      `{ modules: [ { name: "entry", srcPath: "./entry" } ] }`
    );
    fs.mkdirSync(path.join(tmp, 'AppScope'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'AppScope', 'app.json5'),
      `{ app: { bundleName: "com.example.skeleton" } }`
    );
    fs.mkdirSync(path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'profile'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'route_map.json'),
      `{ "routerMap": [] }`
    );
    fs.writeFileSync(
      path.join(tmp, 'entry', 'oh-package.json5'),
      `{ name: "@ohos/entry" }`
    );
    fs.mkdirSync(path.join(tmp, 'entry', 'src', 'main', 'ets'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'entry', 'src', 'main', 'ets', 'Index.ets'), 'export struct Index {}\n');

    cg = await HomeGraph.init(tmp, { index: false });
    cg.buildProjectMap();
    cg.setBuildPhase('fast');
    const handler = new ToolHandler(cg);
    const text = (await handler.execute('homegraph_project', {})).content
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
    expect(text).toContain('bundle: `com.example.skeleton`');
    expect(text).toMatch(/build-profile\.json5/);
    expect(text).toMatch(/route profile: `entry\/.*route_map\.json`/);
    expect(text).toContain('oh-package: `@ohos/entry`');
    expect(text).toMatch(/skeleton map only/);
  });

  it('homegraph_project prints Harmony resource inventory paths (Spec 0042 B)', async () => {
    fs.writeFileSync(
      path.join(tmp, 'build-profile.json5'),
      `{ modules: [ { name: "entry", srcPath: "./entry" } ] }`
    );
    fs.mkdirSync(path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'element'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'rawfile'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'media'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmp, 'entry', 'src', 'main', 'ets'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'element', 'string.json'),
      `{ "string": [{ "name": "app_name", "value": "Demo" }] }`
    );
    fs.writeFileSync(
      path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'rawfile', 'file-data.json'),
      `{ "k": 1 }`
    );
    fs.writeFileSync(
      path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'media', 'icon.svg'),
      `<svg/>`
    );
    fs.writeFileSync(path.join(tmp, 'entry', 'src', 'main', 'ets', 'Index.ets'), 'export struct Index {}\n');
    fs.mkdirSync(path.join(tmp, 'somewhere'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'somewhere', 'random.json'), `{ "x": 1 }\n`);
    // On-disk module not in build-profile / not indexed
    fs.mkdirSync(path.join(tmp, 'feature', 'EntryCard'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'feature', 'EntryCard', 'oh-package.json5'), `{ name: "@ohos/entrycard" }`);

    cg = await HomeGraph.init(tmp, { index: false });
    cg.buildProjectMap();
    cg.setBuildPhase('fast');
    const handler = new ToolHandler(cg);
    const text = (await handler.execute('homegraph_project', {})).content
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
    expect(text).toContain('### HarmonyOS resources');
    expect(text).toMatch(/string\.json/);
    expect(text).toMatch(/file-data\.json/);
    expect(text).toMatch(/media:.*base\/media/);
    expect(text).not.toContain('somewhere/random.json');
    expect(text).toContain('### On disk, not in graph');
    expect(text).toMatch(/feature\/EntryCard/);

    const noFiles = (await handler.execute('homegraph_project', { includeFiles: false })).content
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
    expect(noFiles).toContain('### HarmonyOS resources');
    expect(noFiles).toMatch(/string\.json/);
  });

  it('helpers resolve bundle and route profiles; instructions name project vs explore (Spec 0040)', () => {
    fs.mkdirSync(path.join(tmp, 'AppScope'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'AppScope', 'app.json5'),
      `{ "app": { "bundleName": "com.demo.app" } }`
    );
    fs.mkdirSync(path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'profile'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json'),
      `{ "src": ["pages/Index"] }`
    );
    expect(readHarmonyAppBundleName(tmp)).toBe('com.demo.app');
    expect(listHarmonyRouteProfilesUnderModule(tmp, 'entry')).toEqual([
      'entry/src/main/resources/base/profile/main_pages.json',
    ]);

    const projectTool = tools.find((t) => t.name === 'homegraph_project');
    expect(projectTool?.description).toMatch(/NOT symbol bodies/i);
    expect(projectTool?.description).toMatch(/route_map/);
    expect(SERVER_INSTRUCTIONS).toMatch(/homegraph_project/);
    expect(SERVER_INSTRUCTIONS).toMatch(/skeleton pointers/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/resources path inventory|string\.json \/ rawfile/i);
    const exploreTool = tools.find((t) => t.name === 'homegraph_explore');
    expect(exploreTool?.description).toMatch(/homegraph_project first/);
  });

  it('scanHarmonyResourceInventory is path-whitelist only (Spec 0042 B)', () => {
    fs.mkdirSync(path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'element'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, 'entry', 'src', 'main', 'resources', 'base', 'element', 'string.json'),
      `{}`
    );
    fs.mkdirSync(path.join(tmp, 'orphan'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'orphan', 'oh-package.json5'), `{ name: "orphan" }`);
    fs.writeFileSync(path.join(tmp, 'noise.json'), `{}`);
    const inv = scanHarmonyResourceInventory(tmp, { indexedPaths: [] });
    expect(inv.stringJson.some((p) => p.endsWith('element/string.json'))).toBe(true);
    expect(inv.unindexedDirs.some((u) => u.path === 'orphan')).toBe(true);
    expect(formatHarmonyResourceInventory(inv)).toContain('HarmonyOS resources');
    expect(formatHarmonyResourceInventory(inv)).not.toContain('noise.json');
  });
});
