/** Real ArkAnalyzer → SQLite → MCP, two strategies over one synthetic index. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { HomeGraph } = require('../dist');
const { ToolHandler } = require('../dist/mcp/tools');

const files = {
  'DemoPage.ets': `import { PipelineStart } from './PipelineStart';
@Entry
@Component
struct DemoPage {
  build() {
    Button('Apply').onClick(() => { PipelineStart.start(12); })
  }
}
`,
  'PipelineStart.ets': `import { NormalizeInput } from './NormalizeInput';
import { AuditLog } from './AuditLog';
export class PipelineStart {
  static start(value: number): number {
    AuditLog.record(value);
    return NormalizeInput.clean(value);
  }
}
`,
  'NormalizeInput.ets': `import { ClampInput } from './ClampInput';
export class NormalizeInput {
  static clean(value: number): number {
    if (value < 0) {
      return ClampInput.clamp(0);
    } else {
      return ClampInput.clamp(value);
    }
  }
}
`,
  'ClampInput.ets': `import { ValueStore } from './ValueStore';
export class ClampInput {
  static clamp(value: number): number {
    return ValueStore.apply(Math.min(value, 100));
  }
}
`,
  'ValueStore.ets': `export class ValueStore {
  static apply(value: number): number {
    return value * 2;
  }
}
`,
  'AuditLog.ets': `export class AuditLog {
  static record(value: number): void {
    console.info('Observed input', value);
  }
}
`,
};

async function main() {
  const output = path.resolve(process.argv[2] || 'validation/query-path-smoke.json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-query-path-smoke-'));
  let graph;
  try {
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    process.env.HOMEGRAPH_QUERY_PLANNER = 'rules';
    process.env.HOMEGRAPH_MCP_CACHE = '0';
    process.env.HOMEGRAPH_ARKTS_EVIDENCE_PACKS = '1';
    global.fetch = async () => { throw new Error('Unexpected network call in local smoke'); };
    graph = HomeGraph.initSync(root);
    const index = await graph.indexAll();
    assert.ok(index.success);
    const query = 'PipelineStart.start ValueStore.apply';
    const results = {};
    for (const [name, flag] of [['batch1', '0'], ['batch2', '1']]) {
      process.env.HOMEGRAPH_ARKTS_QUERY_PATHS = flag;
      results[name] = await new ToolHandler(graph).execute('homegraph_explore', { query });
      assert.ok(!results[name].isError);
    }
    // Save raw results before assertions so a failed check remains diagnosable.
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const indexedNodes = Object.keys(files).flatMap(file => graph.getNodesInFile(file));
    const indexedEdges = indexedNodes.flatMap(n => graph.getOutgoingEdges(n.id));
    fs.writeFileSync(output, JSON.stringify({ scope: 'synthetic retrieval correctness; no model/inference latency measurement',
      query, files, index, indexedNodes, indexedEdges, results }, null, 2) + '\n');
    const metadata = results.batch2._meta?.homegraphEvidencePacks;
    assert.equal(metadata?.version, 2);
    assert.equal(metadata?.pathSearch?.stopReason, 'supported');
    assert.equal(metadata?.pathSearch?.paths[0]?.evidence, 'provided');
    const names = metadata.pathSearch.paths[0].nodeIds.map(id => graph.getNode(id).qualifiedName.replace(/::/g, '.'));
    assert.deepEqual(names, ['PipelineStart.start', 'NormalizeInput.clean', 'ClampInput.clamp', 'ValueStore.apply']);
    const text = results.batch2.content[0].text;
    assert.ok(text.includes('if (value < 0)'));
    assert.ok(text.includes('} else {'));
    assert.ok(!metadata.relations.some(e => graph.getNode(e.target)?.qualifiedName === 'AuditLog.record'));
    const summary = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, {
      chars: result.content[0].text.length,
      evidence: result._meta?.homegraphEvidencePacks,
    }]));
    process.stdout.write(JSON.stringify({ output, names, summary }, null, 2) + '\n');
  } finally {
    graph?.destroy(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
