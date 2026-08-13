import { describe, expect, it } from 'vitest';
import {
  decideExploreRepeat,
  exploreQueryTokens,
  extractRetryAnchorsFromQuery,
  formatExploreRepeatRefuse,
  formatPartialExploreGuidance,
  novelAnchorsVsPriors,
  queryTokenJaccard,
  queryTokenOverlapScore,
} from '../src/mcp/explore-repeat-guard';
import type { ExploreCallRecord, ExploreProjectState } from '../src/mcp/explore-session-state';
import { isTestFile } from '../src/search/query-utils';

function call(partial: Partial<ExploreCallRecord> & { query: string }): ExploreCallRecord {
  return {
    index: partial.index ?? 1,
    projectRoot: partial.projectRoot ?? '/repo',
    query: partial.query,
    files: partial.files ?? [],
    sourceBytes: partial.sourceBytes ?? 1000,
    responseBytes: partial.responseBytes ?? 5000,
  };
}

function prior(calls: ExploreCallRecord[]): ExploreProjectState {
  return {
    projectRoot: '/repo',
    callCount: calls.length,
    responseBytes: calls.reduce((s, c) => s + c.responseBytes, 0),
    calls,
  };
}

describe('explore-repeat-guard', () => {
  it('tokenizes identifiers and CJK runs, drops stopwords', () => {
    const t = exploreQueryTokens('项目中是如何实现 notification subscribe 的');
    expect(t.has('notification')).toBe(true);
    expect(t.has('subscribe')).toBe(true);
    expect(t.has('如何')).toBe(false);
    expect(t.has('实现')).toBe(false);
  });

  it('detects overlapping paraphrase bags', () => {
    const a = exploreQueryTokens('notification subscribe multi thread');
    const b = exploreQueryTokens('通知订阅 notification subscribe 多线程');
    expect(queryTokenOverlapScore(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  it('refuses overlapping second explore without novel anchors', () => {
    const state = prior([
      call({
        query: 'how is notification subscribe implemented multi thread',
        responseBytes: 6000,
      }),
    ]);
    const d = decideExploreRepeat(state, 'notification subscribe 多线程 实现');
    expect(d.refuse).toBe(true);
    expect(d.reason).toBe('overlap');
    expect(formatExploreRepeatRefuse(d, 'notification subscribe 多线程 实现')).toMatch(/Skip repeat explore/);
  });

  it('allows follow-up when query adds a new concrete Type', () => {
    const state = prior([
      call({ query: 'how is notification subscribe implemented', responseBytes: 6000 }),
    ]);
    const d = decideExploreRepeat(state, 'NotificationBridgeEventManager register listener');
    expect(d.refuse).toBe(false);
    expect(novelAnchorsVsPriors('NotificationBridgeEventManager register', state.calls).length).toBeGreaterThan(0);
  });

  it('enforces call budget after two substantive explores without new anchors', () => {
    const state = prior([
      call({ index: 1, query: 'theme package parse install flow', responseBytes: 5000 }),
      call({ index: 2, query: 'theme package unzip apply resources', responseBytes: 4500 }),
    ]);
    const d = decideExploreRepeat(state, 'theme package parse install steps');
    expect(d.refuse).toBe(true);
    expect(d.reason).toBe('call-budget');
  });

  it('ignores tiny Partial-sized prior calls for overlap/budget', () => {
    const state = prior([
      call({ query: 'badge manager source', responseBytes: 242 }),
      call({ query: 'badge manager source', responseBytes: 242 }),
    ]);
    const d = decideExploreRepeat(state, 'badge manager source');
    expect(d.refuse).toBe(false);
  });

  it('extracts retry anchors from query without DB', () => {
    const a = extractRetryAnchorsFromQuery(
      'FooBar.baz and @kit.ArkTS.taskpool in WidgetPage.ets via Mgr::run',
    );
    expect(a.some((x) => x.includes('@kit.ArkTS'))).toBe(true);
    expect(a).toContain('WidgetPage.ets');
    expect(a).toContain('FooBar');
  });

  it('formats Partial guidance with anchors', () => {
    const text = formatPartialExploreGuidance({
      seconds: 15,
      query: 'AuthService login RefreshToken',
    });
    expect(text).toMatch(/Partial result/);
    expect(text).toMatch(/AuthService/);
    expect(text).toMatch(/tighter query|Retry ONE/);
  });

  it('keeps data-source intent on Partial retry hints', () => {
    const text = formatPartialExploreGuidance({
      seconds: 25,
      query: 'BadgeManager 角标数据来源于哪个系统服务',
    });
    expect(text).toMatch(/BadgeManager/);
    expect(text).toMatch(/数据来源|系统服务/);
    expect(text).toMatch(/bare Type alone|intent/);
  });
});

describe('isTestFile harmony instrumented trees', () => {
  it('treats ohosTest paths as tests', () => {
    expect(isTestFile('entry/src/ohosTest/ets/test/Foo.test.ets')).toBe(true);
    expect(isTestFile('product/phone/src/main/ets/Foo.ets')).toBe(false);
  });
});
