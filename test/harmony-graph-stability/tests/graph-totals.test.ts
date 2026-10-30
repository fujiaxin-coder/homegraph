import { describe, expect, it } from 'vitest';
import { CONTRACT, requireFilled } from './contract';
import { countByKind, countEdgesByKind, indexStabilityProject } from './helpers';

/**
 * HG 整图 nodes/edges + by-kind。
 *
 * TODO(后续修复后去掉 skip)：
 *   CONTRACT.meta.filled.totals === false；totals / nodesByKind / edgesByKind 仍为 null。
 *   这些数字不是 AA Scene 字段，需在 AA 指纹稳定后单独从 HomeGraph 落库固化进合同，
 *   再 filled.totals=true 并启用本套件。禁止用 `>= 1` 顶替。
 */
describe.skip('harmony-graph-stability / graph totals', () => {
  it(
    'node/edge totals and by-kind maps match CONTRACT',
    async () => {
      const { cg, nodes, edges, counts } = await indexStabilityProject();
      try {
        expect(counts.nodes).toBe(nodes.length);

        const wantNodes = requireFilled(CONTRACT.totals.nodes, 'totals.nodes');
        const wantEdges = requireFilled(CONTRACT.totals.edges, 'totals.edges');
        const nodesByKind = requireFilled(CONTRACT.nodesByKind, 'nodesByKind');
        const edgesByKind = requireFilled(CONTRACT.edgesByKind, 'edgesByKind');

        expect(counts.nodes).toBe(wantNodes);
        expect(counts.edges).toBe(wantEdges);
        expect(countByKind(nodes)).toEqual(nodesByKind);
        expect(countEdgesByKind(edges)).toEqual(edgesByKind);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
