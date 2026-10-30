import { describe, expect, it } from 'vitest';
import { CONTRACT } from './contract';
import { countEdgesByKind, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / heritage edges', () => {
  it(
    'persists CONTRACT extends + implements fingerprints',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        const byKind = countEdgesByKind(edges);
        expect(byKind.extends ?? 0).toBe(CONTRACT.fingerprints.extends);
        expect(byKind.implements ?? 0).toBe(CONTRACT.fingerprints.implements);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
