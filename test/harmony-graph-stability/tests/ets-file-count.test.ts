import { describe, expect, it } from 'vitest';
import { CONTRACT } from './contract';
import { etsFileNodes, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / ets file nodes', () => {
  it(
    'indexes CONTRACT.fingerprints.etsFileNodes (.ets only)',
    async () => {
      const { cg, nodes } = await indexStabilityProject();
      try {
        expect(etsFileNodes(nodes).length).toBe(CONTRACT.fingerprints.etsFileNodes);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
