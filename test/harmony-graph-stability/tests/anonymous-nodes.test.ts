import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { amNodeKeys, indexStabilityProject } from './helpers';

// TODO: source prior = 40 λ; HG+AA currently emits 55 keys (extra Lib line-1 shells).
describe.skip('harmony-graph-stability / anonymous %AM nodes', () => {
  it(
    'indexes exactly 40 source-lambda %AM keys across 20 files',
    async () => {
      const { cg, nodes } = await indexStabilityProject();
      try {
        const keys = amNodeKeys(nodes);
        expect(keys.length).toBe(GOLDEN.anonymousNodes);
        const files = new Set(keys.map((k) => k.split('\0')[0]));
        expect(files.size).toBe(GOLDEN.anonymousFiles);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
