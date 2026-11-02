/**
 * 桶 B — 非 RTA entry helper
 * 测什么：未 export helper 仍被召回；入口扇出有界；hiddenHelper 有节点
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_B_MUST } from '../calls-gold';
import {
  assertMustPresent,
  assertNodeExists,
  collectArkCalls,
  findMatches,
  goldLabel,
  inboundTo,
  outboundFrom,
  uniqueCalleeKeys,
  type IndexedCall,
} from '../calls-match';
import { openStabilityIndex, type StabilityIndex } from '../helpers';

describe('桶 B · 非 RTA entry helper', () => {
  let idx: StabilityIndex;
  let calls: IndexedCall[];

  beforeAll(async () => {
    idx = await openStabilityIndex();
    calls = collectArkCalls(idx.nodes, idx.edges);
  }, 180_000);

  afterAll(() => idx?.dispose());

  describe('must — 逐边召回', () => {
    for (const g of BUCKET_B_MUST) {
      it(goldLabel(g), () => {
        assertMustPresent(calls, [g]);
      });
    }
  });

  it('hiddenHelperA 节点存在（非 export 仍进图）', () => {
    assertNodeExists(
      idx.nodes,
      'mod_a/src/main/ets/UtilA.ets',
      'hiddenHelperA',
      'unexported helper'
    );
  });

  it('helperA / mapAllA / mapAllB 节点存在', () => {
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/UtilA.ets', 'helperA');
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/UtilA.ets', 'mapAllA');
    assertNodeExists(idx.nodes, 'mod_b/src/main/ets/UtilB.ets', 'mapAllB');
  });

  it('hiddenHelperA 入边仅来自 UtilA.ets（非 Page/Lib 洪水）', () => {
    const inbound = inboundTo(calls, 'mod_a/src/main/ets/UtilA.ets', 'hiddenHelperA');
    expect(inbound.length).toBeGreaterThanOrEqual(1);
    for (const c of inbound) {
      expect(c.callerFile).toBe('mod_a/src/main/ets/UtilA.ets');
      const base = c.callerName.includes('$')
        ? c.callerName.split('$').pop()!
        : c.callerName;
      // helperA 本体或其 AM 包装
      expect(base === 'helperA' || /^%AM/.test(c.callerName) || base === 'hiddenHelperA').toBe(
        true
      );
    }
    expect(inbound.some((c) => /Page|Lib|Fanout/.test(c.callerFile))).toBe(false);
  });

  it('helperA 出边包含 hiddenHelperA，且出度有上界（非灌满）', () => {
    const out = outboundFrom(calls, 'mod_a/src/main/ets/UtilA.ets', 'helperA');
    const keys = uniqueCalleeKeys(out);
    expect(keys.some((k) => k.endsWith('\0hiddenHelperA') || k.includes('hiddenHelperA'))).toBe(
      true
    );
    // helperA 体很短：wrap + hiddenHelper；出度不应爆炸
    expect(keys.length).toBeLessThanOrEqual(8);
  });

  it('mapAllA → helperA 命中（含 AM 包装 caller）', () => {
    const g = BUCKET_B_MUST.find((x) => x.callerName === 'mapAllA')!;
    const hits = findMatches(calls, g);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('全桶 must 集合一次扫过', () => {
    assertMustPresent(calls, BUCKET_B_MUST);
  });
});
