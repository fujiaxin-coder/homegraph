import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { countEdgesByKind, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / heritage edges', () => {
  it(
    'emits extends and/or implements for Worker/Base/IFace',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        const byKind = countEdgesByKind(edges);
        const n = (byKind.extends ?? 0) + (byKind.implements ?? 0);
        expect(n).toBeGreaterThanOrEqual(GOLDEN.minExtendsOrImplements);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
