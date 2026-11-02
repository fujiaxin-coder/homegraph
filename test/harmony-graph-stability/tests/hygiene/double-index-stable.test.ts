/**
 * 卫生项 — 两次独立索引结果一致（不钉合同数字）
 */
import { describe, expect, it } from 'vitest';
import {
  amNodeKeys,
  countByKind,
  countEdgesByKind,
  indexStabilityProject,
} from '../helpers';

describe('卫生 · 双次索引稳定', () => {
  it(
    '两次 fresh index 的节点/边计数与 %AM 键一致',
    async () => {
      const a = await indexStabilityProject();
      let b;
      try {
        b = await indexStabilityProject();
        expect(b.counts).toEqual(a.counts);
        expect(countByKind(b.nodes)).toEqual(countByKind(a.nodes));
        expect(countEdgesByKind(b.edges)).toEqual(countEdgesByKind(a.edges));
        expect(amNodeKeys(b.nodes)).toEqual(amNodeKeys(a.nodes));
      } finally {
        a.cg.close();
        b?.cg.close();
      }
    },
    360_000
  );
});
