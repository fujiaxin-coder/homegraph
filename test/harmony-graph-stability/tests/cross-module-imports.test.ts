import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { countEdgesByKind, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / cross-module imports', () => {
  it(
    'persists exactly 24 imports edges (Page×3 + Lib×1 + UtilB–E×1)',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        const byKind = countEdgesByKind(edges);
        expect(byKind.imports ?? 0).toBe(GOLDEN.importEdges);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
