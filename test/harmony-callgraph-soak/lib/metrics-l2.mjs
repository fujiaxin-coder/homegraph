/**
 * L2 quality metrics against sampled gold.
 *
 * Recall = |E ∩ G+| / |G+|
 * Precision@gold = |E ∩ G+| / |E ∩ (G+ ∪ G-)|
 * Must-not violation rate = |E ∩ G-| / |G-|
 * unknown / deferred / noise excluded from denominators.
 * Default calls scoring uses synthesized_by=arkanalyzer; provenance lift
 * adds AA vs HG-heuristic vs all-calls views without replacing the default.
 */
import { moduleKey, scopeOf, isTestPath } from './coverage.mjs';
import {
  findMatches,
  goldLabel,
  poolForGold,
  scoringEligible,
  isArkCall,
  isHeuristicCall,
  normPath,
} from './match.mjs';

function labelOf(g) {
  if (g.label) return g.label;
  return 'true';
}

function splitKey(g, actualHit) {
  const scope = g.scope || scopeOf(g.callerFile, g.calleeFile);
  const suite = g.suite || (isTestPath(g.callerFile) ? 'test' : 'prod');
  let dispatch = 'n/a';
  if ((g.kind || 'calls') === 'calls' && actualHit) {
    dispatch = actualHit.dispatch || 'unknown';
  } else if ((g.kind || 'calls') === 'calls') {
    dispatch = 'unknown';
  }
  return { scope, suite, dispatch, kind: g.kind || 'calls', bucket: g.bucket };
}

function emptySplitAgg() {
  return { gPlus: 0, hitPlus: 0, gMinus: 0, viol: 0 };
}

function bumpSplit(splits, key, field) {
  if (!splits[key]) splits[key] = emptySplitAgg();
  splits[key][field]++;
}

export function scorePolarity(actualEdges, golds, polarity, provenance = 'ark') {
  const eligible = golds.filter(scoringEligible).filter((g) => {
    const want = polarity === 'must' ? 'true' : 'false';
    return labelOf(g) === want;
  });
  const unknown = golds.filter((g) => labelOf(g) === 'unknown');
  const deferred = golds.filter((g) => g.status === 'deferred');

  const hits = [];
  const misses = [];
  const violations = [];

  for (const g of eligible) {
    const pool = poolForGold(actualEdges, g, provenance);
    const found = findMatches(pool, g);
    if (polarity === 'must') {
      if (found.length) hits.push({ gold: g, hit: found[0] });
      else misses.push(g);
    } else if (found.length) violations.push({ gold: g, hit: found[0] });
    else hits.push({ gold: g, hit: null });
  }

  if (polarity === 'must') {
    return {
      polarity,
      eligible: eligible.length,
      unknown: unknown.length,
      deferred: deferred.length,
      hit: hits.length,
      miss: misses.length,
      recall: eligible.length ? hits.length / eligible.length : 1,
      misses: misses.slice(0, 30).map(goldLabel),
      hitSamples: hits.slice(0, 10).map((h) => goldLabel(h.gold)),
    };
  }
  return {
    polarity,
    eligible: eligible.length,
    unknown: unknown.length,
    deferred: deferred.length,
    hit: hits.length,
    miss: violations.length,
    mustNotViolationRate: eligible.length ? violations.length / eligible.length : 0,
    mustNotHoldRate: eligible.length ? hits.length / eligible.length : 1,
    violations: violations.slice(0, 30).map((v) => goldLabel(v.gold)),
  };
}

/**
 * Precision@gold over union of must+must-not that appear in E.
 */
