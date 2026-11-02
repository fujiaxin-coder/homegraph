/**
 * 桶 D — 同模块清晰调用
 * 测什么：同文件 this.foo() / 同模块直连存在；不应靠 CFG 灌到跨模块或高扇出
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_D_MUST, BUCKET_D_MUST_NOT } from '../calls-gold';
import {
  assertMustNotAbsent,
  assertMustPresent,
  assertNodeExists,
  collectArkCalls,
  findMatches,
  goldLabel,
  moduleOf,
  outboundFrom,
  uniqueCalleeKeys,
  type IndexedCall,
} from '../calls-match';
import { openStabilityIndex, type StabilityIndex } from '../helpers';

describe('桶 D · 同模块清晰调用', () => {
  let idx: StabilityIndex;
  let calls: IndexedCall[];

  beforeAll(async () => {
    idx = await openStabilityIndex();
    calls = collectArkCalls(idx.nodes, idx.edges);
  }, 180_000);

  afterAll(() => idx?.dispose());

  describe('must — 逐边召回', () => {
    for (const g of BUCKET_D_MUST) {
      it(goldLabel(g), () => {
        assertMustPresent(calls, [g]);
        const hit = findMatches(calls, g)[0];
        expect(moduleOf(hit.callerFile)).toBe(moduleOf(hit.calleeFile));
      });
    }
  });

  describe('must-not — 同模块不得灌跨界/扇出', () => {
    for (const g of BUCKET_D_MUST_NOT) {
      it(goldLabel(g), () => {
        assertMustNotAbsent(calls, [g]);
      });
    }
  });

  it('WorkerA.run / touch / runLibA 节点存在', () => {
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/LibA.ets', 'run');
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/LibA.ets', 'touch');
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/LibA.ets', 'runLibA');
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/LibA.ets', 'WorkerA');
  });

  it('LibA.run → touch 落在同文件', () => {
    const g = BUCKET_D_MUST.find(
      (x) => x.callerFile.includes('LibA') && x.calleeName === 'touch'
    )!;
    const hit = findMatches(calls, g)[0];
    expect(hit.callerFile).toBe(hit.calleeFile);
  });

  it('LibA.run 出度有上界（清晰边，非 CFG 灌满）', () => {
    const out = outboundFrom(calls, 'mod_a/src/main/ets/LibA.ets', 'run');
    const keys = uniqueCalleeKeys(out);
    expect(keys.some((k) => k.endsWith('\0touch') || k.includes('\0touch'))).toBe(true);
    expect(keys.length).toBeLessThanOrEqual(10);
    expect(keys.some((k) => k.includes('UtilB') || k.includes('FanoutTrap'))).toBe(false);
  });

  it('全桶 must + must-not 一次扫过', () => {
    assertMustPresent(calls, BUCKET_D_MUST);
    assertMustNotAbsent(calls, BUCKET_D_MUST_NOT);
  });
});
