import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import HomeGraph from '../src/index';
import type { Edge, Node } from '../src/types';
import { evidenceEdgeCost, resolveEvidencePathGoal, searchEvidencePaths,
  type EvidencePathGoal, type EvidencePathGraph } from '../src/graph/evidence-paths';
import { buildArktsEvidencePacks } from '../src/mcp/arkts-evidence-packs';
import { ToolHandler } from '../src/mcp/tools';
import { buildRuleQueryPlan } from '../src/search/query-plan';

describe('bounded directed ArkTS evidence paths', () => {
  let root: string;
  let graph: HomeGraph;
  let adapter: EvidencePathGraph;
  let nodes: Node[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-query-paths-'));
    graph = HomeGraph.initSync(root);
    graph.setBuildPhase('full');
    nodes = [];
    adapter = { getNode: id => graph.getNode(id),
      getEdges: (...args) => graph.getQueryBuilder().getEvidenceEdges(...args) };
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'rules');
    vi.stubEnv('HOMEGRAPH_MCP_CACHE', '0');
    vi.stubEnv('HOMEGRAPH_ARKTS_EVIDENCE_PACKS', '1');
    vi.stubEnv('HOMEGRAPH_ARKTS_QUERY_PATHS', '1');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected model call'); }));
  });
  afterEach(() => {
    graph.destroy(); fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });
  function declaration(id: string, overrides: Partial<Node> = {}, source = `function ${id}() { return 1; }`): Node {
    const n: Node = { id, name: id, qualifiedName: id, filePath: `${id}.ets`, kind: 'function',
      startLine: 1, endLine: source.split('\n').length, language: 'arkts', ...overrides };
    fs.writeFileSync(path.join(root, n.filePath), source);
    graph.getQueryBuilder().upsertFile({ path: n.filePath, contentHash: createHash('sha256').update(source).digest('hex'),
      size: Buffer.byteLength(source), language: 'arkts', modifiedAt: Date.now(), indexedAt: Date.now(), nodeCount: 1 });
    graph.getQueryBuilder().insertNodes([n]); nodes.push(n);
    return n;
  }
  function edge(a: Node, b: Node, extra: Partial<Edge> = {}): Edge {
    const e: Edge = { source: a.id, target: b.id, kind: 'calls', provenance: 'tree-sitter', ...extra };
    graph.getQueryBuilder().insertEdges([e]); return e;
  }
  function goal(anchors: Node[], extra: Partial<EvidencePathGoal> = {}): EvidencePathGoal {
    return { kind: 'calls', direction: 'either', anchorIds: anchors.map(n => n.id), ambiguous: [], limited: false, ...extra };
  }
  function search(anchors: Node[], extra: Partial<EvidencePathGoal> = {}) {
    return searchEvidencePaths(adapter, goal(anchors, extra), { now: () => 0 });
  }
  function chain() {
    const a = declaration('startFlow', {}, 'function startFlow() { return normalizeInput(); }');
    const b = declaration('normalizeInput', {}, 'function normalizeInput() { return clampInput(); }');
    const c = declaration('clampInput', {}, 'function clampInput() { return applyValue(); }');
    const d = declaration('applyValue');
    edge(a, b); edge(b, c); edge(c, d);
    return [a, b, c, d] as const;
  }
  function render(anchors: Node[], maxChars = 12000, extra: Partial<EvidencePathGoal> = {}) {
    return buildArktsEvidencePacks(graph, { projectRoot: root, query: anchors.map(n => n.name).join(' '), nodes: anchors,
      focusIds: new Set(anchors.map(n => n.id)), maxChars, pathSearch: search(anchors, extra) })!;
  }

  it('finds two unnamed bridge methods and normalizes reverse search to actual edge direction', () => {
    const [a, b, c, d] = chain();
    expect(search([a, d]).paths[0]?.nodeIds).toEqual([a.id, b.id, c.id, d.id]);
    const reverse = search([d, a], { direction: 'incoming' });
    expect(reverse.stopReason).toBe('supported');
    expect(reverse.paths[0]).toMatchObject({ nodeIds: [a.id, b.id, c.id, d.id], orientation: 'incoming' });
    expect(search([d, a], { direction: 'outgoing' }).paths).toEqual([]);
  });

  it('does not join two callers through a shared callee or imports/contains/return types', () => {
    const a = declaration('save'); const b = declaration('load'); const common = declaration('log');
    edge(a, common); edge(b, common);
    for (const kind of ['imports', 'contains', 'returns', 'references'] as const) edge(a, b, { kind });
    const result = search([a, b]);
    expect(result.paths).toEqual([]);
    expect(result.stopReason).toBe('no_path_in_scope');
    expect(render([a, b]).metadata.gaps.some(g => g.reason === 'unindexed_connection')).toBe(true);
  });

  it('requires state/event evidence for those goals and does not turn state refresh into a call', () => {
    const a = declaration('onTap'); const b = declaration('buildUi'); const c = declaration('draw');
    const state = edge(a, b, { provenance: 'heuristic', metadata: { synthesizedBy: 'arkui-state', via: 'state assignment' } });
    edge(b, c);
    expect(search([a, c]).paths).toEqual([]);
    expect(search([a, c], { kind: 'state' }).paths[0]?.nodeIds).toEqual([a.id, b.id, c.id]);
    expect(search([b, c], { kind: 'state' }).paths).toEqual([]);
    expect(search([b, c], { kind: 'events' }).paths).toEqual([]);
    expect(search([c], { kind: 'events' }).stopReason).toBe('no_path_in_scope');
    expect(render([c], 12000, { kind: 'events' }).metadata.gaps.some(g => g.reason === 'unindexed_connection')).toBe(true);
    expect(evidenceEdgeCost(state, goal([a, b]))).toBeNull();
    edge(a, b, { kind: 'references', metadata: { synthesizedBy: 'viewtree', via: 'onClick' } });
    expect(search([a, c], { kind: 'events' }).paths[0]?.nodeIds).toEqual([a.id, b.id, c.id]);
    const passage = { ...state, kind: 'references' as const, metadata: { synthesizedBy: 'viewtree', via: 'Param', passageType: 'value' } };
    expect(evidenceEdgeCost(passage, goal([a, b], { kind: 'events' }))).toBeNull();
    expect(evidenceEdgeCost(passage, goal([a, b], { kind: 'state' }))).not.toBeNull();
    const emitter = { ...state, metadata: { synthesizedBy: 'arkui-emitter' } };
    expect(evidenceEdgeCost(emitter, goal([a, b], { kind: 'events' }))).not.toBeNull();
  });

  it('follows type structure only for a structure goal', () => {
    const a = declaration('Child', { kind: 'class' }); const b = declaration('Parent', { kind: 'class' });
    edge(a, b, { kind: 'extends' });
    expect(search([a, b]).paths).toEqual([]);
    expect(search([a, b], { kind: 'structure' }).paths[0]?.nodeIds).toEqual([a.id, b.id]);
    expect(resolveEvidencePathGoal('Child Parent', nodes, new Set()).kind).toBe('structure');
  });

  it('prefers a parsed route over an equally long heuristic route and preserves provenance', () => {
    const a = declaration('start'); const b = declaration('heuristicBridge');
    const c = declaration('parsedBridge'); const d = declaration('finish');
    edge(a, b, { provenance: 'heuristic' }); edge(b, d, { provenance: 'heuristic' });
    edge(a, c); edge(c, d);
    const result = search([a, d]);
    expect(result.paths[0]?.nodeIds).toEqual([a.id, c.id, d.id]);
    expect(result.paths[0]?.edges.every(e => e.provenance === 'tree-sitter')).toBe(true);
    expect(result.paths[0]?.cost).toBe(2);
  });

  it('preserves query order and resolves homonyms only with qualified scope or validated identity', () => {
    const a = declaration('alphaRun', { name: 'run', qualifiedName: 'Alpha::run' });
    const b = declaration('betaRun', { name: 'run', qualifiedName: 'Beta::run' });
    const end = declaration('finish');
    const base = buildRuleQueryPlan('run finish');
    expect(resolveEvidencePathGoal('run finish', nodes, new Set([a.id]), base))
      .toMatchObject({ anchorIds: [end.id], ambiguous: ['run'] });
    expect(resolveEvidencePathGoal('finish Alpha.run', nodes, new Set()).anchorIds).toEqual([end.id, a.id]);
    expect(resolveEvidencePathGoal('run betaRun.ets finish', nodes, new Set()).anchorIds).toEqual([b.id, end.id]);
    const binding = { id: b.id, name: b.name, filePath: b.filePath, startLine: b.startLine, qualifiedName: b.qualifiedName };
    expect(resolveEvidencePathGoal('run finish', nodes, new Set(), { ...base, bindings: [binding] }).anchorIds).toEqual([b.id, end.id]);
    expect(resolveEvidencePathGoal('run finish', nodes, new Set(), { ...base, bindings: [{ ...binding, startLine: 999 }] }).ambiguous).toEqual(['run']);
    expect(resolveEvidencePathGoal('finish Alpha.run', nodes, new Set(), { ...base, relation: 'outgoing_calls' }))
      .toMatchObject({ kind: 'calls', direction: 'outgoing', anchorIds: [end.id, a.id] });
    expect(resolveEvidencePathGoal('finish Alpha.run', nodes, new Set(), { ...base, relation: 'registration_sites' }))
      .toMatchObject({ kind: 'events', direction: 'incoming' });
  });

  it('keeps owning classes as scope rather than extra callable endpoints', () => {
    const owner = declaration('Alpha', { kind: 'class', endLine: 30 });
    const a = declaration('alphaRun', { name: 'run', qualifiedName: 'Alpha.run', filePath: owner.filePath, startLine: 5, endLine: 8 });
    declaration('betaRun', { name: 'run', qualifiedName: 'Beta.run' });
    const end = declaration('finish');
    expect(resolveEvidencePathGoal('Alpha run finish', nodes, new Set()).anchorIds).toEqual([a.id, end.id]);
  });

  it('bounds SQLite rows on a hub while retaining a late direct endpoint', () => {
    const a = declaration('hub'); const end = declaration('finish');
    for (let i = 0; i < 80; i++) edge(a, declaration(`noise${i}`));
    edge(a, end);
    const rows = graph.getQueryBuilder().getEvidenceEdges(a.id, 'outgoing', ['calls'], 25, [end.id]);
    expect(rows).toHaveLength(25); expect(rows[0]?.target).toBe(end.id);
    const result = search([a, end]);
    expect(result.paths[0]?.nodeIds).toEqual([a.id, end.id]);
    expect(result.stats.rowsRead).toBeLessThanOrEqual(result.stats.adjacencyReads * 25);
    expect(result.limitsHit).toContain('neighbors');
    expect(result.stopReason).toBe('supported');
    const absent = declaration('absent');
    expect(search([a, absent]).stopReason).toBe('budget_exhausted');
  });

  it('terminates on cycles and reports time, hop, node and read limits', () => {
    const [a, , c, d] = chain(); edge(c, a);
    const absent = declaration('absent');
    expect(search([a, absent]).paths).toEqual([]);
    for (const [limits, hit] of [[{ reads: 1 }, 'reads'], [{ nodes: 1 }, 'nodes'], [{ hops: 1 }, 'hops']] as const) {
      const result = searchEvidencePaths(adapter, goal([a, d]), { now: () => 0, limits });
      expect(result.stopReason).toBe('budget_exhausted'); expect(result.limitsHit).toContain(hit);
    }
    let tick = 0;
    const timed = searchEvidencePaths(adapter, goal([a, d]), { now: () => tick++ * 100 });
    expect(timed.stopReason).toBe('budget_exhausted'); expect(timed.limitsHit).toContain('time');
    expect(timed.stats.adjacencyReads).toBe(0);
  });

  it('provides the whole multi-hop source dependency set and matching receipts', () => {
    const [a, b, c, d] = chain(); const result = render([a, d]);
    expect(result.metadata.pathSearch).toMatchObject({ stopReason: 'supported', paths: [{ evidence: 'provided' }] });
    expect(result.metadata.status).toBe('complete');
    expect(result.metadata.relations).toHaveLength(3);
    for (const n of [a, b, c, d]) {
      expect(result.text).toContain(fs.readFileSync(path.join(root, n.filePath), 'utf8'));
      expect(result.emission.files.map(f => f.path)).toContain(n.filePath);
      expect(result.emission.locatedNodes?.map(n => n.id)).toContain(n.id);
    }
  });

  it('marks stale or missing intermediate source as partial even when both endpoints are readable', () => {
    const [a, b, c, d] = chain();
    fs.writeFileSync(path.join(root, b.filePath), '// edited\nfunction normalizeInput() {}');
    let result = render([a, d]);
    expect(result.metadata.pathSearch).toMatchObject({ stopReason: 'source_incomplete', paths: [{ evidence: 'partial' }] });
    expect(result.text).not.toContain('**Directed paths');
    expect(result.emission.files.map(f => f.path)).not.toContain(b.filePath);
    expect(result.metadata.gaps.some(g => g.reason === 'stale')).toBe(true);
    fs.unlinkSync(path.join(root, c.filePath)); result = render([a, d]);
    expect(result.metadata.gaps.some(g => g.reason === 'unavailable')).toBe(true);
  });

  it('requires the registration declaration and will not claim an over-budget path', () => {
    const a = declaration('buildUi'); const b = declaration('onClick');
    const reg = declaration('wire', {}, 'function wire() {\n  if (enabled) { register(onClick); }\n}');
    edge(a, b, { kind: 'references', provenance: 'heuristic', metadata: { synthesizedBy: 'viewtree', via: 'onClick', registeredAt: 'wire.ets:2' } });
    const complete = render([a, b], 12000, { kind: 'events' });
    expect(complete.metadata.pathSearch?.paths[0]?.evidence).toBe('provided');
    expect(complete.emission.files.map(f => f.path)).toContain(reg.filePath);
    expect(complete.text).toContain('if (enabled)');
    const tiny = render([a, b], 500, { kind: 'events' });
    expect(tiny.text.length).toBeLessThanOrEqual(500);
    expect(tiny.metadata.pathSearch?.paths[0]?.evidence).toBe('partial');
    expect(tiny.text).not.toContain('**Directed paths');
    fs.unlinkSync(path.join(root, reg.filePath));
    expect(render([a, b], 12000, { kind: 'events' }).metadata.pathSearch?.stopReason).toBe('source_incomplete');
  });

  it('reaches the MCP boundary without a model call and supports first-batch ablation', async () => {
    const [a, b, c, d] = chain();
    const result = await new ToolHandler(graph).execute('homegraph_explore', { query: `${a.name} ${d.name}` });
    expect(result.isError).toBeFalsy();
    expect(result._meta?.homegraphEvidencePacks, result.content[0]?.text).toMatchObject({ version: 2,
      pathSearch: { paths: [{ nodeIds: [a.id, b.id, c.id, d.id], evidence: 'provided' }] } });
    vi.stubEnv('HOMEGRAPH_ARKTS_QUERY_PATHS', '0');
    const baseline = await new ToolHandler(graph).execute('homegraph_explore', { query: `${a.name} ${d.name}` });
    expect(baseline._meta?.homegraphEvidencePacks).toMatchObject({ version: 1 });
    expect((baseline._meta?.homegraphEvidencePacks as { pathSearch?: unknown }).pathSearch).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('recovers an exact qualified endpoint omitted by generic stopword filtering', async () => {
    const owner = declaration('Pipeline', { kind: 'class' });
    const start = declaration('pipelineStart', { name: 'start', qualifiedName: 'Pipeline::start' });
    const end = declaration('applyValue'); edge(start, end);
    const result = await new ToolHandler(graph).execute('homegraph_explore', { query: 'Pipeline.start applyValue' });
    expect(result._meta?.homegraphEvidencePacks, result.content[0]?.text).toMatchObject({
      pathSearch: { goal: { anchorIds: [start.id, end.id] }, paths: [{ evidence: 'provided' }] } });
    expect((result._meta?.homegraphEvidencePacks as { pathSearch: { goal: EvidencePathGoal } }).pathSearch.goal.anchorIds).not.toContain(owner.id);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