export function precisionAtGold(actualEdges, must, mustNot, provenance = 'ark') {
  const gPlus = must.filter((g) => scoringEligible(g) && labelOf(g) === 'true');
  const gMinus = mustNot.filter((g) => scoringEligible(g) && labelOf(g) === 'false');
  let inEPlus = 0;
  let inEUnion = 0;
  for (const g of gPlus) {
    if (findMatches(poolForGold(actualEdges, g, provenance), g).length) {
      inEPlus++;
      inEUnion++;
    }
  }
  for (const g of gMinus) {
    if (findMatches(poolForGold(actualEdges, g, provenance), g).length) {
      inEUnion++;
    }
  }
  return {
    inEPlus,
    inEUnion,
    precisionAtGold: inEUnion ? inEPlus / inEUnion : null,
    gPlus: gPlus.length,
    gMinus: gMinus.length,
  };
}

/**
 * AA vs HG-heuristic provenance view (additive; does not replace default ark metrics).
 * Focus: call golds — how much HomeGraph synthesis contributes beyond ArkAnalyzer.
 */
export function scoreProvenance(actualEdges, must, mustNot) {
  const callMust = must.filter(
    (g) => scoringEligible(g) && labelOf(g) === 'true' && (g.kind || 'calls') === 'calls'
  );
  const callMustNot = mustNot.filter(
    (g) => scoringEligible(g) && labelOf(g) === 'false' && (g.kind || 'calls') === 'calls'
  );

  function arm(provenance) {
    const mustScore = scorePolarity(actualEdges, callMust, 'must', provenance);
    const mustNotScore = scorePolarity(actualEdges, callMustNot, 'must-not', provenance);
    const prec = precisionAtGold(actualEdges, callMust, callMustNot, provenance);
    return {
      provenance,
      scope: 'calls-only',
      recall: mustScore.recall,
      hit: mustScore.hit,
      miss: mustScore.miss,
      eligibleMust: mustScore.eligible,
      mustNotViolationRate: mustNotScore.mustNotViolationRate,
      eligibleMustNot: mustNotScore.eligible,
      precisionAtGold: prec.precisionAtGold,
    };
  }

  const ark = arm('ark');
  const heuristic = arm('heuristic');
  const all = arm('all');

  // Per-gold attribution for must calls
  let arkOnlyHit = 0;
  let heuristicOnlyHit = 0;
  let bothHit = 0;
  let neither = 0;
  const synthHitCounts = {};
  for (const g of callMust) {
    const inArk = findMatches(poolForGold(actualEdges, g, 'ark'), g).length > 0;
    const heurHits = findMatches(poolForGold(actualEdges, g, 'heuristic'), g);
    const inHeur = heurHits.length > 0;
    if (inArk && inHeur) bothHit++;
    else if (inArk) arkOnlyHit++;
    else if (inHeur) {
      heuristicOnlyHit++;
      const synth = heurHits[0]?.synthesizedBy || 'unknown';
      synthHitCounts[synth] = (synthHitCounts[synth] || 0) + 1;
    } else neither++;
  }

  const calls = actualEdges.filter((e) => (e.kind || 'calls') === 'calls');
  const bySynth = {};
  for (const e of calls) {
    const k = e.synthesizedBy || 'arkanalyzer(missing)';
    bySynth[k] = (bySynth[k] || 0) + 1;
  }
  const byClass = {
    arkanalyzer: calls.filter(isArkCall).length,
    'hg-heuristic': calls.filter(isHeuristicCall).length,
  };

  return {
    note:
      'Default L2 metrics remain AA-scoped. This block isolates HomeGraph heuristic contribution on call golds.',
    inventory: {
      callsTotal: calls.length,
      byProvenanceClass: byClass,
      bySynthesizedBy: bySynth,
    },
    metrics: {
      arkanalyzer: ark,
      'hg-heuristic': heuristic,
      'aa+hg-all': all,
    },
    mustCallAttribution: {
      eligible: callMust.length,
      arkOnlyHit,
      heuristicOnlyHit,
      bothHit,
      neither,
      heuristicRecallLift: all.recall != null && ark.recall != null ? all.recall - ark.recall : null,
      heuristicOnlyHitBySynth: synthHitCounts,
    },
  };
}

