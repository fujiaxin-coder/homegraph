import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { indexStabilityProject, synthBy } from './helpers';

// TODO: source+rule prior = 35 (7×5); HG currently emits 30 viewtree edges.
describe.skip('harmony-graph-stability / viewtree edges', () => {
  it(
    'emits exactly 35 viewtree edges (7 per module × 5, source+rule prior)',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        expect(synthBy(edges, 'viewtree').length).toBe(GOLDEN.viewtreeEdges);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
