/**
 * Build bucket G gold:
 *  - must: source-audited true HG heuristic bridges
 *  - must-not: heuristic edges that EXIST in the index but are wrong / over-approx noise
 *
 * Run: node test/harmony-callgraph-soak/tools/gen-g-heuristic-gold.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOAK = path.resolve(HERE, '..');
const candPath = path.join(SOAK, 'out', 'heuristic-candidates.json');
const fpPath = path.join(SOAK, 'out', 'heuristic-fp-candidates.json');
const goldDir = path.join(SOAK, 'gold');

const c = JSON.parse(fs.readFileSync(candPath, 'utf8'));
const fpDoc = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
const fps = fpDoc.fps || {};

function scopeOf(a, b) {
  const ma = a.split('/').slice(0, 2).join('/');
  const mb = b.split('/').slice(0, 2).join('/');
  if (a === b) return 'same-file';
  if (ma !== mb) return 'cross-module';
  return 'cross-file';
}

function pick(arr, n, pred = () => true) {
  return (arr || []).filter(pred).slice(0, n);
}

function toMust(e) {
  const evidence =
    e.registeredAt && String(e.registeredAt).includes(':')
      ? String(e.registeredAt).replace(/\\/g, '/')
      : `${e.callerFile}:${e.evidenceLine || e.callerStart}`;
  return {
    kind: 'calls',
    callerFile: e.callerFile,
    callerName: e.callerName,
    callerStart: e.callerStart,
    callerNodeKind: e.callerKind,
    calleeFile: e.calleeFile,
    calleeName: e.calleeName,
    calleeStart: e.calleeStart,
    calleeNodeKind: e.calleeKind,
    bucket: 'G',
    label: 'true',
    scope: scopeOf(e.callerFile, e.calleeFile),
    suite: 'prod',
    evidence,
    note: `hg-heuristic:${e.synthesizedBy}${e.via ? ' via ' + e.via : ''}`,
    status: 'active',
    provenance: 'source-audit+index-candidate',
    expectedSynthesizedBy: e.synthesizedBy,
  };
}

function toMustNot(e, note) {
  return {
    kind: 'calls',
    callerFile: e.callerFile,
    callerName: e.callerName,
    callerStart: e.callerStart,
    callerNodeKind: e.callerKind,
    calleeFile: e.calleeFile,
    calleeName: e.calleeName,
    calleeStart: e.calleeStart,
    calleeNodeKind: e.calleeKind,
    bucket: 'G',
    label: 'false',
    scope: scopeOf(e.callerFile, e.calleeFile),
    suite: 'prod',
    evidence: e.registeredAt || `${e.callerFile}:${e.callerStart || 1}`,
    note:
      note ||
      `false hg-heuristic:${e.synthesizedBy}${e.via ? ' via ' + e.via : ''}`,
    status: 'active',
    provenance: 'source-audit-fp-in-index',
    expectedSynthesizedBy: e.synthesizedBy,
  };
}

function keyOf(e) {
  return `${e.callerFile}|${e.callerName}|${e.calleeFile}|${e.calleeName}`;
}

// --- MUST: keep high-confidence true bridges ---
const ifaceMust = pick(c['interface-impl'], 12, (e) => {
  if (e.callerName === 'constructor' || e.calleeName === 'constructor') return false;
  // skip abstract BrowserDataImpl stubs (startLine<=1) — those go to must-not
  if (/BrowserDataImpl\.ets$/.test(e.calleeFile) && (e.calleeStart || 0) <= 1) return false;
  return (
    /YearMonthDataImpl|IdlCommonServiceProxy|BasePhotoBrowserController|AlbumDataImpl|PhotoDataImpl|TimelineDataImpl|CleanupDataImpl|OperationImpl/.test(
      e.calleeFile
    ) || (e.calleeStart || 0) > 40
  );
});

const stateMust = pick(c['arkui-state'], 8, (e) => {
  // aboutToAppear→build tagged arkui-state is over-approx / mis-channel → must-not
  return !/^(aboutToAppear|aboutToDisappear|onPageShow|onPageHide)$/.test(e.callerName);
});

const mustRaw = [
  ...ifaceMust,
  ...stateMust,
  ...pick(c['arkts-lifecycle'], 6), // keep a few as intentional flow bridges
  ...pick(c['arkui-taskpool'], 10),
  ...pick(c['arkui-child'], 8),
  ...pick(c['arkts-load-content'], 2),
  ...pick(c['arkui-route'], 2),
];

const mustSeen = new Set();
const mustEdges = [];
for (const e of mustRaw) {
  const k = keyOf(e);
  if (mustSeen.has(k)) continue;
  mustSeen.add(k);
  mustEdges.push(toMust(e));
}

// --- MUST-NOT: real edges present in index that are wrong ---
const mustNotRaw = [];

for (const e of fps['event-emitter'] || []) {
  mustNotRaw.push(
    toMustNot(
      e,
      'false event-emitter: enterMenu↛initData (unrelated emitter key collision / over-link)'
    )
  );
}

// abstract BrowserDataImpl method bridges (iface → abstract stub, not concrete leaf)
for (const e of pick(fps['interface-impl-abstractish'], 10, (x) =>
  /BrowserDataImpl\.ets$/.test(x.calleeFile) &&
  (x.calleeStart || 0) <= 1 &&
  x.callerName !== 'constructor'
)) {
  mustNotRaw.push(
    toMustNot(
      e,
      'false interface-impl: bridges to abstract BrowserDataImpl stub, not a concrete callee'
    )
  );
}

// constructor→constructor interface-impl (not a real call edge)
for (const e of pick(fps['interface-impl-abstractish'], 6, (x) => x.callerName === 'constructor')) {
  mustNotRaw.push(
    toMustNot(e, 'false interface-impl: constructor→constructor bridge is not a call')
  );
}

// arkui-state on lifecycle method names (should be lifecycle channel or absent)
for (const e of pick(fps['arkui-state-lifecycle-name'], 8)) {
  mustNotRaw.push(
    toMustNot(
      e,
      'false arkui-state: lifecycle method→build should not be state-assignment synthesis'
    )
  );
}

// multi-impl over-approx: extra concrete targets beyond the first (fanout≥4)
for (const e of pick(fps['interface-impl-multi'], 12, (x) => x.callerName !== 'constructor')) {
  mustNotRaw.push(
    toMustNot(
      e,
      `false interface-impl over-approx: iface fans out to ${e.fanout || 'N'} impls; this extra target is noise for precision`
    )
  );
}

const mustNotSeen = new Set();
const mustNotEdges = [];
for (const e of mustNotRaw) {
  const k = keyOf(e);
  if (mustSeen.has(k)) continue; // never contradict must
  if (mustNotSeen.has(k)) continue;
  mustNotSeen.add(k);
  mustNotEdges.push(e);
}

const mustDoc = {
  bucket: 'G',
  polarity: 'must',
  targetRepo: 'applications_photos',
  description:
    'True HomeGraph heuristic bridges (taskpool / child / route / loadContent / concrete interface-impl / audited state→build).',
  edges: mustEdges,
};
const mustNotDoc = {
  bucket: 'G',
  polarity: 'must-not',
  targetRepo: 'applications_photos',
  description:
    'False heuristic edges that EXIST in the indexed graph (abstract iface bridges, ctor bridges, emitter mislink, lifecycle-as-state, multi-impl over-approx).',
  edges: mustNotEdges,
};

fs.writeFileSync(
  path.join(goldDir, 'must', 'G-hg-heuristic.json'),
  JSON.stringify(mustDoc, null, 2) + '\n'
);
fs.writeFileSync(
  path.join(goldDir, 'must-not', 'G-hg-heuristic.json'),
  JSON.stringify(mustNotDoc, null, 2) + '\n'
);

const bySynthMust = {};
for (const e of mustEdges) {
  const m = /hg-heuristic:(\S+)/.exec(e.note || '');
  const k = m ? m[1] : '?';
  bySynthMust[k] = (bySynthMust[k] || 0) + 1;
}
const bySynthNot = {};
for (const e of mustNotEdges) {
  const m = /hg-heuristic:(\S+)/.exec(e.note || '') || /false ([a-z0-9-]+)/.exec(e.note || '');
  const k = e.expectedSynthesizedBy || (m ? m[1] : '?');
  bySynthNot[k] = (bySynthNot[k] || 0) + 1;
}
console.log({
  must: mustEdges.length,
  mustNot: mustNotEdges.length,
  bySynthMust,
  bySynthNot,
});
