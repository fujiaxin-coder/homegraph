/** Public synthetic code only: real ArkAnalyzer + SQLite + ordinary MCP explore. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { HomeGraph } = require('../dist');
const { ToolHandler } = require('../dist/mcp/tools');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-implementation-smoke-'));
  const out = path.resolve(process.argv[2] || 'validation/054/implementation-smoke.json');
  const files = {
    'Page.ets': `import { ProductBadge } from './ProductBadge';\nimport { Product } from './Product';\n@Component\nexport struct CatalogPage {\n @State ready: boolean = false;\n item: Product = { id: 1 };\n update() { this.ready = true; }\n build() {\n  Column() {\n   ProductBadge({ item: this.item })\n   Image(this.ready ? $r('app.media.active') : $r('app.media.inactive')).onClick(() => { if (!this.ready) return; this.update(); })\n  }\n }\n}\n`,
    'ProductBadge.ets': `import { Product } from './Product';\n@Component\nexport struct ProductBadge {\n @Prop item: Product;\n build() {\n  Text('Badge').enabled(this.item.id > 0)\n }\n}\n`,
    'Product.ets': 'export interface Product {\n id: number;\n}\n',
    'oh-package.json5': "{name: 'catalog', dependencies: {}}",
  };
  let graph;
  try {
    Object.assign(process.env, { HOMEGRAPH_QUERY_PLANNER: 'rules', HOMEGRAPH_MCP_CACHE: '1', HOMEGRAPH_ARKTS_EVIDENCE_LOG: '1' });
    global.fetch = async () => { throw new Error('Unexpected model/network request'); };
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    graph = HomeGraph.initSync(root);
    const index = await graph.indexAll(); assert.ok(index.success);
    const nodes = graph.getNodesInFile('Page.ets');
    const result = await new ToolHandler(graph).execute('homegraph_explore', { query: 'CatalogPage ProductBadge render structure' });
    const audit = fs.readFileSync(path.join(root, '.homegraph/evidence-packs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ scope: 'Synthetic real-index regression, no model inference or accuracy measurement', files, index,
      nodes, edges: nodes.flatMap(n => graph.getOutgoingEdges(n.id)), result, audit, results: { implementation: result } }, null, 2));
    assert.ok(!result.isError);
    assert.equal(audit[0]?.stage, 'arkts_pack_before_host_wrapping');
    assert.ok(audit[0]?.output?.text.includes('id: number'));
    assert.equal(result._meta?.homegraphEvidenceAudit, 'written');
    const meta = result._meta?.homegraphEvidencePacks;
    assert.ok(meta, 'Expected evidence pack from normal explore');
    assert.ok(meta.implementationContext?.length, 'Expected implementation context');
    assert.ok(meta.controls?.some(c => c.control === 'Image' && c.enabled === 'binding_not_observed'), 'Expected icon enablement gap');
    assert.ok(result.content[0].text.includes('id: number'), 'Expected imported Product fields');
    assert.ok(result.content[0].text.includes('oh-package.json5'), 'Expected module dependency snapshot');
    console.log(JSON.stringify({ out, contexts: meta.implementationContext.length, controls: meta.controls.length, status: meta.status }));
  } finally { graph?.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
