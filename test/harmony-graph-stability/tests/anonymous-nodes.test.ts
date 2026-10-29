import { describe, expect, it } from 'vitest';
import { GOLDEN } from './golden';
import { amNodeKeys, indexStabilityProject } from './helpers';

describe('harmony-graph-stability / anonymous %AM nodes', () => {
  it(
    'indexes at least one RTA-reached %AM node with stable file keys',
    async () => {
      const { cg, nodes } = await indexStabilityProject();
      try {
        const keys = amNodeKeys(nodes);
        expect(keys.length).toBeGreaterThanOrEqual(GOLDEN.minAnonymousNodes);
        // Each key embeds filePath — duplicates of the same name in different
        // files are distinct entries, not a single drifted attribution.
        const files = new Set(keys.map((k) => k.split('\0')[0]));
        expect(files.size).toBeGreaterThanOrEqual(1);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
