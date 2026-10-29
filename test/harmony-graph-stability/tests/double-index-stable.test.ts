import { describe, expect, it } from 'vitest';
import {
  amNodeKeys,
  countByKind,
  countEdgesByKind,
  indexStabilityProject,
} from './helpers';

describe('harmony-graph-stability / double index', () => {
  it(
    'two fresh indexes yield identical counts and %AM file keys',
    async () => {
      const a = await indexStabilityProject();
      let b;
      try {
        b = await indexStabilityProject();
        expect(b.counts).toEqual(a.counts);
        expect(countByKind(b.nodes)).toEqual(countByKind(a.nodes));
        expect(countEdgesByKind(b.edges)).toEqual(countEdgesByKind(a.edges));
        expect(amNodeKeys(b.nodes)).toEqual(amNodeKeys(a.nodes));
      } finally {
        a.cg.close();
        b?.cg.close();
      }
    },
    360_000
  );
});
