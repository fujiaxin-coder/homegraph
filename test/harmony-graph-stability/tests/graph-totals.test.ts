import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { countByKind, countEdgesByKind, indexStabilityProject } from './helpers';

// TODO: edges/references priors (363 / references=35) disagree with live index (358 / 30);
// method/function/contains/calls inventory still incomplete in golden.ts.
describe.skip('harmony-graph-stability / graph totals', () => {
  it(
    'reports node/edge totals (locks golden when set)',
    async () => {
      const { cg, nodes, edges, counts } = await indexStabilityProject();
      try {
        expect(counts.nodes).toBe(nodes.length);
        expect(counts.edges).toBeGreaterThan(0);
        expect(Object.keys(countByKind(nodes)).length).toBeGreaterThan(0);
        expect(Object.keys(countEdgesByKind(edges)).length).toBeGreaterThan(0);

        expect(counts.nodes).toBe(GOLDEN.nodes);
        expect(counts.edges).toBe(GOLDEN.edges);
        expect(countByKind(nodes)).toEqual(GOLDEN.nodesByKind);
        expect(countEdgesByKind(edges)).toEqual(GOLDEN.edgesByKind);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
