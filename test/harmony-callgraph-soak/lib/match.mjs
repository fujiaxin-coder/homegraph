/** Gold edge matching — L1-aligned names; soak-tolerant on lines / import→file. */

export function normPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

export function nameMatches(actual, expected) {
  if (actual === expected) return true;
  if (actual.endsWith('$' + expected)) return true;
  const parts = String(actual).split('$');
  return parts[parts.length - 1] === expected;
}

function baseName(p) {
  const n = normPath(p).split('/').pop() || '';
  return n.replace(/\.(ets|ts|d\.ets)$/i, '');
}

/** imports: HG is import-node → file-node; gold often names the exported symbol as callee. */
function importCalleeMatches(actual, gold) {
  const gName = gold.calleeName;
  const aName = actual.calleeName;
  if (nameMatches(aName, gName)) return true;
  // file node "BroadCast.ts" vs gold "BroadCast"
  if (baseName(actual.calleeFile) === gName) return true;
  if (baseName(aName) === gName) return true;
  return false;
}

export function edgeKey(e) {
  return `${e.kind || 'calls'}|${normPath(e.callerFile)}|${e.callerName}|${normPath(e.calleeFile)}|${e.calleeName}`;
}

export function goldLabel(g) {
  return `[${g.bucket}] ${g.kind || 'calls'} ${g.callerFile}:${g.callerName} → ${g.calleeFile}:${g.calleeName}` +
    (g.note ? ` (${g.note})` : '');
}

export function edgeMatchesGold(actual, gold) {
  const kind = gold.kind || 'calls';
  if ((actual.kind || 'calls') !== kind) return false;
  if (normPath(actual.callerFile) !== normPath(gold.callerFile)) return false;
  if (normPath(actual.calleeFile) !== normPath(gold.calleeFile)) return false;
  if (!nameMatches(actual.callerName, gold.callerName)) return false;

  if (kind === 'imports') {
    if (!importCalleeMatches(actual, gold)) return false;
  } else if (!nameMatches(actual.calleeName, gold.calleeName)) {
    return false;
  }

  // startLine is advisory only (miner vs HG off-by-one is common) — do not fail match
  return true;
}

export function findMatches(actuals, gold) {
  return actuals.filter((a) => edgeMatchesGold(a, gold));
}

/** Obvious non-call / SDK / UI gold noise — exclude from active L2 scores. */
const NOISE_CALLEES = new Set([
  'PanGesture',
  'PinchGesture',
  'LongPressGesture',
  'TapGesture',
  'SwipeGesture',
  'RotationGesture',
  'List',
  'ListItem',
  'Column',
  'Row',
  'Text',
  'Button',
  'Image',
  'ForEach',
  'LazyForEach',
  'MenuItem',
  'SubHeader',
]);

export function isNoisyGold(g) {
  if (NOISE_CALLEES.has(g.calleeName) || NOISE_CALLEES.has(g.callerName)) return true;
  const cf = normPath(g.callerFile || '');
  const tf = normPath(g.calleeFile || '');
  if (cf.startsWith('demo/') || tf.startsWith('demo/')) return true;
  if (/\/index\.ets$/i.test(tf) && /^[ei]$/i.test(g.calleeName)) return true; // HiLog barrel
  return false;
}
