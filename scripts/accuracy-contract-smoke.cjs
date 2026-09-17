/** Synthetic public requirements → real ArkAnalyzer/SQLite → ordinary explore.
 * Planner JSON is a fixed provider fixture; no model or codingeval execution.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { HomeGraph } = require('../dist');
const { ToolHandler } = require('../dist/mcp/tools');
const query = 'Explain how the “保存” button in “账户设置” follows the input state, then inspect the binding. 输入完整后启用“保存”。';
const contract = { targets: [
  { id: 'page', text: '账户设置', role: 'page', presence: 'existing', objectKind: 'ui' },
  { id: 'save', text: '保存', role: 'literal', presence: 'existing', objectKind: 'ui' },
], obligations: [{ id: 'enabled', text: '输入完整后启用“保存”', kind: 'enabled', targetId: 'save' }] };
const page = (binding = '') => `@Entry
@Component
struct AccountPage {
  @State ready: boolean = false;
  onTap() { if (!this.ready) return; }
  build() {
    Column() {
      Text('账户设置')
      Button('保存')${binding}.onClick(() => this.onTap())
    }
  }
}
`;
async function main() {
  const output = path.resolve(process.argv[2] || 'validation/accuracy-smoke.json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-accuracy-smoke-'));
  const files = { 'AccountPage.ets': page(), 'OtherPage.ets': '@Component\nstruct OtherPage {\n build() {\n  Button("保存")\n }\n}\n' };
  let graph; let requests = 0;
  try {
    Object.assign(process.env, { HOMEGRAPH_QUERY_PLANNER: 'llm', HOMEGRAPH_QUERY_PLANNER_URL: 'https://fixture.invalid/v1',
      HOMEGRAPH_QUERY_PLANNER_API_KEY: 'fixture', HOMEGRAPH_QUERY_PLANNER_MODEL: 'fixture', HOMEGRAPH_MCP_CACHE: '1',
      HOMEGRAPH_ARKTS_EVIDENCE_PACKS: '1', HOMEGRAPH_ACCURACY_TARGETS: '1', HOMEGRAPH_ACCURACY_COVERAGE: '1' });
    global.fetch = async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      canonicalQuery: query, intent: 'general', confidence: 0.9, anchors: [], searchTerms: ['保存'], requestContract: contract,
      steps: [{ id: 'locate', query: '保存', intent: 'general', anchors: [], dependsOn: [] }],
    }) } }] })); };
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    graph = HomeGraph.initSync(root); const index = await graph.indexAll(); assert.ok(index.success);
    const handler = new ToolHandler(graph); const results = {};
    results.appearanceOnly = await handler.execute('homegraph_explore', { query, taskContext: query });
    fs.writeFileSync(path.join(root, 'AccountPage.ets'), page('.enabled(this.ready)'));
    results.stale = await handler.execute('homegraph_explore', { query, taskContext: query });
    const reindex = await graph.indexAll(); assert.ok(reindex.success);
    results.binding = await handler.execute('homegraph_explore', { query, taskContext: query });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ scope: 'Synthetic real-index regression; fixed planner fixture; no inference or accuracy measurement',
      files, changedSource: page('.enabled(this.ready)'), query, index, reindex, plannerFixtureCalls: requests, results }, null, 2));
    const behavior = name => results[name]._meta?.homegraphEvidencePacks?.requestEvidence?.behaviors[0]?.status;
    assert.equal(behavior('appearanceOnly'), 'binding_not_observed');
    assert.equal(behavior('stale'), 'unknown');
    assert.equal(behavior('binding'), 'binding_observed');
    assert.equal(requests, 3);
    for (const result of Object.values(results)) assert.ok(!result.isError);
    process.stdout.write(JSON.stringify({ output, plannerFixtureCalls: requests,
      behaviors: Object.fromEntries(Object.keys(results).map(name => [name, behavior(name)])) }, null, 2) + '\n');
  } finally { graph?.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
