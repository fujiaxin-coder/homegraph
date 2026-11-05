import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

/**
 * Open existing .homegraph or init+index.
 * Returns { nodes, edges, stats, meta }
 */
export async function indexProject(root, { skipIndex = false } = {}) {
  const distEntry = path.join(REPO, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    throw new Error('dist/ missing — run npm run build first');
  }
  const mod = await import(pathToFileURL(distEntry).href);
  const { HomeGraph } = mod;

  const marker = path.join(root, '.homegraph');
  let cg;
  const t0 = Date.now();
  if (fs.existsSync(marker) && skipIndex) {
    console.error('Opening existing .homegraph (skip-index)…');
    cg = HomeGraph.openSync(root);
  } else if (fs.existsSync(marker)) {
    cg = HomeGraph.initSync(root);
    console.error('Re-indexing (existing .homegraph)…');
    await cg.indexAll();
  } else {
    cg = HomeGraph.initSync(root);
    console.error('Indexing from scratch…');
    await cg.indexAll();
  }
  const indexMs = Date.now() - t0;

  const qb = cg.getQueryBuilder();
  const nodes = qb.getAllNodes();
  const edges = [];
  const seen = new Set();
  for (const n of nodes) {
    for (const e of cg.getOutgoingEdges(n.id)) {
      // Keep AA + heuristic parallels between the same endpoints (provenance arms need both).
      const synth = e.metadata?.synthesizedBy ?? '';
      const k = `${e.source}\0${e.target}\0${e.kind}\0${synth}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push(e);
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const actualEdges = [];
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const synth = e.metadata?.synthesizedBy;
    actualEdges.push({
      kind: e.kind,
      callerFile: norm(s.filePath),
      callerName: s.name,
      callerStart: s.startLine,
      callerKind: s.kind,
      calleeFile: norm(t.filePath),
      calleeName: t.name,
      calleeStart: t.startLine,
      calleeKind: t.kind,
      synthesizedBy: synth != null ? String(synth) : undefined,
      via: e.metadata?.via != null ? String(e.metadata.via) : undefined,
      dispatch:
        e.metadata?.dispatch != null
          ? String(e.metadata.dispatch)
          : e.metadata?.direct === true
            ? 'direct'
            : e.metadata?.direct === false
              ? 'indirect'
              : undefined,
    });
  }

  const nodesByKind = {};
  const edgesByKind = {};
  for (const n of nodes) nodesByKind[n.kind] = (nodesByKind[n.kind] || 0) + 1;
  for (const e of edges) edgesByKind[e.kind] = (edgesByKind[e.kind] || 0) + 1;

  const calls = actualEdges.filter((e) => e.kind === 'calls');
  const arkCalls = calls.filter((c) => !c.synthesizedBy || c.synthesizedBy === 'arkanalyzer');
  const heuristicCalls = calls.filter(
    (c) => c.synthesizedBy && c.synthesizedBy !== 'arkanalyzer'
  );
  const arkDirect = arkCalls.filter((c) => c.dispatch === 'direct');
  const arkIndirect = arkCalls.filter((c) => c.dispatch === 'indirect');
  const callsBySynthesizedBy = {};
  for (const c of calls) {
    const k = c.synthesizedBy || 'arkanalyzer';
    callsBySynthesizedBy[k] = (callsBySynthesizedBy[k] || 0) + 1;
  }
  const fanout = new Map();
  for (const c of calls) {
    const k = `${c.calleeFile}\0${c.calleeName}`;
    fanout.set(k, (fanout.get(k) || 0) + 1);
  }
  const fanoutTop = [...fanout.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([k, n]) => {
      const [file, name] = k.split('\0');
      return { file, name, inDegree: n };
    });

  const filesWithCalls = new Set(calls.map((c) => c.callerFile));
  const etsFiles = nodes.filter((n) => n.kind === 'file' && /\.ets$/i.test(n.filePath || n.name || ''));
  const zeroCallFiles = etsFiles
    .map((n) => norm(n.filePath))
    .filter((f) => f && !filesWithCalls.has(f));

  const stats = {
    nodes: nodes.length,
    edges: edges.length,
    nodesByKind,
    edgesByKind,
    callEdges: calls.length,
    callDirect: calls.filter((c) => c.dispatch === 'direct').length,
    callIndirect: calls.filter((c) => c.dispatch === 'indirect').length,
    callArk: arkCalls.length,
    callHeuristic: heuristicCalls.length,
    arkCallsDirect: arkDirect.length,
    arkCallsIndirect: arkIndirect.length,
    arkCallsTotal: arkCalls.length,
    arkCallsUnknownDispatch: arkCalls.filter(
      (c) => c.dispatch !== 'direct' && c.dispatch !== 'indirect'
    ).length,
    callsByProvenanceClass: {
      arkanalyzer: arkCalls.length,
      'hg-heuristic': heuristicCalls.length,
    },
    callsBySynthesizedBy,
    fanoutTop,
    zeroCallFileCount: zeroCallFiles.length,
    zeroCallFilesSample: zeroCallFiles.slice(0, 20),
    etsFileNodes: etsFiles.length,
  };

  const meta = {
    root,
    indexMs,
    homegraphDist: distEntry,
    skipIndex,
  };

  return {
    cg,
    nodes,
    edges: actualEdges,
    stats,
    meta,
    close: () => {
      try {
        cg.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export function packageVersions() {
  try {
    const pkg = require(path.join(REPO, 'package.json'));
    return {
      homegraphVersion: pkg.version,
      arkanalyzer: pkg.dependencies?.arkanalyzer || null,
    };
  } catch {
    return {};
  }
}