function scoreSplits(actualEdges, must, mustNot) {
  const byScope = {};
  const bySuite = {};
  const byDispatch = {};
  const byKind = {};
  const byBucket = {};
  const byModulePair = {};

  for (const g of must.filter((x) => scoringEligible(x) && labelOf(x) === 'true')) {
    const found = findMatches(poolForGold(actualEdges, g, 'ark'), g);
    const hit = found[0] || null;
    const sk = splitKey(g, hit);
    bumpSplit(byScope, sk.scope, 'gPlus');
    bumpSplit(bySuite, sk.suite, 'gPlus');
    bumpSplit(byKind, sk.kind, 'gPlus');
    bumpSplit(byBucket, sk.bucket, 'gPlus');
    if (sk.kind === 'calls') bumpSplit(byDispatch, sk.dispatch, 'gPlus');
    if (found.length) {
      bumpSplit(byScope, sk.scope, 'hitPlus');
      bumpSplit(bySuite, sk.suite, 'hitPlus');
      bumpSplit(byKind, sk.kind, 'hitPlus');
      bumpSplit(byBucket, sk.bucket, 'hitPlus');
      if (sk.kind === 'calls') bumpSplit(byDispatch, sk.dispatch, 'hitPlus');
    }
    const pair = `${moduleKey(g.callerFile)}→${moduleKey(g.calleeFile)}`;
    bumpSplit(byModulePair, pair, 'gPlus');
    if (found.length) bumpSplit(byModulePair, pair, 'hitPlus');
  }

  for (const g of mustNot.filter((x) => scoringEligible(x) && labelOf(x) === 'false')) {
    const found = findMatches(poolForGold(actualEdges, g, 'ark'), g);
    const sk = splitKey(g, found[0]);
    bumpSplit(byScope, sk.scope, 'gMinus');
    bumpSplit(bySuite, sk.suite, 'gMinus');
    bumpSplit(byKind, sk.kind, 'gMinus');
    bumpSplit(byBucket, sk.bucket, 'gMinus');
    if (found.length) {
      bumpSplit(byScope, sk.scope, 'viol');
      bumpSplit(bySuite, sk.suite, 'viol');
      bumpSplit(byKind, sk.kind, 'viol');
      bumpSplit(byBucket, sk.bucket, 'viol');
    }
  }

  function finalize(map) {
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = {
        ...v,
        recall: v.gPlus ? v.hitPlus / v.gPlus : null,
        mustNotViolationRate: v.gMinus ? v.viol / v.gMinus : null,
      };
    }
    return out;
  }

  // keep top module pairs only
  const pairs = Object.entries(byModulePair)
    .sort((a, b) => b[1].gPlus - a[1].gPlus)
    .slice(0, 15);
  const topPairs = finalize(Object.fromEntries(pairs));

  return {
    byScope: finalize(byScope),
    bySuite: finalize(bySuite),
    byDispatch: finalize(byDispatch),
    byKind: finalize(byKind),
    byBucket: finalize(byBucket),
    byModulePairTop: topPairs,
  };
}

/**
 * Reachability@k from DummyMain / lifecycle seeds along call edges.
 * @param {'ark'|'all'} [provenance]
 */
