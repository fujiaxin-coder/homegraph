import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import HomeGraph from '../src/index';
import { findLiteralEvidence, normalizeLiteralTexts } from '../src/search/literal-evidence';
import { removeTempDir } from './helpers/fs';

describe('bounded local literal evidence', () => {
  let dir: string;
  let graph: HomeGraph | undefined;
  let sdk: HomeGraph | undefined;
  let sdkDir: string | undefined;
  const write = (file: string, text: string): void => {
    const absolute = path.join(dir, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-literal-')); });
  afterEach(() => {
    graph?.destroy(); graph = undefined;
    sdk?.destroy(); sdk = undefined;
    removeTempDir(dir);
    if (sdkDir) removeTempDir(sdkDir);
    sdkDir = undefined;
  });

  it('resolves a resource value through the exact resource key to a UI callback', () => {
    const resource = 'entry/src/main/resources/base/element/string.json';
    const source = 'entry/src/main/ets/pages/Index.ets';
    write(resource, JSON.stringify({ string: [{ name: 'verify_choice', value: '选择验证码' }] }, null, 2));
    write(source, `@Entry\n@Component\nstruct Index {\n build() {\n  Button($r('app.string.verify_choice'))\n   .onClick(() => { router.pushUrl({ url: 'pages/Verification' }); })\n }\n}`);
    const found = findLiteralEvidence(dir, { literalTexts: ['选择验证码'] });
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({ kind: 'resource_reference', filePath: source, line: 5,
      literal: '选择验证码', resource: { filePath: resource, key: 'verify_choice', value: '选择验证码' } });
    expect(found.hits[0]?.text).toContain('router.pushUrl');
    expect(found.truncated).toBe(false);
  });

  it('selects an indexed local text owner rather than a dense native implementation', async () => {
    write('GoodsPage.ts', `export class GoodsPage {\n render() {\n  return { label: '总体积', onChange: () => this.calculateVolume() };\n }\n calculateVolume() { return 10; }\n}`);
    write('native/Upscale.cpp', Array.from({ length: 30 }, (_, i) => `void Upscale${i}() {}`).join('\n'));
    graph = HomeGraph.initSync(dir, { config: { include: ['**/*.ts', '**/*.cpp'], exclude: [] } });
    await graph.indexAll();
    const found = await graph.findRelevantContext('locate total volume input', {
      searchLimit: 1, traversalDepth: 1,
      retrievalHints: { symbols: ['Upscale0'], searchTerms: ['upscale'], literalTexts: ['总体积'], sourceScope: 'local' },
    });
    expect(found.roots.map(id => found.nodes.get(id)?.filePath)).toEqual(['GoodsPage.ts']);
    expect(found.roots.map(id => found.nodes.get(id)?.name)).toEqual(['render']);
    expect(found.literalEvidence?.hits[0]?.text).toContain('calculateVolume');
  });

  it('retains unindexed ArkTS Select source when only native files were indexed', async () => {
    write('native/fsr.cpp', 'void DestroyFSR() {}');
    graph = HomeGraph.initSync(dir, { config: { include: ['**/*.cpp'], exclude: [] } });
    await graph.indexAll();
    write('entry/src/main/ets/pages/Index.ets', `@Component\nstruct Index {\n build() {\n  Select([{ value: 'no upscale' }, { value: 'temporal upscale' }])\n   .onSelect((i: number) => { nativeRenderer.setMode(i); })\n }\n}`);
    const found = await graph.findRelevantContext('select upscaler', {
      retrievalHints: { symbols: [], searchTerms: [], literalTexts: ['no upscale'], sourceScope: 'local' },
    });
    expect(found.nodes.size).toBe(0);
    expect(found.literalEvidence?.hits[0]?.filePath).toMatch(/Index\.ets$/);
    expect(found.literalEvidence?.hits[0]?.text).toContain('.onSelect');
  });

  it('rejects incidental SDK roots for local plans while retaining explicit SDK lookups', async () => {
    write('GoodsPage.ts', `export const amountLabel = '总体积';`);
    graph = HomeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await graph.indexAll();
    sdkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-literal-sdk-'));
    fs.writeFileSync(path.join(sdkDir, 'Stack.ts'), 'export class Stack { locate(value: string): number { return 0; } }');
    sdk = HomeGraph.initSync(sdkDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await sdk.indexAll();
    graph.getQueryBuilder().attachOhosApiDb(path.join(sdkDir, '.homegraph', 'homegraph.db'));
    const explicit = await graph.findRelevantContext('Stack.locate', {
      retrievalHints: { symbols: ['locate'], searchTerms: [], sourceScope: 'sdk' }, traversalDepth: 0,
    });
    expect(explicit.roots.length).toBeGreaterThan(0);
    expect(explicit.roots.every(id => explicit.nodes.get(id)?.filePath.startsWith('ohos-sdk:'))).toBe(true);
    const local = await graph.findRelevantContext('locate total volume feature', {
      retrievalHints: { symbols: ['locate'], searchTerms: [], sourceScope: 'local' }, traversalDepth: 0,
    });
    expect(local.roots).toEqual([]);
  });

  it('skips ignored, hidden, secret-config and symlink escape files', () => {
    write('.gitignore', 'private/\n');
    write('private/Hidden.ts', `const label = '酒店位置';`);
    write('.env', 'SECRET=酒店位置');
    write('settings.json', '{"secret":"酒店位置"}');
    write('src/.gitignore', 'secret.ts\n');
    write('src/secret.ts', `const label = '酒店位置';`);
    write('public/Page.ets', `Text('酒店位置')`);
    const outside = path.join(os.tmpdir(), `hg-literal-external-${process.pid}.ts`);
    fs.writeFileSync(outside, `const external = '酒店位置';`);
    try {
      fs.symlinkSync(outside, path.join(dir, 'escaped.ts'));
      const found = findLiteralEvidence(dir, { literalTexts: ['酒店位置'], files: ['escaped.ts', '../escape.ts'] });
      expect(found.hits.map(hit => hit.filePath)).toEqual(['public/Page.ets']);
      expect(JSON.stringify(found)).not.toContain('external');
    } finally { fs.unlinkSync(outside); }
  });

  it('keeps literal matching literal and records bounded partial results', () => {
    write('a.ts', `const label = 'Size (A+B)?';`);
    write('b.ts', `const label = 'Size ABBBB';`);
    write('c.ts', 'x'.repeat(300));
    expect(findLiteralEvidence(dir, { literalTexts: ['Size (A+B)?'] }).hits.map(hit => hit.filePath)).toEqual(['a.ts']);
    const bounded = findLiteralEvidence(dir, { literalTexts: ['Size'], maxFiles: 1, maxBytes: 100 });
    expect(bounded.stats.filesRead).toBe(1);
    expect(bounded.stats.bytesRead).toBeLessThanOrEqual(100);
    expect(bounded.truncated).toBe(true);
    expect(bounded.limitsHit).toContain('files');
    expect(normalizeLiteralTexts(['ok', 'ok', 3, '\0bad', 'x'.repeat(161)])).toEqual(['ok']);
  });
});
