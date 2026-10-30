import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { countEdgesByKind, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / heritage edges', () => {
  it(
    'emits 5 extends + 5 implements (Worker→Base, Base→IFace per module)',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        const byKind = countEdgesByKind(edges);
        expect(byKind.extends ?? 0).toBe(GOLDEN.extendsEdges);
        expect(byKind.implements ?? 0).toBe(GOLDEN.implementsEdges);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
