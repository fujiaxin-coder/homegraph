import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import HomeGraph from '../src/index';
import { buildProjectMapScan } from '../src/project-map';
import { ToolHandler } from '../src/mcp/tools';

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
    expect(exploreText).toMatch(/still building|homegraph_project/i);
  });
});
