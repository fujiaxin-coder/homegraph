import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { etsFileNodes, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / ets file nodes', () => {
  it(
    'indexes 25 .ets file nodes (5 modules × 5 files)',
    async () => {
      const { cg, nodes } = await indexStabilityProject();
      try {
        expect(etsFileNodes(nodes).length).toBe(GOLDEN.etsFileNodes);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
