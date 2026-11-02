/**
 * 桶 A — 跨模块 static direct
 * 测什么：Class.method / 跨模块函数在 exact 名漂了时仍能召回；禁止跳级塌缩
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_A_MUST, BUCKET_A_MUST_NOT } from '../calls-gold';
import {
  assertMustNotAbsent,
  assertMustPresent,
  assertNodeExists,
  collectArkCalls,
  findMatches,
  goldLabel,
  moduleOf,
  type IndexedCall,
} from '../calls-match';
import { openStabilityIndex, type StabilityIndex } from '../helpers';

describe('桶 A · 跨模块 static direct', () => {
  let idx: StabilityIndex;
  let calls: IndexedCall[];

  beforeAll(async () => {
    idx = await openStabilityIndex();
    calls = collectArkCalls(idx.nodes, idx.edges);
  }, 180_000);

  afterAll(() => idx?.dispose());

  describe('must — 逐边召回', () => {
    for (const g of BUCKET_A_MUST) {
      it(goldLabel(g), () => {
        assertMustPresent(calls, [g]);
        const hit = findMatches(calls, g)[0];
        expect(moduleOf(hit.callerFile)).not.toBe(moduleOf(hit.calleeFile));
      });
    }
  });

  describe('must-not — 禁止跳级直连', () => {
    for (const g of BUCKET_A_MUST_NOT) {
      it(goldLabel(g), () => {
        assertMustNotAbsent(calls, [g]);
      });
    }
  });

  it('端点符号节点存在：DateFmt.weekTitle / helperA–E', () => {
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/DateFmt.ets', 'weekTitle', 'Class.method');
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/DateFmt.ets', 'DateFmt', 'class');
    for (const [mod, name] of [
      ['mod_a', 'helperA'],
      ['mod_b', 'helperB'],
      ['mod_c', 'helperC'],
      ['mod_d', 'helperD'],
      ['mod_e', 'helperE'],
    ] as const) {
      assertNodeExists(idx.nodes, `${mod}/src/main/ets/Util${mod.slice(-1).toUpperCase()}.ets`, name);
    }
  });

  it('全桶 must 集合一次扫过（防漏挂）', () => {
    assertMustPresent(calls, BUCKET_A_MUST);
    assertMustNotAbsent(calls, BUCKET_A_MUST_NOT);
  });

  it('helperB→weekTitle 与 helperB→helperA 同时存在（同 caller 多 callee）', () => {
    const toWeek = BUCKET_A_MUST.find((g) => g.calleeName === 'weekTitle')!;
    const toHelper = BUCKET_A_MUST.find((g) => g.calleeName === 'helperA')!;
    expect(findMatches(calls, toWeek).length).toBeGreaterThanOrEqual(1);
    expect(findMatches(calls, toHelper).length).toBeGreaterThanOrEqual(1);
  });
});
