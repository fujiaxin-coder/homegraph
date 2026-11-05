import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.resolve(HERE, '..', 'baseline', 'photos.stats.json');

function pct(cur, base) {
  if (base == null || base === 0) return cur === 0 ? 0 : null;
  return ((cur - base) / base) * 100;
}

function band(deltaPct, soft, hard) {
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

/** Enrich raw stats with L3 derived fields. */
export function enrichStats(stats) {
  const arkDirect = stats.arkCallsDirect ?? stats.callDirect ?? 0;
  const arkIndirect = stats.arkCallsIndirect ?? stats.callIndirect ?? 0;
  const arkCalls = stats.arkCallsTotal ?? stats.callArk ?? arkDirect + arkIndirect;
  const heuristicCalls = stats.callHeuristic ?? stats.callsByProvenanceClass?.['hg-heuristic'] ?? 0;
  const ratio = arkDirect > 0 ? arkIndirect / arkDirect : null;
  const fanoutTop = stats.fanoutTop || [];
  const topN = fanoutTop.slice(0, 10);
  const topNSum = topN.reduce((s, x) => s + (x.inDegree || 0), 0);
  const callEdges = stats.callEdges || 0;
  return {
    ...stats,
    arkCallsDirect: arkDirect,
    arkCallsIndirect: arkIndirect,
    arkCallsTotal: arkCalls,
    callHeuristic: heuristicCalls,
    callsByProvenanceClass: stats.callsByProvenanceClass || {
      arkanalyzer: arkCalls,
      'hg-heuristic': heuristicCalls,
    },
    callsBySynthesizedBy: stats.callsBySynthesizedBy || {},
    indirectDirectRatio: ratio == null ? null : Number(ratio.toFixed(3)),
    fanoutTop10Share: callEdges ? Number((topNSum / callEdges).toFixed(4)) : null,
    fanoutTop10Sum: topNSum,
    zeroCallFileCount: stats.zeroCallFileCount ?? 0,
  };
}

export function summarize(stats) {
  const s = enrichStats(stats);
  return {
    nodes: s.nodes,
    edges: s.edges,
    nodesByKind: s.nodesByKind,
    edgesByKind: s.edgesByKind,
    callEdges: s.callEdges,
    arkCallsDirect: s.arkCallsDirect,
    arkCallsIndirect: s.arkCallsIndirect,
    arkCallsTotal: s.arkCallsTotal,
    callHeuristic: s.callHeuristic ?? 0,
    callsByProvenanceClass: s.callsByProvenanceClass || {
      arkanalyzer: s.arkCallsTotal,
      'hg-heuristic': s.callHeuristic ?? 0,
    },
    callsBySynthesizedBy: s.callsBySynthesizedBy || {},
    indirectDirectRatio: s.indirectDirectRatio,
    fanoutTop10Share: s.fanoutTop10Share,
    fanoutTop10Sum: s.fanoutTop10Sum,
    zeroCallFileCount: s.zeroCallFileCount,
    zeroCallFilesSample: s.zeroCallFilesSample,
    fanoutTop: s.fanoutTop,
    etsFileNodes: s.etsFileNodes,
  };
}

export function scoreL3(stats, baseline) {
  const cur = summarize(stats);
  if (!baseline) {
    return {
      hasBaseline: false,
      message:
        'No baseline/photos.stats.json — wrote candidate; copy after review to enable bandwidth guards.',
      current: cur,
      deltas: [],
      alerts: [],
      absoluteGuards: absoluteGuards(cur),
    };
  }

  const base = summarize(baseline.stats || baseline);
  const deltas = [];
  const alerts = [];

  function push(name, current, previous, soft, hard) {
    const d = pct(current, previous);
    const b = band(d, soft, hard);
    const row = {
      name,
      current,
      previous,
      deltaPct: d == null ? null : Number(d.toFixed(2)),
      band: b,
    };
    deltas.push(row);
    if (b === 'warn' || b === 'alert') alerts.push(row);
  }

  // Core L3 bandwidths (densify / recall-collapse guards)
  push('arkCallsDirect', cur.arkCallsDirect, base.arkCallsDirect, 20, 50);
  push('arkCallsIndirect', cur.arkCallsIndirect, base.arkCallsIndirect, 25, 60);
  push('arkCallsTotal', cur.arkCallsTotal, base.arkCallsTotal, 20, 50);
  push('indirectDirectRatio', cur.indirectDirectRatio ?? 0, base.indirectDirectRatio ?? 0, 30, 80);
  push('fanoutTop10Share', cur.fanoutTop10Share ?? 0, base.fanoutTop10Share ?? 0, 25, 60);
  push('zeroCallFileCount', cur.zeroCallFileCount, base.zeroCallFileCount, 25, 60);
  push('nodes', cur.nodes, base.nodes, 10, 25);
  push('edges', cur.edges, base.edges, 10, 25);
  push('edgesByKind.calls', cur.edgesByKind?.calls || 0, base.edgesByKind?.calls || 0, 15, 40);
  push('edgesByKind.imports', cur.edgesByKind?.imports || 0, base.edgesByKind?.imports || 0, 15, 40);
  push('edgesByKind.extends', cur.edgesByKind?.extends || 0, base.edgesByKind?.extends || 0, 20, 50);
  push(
    'edgesByKind.implements',
    cur.edgesByKind?.implements || 0,
    base.edgesByKind?.implements || 0,
    20,
    50
  );
  push('edgesByKind.contains', cur.edgesByKind?.contains || 0, base.edgesByKind?.contains || 0, 15, 40);

  const abs = absoluteGuards(cur);
  alerts.push(...abs.filter((a) => a.band === 'alert' || a.band === 'warn'));

  return {
    hasBaseline: true,
    baselineCommit: baseline.commit || null,
    current: cur,
    deltas,
    alerts,
    absoluteGuards: abs,
    formulas: {
      arkCallsDirect:
        'AA calls with uniquely bound callee (dispatch=direct)',
      arkCallsIndirect:
        'AA calls with unbound/virtual/callback target (dispatch=indirect)',
      indirectDirectRatio:
        'arkCallsIndirect / arkCallsDirect — density of indirect vs direct AA edges',
      callHeuristic: 'calls with synthesizedBy ≠ arkanalyzer (HomeGraph synthesis)',
      fanoutTop10Share: 'sum(inDegree of top-10 callees) / callEdges',
      zeroCallFileCount: 'ets file nodes with no outbound calls edge',
      bandwidth: 'Δ% vs baseline → ok≤soft, warn≤hard, else alert',
    },
  };
}

/** Hard absolute ceilings — densify tripwires independent of baseline. */
function absoluteGuards(cur) {
  const out = [];
  // Historical densify ballpark was ~390k indirect — stay far below.
  const densifyCeil = 200000;
  out.push({
    name: 'arkCallsIndirect.absCeil',
    current: cur.arkCallsIndirect,
    limit: densifyCeil,
    band: cur.arkCallsIndirect >= densifyCeil ? 'alert' : cur.arkCallsIndirect >= densifyCeil * 0.5 ? 'warn' : 'ok',
    note: 'must stay well below densify-era ~390k',
  });
  if (cur.indirectDirectRatio != null && cur.indirectDirectRatio > 5000) {
    out.push({
      name: 'indirectDirectRatio.abs',
      current: cur.indirectDirectRatio,
      limit: 5000,
      band: 'warn',
      note: 'extreme indirect/direct skew',
    });
  }
  return out;
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

export function installBaselineFromCandidate(candidatePath, commit) {
  const doc = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  if (commit) doc.commit = commit;
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n');
  return BASELINE;
}

export { BASELINE };
