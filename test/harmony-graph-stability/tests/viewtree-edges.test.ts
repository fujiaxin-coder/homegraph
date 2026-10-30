import { describe, expect, it } from 'vitest';
import { CONTRACT, requireFilled, viewtreeEdgeTotal } from './contract';
import { indexStabilityProject, synthBy } from './helpers';
import type { Edge } from '../../../src/types';

function viewtreeByVia(edges: Edge[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of synthBy(edges, 'viewtree')) {
    const via = String((e.metadata as { via?: string } | undefined)?.via ?? '');
    out[via] = (out[via] ?? 0) + 1;
  }
  return out;
}

describe('harmony-graph-stability / viewtree edges', () => {
  it(
    'viewtree edges by via match CONTRACT.fingerprints.viewtreeByVia',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        const expected = requireFilled(
          CONTRACT.fingerprints.viewtreeByVia,
          'fingerprints.viewtreeByVia'
        );
        expect(viewtreeByVia(edges)).toEqual(expected);
        expect(synthBy(edges, 'viewtree').length).toBe(viewtreeEdgeTotal(expected));
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
