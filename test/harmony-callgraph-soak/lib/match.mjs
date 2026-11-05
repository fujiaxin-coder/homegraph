/** Gold edge matching — soak-tolerant on lines / import→file. */

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

function importCalleeMatches(actual, gold) {
  const gName = gold.calleeName;
  const aName = actual.calleeName;
  if (nameMatches(aName, gName)) return true;
  if (baseName(actual.calleeFile) === gName) return true;
  if (baseName(aName) === gName) return true;
  return false;
}

export function goldLabel(g) {
  return (
    `[${g.bucket}] ${g.kind || 'calls'} ${g.callerFile}:${g.callerName} → ${g.calleeFile}:${g.calleeName}` +
    (g.evidence ? ` @${g.evidence}` : '') +
    (g.note ? ` (${g.note})` : '')
  );
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
  return true;
}

export function findMatches(actuals, gold) {
  return actuals.filter((a) => edgeMatchesGold(a, gold));
}

/** ArkTS AA call edges (missing synth counts as ark). */
export function isArkCall(e) {
  if ((e.kind || 'calls') !== 'calls') return false;
  return !e.synthesizedBy || e.synthesizedBy === 'arkanalyzer';
}

/** HomeGraph heuristic / synthesized call edges (non-AA). */
export function isHeuristicCall(e) {
  if ((e.kind || 'calls') !== 'calls') return false;
  return !!(e.synthesizedBy && e.synthesizedBy !== 'arkanalyzer');
}

export function isAnyCall(e) {
  return (e.kind || 'calls') === 'calls';
}

/**
 * @param {'ark'|'heuristic'|'all'} [provenance]
 *   ark (default): AA calls only for kind=calls
 *   heuristic: HG synthesized calls only
 *   all: all calls (AA + HG heuristic)
 * Non-call kinds always use full kind pool.
 */
export function poolForGold(actualEdges, gold, provenance = 'ark') {
  const kind = gold.kind || 'calls';
  if (kind !== 'calls') {
    return actualEdges.filter((e) => (e.kind || 'calls') === kind);
  }
  if (provenance === 'heuristic') return actualEdges.filter(isHeuristicCall);
  if (provenance === 'all') return actualEdges.filter(isAnyCall);
  return actualEdges.filter(isArkCall);
}

export function provenanceOfCall(e) {
  if (!isAnyCall(e)) return 'n/a';
  if (isHeuristicCall(e)) return 'hg-heuristic';
  return 'arkanalyzer';
}

const NOISE_CALLEES = new Set([
  'PanGesture',
  'PinchGesture',
  'LongPressGesture',
  'TapGesture',
  'SwipeGesture',
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
  'animateTo',
  'animateToImmediately',
]);

export function isNoisyGold(g) {
  if (NOISE_CALLEES.has(g.calleeName) || NOISE_CALLEES.has(g.callerName)) return true;
  const cf = normPath(g.callerFile || '');
  const tf = normPath(g.calleeFile || '');
  if (/\/index\.ets$/i.test(tf) && /^[ei]$/i.test(g.calleeName)) return true;
  return false;
}

/** Eligible for P/R denominator: active + label true|false (not unknown) + not noise. */
export function scoringEligible(g) {
  if ((g.status || 'active') !== 'active') return false;
  if (isNoisyGold(g)) return false;
  const label = g.label || (g.polarity === 'must-not' ? 'false' : 'true');
  return label === 'true' || label === 'false';
}
