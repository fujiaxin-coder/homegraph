import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.resolve(HERE, '..', 'baseline', 'photos.stats.json');

const KIND_KEYS = [
  'file',
  'class',
  'struct',
  'interface',
  'method',
  'function',
  'component',
  'import',
  'property',
  'anonymous_method',
];
const EDGE_KEYS = ['calls', 'imports', 'extends', 'implements', 'contains', 'references'];

function pct(cur, base) {
  if (base == null || base === 0) return cur === 0 ? 0 : null;
  return ((cur - base) / base) * 100;
}

function band(deltaPct, soft = 15, hard = 40) {
  if (deltaPct == null) return 'no-baseline';
  const a = Math.abs(deltaPct);
  if (a <= soft) return 'ok';
  if (a <= hard) return 'warn';
  return 'alert';
}

export function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
}

export function scoreL3(stats, baseline) {
  if (!baseline) {
    return {
      hasBaseline: false,
      message: 'No baseline/photos.stats.json — write current stats as baseline after first good soak.',
      current: summarize(stats),
      deltas: [],
      alerts: [],
    };
  }

  const cur = summarize(stats);
  const base = baseline.stats || baseline;
  const deltas = [];
  const alerts = [];

  function push(name, current, previous, soft, hard) {
    const d = pct(current, previous);
    const b = band(d, soft, hard);
    const row = { name, current, previous, deltaPct: d == null ? null : Number(d.toFixed(2)), band: b };
    deltas.push(row);
    if (b === 'warn' || b === 'alert') alerts.push(row);
  }

  push('nodes', cur.nodes, base.nodes, 10, 25);
  push('edges', cur.edges, base.edges, 10, 25);
  push('callEdges', cur.callEdges, base.callEdges, 12, 35);
  push('callArk', cur.callArk, base.callArk, 12, 35);
  push('etsFileNodes', cur.etsFileNodes, base.etsFileNodes, 5, 15);
  push('zeroCallFileCount', cur.zeroCallFileCount, base.zeroCallFileCount, 20, 50);

  for (const k of KIND_KEYS) {
    push(`nodesByKind.${k}`, cur.nodesByKind[k] || 0, (base.nodesByKind || {})[k] || 0, 15, 40);
  }
  for (const k of EDGE_KEYS) {
    push(`edgesByKind.${k}`, cur.edgesByKind[k] || 0, (base.edgesByKind || {})[k] || 0, 15, 40);
  }

  // Fanout top-name drift: compare top callee keys
  const curTop = new Set((cur.fanoutTop || []).slice(0, 15).map((x) => `${x.file}|${x.name}`));
  const baseTop = new Set((base.fanoutTop || []).slice(0, 15).map((x) => `${x.file}|${x.name}`));
  let overlap = 0;
  for (const k of curTop) if (baseTop.has(k)) overlap++;
  const fanoutJaccard =
    curTop.size || baseTop.size ? overlap / new Set([...curTop, ...baseTop]).size : 1;
  deltas.push({
    name: 'fanoutTop15.jaccard',
    current: Number(fanoutJaccard.toFixed(3)),
    previous: 1,
    deltaPct: Number(((1 - fanoutJaccard) * 100).toFixed(2)),
    band: fanoutJaccard >= 0.5 ? 'ok' : fanoutJaccard >= 0.3 ? 'warn' : 'alert',
  });
  if (fanoutJaccard < 0.5) alerts.push(deltas[deltas.length - 1]);

  return {
    hasBaseline: true,
    baselineCommit: baseline.commit || null,
    current: cur,
    deltas,
    alerts,
  };
}

export function summarize(stats) {
  return {
    nodes: stats.nodes,
    edges: stats.edges,
    nodesByKind: stats.nodesByKind,
    edgesByKind: stats.edgesByKind,
    callEdges: stats.callEdges,
    callDirect: stats.callDirect,
    callIndirect: stats.callIndirect,
    callArk: stats.callArk,
    etsFileNodes: stats.etsFileNodes,
    zeroCallFileCount: stats.zeroCallFileCount,
    zeroCallFilesSample: stats.zeroCallFilesSample,
    fanoutTop: stats.fanoutTop,
  };
}

export function writeBaselineSuggestion(outDir, stats, commit) {
  const doc = {
    commit,
    updatedAt: new Date().toISOString(),
    stats: summarize(stats),
  };
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, 'photos.stats.candidate.json');
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  return p;
}

export { BASELINE };
