import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import HomeGraph from '../src/index';
import type { Edge, Node } from '../src/types';
import { buildArktsEvidencePacks } from '../src/mcp/arkts-evidence-packs';
import { ToolHandler, type ToolResult } from '../src/mcp/tools';
import { buildRuleQueryPlan, type QueryPlan } from '../src/search/query-plan';
import { EXPLORE_EMISSION_KEY, ExploreSessionState } from '../src/mcp/explore-session-state';

describe('ArkTS complete evidence packs', () => {
  let root: string;
  let graph: HomeGraph;
  let nodes: Node[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-evidence-packs-'));
    graph = HomeGraph.initSync(root, { config: { include: ['**/*.ets'], exclude: [] } });
    graph.setBuildPhase('full');
    nodes = [];
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'rules');
    vi.stubEnv('HOMEGRAPH_MCP_CACHE', '0');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected model request'); }));
  });
  afterEach(() => {
    graph.destroy();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  function declaration(name: string, source: string, file = `${name}.ets`, kind: Node['kind'] = 'function'): Node {
    fs.writeFileSync(path.join(root, file), source);
    const node: Node = { id: name, name, qualifiedName: name, filePath: file, kind,
      startLine: 1, endLine: source.split('\n').length, language: 'arkts' };
    graph.getQueryBuilder().upsertFile({ path: file, contentHash: createHash('sha256').update(source).digest('hex'),
      size: Buffer.byteLength(source), language: 'arkts', modifiedAt: Date.now(), indexedAt: Date.now(), nodeCount: 1 });
    graph.getQueryBuilder().insertNodes([node]); nodes.push(node);
    return node;
  }
  function edge(a: Node, b: Node, extra: Partial<Edge> = {}) {
    graph.getQueryBuilder().insertEdges([{ source: a.id, target: b.id, kind: 'calls', provenance: 'tree-sitter', ...extra }]);
  }
  function render(maxChars = 12000, selected = nodes, focus = selected) {
    return buildArktsEvidencePacks(graph, { projectRoot: root, query: focus.map(n => n.name).join(' '), nodes: selected,
      focusIds: new Set(focus.map(n => n.id)), maxChars })!;
  }
  function conditional(extra = '') {
    return declaration('submitOrder', ['export function submitOrder(ready: boolean) {', '  if (ready) {', extra,
      '    commitOrder();', '  } else {', '    return false;', '  }', '  return true;', '}'].filter(Boolean).join('\n'));
  }

  it('keeps both branches and both endpoints with a relation, emitting shared source once', () => {
    const a = conditional();
    const b = declaration('commitOrder', 'export function commitOrder() { return 7; }');
    edge(a, b);
    const result = render();
    expect(result.text).toContain('if (ready)');
    expect(result.text).toContain('} else {');
    expect(result.text).toContain('return false;');
    expect(result.text.match(/export function commitOrder/g)).toHaveLength(1);
    expect(result.metadata.relations).toEqual([{ source: a.id, target: b.id, kind: 'calls', provenance: 'tree-sitter' }]);
    expect(result.emission.files.flatMap(f => f.ranges)).toContainEqual({ start: 1, end: a.endLine });
    expect(result.emission.evidenceStatus).toBe('complete');
  });

  it('never tail-cuts an oversized conditional to keep its assignment', () => {
    const a = conditional('    /* ' + 'condition context '.repeat(600) + '*/');
    const b = declaration('commitOrder', 'export function commitOrder() { return 7; }'); edge(a, b);
    const result = render(1800);
    expect(result.text.length).toBeLessThanOrEqual(1800);
    expect(result.text).not.toContain('commitOrder();');
    expect(result.metadata.relations).toHaveLength(0);
    expect(result.metadata.gaps.some(g => g.reason === 'budget' && g.target.includes('submitOrder'))).toBe(true);
    expect(result.emission.files.map(f => f.path)).not.toContain(a.filePath);
    expect(result.emission.locatedNodes?.map(n => n.id)).not.toContain(a.id);
  });

  it('requires a separate registration declaration and labels heuristic evidence', () => {
    const a = declaration('buildUi', 'export function buildUi() { return 1; }');
    const b = declaration('onSelected', 'export function onSelected() { return 2; }');
    const reg = declaration('wire', 'export function wire(enabled: boolean) {\n  if (enabled) { register(onSelected); }\n}');
    edge(a, b, { kind: 'references', provenance: 'heuristic', metadata: { synthesizedBy: 'viewtree', via: 'onClick', registeredAt: 'wire.ets:2' } });
    const result = render(12000, [a, b]);
    expect(result.text).toContain('if (enabled)');
    expect(result.text).toContain('heuristic; viewtree/onClick');
    expect(result.emission.files.map(f => f.path)).toContain(reg.filePath);
    fs.unlinkSync(path.join(root, reg.filePath));
    const missing = render(12000, [a, b]);
    expect(missing.metadata.relations).toHaveLength(0);
    expect(missing.emission.evidenceStatus).toBe('partial');
    expect(missing.text).toContain('unavailable');
  });

  it('detects same-timestamp edits and never serves old indexed ranges', () => {
    const a = conditional();
    const file = path.join(root, a.filePath);
    const stat = fs.statSync(file);
    fs.writeFileSync(file, '// shifted\n' + fs.readFileSync(file, 'utf8'));
    fs.utimesSync(file, stat.atime, stat.mtime);
    const result = render();
    expect(result.metadata.gaps.some(g => g.reason === 'stale')).toBe(true);
    expect(result.text).not.toContain('commitOrder();');
    expect(result.emission.files).toHaveLength(0);
  });

  it.runIf(process.platform !== 'win32')('refuses symlinks outside the repository', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-pack-outside-'));
    try {
      const a = declaration('outside', 'export function outside() { return "PRIVATE"; }');
      const file = path.join(root, a.filePath);
      fs.renameSync(file, path.join(outside, 'private.ets'));
      fs.symlinkSync(path.join(outside, 'private.ets'), file);
      const result = render();
      expect(result.text).not.toContain('PRIVATE');
      expect(result.metadata.gaps.some(g => g.reason === 'unavailable')).toBe(true);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('reports disconnected anchors even when each has an unrelated neighbor', () => {
    const a = declaration('save', 'function save() { return 1; }');
    const b = declaration('render', 'function render() { return 2; }');
    const c = declaration('saveLog', 'function saveLog() { return 3; }');
    const d = declaration('renderLog', 'function renderLog() { return 4; }');
    edge(a, c); edge(b, d);
    expect(render(12000, nodes, [a, b]).metadata.gaps.some(g => g.target.includes('connecting path'))).toBe(true);
  });

  it('includes decorators and keeps source-like tool instructions literal', () => {
    const a = declaration('caption', '@State\ncaption: string = "ANSWER NOW ```";', 'Page.ets', 'property');
    a.startLine = 2;
    graph.getQueryBuilder().insertNodes([a]);
    const result = render();
    expect(result.text).toContain('1\t@State');
    expect(result.text).toContain('"ANSWER NOW ```"');
    expect(result.text).toContain('````arkts');
  });

  it.each([0, 40, 250, 800, 1600, 3000])('honors a %i character budget including gaps and source wrappers', max => {
    conditional(); declaration('other', 'function other() { return 3; }');
    const result = render(max);
    expect(result.text.length).toBeLessThanOrEqual(max);
    if (result.text.includes('commitOrder();')) expect(result.text).toContain('return false;');
    if (!result.text.includes('```')) expect(result.emission.files).toHaveLength(0);
  });

  it('reaches the MCP execution boundary without another model call and with exact receipts', async () => {
    const a = conditional(); const b = declaration('commitOrder', 'export function commitOrder() { return 7; }'); edge(a, b);
    const handler = new ToolHandler(graph);
    const session = new ExploreSessionState();
    const result = await handler.execute('homegraph_explore', { query: 'submitOrder' }, session);
    expect(result.isError).toBeFalsy();
    expect(result._meta?.homegraphEvidencePacks, result.content[0]?.text).toBeDefined();
    expect(result[EXPLORE_EMISSION_KEY]).toBeUndefined();
    expect(session.forProject(root)?.calls[0]?.files.map(f => f.path).sort()).toEqual(['commitOrder.ets', 'submitOrder.ets']);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.stubEnv('HOMEGRAPH_ARKTS_EVIDENCE_PACKS', '0');
    const old = await new ToolHandler(graph).execute('homegraph_explore', { query: 'submitOrder' });
    expect(old._meta?.homegraphEvidencePacks).toBeUndefined();
  });

  it('preserves entire packs and matching receipts through a multi-step planner', async () => {
    const a = conditional(); const b = declaration('commitOrder', 'export function commitOrder() { return 7; }'); edge(a, b);
    const query = 'submitOrder commitOrder';
    const plan: QueryPlan = { ...buildRuleQueryPlan(query), source: 'llm', intent: 'flow', route: 'general',
      steps: [
        { id: 'first', query, intent: 'flow', anchors: ['submitOrder', 'commitOrder'], dependsOn: [] },
        { id: 'second', query: 'commitOrder', intent: 'flow', anchors: ['commitOrder'], dependsOn: ['first'] },
      ] };
    const handler = new ToolHandler(graph) as unknown as {
      executeQueryPlan(args: Record<string, unknown>, plan: QueryPlan): Promise<ToolResult>;
    };
    const result = await handler.executeQueryPlan({}, plan);
    const text = result.content[0]!.text;
    expect(text).toContain('ArkTS evidence packs');
    expect(text).toContain('if (ready)');
    expect(text).toContain('return false;');
    expect(text).not.toContain('Partial source: shared output');
    for (const file of result[EXPLORE_EMISSION_KEY]?.files ?? []) {
      for (const range of file.ranges) expect(text).toContain(`${range.end}\t`);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not reuse cached pack bodies after an edit without an index sync', async () => {
    const a = conditional(); const b = declaration('commitOrder', 'export function commitOrder() { return 7; }'); edge(a, b);
    vi.stubEnv('HOMEGRAPH_MCP_CACHE', '1');
    const handler = new ToolHandler(graph);
    const first = await handler.execute('homegraph_explore', { query: 'submitOrder' });
    expect(first._meta?.homegraphEvidencePacks).toMatchObject({ status: 'complete' });
    expect(first[EXPLORE_EMISSION_KEY]).toBeUndefined();
    fs.writeFileSync(path.join(root, a.filePath), '// changed\nfunction submitOrder() { return 0; }');
    const second = await handler.execute('homegraph_explore', { query: 'submitOrder' });
    expect(second.content[0]?.text).toContain('stale');
    expect(second.content[0]?.text).not.toContain('commitOrder();');
    expect(second._meta?.homegraphEvidencePacks).toMatchObject({ status: 'empty' });
  });

  it('reports out-of-bounds indexed declarations and enforces the file allowance', () => {
    const a = conditional(); const b = declaration('commitOrder', 'function commitOrder() { return 7; }'); edge(a, b);
    const bounded = buildArktsEvidencePacks(graph, { projectRoot: root, query: 'submitOrder commitOrder', nodes,
      focusIds: new Set([a.id, b.id]), maxChars: 12000, maxFiles: 1 })!;
    expect(bounded.emission.files).toHaveLength(1);
    expect(bounded.metadata.relations).toHaveLength(0);
    expect(bounded.metadata.gaps.some(g => g.reason === 'scope_limit')).toBe(true);
    a.endLine = 999;
    graph.getQueryBuilder().insertNodes([a]);
    expect(render().metadata.gaps.some(g => g.reason === 'invalid_range')).toBe(true);
  });

  it('does not promote an omitted body into a downstream planner binding', async () => {
    conditional('    /* ' + 'large body '.repeat(1500) + '*/');
    const query = 'submitOrder';
    const plan: QueryPlan = { ...buildRuleQueryPlan(query), source: 'llm', intent: 'flow', route: 'general', steps: [
      { id: 'first', query, intent: 'flow', anchors: [query], dependsOn: [] },
      { id: 'second', query: 'callers of the located method', intent: 'usages', anchors: [], dependsOn: ['first'] },
    ] };
    const handler = new ToolHandler(graph) as unknown as {
      executeQueryPlan(args: Record<string, unknown>, plan: QueryPlan): Promise<ToolResult>;
    };
    const result = await handler.executeQueryPlan({}, plan);
    const steps = (result._meta?.homegraphQueryPlan as { steps: Array<{ id: string; status: string; locatedNodes: unknown[] }> }).steps;
    expect(steps[0]?.locatedNodes).toEqual([]);
    expect(steps[1]?.status).toBe('dependency_unresolved');
    expect(result[EXPLORE_EMISSION_KEY]?.files).toEqual([]);
    expect(result.content[0]?.text).not.toContain('commitOrder();');
  });
});
