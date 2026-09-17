import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import HomeGraph from '../src/index';
import type { Node } from '../src/types';
import { buildRuleQueryPlan, type QueryPlan } from '../src/search/query-plan';
import type { RequestContract } from '../src/search/request-contract';
import { buildArktsEvidencePacks } from '../src/mcp/arkts-evidence-packs';
import { ToolHandler } from '../src/mcp/tools';
import { findLiteralEvidence } from '../src/search/literal-evidence';
const query = '在“账户设置”页面找到“保存”按钮的状态来源，输入完整后启用“保存”。';
const contract: RequestContract = { targets: [
  { id: 'page', text: '账户设置', role: 'page', presence: 'existing', objectKind: 'ui' },
  { id: 'save', text: '保存', role: 'literal', presence: 'existing', objectKind: 'ui' },
], obligations: [{ id: 'enabled', text: '输入完整后启用“保存”', kind: 'enabled', targetId: 'save' }] };
describe('request evidence with real source and SQLite', () => {
  let root: string; let graph: HomeGraph; let nodes: Node[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-request-evidence-'));
    graph = HomeGraph.initSync(root); graph.setBuildPhase('full'); nodes = [];
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'rules'); vi.stubEnv('HOMEGRAPH_MCP_CACHE', '1');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected model request'); }));
  });
  afterEach(() => { graph.destroy(); fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  function add(name: string, source: string): Node {
    const file = `${name}.ets`; fs.writeFileSync(path.join(root, file), source);
    const node: Node = { id: name, name, qualifiedName: name, kind: 'component', language: 'arkts', filePath: file,
      startLine: 1, endLine: source.split('\n').length };
    graph.getQueryBuilder().upsertFile({ path: file, contentHash: createHash('sha256').update(source).digest('hex'),
      size: Buffer.byteLength(source), language: 'arkts', modifiedAt: Date.now(), indexedAt: Date.now(), nodeCount: 1 });
    graph.getQueryBuilder().insertNodes([node]); nodes.push(node); return node;
  }
  const source = (binding = '') => `@Component\nstruct AccountPage {\n  @State ready: boolean = false;\n  build() { Column() {\n    Text('账户设置')\n    Button('保存')${binding}\n  } }\n}`;
  const render = (maxChars = 12000, focus = nodes) => buildArktsEvidencePacks(graph, { projectRoot: root, query, nodes,
    focusIds: new Set(focus.map(n => n.id)), maxChars, requestContract: contract })!;
  it('prioritizes joint page/literal evidence before an alphabetically earlier distractor', () => {
    add('AOther', "@Component struct AOther { build() { Button('保存') } }");
    const right = add('ZAccount', source());
    const full = render();
    expect(full.metadata.selectedPacks[0]).toBe(`source:${right.id}`);
    expect(full.metadata.requestEvidence?.targets[1]?.status).toBe('ambiguous');
  });
  it('keeps behavioral evidence separate even when source coverage is complete', () => {
    add('AccountPage', source('.onClick(() => { if (!this.ready) return; })'));
    const result = render(12000, []);
    expect(result.metadata.status).toBe('complete');
    expect(result.metadata.requestEvidence?.behaviors[0]?.status).toBe('binding_not_observed');
  });
  it('never claims a positive binding whose complete source did not fit', () => {
    add('AccountPage', source('.enabled(this.ready)') + '\n/*' + 'padding '.repeat(600) + '*/');
    const result = render(1600);
    expect(result.text.length).toBeLessThanOrEqual(1600);
    expect(result.emission.files).toEqual([]);
    expect(result.metadata.requestEvidence?.behaviors[0]?.status).toBe('unknown');
    expect(result.text).not.toContain('binding_observed');
  });
  it('invalidates same-timestamp source changes before reporting a binding', () => {
    const node = add('AccountPage', source('.enabled(this.ready)'));
    expect(render().metadata.requestEvidence?.behaviors[0]?.status).toBe('binding_observed');
    const file = path.join(root, node.filePath); const stat = fs.statSync(file);
    fs.writeFileSync(file, source()); fs.utimesSync(file, stat.atime, stat.mtime);
    const result = render();
    expect(result.metadata.requestEvidence?.behaviors[0]?.status).toBe('unknown');
    expect(result.metadata.gaps.some(g => g.reason === 'stale')).toBe(true);
    expect(result.emission.files).toEqual([]);
  });
  it('keeps both labels on the same line and an occurrence after a leading comment', () => {
    add('AccountPage', "// 保存\n@Component struct Page {\n build() { Text('账户设置'); Button('保存') }\n}");
    const found = findLiteralEvidence(root, { literalTexts: ['保存', '账户设置'] });
    expect(found.hits.some(h => h.literal === '保存' && h.line === 3)).toBe(true);
    expect(found.hits.filter(h => h.line === 3).map(h => h.literal).sort()).toEqual(['保存', '账户设置'].sort());
  });
  it('runs through public explore with one retrieval/planner pass and no stale query cache', async () => {
    const node = add('AccountPage', source('.enabled(this.ready)'));
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'llm'); vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_URL', 'https://planner.invalid/v1');
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_MODEL', 'fixture'); vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', 'fixture');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      canonicalQuery: query, intent: 'general', confidence: 0.9, anchors: [], searchTerms: ['保存'], requestContract: contract,
      steps: [{ id: 'locate', query: '保存', intent: 'general', anchors: [], dependsOn: [] }],
    }) } }] })));
    vi.stubGlobal('fetch', fetcher);
    const handler = new ToolHandler(graph);
    const first = await handler.execute('homegraph_explore', { query, taskContext: query });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first._meta?.homegraphEvidencePacks).toMatchObject({ requestEvidence: { runtimeVerified: false,
      behaviors: [{ status: 'binding_observed' }] } });
    fs.writeFileSync(path.join(root, node.filePath), source());
    const second = await handler.execute('homegraph_explore', { query, taskContext: query });
    expect(second._meta?.homegraphEvidencePacks).toMatchObject({ requestEvidence: { behaviors: [{ status: 'unknown' }] } });
    expect(second.content[0]?.text).not.toContain('binding_observed');
  });
  it('preserves exact usage routing under a larger UI task', async () => {
    add('AccountPage', source());
    const plan: QueryPlan = { ...buildRuleQueryPlan(query), source: 'llm', intent: 'usages', route: 'usages', anchors: ['AccountPage'], requestContract: contract,
      steps: [{ id: 'uses', query: 'AccountPage usages', intent: 'usages', anchors: ['AccountPage'], relation: 'incoming_references', dependsOn: [] }] };
    const result = await (new ToolHandler(graph) as any).executeQueryPlan({ projectPath: root }, plan);
    expect(result.content[0]?.text).toContain('HomeGraph specialized route: usages');
    expect(result._meta?.homegraphEvidencePacks).toBeUndefined();
  });
  it('retains the resource value and reference together instead of dropping the value', async () => {
    add('AccountPage', source().replace("Button('保存')", "Button($r('app.string.save_label'))"));
    const resource = path.join(root, 'entry/src/main/resources/base/element/string.json');
    fs.mkdirSync(path.dirname(resource), { recursive: true });
    fs.writeFileSync(resource, '{"string":[{"name":"save_label","value":"保存"}]}');
    const result = await new ToolHandler(graph).execute('homegraph_explore', { query: 'AccountPage build “保存” 状态来源', taskContext: query });
    expect(result.content[0]?.text).toContain('app.string.save_label');
    expect(result.content[0]?.text).toContain('string.json');
    expect(result._meta?.homegraphEvidencePacks).toBeUndefined();
  });
  it('turns behavioral reporting off independently without losing target verification', () => {
    add('AccountPage', source('.enabled(this.ready)')); vi.stubEnv('HOMEGRAPH_ACCURACY_COVERAGE', '0');
    const result = render();
    expect(result.metadata.requestEvidence?.behaviors).toEqual([]);
    expect(result.metadata.requestEvidence?.targets[0]?.status).toBe('observed');
    expect(result.text).not.toContain('Behavior enabled');
  });
});
