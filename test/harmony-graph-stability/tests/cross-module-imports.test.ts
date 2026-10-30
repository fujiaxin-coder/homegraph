import { describe, expect, it } from 'vitest';
import { CONTRACT } from './contract';
import { countEdgesByKind, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / cross-module imports', () => {
  it(
    'persists CONTRACT.fingerprints.imports edges',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        const byKind = countEdgesByKind(edges);
        expect(byKind.imports ?? 0).toBe(CONTRACT.fingerprints.imports);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
