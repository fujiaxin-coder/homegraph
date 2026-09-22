import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import HomeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { buildArktsEvidencePacks } from '../src/mcp/arkts-evidence-packs';
import { ToolHandler } from '../src/mcp/tools';
import type { Node } from '../src/types';

describe('implementation context at source and SDK boundaries', () => {
  let root: string; let graph: HomeGraph; let sdk: DatabaseConnection | undefined;
  let page: Node;
  function file(filePath: string, source: string, declarations: Array<{ name: string; kind: Node['kind']; start: number; end: number }>): Node[] {
    fs.mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true }); fs.writeFileSync(path.join(root, filePath), source);
    graph.getQueryBuilder().upsertFile({ path: filePath, contentHash: createHash('sha256').update(source).digest('hex'),
      language: 'arkts', size: Buffer.byteLength(source), modifiedAt: 0, indexedAt: 0, nodeCount: declarations.length });
    const nodes: Node[] = declarations.map(d => ({ id: `${filePath}:${d.name}`, name: d.name, qualifiedName: d.name,
      filePath, kind: d.kind, startLine: d.start, endLine: d.end, startColumn: 0, endColumn: 0, language: 'arkts', updatedAt: 0 }));
    graph.getQueryBuilder().insertNodes(nodes); return nodes;
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-context-integration-')); graph = HomeGraph.initSync(root); graph.setBuildPhase('full');
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'rules'); vi.stubEnv('HOMEGRAPH_ARKTS_IMPLEMENTATION_CONTEXT', '1');
    vi.stubEnv('HOMEGRAPH_ARKTS_CONTROL_EVIDENCE', '1'); vi.stubEnv('HOMEGRAPH_MCP_CACHE', '1');
    const ns = file('Page.ets', "import { Product as Item } from './barrel';\n@Component\nstruct CatalogPanel { item: Item; build() { Image('icon').onClick(() => {}) } }", [
      { name: 'Item', kind: 'import', start: 1, end: 1 }, { name: 'CatalogPanel', kind: 'component', start: 2, end: 3 }]);
    page = ns[1]!;
    file('barrel.ets', "export { Product } from './model';", [{ name: 'barrel', kind: 'file', start: 1, end: 1 }]);
    file('model.ets', 'export interface Product {\n id: number;\n}', [{ name: 'Product', kind: 'interface', start: 1, end: 3 }]);
    fs.writeFileSync(path.join(root, 'oh-package.json5'), '{name:"catalog",dependencies:{}}');
  });
  afterEach(() => { graph.destroy(); sdk?.close(); sdk = undefined; fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const render = (maxChars = 14000) => buildArktsEvidencePacks(graph, { projectRoot: root, query: 'CatalogPanel', nodes: [page],
    focusIds: new Set([page.id]), maxChars, maxFiles: 8 })!;
  it('returns a verified barrel, aliased type and manifest together; hashes only emitted sources', () => {
    const r = render();
    expect(r.text).toContain('id: number'); expect(r.text).toContain("export { Product } from './model'");
    expect(r.text).toContain('current configuration snapshot');
    expect(r.emission.files.map(f => f.path).sort()).toEqual(['Page.ets', 'barrel.ets', 'model.ets', 'oh-package.json5']);
    expect(r.metadata.controls?.[0]?.enabled).toBe('binding_not_observed');
  });
  it('never uses an edited barrel to retain a stale dependency conclusion', () => {
    fs.writeFileSync(path.join(root, 'barrel.ets'), "export { Product } from './different';");
    const r = render(); expect(r.text).not.toContain('id: number');
    expect(r.emission.files.map(f => f.path)).not.toContain('model.ets');
    expect(r.metadata.gaps.some(g => g.target.includes('resolved definition/export'))).toBe(true);
  });
  it('ignores commented or quoted export statements even in a current indexed barrel', () => {
    file('barrel.ets', "// export { Product } from './model';\nconst example = \"export { Product } from './model'\";", [
      { name: 'barrel', kind: 'file', start: 1, end: 2 }]);
    expect(render().text).not.toContain('id: number');
  });
  it('follows a declared file dependency through its actual package entry and exports', () => {
    const ns = file('Page.ets', "import { Product as Item } from 'models';\n@Component\nstruct CatalogPanel { item: Item; }", [
      { name: 'Item', kind: 'import', start: 1, end: 1 }, { name: 'CatalogPanel', kind: 'component', start: 2, end: 3 }]);
    page = ns[1]!;
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'oh-package.json5'), "{name: 'catalog', dependencies: {models:'file:./lib'}}");
    fs.writeFileSync(path.join(root, 'lib/oh-package.json5'), "{name:'models',main:'Index.ets'}");
    file('lib/Index.ets', "export { Product } from '../model';", [{ name: 'libIndex', kind: 'file', start: 1, end: 1 }]);
    const r = render(); expect(r.text).toContain('id: number');
    expect(r.text).toContain('lib/oh-package.json5'); expect(r.text).toContain('lib/Index.ets');
    fs.writeFileSync(path.join(root, 'oh-package.json5'), "{name:'catalog',dependencies:{models:'file:../outside'}}");
    expect(render().text).not.toContain('id: number');
  });
  it.each([0, 200, 1000, 2300, 6000])('keeps groups atomic within %i characters', max => {
    const r = render(max); expect(r.text.length).toBeLessThanOrEqual(max);
    if (r.text.includes('id: number')) expect(r.text).toContain("export { Product } from './model'");
    for (const f of r.emission.files) expect(r.text).toContain(f.path);
  });
  it('can disable both features without removing the existing source pack', () => {
    vi.stubEnv('HOMEGRAPH_ARKTS_IMPLEMENTATION_CONTEXT', '0'); vi.stubEnv('HOMEGRAPH_ARKTS_CONTROL_EVIDENCE', '0');
    const r = render(); expect(r.text).toContain('struct CatalogPanel'); expect(r.text).not.toContain('id: number');
    expect(r.metadata.implementationContext).toBeUndefined(); expect(r.metadata.controls).toBeUndefined();
  });
  it('does not serve an old module snapshot on a repeated MCP query', async () => {
    const handler = new ToolHandler(graph);
    await handler.execute('homegraph_explore', { query: 'CatalogPanel' });
    fs.writeFileSync(path.join(root, 'oh-package.json5'), '{name:"catalog",dependencies:{newDep:"file:../newDep"}}');
    const next = await handler.execute('homegraph_explore', { query: 'CatalogPanel' });
    expect(next.content[0]?.text).toContain('newDep');
    expect((next._meta?.homegraphQueryPlan as { cacheHit?: boolean })?.cacheHit).not.toBe(true);
  });
  it.runIf(process.platform !== 'win32')('refuses a manifest symlink outside the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-context-private-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret'), 'PRIVATE_SENTINEL'); fs.unlinkSync(path.join(root, 'oh-package.json5'));
      fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'oh-package.json5'));
      expect(render().text).not.toContain('PRIVATE_SENTINEL');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it('reads exact attached SDK modules, rejects ambiguous paths and keeps project names separate', () => {
    const sdkPath = path.join(root, 'sdk.db'); sdk = DatabaseConnection.initialize(sdkPath);
    const queries = new QueryBuilder(sdk.getDb());
    const api: Node = { ...page, id: 'api', filePath: 'ets/api/@ohos.paint.d.ts', name: 'paint', qualifiedName: 'paint',
      kind: 'function', signature: 'paint(style: Style): void' };
    queries.insertNodes([api]); graph.getQueryBuilder().attachOhosApiDb(sdkPath);
    expect(graph.getQueryBuilder().getOhosApiModuleNodes('@ohos.paint')[0]?.filePath).toBe('ohos-sdk:ets/api/@ohos.paint.d.ts');
    expect(graph.getQueryBuilder().getOhosApiModuleNodes('@ohos.missing')).toEqual([]);
    expect(graph.getQueryBuilder().getOhosApiModuleNodes('@ohos.%')).toEqual([]);
    queries.insertNodes([{ ...api, id: 'duplicate', filePath: 'other/@ohos.paint.d.ts' }]);
    expect(graph.getQueryBuilder().getOhosApiModuleNodes('@ohos.paint')).toEqual([]);
  });
  it('delivers SDK parameter signatures through normal explore without recording SDK as read source', async () => {
    const sdkPath = path.join(root, 'sdk.db'); sdk = DatabaseConnection.initialize(sdkPath);
    const queries = new QueryBuilder(sdk.getDb());
    const base: Node = { ...page, filePath: 'ets/api/@ohos.paint.d.ts' };
    queries.insertNodes([
      { ...base, id: 'paint', name: 'paint', qualifiedName: 'paint', kind: 'function', startLine: 1, endLine: 1, signature: 'paint(style: Style): void', docstring: 'API note '.repeat(300) },
      { ...base, id: 'Style', name: 'Style', qualifiedName: 'Style', kind: 'interface', startLine: 2, endLine: 4, signature: 'interface Style' },
      { ...base, id: 'width', name: 'width', qualifiedName: 'Style.width', kind: 'property', startLine: 3, endLine: 3, signature: 'width: number' },
    ]);
    graph.getQueryBuilder().attachOhosApiDb(sdkPath);
    file('Page.ets', "import { paint } from '@ohos.paint';\n@Component\nstruct CatalogPanel { draw() { paint({width: 2}); } }", [
      { name: 'paint', kind: 'import', start: 1, end: 1 }, { name: 'CatalogPanel', kind: 'component', start: 2, end: 3 }]);
    const r = await new ToolHandler(graph).execute('homegraph_explore', { query: 'CatalogPanel' });
    expect(r.content[0]?.text).toContain('width: number');
    expect(r.content[0]?.text).toContain('Not source bodies or device validation');
    const pack = r._meta?.homegraphEvidencePacks as { implementationContext: Array<{ sdk?: { nodes: Node[] } }> };
    expect(pack.implementationContext.flatMap(c => c.sdk?.nodes ?? []).every(n => !n.docstring)).toBe(true);
    expect(r.content[0]?.text).toContain('documentation excerpt');
    const receipts = r._meta?.homegraphEvidence as { files: Array<{ path: string }> };
    expect(receipts.files.every(f => !f.path.startsWith('ohos-sdk:'))).toBe(true);
  });
});
