import { describe, expect, it } from 'vitest';
import { collectImplementationContext, type ImplementationGraph } from '../src/mcp/implementation-context';
import { inspectControlEvidence } from '../src/mcp/request-evidence';
import type { Edge, Node } from '../src/types';

function fixture() {
  const nodes: Node[] = []; const edges: Edge[] = []; const bodies = new Map<string, string>();
  const node = (name: string, filePath: string, kind: Node['kind'], source: string, start = 1, end = 1) => {
    const n: Node = { id: `${filePath}:${name}`, name, qualifiedName: name, filePath, kind, language: 'arkts',
      startLine: start, endLine: end, startColumn: 0, endColumn: 0, updatedAt: 0 };
    nodes.push(n); bodies.set(n.id, source); return n;
  };
  const graph: ImplementationGraph = { getNode: id => nodes.find(n => n.id === id), getNodesInFile: file => nodes.filter(n => n.filePath === file),
    getOutgoingEdges: id => edges.filter(e => e.source === id), getIncomingEdges: id => edges.filter(e => e.target === id) };
  const edge = (from: Node, to: Node, kind: Edge['kind'], by?: string) => edges.push({ source: from.id, target: to.id, kind,
    ...(by ? { metadata: { synthesizedBy: by, via: 'child-component' }, provenance: 'heuristic' as const } : {}) });
  return { nodes, edges, bodies, node, graph, edge, source: (n: Node) => bodies.get(n.id) };
}

describe('bounded implementation context', () => {
  it('keeps aliased imports with their actual target type, without a same-name global fallback', () => {
    const f = fixture();
    const page = f.node('Page', 'Page.ets', 'component', 'struct Page { item: ProductAlias; }', 2, 3);
    const imp = f.node('ProductAlias', 'Page.ets', 'import', "import { Product as ProductAlias } from './model';");
    const file = f.node('file', 'model.ets', 'file', '');
    const type = f.node('Product', 'model.ets', 'interface', 'export interface Product { id: number; }');
    f.node('Product', 'unrelated.ets', 'interface', 'export interface Product { wrong: boolean; }');
    f.edge(imp, file, 'imports');
    const result = collectImplementationContext(f.graph, [page], f.source);
    expect(result[0]?.nodes.map(n => n.id)).toEqual([page.id, imp.id, type.id]);
    f.edges.length = 0;
    f.bodies.set(imp.id, "import { Product as ProductAlias } from './missing';");
    const unresolved = collectImplementationContext(f.graph, [page], f.source);
    expect(unresolved[0]?.missing[0]).toContain('resolved definition/export');
    expect(unresolved[0]?.nodes).not.toContain(type);
  });
  it('never uses an import seen only in comments or a string', () => {
    const f = fixture(); const p = f.node('Page', 'Page.ets', 'component', 'struct Page { x = "Product"; /* Product */ }');
    f.node('Product', 'Page.ets', 'import', "import { Product } from './model';");
    expect(collectImplementationContext(f.graph, [p], f.source)).toEqual([]);
  });
  it('shows shared parents without expanding their unrelated siblings', () => {
    const f = fixture(); const child = f.node('Badge', 'Badge.ets', 'component', 'struct Badge {}');
    const a = f.node('A', 'A.ets', 'component', 'struct A {}'); const b = f.node('B', 'B.ets', 'component', 'struct B {}');
    const unrelated = f.node('Other', 'Other.ets', 'component', 'struct Other {}');
    f.edge(a, child, 'references', 'viewtree'); f.edge(b, child, 'calls', 'arkui-child'); f.edge(a, unrelated, 'calls', 'arkui-child');
    const groups = collectImplementationContext(f.graph, [child], f.source);
    expect(groups).toHaveLength(2);
    expect(groups.flatMap(g => g.nodes)).not.toContain(unrelated);
    expect(collectImplementationContext(f.graph, [child], () => undefined)).toEqual([]);
  });
  it('does not call a generic reference a page ownership edge', () => {
    const f = fixture(); const a = f.node('A', 'A.ets', 'component', 'struct A {}'); const b = f.node('B', 'B.ets', 'component', 'struct B {}');
    f.edge(a, b, 'references');
    expect(collectImplementationContext(f.graph, [a], f.source)).toEqual([]);
  });
  it('returns SDK method and parameter fields together, labelled as index signatures', () => {
    const f = fixture(); const page = f.node('Page', 'Page.ets', 'component', 'struct Page { use() { sdk.paint(); } }');
    f.node('sdk', 'Page.ets', 'import', "import sdk from '@ohos.paint';");
    const method = f.node('paint', 'ohos-sdk:api/@ohos.paint.d.ts', 'method', '', 1, 1); method.signature = 'paint(style: Style): void';
    const type = f.node('Style', method.filePath, 'interface', '', 2, 4); type.signature = 'interface Style';
    const field = f.node('size', method.filePath, 'property', '', 3, 3); field.signature = 'size: number';
    const groups = collectImplementationContext(f.graph, [page], f.source, module => module === '@ohos.paint'
      ? { version: '6.0.1', nodes: [method, type, field] } : undefined);
    expect(groups[0]?.sdk?.nodes.map(n => n.name)).toEqual(['paint', 'Style', 'size']);
    expect(groups[0]?.sdk?.version).toBe('6.0.1');
    expect(groups[0]?.nodes.every(n => !n.filePath.startsWith('ohos-sdk:'))).toBe(true);
  });
});

describe('icon and state evidence', () => {
  const read = (source: string) => inspectControlEvidence([{ filePath: 'Page.ets', start: 1, source }]);
  it('does not confuse a disabled-looking resource and guard with enabled binding', () => {
    const rows = read(`@Component struct Page { build() { Image(this.ready ? $r('app.media.active') : $r('app.media.inactive'))
      .onClick(() => { if (!this.ready) return; this.save(); }) } }`);
    expect(rows[0]?.labels).toEqual(['app.media.active', 'app.media.inactive']);
    expect(rows[0]?.enabled).toBe('binding_not_observed');
    expect(rows[0]?.state[0]).toEqual({ expression: 'this.ready', writeLocations: [] });
  });
  it('keeps actual writes but not comparisons, quoted assignments or other object fields', () => {
    const rows = read(`struct Page { update() { this.ready = true; other.ready = false; if (this.ready === true) {} const s = "this.ready = false"; }
      build() { Button('Save').enabled(this.ready).onClick(() => this.save()) } }`);
    expect(rows[0]?.enabled).toBe('binding_observed');
    expect(rows[0]?.state[0]?.writeLocations).toEqual(['Page.ets:1']);
  });
  it('leaves duplicate/constant modifiers and malformed sources unknown', () => {
    expect(read('build() { Button("X").enabled(true).onClick(() => {}) }')[0]?.enabled).toBe('unknown');
    expect(read('build() { Button("X").enabled(this.x).enabled(this.y) }')[0]?.enabled).toBe('unknown');
    expect(read('// Image("icon").onClick(() => {})')).toEqual([]);
    expect(read('build() { Button("X").enabled(this.x)')).toEqual([]);
  });
  it('retains separate controls on the same source line', () => {
    expect(read('build() { Button("A").onClick(() => {}); Button("B").enabled(this.ready) }')).toHaveLength(2);
  });
});
