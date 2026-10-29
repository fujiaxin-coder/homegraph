import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { indexStabilityProject, synthBy } from './helpers';

describe('harmony-graph-stability / viewtree edges', () => {
  it(
    'emits viewtree-synthesized edges from Page/Child build trees',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        expect(synthBy(edges, 'viewtree').length).toBeGreaterThanOrEqual(GOLDEN.minViewTreeEdges);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
