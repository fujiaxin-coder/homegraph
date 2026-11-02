/**
 * 桶 C — 扇出负例
 * 测什么：高扇出符号存在于图中，但不得被无关 caller 洪水连接
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_C_MUST_NOT } from '../calls-gold';
import {
  assertMustNotAbsent,
  assertNodeExists,
  collectArkCalls,
  goldLabel,
  inboundTo,
  outboundFrom,
  uniqueCalleeKeys,
  type IndexedCall,
} from '../calls-match';
import { openStabilityIndex, type StabilityIndex } from '../helpers';

describe('桶 C · 扇出负例（must-not）', () => {
  let idx: StabilityIndex;
  let calls: IndexedCall[];

  beforeAll(async () => {
    idx = await openStabilityIndex();
    calls = collectArkCalls(idx.nodes, idx.edges);
  }, 180_000);

  afterAll(() => idx?.dispose());

  describe('符号存在（负例不是“节点缺失”）', () => {
    it('FanoutTrap 类与 getInstance / error / info 方法在图中', () => {
      assertNodeExists(idx.nodes, 'mod_a/src/main/ets/FanoutTrap.ets', 'FanoutTrap');
      assertNodeExists(idx.nodes, 'mod_a/src/main/ets/FanoutTrap.ets', 'getInstance');
      assertNodeExists(idx.nodes, 'mod_a/src/main/ets/FanoutTrap.ets', 'error');
      assertNodeExists(idx.nodes, 'mod_a/src/main/ets/FanoutTrap.ets', 'info');
    });
  });

  describe('must-not — 逐边禁止', () => {
    for (const g of BUCKET_C_MUST_NOT) {
      it(goldLabel(g), () => {
        assertMustNotAbsent(calls, [g]);
      });
    }
  });

  it('getInstance 入边不得来自 UtilA/PageA/LibA 业务 caller', () => {
    const inbound = inboundTo(calls, 'mod_a/src/main/ets/FanoutTrap.ets', 'getInstance');
    for (const c of inbound) {
      expect(
        ['UtilA.ets', 'PageA.ets', 'LibA.ets'].some((f) => c.callerFile.endsWith(f)),
        `flood edge ${c.callerFile}:${c.callerName} → getInstance`
      ).toBe(false);
    }
  });

  it('aboutToAppear 出度有上界（不向 FanoutTrap 扇出）', () => {
    const out = outboundFrom(calls, 'mod_a/src/main/ets/PageA.ets', 'aboutToAppear');
    const keys = uniqueCalleeKeys(out);
    expect(keys.some((k) => k.includes('FanoutTrap'))).toBe(false);
    expect(keys.length).toBeLessThanOrEqual(12);
  });

  it('helperA 出边不含 FanoutTrap.*', () => {
    const out = outboundFrom(calls, 'mod_a/src/main/ets/UtilA.ets', 'helperA');
    expect(uniqueCalleeKeys(out).some((k) => k.includes('FanoutTrap'))).toBe(false);
  });

  it('全桶 must-not 一次扫过', () => {
    assertMustNotAbsent(calls, BUCKET_C_MUST_NOT);
  });
});
