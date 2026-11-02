/**
 * Index project/ → viewer/graph-data.json for the HTML graph viewer.
 * Usage: node test/harmony-graph-stability/export-graph.mjs
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const { HomeGraph } = await import(pathToFileURL(path.join(ROOT, 'dist/index.js')).href);
const ctx = await import(pathToFileURL(path.join(ROOT, 'dist/extraction/context.js')).href);
const ark = await import(pathToFileURL(path.join(ROOT, 'dist/extraction/languages/arkts.js')).href);

const src = path.join(HERE, 'project');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-export-'));
fs.cpSync(src, tmp, { recursive: true });
ark.resetArkTSBatch();
ctx.resetExtractionContext();

const cg = HomeGraph.initSync(tmp);
try {
  await cg.indexAll();
  const qb = cg.getQueryBuilder();
  const nodes = qb.getAllNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const edges = [];
  for (const n of nodes) {
    for (const e of cg.getOutgoingEdges(n.id)) {
      const k = `${e.source}\0${e.target}\0${e.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push(e);
    }
  }

  const norm = (p) => String(p || '').replace(/\\/g, '/');
  const moduleOf = (file) => {
    const m = norm(file).match(/^(mod_[a-z])/);
    return m ? m[1] : 'other';
  };

  const outNodes = nodes
    .filter((n) => !norm(n.filePath).includes('@dummy'))
    .map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      file: norm(n.filePath),
      module: moduleOf(n.filePath),
      startLine: n.startLine,
      endLine: n.endLine,
    }));

  const idSet = new Set(outNodes.map((n) => n.id));
  const outEdges = edges
    .filter((e) => idSet.has(e.source) && idSet.has(e.target))
    .map((e) => ({
      id: `${e.source}->${e.target}:${e.kind}`,
      source: e.source,
      target: e.target,
      kind: e.kind,
      synth: e.metadata?.synthesizedBy ?? null,
      via: e.metadata?.via ?? null,
      direct: e.metadata?.direct ?? null,
    }));

  const payload = {
    meta: {
      fixture: 'project/',
      generatedAt: new Date().toISOString(),
      nodeCount: outNodes.length,
      edgeCount: outEdges.length,
    },
    nodes: outNodes,
    edges: outEdges,
  };

  const viewerDir = path.join(HERE, 'viewer');
  fs.mkdirSync(viewerDir, { recursive: true });
  const outPath = path.join(viewerDir, 'graph-data.json');
  const jsPath = path.join(viewerDir, 'graph-data.js');
  const json = JSON.stringify(payload);
  fs.writeFileSync(outPath, json);
  // file:// 打不开 fetch；同步写 JS 便于双击打开 index.html
  fs.writeFileSync(jsPath, `window.GRAPH_DATA = ${json};\n`);
  console.log(`wrote ${outPath} + graph-data.js nodes=${outNodes.length} edges=${outEdges.length}`);
} finally {
  cg.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