export function reachabilityAtK(actualEdges, must, k = 6, provenance = 'ark') {
  const callGolds = must.filter(
    (g) => scoringEligible(g) && labelOf(g) === 'true' && (g.kind || 'calls') === 'calls'
  );
  if (!callGolds.length) {
    return { k, seeds: 0, goldCalls: 0, reachable: 0, rate: null, provenance };
  }

  const pool =
    provenance === 'all'
      ? actualEdges.filter((e) => (e.kind || 'calls') === 'calls')
      : actualEdges.filter(isArkCall);
  const adj = new Map();
  const nodes = new Set();
  for (const e of pool) {
    const a = `${normPath(e.callerFile)}\0${e.callerName}`;
    const b = `${normPath(e.calleeFile)}\0${e.calleeName}`;
    nodes.add(a);
    nodes.add(b);
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }

  const seeds = [...nodes].filter((id) => {
    const name = id.split('\0')[1] || '';
    return (
      name === 'DummyMain' ||
      name.includes('DummyMain') ||
      /^(aboutToAppear|onCreate|build)$/.test(name) ||
      name.endsWith('$aboutToAppear') ||
      name.endsWith('$onCreate') ||
      name.endsWith('$build')
    );
  });

  const seen = new Set(seeds);
  let frontier = [...seeds];
  for (let depth = 0; depth < k && frontier.length; depth++) {
    const next = [];
    for (const u of frontier) {
      for (const v of adj.get(u) || []) {
        if (seen.has(v)) continue;
        seen.add(v);
        next.push(v);
      }
    }
    frontier = next;
  }

  let reachable = 0;
  for (const g of callGolds) {
    const key = `${normPath(g.calleeFile)}\0${g.calleeName}`;
    const hit =
      seen.has(key) ||
      [...seen].some((id) => {
        const [f, n] = id.split('\0');
        return f === normPath(g.calleeFile) && (n === g.calleeName || n.endsWith('$' + g.calleeName));
      });
    if (hit) reachable++;
  }

  return {
    k,
    seeds: seeds.length,
    goldCalls: callGolds.length,
    reachable,
    rate: callGolds.length ? reachable / callGolds.length : null,
    provenance,
  };
}

function scoreOverallArm(actualEdges, gold, provenance) {
  const must = scorePolarity(actualEdges, gold.must, 'must', provenance);
  const mustNot = scorePolarity(actualEdges, gold.mustNot, 'must-not', provenance);
  const precision = precisionAtGold(actualEdges, gold.must, gold.mustNot, provenance);
  const reach = reachabilityAtK(actualEdges, gold.must, 6, provenance);
  return { must, mustNot, precision, reachabilityAtK: reach, provenance };
}

function deltaMetric(allVal, arkVal) {
  if (allVal == null || arkVal == null) return null;
  return allVal - arkVal;
}

export function scoreL2(actualEdges, gold) {
  const byBucket = {};
  for (const [bucket, pack] of Object.entries(gold.byBucket)) {
    byBucket[bucket] = {
      must: scorePolarity(actualEdges, pack.must, 'must', 'ark'),
      mustNot: scorePolarity(actualEdges, pack.mustNot, 'must-not', 'ark'),
    };
  }
  const ark = scoreOverallArm(actualEdges, gold, 'ark');
  const all = scoreOverallArm(actualEdges, gold, 'all');
  const splits = scoreSplits(actualEdges, gold.must, gold.mustNot);
  const provenance = scoreProvenance(actualEdges, gold.must, gold.mustNot);
  const lift = {
    recall: deltaMetric(all.must.recall, ark.must.recall),
    precisionAtGold: deltaMetric(all.precision.precisionAtGold, ark.precision.precisionAtGold),
    mustNotViolationRate: deltaMetric(
      all.mustNot.mustNotViolationRate,
      ark.mustNot.mustNotViolationRate
    ),
    reachabilityAtK: deltaMetric(all.reachabilityAtK.rate, ark.reachabilityAtK.rate),
    note: 'all − ark：加入 HomeGraph 启发式边后相对仅 AA 的变化（百分点）',
  };
  return {
    // overall = AA-only (compat); overallAll = AA + HG heuristic
    overall: ark,
    overallArk: ark,
    overallAll: all,
    heuristicLift: lift,
    byBucket,
    splits,
    provenance,
    formulas: {
      recall: '|E ∩ G+| / |G+|',
      precisionAtGold: '|E ∩ G+| / |E ∩ (G+ ∪ G-)|',
      mustNotViolationRate: '|E ∩ G-| / |G-|',
      reachabilityAtK:
        'fraction of G+ call callees reachable in ≤k hops from DummyMain/lifecycle seeds',
      arms: 'overallArk: E calls = arkanalyzer; overallAll: E calls = AA ∪ HG-heuristic',
      heuristicLift: 'metric(all) − metric(ark)',
    },
  };
}
