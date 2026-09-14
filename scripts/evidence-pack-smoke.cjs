/** Synthetic source → real ArkAnalyzer index → MCP tool handler. No model/benchmark access. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { HomeGraph } = require('../dist');
const { ToolHandler } = require('../dist/mcp/tools');
const { ExploreSessionState } = require('../dist/mcp/explore-session-state');

const files = {
  'CounterPage.ets': `import { CounterStore } from './CounterStore';
@Entry
@Component
struct CounterPage {
  @State count: number = 0;
  @State enabled: boolean = true;
  onTap(): void {
    if (this.enabled) {
      this.count = CounterStore.increment(this.count);
    } else {
      this.count = 0;
    }
  }
  build() {
    Button('Increment').onClick(() => { this.onTap(); })
  }
}
`,
  'CounterStore.ets': `export class CounterStore {
  static increment(value: number): number {
    return value + 1;
  }
}
`,
};

async function main() {
  const output = path.resolve(process.argv[2] || 'validation/evidence-smoke.json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-pack-smoke-'));
  let graph;
  try {
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    process.env.HOMEGRAPH_QUERY_PLANNER = 'rules';
    process.env.HOMEGRAPH_MCP_CACHE = '0';
    global.fetch = async () => { throw new Error('Unexpected network call in local smoke'); };
    graph = HomeGraph.initSync(root);
    const index = await graph.indexAll();
    assert.ok(index.success);
    const query = 'CounterPage.onTap CounterPage.build CounterStore.increment';
    const results = {};
    for (const [name, flag] of [['legacy', '0'], ['packs', '1']]) {
      process.env.HOMEGRAPH_ARKTS_EVIDENCE_PACKS = flag;
      const handler = new ToolHandler(graph);
      const session = new ExploreSessionState();
      results[name] = await handler.execute('homegraph_explore', { query }, session);
      assert.ok(!results[name].isError);
    }
    const text = results.packs.content.map(p => p.text).join('\n');
    assert.ok(results.packs._meta.homegraphEvidencePacks);
    assert.ok(text.includes('if (this.enabled)'));
    assert.ok(text.includes('} else {'));
    assert.ok(text.includes('return value + 1;'));
    assert.ok(text.includes('.onClick'));
    assert.ok(!text.includes('@dummyFile'));
    assert.ok(!results.packs._meta.homegraphEvidencePacks.gaps.some(g => g.target.includes('CounterPage @') || g.target.includes('CounterStore @')));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ scope: 'synthetic correctness smoke; no model latency measurement',
      query, files, results }, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ output, legacyChars: results.legacy.content[0].text.length,
      packChars: text.length, status: results.packs._meta.homegraphEvidencePacks.status }) + '\n');
  } finally {
    graph?.destroy(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
