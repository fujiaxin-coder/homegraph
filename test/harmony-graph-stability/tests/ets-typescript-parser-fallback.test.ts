/**
 * P2 — non-persisted .ets after ArkTS batch → TreeSitterExtractor forced to
 * 'typescript' → "Failed to get parser for language: typescript" when the TS
 * wasm grammar was never loaded (ArkUI-only trees).
 * Production fix deferred — this test fails on the current branch.
 */
import { describe, expect, it } from 'vitest';
import { extractFromSource } from '../../../src/extraction/tree-sitter';
import {
  isArkTSBatchCommitted,
  isArkTSBatchPersisted,
} from '../../../src/extraction/languages/arkts';
import { indexStabilityProject } from './helpers';

describe('P2 .ets → typescript parser fallback', () => {
  it(
    'non-persisted .ets with batch committed must not error Failed to get parser for language: typescript',
    async () => {
      const { cg } = await indexStabilityProject();
      try {
        expect(isArkTSBatchCommitted()).toBe(true);
        const ghost = 'feature/never-scanned/Ghost.ets';
        expect(isArkTSBatchPersisted(ghost)).toBe(false);
        const result = extractFromSource(
          ghost,
          `@Component\nstruct Ghost {\n  build() { Text('g') }\n}\n`,
          'arkts'
        );
        expect(result.errors.map((e) => e.message).join('\n')).not.toMatch(
          /Failed to get parser for language: typescript/
        );
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
