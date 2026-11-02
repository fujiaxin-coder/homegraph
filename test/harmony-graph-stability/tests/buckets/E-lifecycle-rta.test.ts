/**
 * 桶 E — DummyMain / export lifecycle
 * 测什么：Component lifecycle → 子调用（RTA 主路径）在各 HAP 模块可复现
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_E_MUST } from '../calls-gold';
import {
  assertMustPresent,
  assertNodeExists,
  collectArkCalls,
  findMatches,
  goldLabel,
  moduleOf,
  outboundFrom,
  uniqueCalleeKeys,
  type IndexedCall,
} from '../calls-match';
import { openStabilityIndex, type StabilityIndex } from '../helpers';

describe('桶 E · lifecycle / RTA 主路径', () => {
  let idx: StabilityIndex;
  let calls: IndexedCall[];

  beforeAll(async () => {
    idx = await openStabilityIndex();
    calls = collectArkCalls(idx.nodes, idx.edges);
  }, 180_000);

  afterAll(() => idx?.dispose());

  describe('must — 逐边召回', () => {
    for (const g of BUCKET_E_MUST) {
      it(goldLabel(g), () => {
        assertMustPresent(calls, [g]);
      });
    }
  });

  it('各 Page / Child / runLib 符号存在', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E'] as const) {
      const mod = `mod_${letter.toLowerCase()}`;
      assertNodeExists(idx.nodes, `${mod}/src/main/ets/Page${letter}.ets`, `Page${letter}`);
      assertNodeExists(idx.nodes, `${mod}/src/main/ets/Page${letter}.ets`, 'aboutToAppear');
      assertNodeExists(idx.nodes, `${mod}/src/main/ets/Page${letter}.ets`, 'build');
      assertNodeExists(idx.nodes, `${mod}/src/main/ets/Child${letter}.ets`, `Child${letter}`);
      assertNodeExists(idx.nodes, `${mod}/src/main/ets/Lib${letter}.ets`, `runLib${letter}`);
    }
  });

  it('aboutToAppear → runLib* 均在同模块', () => {
    const lifecycle = BUCKET_E_MUST.filter((g) => g.callerName === 'aboutToAppear');
    expect(lifecycle.length).toBeGreaterThanOrEqual(5);
    for (const g of lifecycle) {
      const hit = findMatches(calls, g)[0];
      expect(moduleOf(hit.callerFile)).toBe(moduleOf(hit.calleeFile));
      expect(hit.calleeName).toMatch(/^runLib[A-E]$/);
    }
  });

  it('build → Child constructor 同模块', () => {
    const builds = BUCKET_E_MUST.filter((g) => g.calleeName === 'constructor');
    expect(builds.length).toBeGreaterThanOrEqual(2);
    for (const g of builds) {
      const hit = findMatches(calls, g)[0];
      expect(moduleOf(hit.callerFile)).toBe(moduleOf(hit.calleeFile));
      expect(hit.calleeFile).toMatch(/Child[A-E]\.ets$/);
    }
  });

  it('PageA.aboutToAppear 出边含 runLibA，且不含 FanoutTrap', () => {
    const out = outboundFrom(calls, 'mod_a/src/main/ets/PageA.ets', 'aboutToAppear');
    const keys = uniqueCalleeKeys(out);
    expect(keys.some((k) => k.includes('runLibA'))).toBe(true);
    expect(keys.some((k) => k.includes('FanoutTrap'))).toBe(false);
  });

  it('全桶 must 一次扫过', () => {
    assertMustPresent(calls, BUCKET_E_MUST);
  });
});
