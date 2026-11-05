/**
 * 桶 G — HomeGraph 启发式调用边
 * 测什么：本 fixture 索引里真实存在、且源码可证的合成边必须召回。
 * 不写：图里没有的边；constructor 桥；aboutToAppear→build 的 arkui-state 过近似。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_G_MUST } from '../calls-gold';
import {
  assertMustPresent,
  assertNodeExists,
  collectHeuristicCalls,
  findMatches,
  goldLabel,
  type IndexedCall,
} from '../calls-match';
import { openStabilityIndex, type StabilityIndex } from '../helpers';

describe('桶 G · HG heuristic calls', () => {
  let idx: StabilityIndex;
  let calls: IndexedCall[];

  beforeAll(async () => {
    idx = await openStabilityIndex();
    calls = collectHeuristicCalls(idx.nodes, idx.edges);
  }, 180_000);

  afterAll(() => idx?.dispose());

  describe('must — 逐边召回（仅启发式池）', () => {
    for (const g of BUCKET_G_MUST) {
      it(goldLabel(g), () => {
        assertMustPresent(calls, [g]);
        const hit = findMatches(calls, g)[0];
        expect(hit.synthesizedBy).toBe(g.synthesizedBy);
      });
    }
  });

  it('端点：IFace/Base.tag 与 Page.bumpCount 存在', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E'] as const) {
      const mod = `mod_${letter.toLowerCase()}`;
      assertNodeExists(idx.nodes, `${mod}/src/main/ets/Base${letter}.ets`, 'tag');
    }
    assertNodeExists(idx.nodes, 'mod_a/src/main/ets/PageA.ets', 'bumpCount');
    assertNodeExists(idx.nodes, 'mod_b/src/main/ets/PageB.ets', 'bumpCount');
  });

  it('全桶 must 一次扫过', () => {
    assertMustPresent(calls, BUCKET_G_MUST);
  });

  it('启发式池含 interface-impl 与 arkui-state', () => {
    const syn = new Set(calls.map((c) => c.synthesizedBy).filter(Boolean));
    expect(syn.has('interface-impl')).toBe(true);
    expect(syn.has('arkui-state')).toBe(true);
  });
});
