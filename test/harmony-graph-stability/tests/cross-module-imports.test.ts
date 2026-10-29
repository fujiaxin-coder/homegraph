import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { countEdgesByKind, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / cross-module imports', () => {
  it(
    'persists imports edges (UtilB→UtilA chain and in-module imports)',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        const byKind = countEdgesByKind(edges);
        expect(byKind.imports ?? 0).toBeGreaterThanOrEqual(GOLDEN.minImportEdges);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
