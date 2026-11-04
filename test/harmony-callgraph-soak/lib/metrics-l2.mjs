import { activeOnly, deferredOnly } from './load-gold.mjs';
import { findMatches, goldLabel, isNoisyGold } from './match.mjs';

function relevantActuals(actualEdges, gold) {
  const kind = gold.kind || 'calls';
  return actualEdges.filter((e) => (e.kind || 'calls') === kind);
}

export function scorePolarity(actualEdges, golds, polarity) {
  const deferred = deferredOnly(golds);
  const skippedNoise = activeOnly(golds).filter(isNoisyGold);
  const active = activeOnly(golds).filter((g) => !isNoisyGold(g));
  const hits = [];
  const misses = [];
  const violations = [];

  for (const g of active) {
    const pool = relevantActuals(actualEdges, g);
    const found = findMatches(pool, g);
    if (polarity === 'must') {
      if (found.length > 0) hits.push({ gold: g, n: found.length });
      else misses.push(g);
    } else {
      if (found.length > 0) violations.push({ gold: g, n: found.length });
      else hits.push({ gold: g, n: 0 });
    }
  }

  const deferredHits = [];
  const deferredMisses = [];
  for (const g of deferred) {
    const found = findMatches(relevantActuals(actualEdges, g), g);
    if (polarity === 'must') {
      if (found.length > 0) deferredHits.push(g);
      else deferredMisses.push(g);
    } else if (found.length > 0) deferredHits.push(g);
    else deferredMisses.push(g);
  }

  if (polarity === 'must') {
    const recall = active.length ? hits.length / active.length : 1;
    return {
      polarity,
      active: active.length,
      deferred: deferred.length,
      skippedNoise: skippedNoise.length,
      hit: hits.length,
      miss: misses.length,
      recall,
      precision: null,
      misses: misses.slice(0, 25).map(goldLabel),
      deferredStillBroken: deferredMisses.slice(0, 15).map(goldLabel),
      deferredFixed: deferredHits.slice(0, 15).map(goldLabel),
    };
  }

  // must-not: "precision-like" = share of golds that stay absent
  const clean = hits.length;
  const rate = active.length ? clean / active.length : 1;
  return {
    polarity,
    active: active.length,
    deferred: deferred.length,
    skippedNoise: skippedNoise.length,
    hit: clean,
    miss: violations.length,
    recall: null,
    precision: rate,
    mustNotHoldRate: rate,
    violations: violations.slice(0, 25).map((v) => goldLabel(v.gold)),
    deferredStillBroken: deferredHits.slice(0, 15).map(goldLabel),
    deferredFixed: deferredMisses.slice(0, 15).map(goldLabel),
  };
}

export function scoreL2(actualEdges, gold) {
  const byBucket = {};
  for (const [bucket, pack] of Object.entries(gold.byBucket)) {
    byBucket[bucket] = {
      must: scorePolarity(actualEdges, pack.must, 'must'),
      mustNot: scorePolarity(actualEdges, pack.mustNot, 'must-not'),
    };
  }
  const must = scorePolarity(actualEdges, gold.must, 'must');
  const mustNot = scorePolarity(actualEdges, gold.mustNot, 'must-not');
  return { overall: { must, mustNot }, byBucket };
}
