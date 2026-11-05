/** Gold + graph coverage proportions for the soak report. */

import { normPath } from './match.mjs';

function inc(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

function pctMap(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const [k, v] of Object.entries(counts)) {
    out[k] = { count: v, pct: Number(((v / total) * 100).toFixed(1)) };
  }
  return { total, by: out };
}

export function moduleKey(file) {
  const p = normPath(file);
  const m = p.match(
    /^(feature|product|common|browserCommon|browserCommonPC|browserCommonPhone|AppScope|imageEditor|demo|tools)\/([^/]+)/
  );
  if (m) return `${m[1]}/${m[2]}`;
  return p.split('/')[0] || p;
}

export function isTestPath(file) {
  const p = normPath(file);
  return /\/test\//i.test(p) || /\.(test|spec)\./i.test(p) || /ohosTest/i.test(p);
}

export function scopeOf(callerFile, calleeFile) {
  const a = normPath(callerFile);
  const b = normPath(calleeFile);
  if (a === b) return 'same-file';
  if (moduleKey(a) !== moduleKey(b)) return 'cross-module';
  return 'cross-file';
}

export function goldCoverage(edges) {
  const kind = {};
  const scope = {};
  const suite = {};
  const bucket = {};
  const label = {};
  const callerNodeKind = {};
  const calleeNodeKind = {};
  for (const e of edges) {
    inc(kind, e.kind || 'calls');
    inc(scope, e.scope || scopeOf(e.callerFile, e.calleeFile));
    inc(suite, e.suite || (isTestPath(e.callerFile) ? 'test' : 'prod'));
    inc(bucket, e.bucket || '?');
    inc(label, e.label || (e.status === 'deferred' ? 'deferred' : 'true'));
    if (e.callerNodeKind) inc(callerNodeKind, e.callerNodeKind);
    if (e.calleeNodeKind) inc(calleeNodeKind, e.calleeNodeKind);
  }
  return {
    kind: pctMap(kind),
    scope: pctMap(scope),
    suite: pctMap(suite),
    bucket: pctMap(bucket),
    label: pctMap(label),
    callerNodeKind: pctMap(callerNodeKind),
    calleeNodeKind: pctMap(calleeNodeKind),
  };
}

export function graphCoverage(stats) {
  return {
    nodesByKind: pctMap(stats.nodesByKind || {}),
    edgesByKind: pctMap(stats.edgesByKind || {}),
    callsByProvenanceClass: pctMap(stats.callsByProvenanceClass || {}),
    callsBySynthesizedBy: pctMap(stats.callsBySynthesizedBy || {}),
  };
}

/** Target floors for gold diversity (report warns if below). */
export const GOLD_KIND_FLOORS = {
  calls: 0.35,
  imports: 0.1,
  extends: 0.05,
  implements: 0.03,
  contains: 0.05,
};

export const GOLD_SCOPE_FLOORS = {
  'cross-module': 0.2,
  'cross-file': 0.15,
  'same-file': 0.15,
};

export function coverageAlerts(cov) {
  const alerts = [];
  const kindTotal = cov.kind.total || 1;
  for (const [k, floor] of Object.entries(GOLD_KIND_FLOORS)) {
    const pct = (cov.kind.by[k]?.count || 0) / kindTotal;
    if (pct < floor) {
      alerts.push(
        `gold kind ${k} share ${(pct * 100).toFixed(1)}% < floor ${(floor * 100).toFixed(0)}%`
      );
    }
  }
  const scopeTotal = cov.scope.total || 1;
  for (const [k, floor] of Object.entries(GOLD_SCOPE_FLOORS)) {
    const pct = (cov.scope.by[k]?.count || 0) / scopeTotal;
    if (pct < floor) {
      alerts.push(
        `gold scope ${k} share ${(pct * 100).toFixed(1)}% < floor ${(floor * 100).toFixed(0)}%`
      );
    }
  }
  return alerts;
}
