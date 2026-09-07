import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMcpQueryCacheKey } from '../src/mcp/query-cache';
import { QUERY_PLAN_VERSION } from '../src/search/query-plan';

function plan(query = 'AlphaService calls BetaService') {
  return {
    version: QUERY_PLAN_VERSION,
    originalQuery: query,
    canonicalQuery: query,
    intent: 'flow',
    route: 'general',
    anchors: ['AlphaService', 'BetaService'],
    searchTerms: ['alpha', 'beta'],
    steps: [{ id: 'step-1', query, intent: 'flow', anchors: ['AlphaService', 'BetaService'], dependsOn: [] }],
    features: { flow: true },
    source: 'rules',
    confidence: 0.9,
    telemetry: { durationMs: 1, inputTokens: 0 },
  };
}

const key = (value: unknown, extra: Record<string, unknown> = {}) =>
  buildMcpQueryCacheKey('homegraph_explore', {
    query: 'AlphaService calls BetaService', __homegraphQueryPlan: value, ...extra,
  }, 100);

describe('Structured query-plan cache identity', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not equate reversed relations with identical word bags', () => {
    expect(key(plan())).not.toBe(key(plan('BetaService calls AlphaService')));
  });

  it('includes intent, route, version, features and index readiness', () => {
    const base = plan();
    for (const change of [
      { intent: 'usages' }, { route: 'usages' }, { version: QUERY_PLAN_VERSION - 1 },
      { features: { flow: false } }, { canonicalQuery: 'BetaService callers' },
      { originalQuery: 'Follow the reverse relationship' },
    ]) expect(key(base)).not.toBe(key({ ...base, ...change }));
    expect(key(base, { __homegraphQueryIndexState: 'shallow:1' }))
      .not.toBe(key(base, { __homegraphQueryIndexState: 'full:1' }));
    const before = key(base);
    vi.stubEnv('HOMEGRAPH_EXPLORE_FULL_SOURCE', '1');
    expect(key(base)).not.toBe(before);
  });

  it('preserves step, anchor and dependency order', () => {
    const base = plan();
    expect(key(base)).not.toBe(key({ ...base, anchors: [...base.anchors].reverse() }));
    const second = { ...base.steps[0]!, id: 'step-2', dependsOn: ['step-1'] };
    expect(key({ ...base, steps: [...base.steps, second] }))
      .not.toBe(key({ ...base, steps: [second, ...base.steps] }));
    expect(key(base)).not.toBe(key({ ...base, steps: [{ ...base.steps[0]!, query: 'BetaService calls AlphaService' }] }));
    expect(key(base)).not.toBe(key({ ...base, steps: [{ ...base.steps[0]!, dependsOn: ['prior'] }] }));
  });

  it('isolates original task context even for identical lookup terms', () => {
    expect(key({ ...plan(), taskContext: 'Remove the phone entry, keep wearable' }))
      .not.toBe(key({ ...plan(), taskContext: 'Remove wearable, keep the phone entry' }));
  });

  it('keys each typed retrieval field at both plan and step scope', () => {
    const base = plan();
    for (const change of [
      { literalTexts: ['账户设置'] }, { relation: 'incoming_references' }, { sourceScope: 'local' },
      { searchTerms: ['alpha', 'settings'] },
    ]) {
      expect(key({ ...base, ...change })).not.toBe(key(base));
      expect(key({ ...base, steps: [{ ...base.steps[0]!, ...change }] })).not.toBe(key(base));
    }
    expect(key({ ...base, relation: 'incoming_references' }))
      .not.toBe(key({ ...base, relation: 'outgoing_calls' }));
    expect(key({ ...base, sourceScope: 'local' })).not.toBe(key({ ...base, sourceScope: 'sdk' }));
    expect(key({ ...base, literalTexts: ['账户设置', '设置账户'] }))
      .not.toBe(key({ ...base, literalTexts: ['设置账户', '账户设置'] }));
  });

  it('does not collapse malformed optional retrieval slots into an absent valid slot', () => {
    const base = plan();
    const legacy = buildMcpQueryCacheKey('homegraph_explore', { query: 'AlphaService calls BetaService' }, 100);
    for (const change of [
      { literalTexts: 'label' }, { literalTexts: [null] }, { relation: 12 }, { sourceScope: {} },
      { relation: 'unknown_relation' }, { sourceScope: 'remote' },
    ]) {
      for (const invalid of [{ ...base, ...change }, { ...base, steps: [{ ...base.steps[0]!, ...change }] }]) {
        expect(() => key(invalid)).not.toThrow();
        expect(key(invalid)).toBe(legacy);
        expect(key(invalid)).not.toBe(key(base));
      }
    }
    expect(key({ ...base, steps: [{ ...base.steps[0]!, searchTerms: [null] }] })).toBe(legacy);
  });

  it('ignores telemetry and execution deadlines, including nested metadata', () => {
    const base = plan();
    expect(key(base)).toBe(key({
      ...base,
      telemetry: { durationMs: 3000, inputTokens: 400, outputTokens: 75, fallbackReason: 'timeout' },
      deadline: Date.now(),
      steps: base.steps.map(step => ({ ...step, deadlineMs: 1234, telemetry: { elapsed: 100 } })),
    }, { __homegraphQueryDeadline: 321 }));
  });

  it('sorts feature properties without dropping their semantic values', () => {
    expect(key({ ...plan(), features: { flow: true, mechanism: false } }))
      .toBe(key({ ...plan(), features: { mechanism: false, flow: true } }));
  });

  it('preserves the legacy bag key when no valid plan exists', () => {
    const forward = { query: 'AlphaService calls BetaService' };
    const reverse = { query: 'BetaService calls AlphaService' };
    expect(buildMcpQueryCacheKey('homegraph_explore', forward, 100))
      .toBe(buildMcpQueryCacheKey('homegraph_explore', reverse, 100));
    const cyclic: Record<string, unknown> = {};
    cyclic.steps = [cyclic];
    for (const invalid of [undefined, null, 12, 'plan', [], {}, cyclic,
      { ...plan(), anchors: [null] }, { ...plan(), steps: [null] },
      { ...plan(), features: { flow: {} } }]) {
      expect(() => key(invalid)).not.toThrow();
      expect(key(invalid)).toBe(buildMcpQueryCacheKey('homegraph_explore', forward, 100));
    }
  });
});
