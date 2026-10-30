import { describe, expect, it } from 'vitest';
import { CONTRACT } from './contract';
import { amNodeKeys, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / anonymous %AM nodes', () => {
  it(
    'HG has CONTRACT.amKeyCount anonymous %AM* nodes (AA name strings may differ by load mode)',
    async () => {
      const { cg, nodes } = await indexStabilityProject();
      try {
        const keys = amNodeKeys(nodes);
        expect(keys.length).toBe(CONTRACT.fingerprints.amKeyCount);
        expect(new Set(keys.map((k) => k.split('\0')[0])).size).toBe(
          CONTRACT.fingerprints.amFileCount
        );
        for (const key of keys) {
          expect(key.split('\0')[1] ?? '').toMatch(/^%AM\d+/);
        }
        expect(CONTRACT.fingerprints.amKeys.length).toBe(CONTRACT.fingerprints.amKeyCount);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
