/**
 * Optional live probes against an indexed repo.
 *
 * Prefer the suite script (runs routing + live together):
 *   node scripts/run-explore-routing.mjs
 *   HOMEGRAPH_PROBE_ROOT=D:\code\scene_board_ext node scripts/run-explore-routing.mjs
 *
 * Or directly:
 *   HOMEGRAPH_PROBE_ROOT=... npx vitest run test/explore-routing/
 *
 * Skipped in CI when HOMEGRAPH_PROBE_ROOT is unset — routing.test.ts is the
 * always-on gate. Live probes catch output-size / section-kind regressions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import HomeGraph from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';
import { ROUTING_CORPUS, resolveExploreRoute } from './corpus';
import * as q from '../../src/search/query-utils';

const ROOT = process.env.HOMEGRAPH_PROBE_ROOT?.trim();
const runLive = !!ROOT;

function asRegExp(p: string | RegExp): RegExp {
  return typeof p === 'string' ? new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : p;
}

describe.runIf(runLive)('explore-routing live probes', () => {
  let hg: HomeGraph;
  let th: ToolHandler;

  beforeAll(async () => {
    process.env.HOMEGRAPH_WASM_RELAUNCHED = '1';
    hg = await HomeGraph.open(ROOT!);
    th = new ToolHandler(hg, ROOT!);
  }, 120_000);

  afterAll(async () => {
    await hg?.close();
  });

  const liveCases = ROUTING_CORPUS.filter((c) => c.expect !== 'defer' && c.expect !== 'other');

  for (const c of liveCases) {
    it(`${c.id} route=${c.expect} size≤${c.maxChars ?? '∞'}`, async () => {
      expect(resolveExploreRoute(c.query, q)).toBe(c.expect);

      const result = await th.execute('homegraph_explore', { query: c.query });
      const text = result?.content?.[0]?.text ?? '';
      expect(text.length).toBeGreaterThan(80);

      if (c.maxChars != null) {
        expect(text.length, `too fat for ${c.id}: ${text.length}`).toBeLessThanOrEqual(c.maxChars);
      }
      for (const pat of c.mustContain ?? []) {
        expect(text, `missing ${pat} in ${c.id}`).toMatch(asRegExp(pat));
      }
      for (const pat of c.mustNotMatch ?? []) {
        expect(text, `forbidden ${pat} in ${c.id}`).not.toMatch(asRegExp(pat));
      }

      // Kind smoke checks — wrong section = wrong route landed in output.
      if (c.expect === 'light') {
        expect(text).toMatch(/Locator partial|Mechanism explore complete|CMake \/ link|Source Code|Partial locator/i);
        expect(text).not.toMatch(/Skip HomeGraph/i);
      }
      if (c.expect === 'inventory') {
        expect(text).toMatch(
          /ANSWER NOW|Kit module|Caller inventory|API usage|oh-package|Member|Related files|NAPI|Module dep|Control\/Toggle|Declaration|Data-source|Hover|System-capability|Dependency list|Unique caller/i,
        );
        expect(text).not.toMatch(/Mechanism explore complete/i);
      }
      if (c.expect === 'local') {
        expect(text).toMatch(/Local-symbol|ANSWER NOW|Source|trail|Compact local/i);
        expect(text).not.toMatch(/Mechanism explore complete/i);
      }
    }, 60_000);
  }
});

describe.runIf(!runLive)('explore-routing live probes (skipped)', () => {
  it('set HOMEGRAPH_PROBE_ROOT to enable live size/kind probes', () => {
    expect(ROOT).toBeFalsy();
  });
});
