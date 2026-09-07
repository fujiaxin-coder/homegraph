import { describe, expect, it } from 'vitest';
import {
  decideDepthToolFuse,
  decideExploreRepeat,
  exploreQueryTokens,
  extractNextAnchorFromText,
  extractRetryAnchorsFromQuery,
  formatDepthToolRefuse,
  formatExploreRepeatRefuse,
  formatMechanismSoftCloseFooter,
  formatMechanismSoftCloseHeader,
  formatPartialExploreGuidance,
  formatSecondPartialStopFooter,
  inferExplorePartialMeta,
  isTightExploreFollowUp,
  novelAnchorsVsPriors,
  pickBestDomainRoleAnchor,
  queryTokenOverlapScore,
  scoreDomainRoleForQuery,
} from '../src/mcp/explore-repeat-guard';
import type { ExploreCallRecord, ExploreProjectState } from '../src/mcp/explore-session-state';
import { ExploreSessionState, inferExploreEvidenceStatus, EXPLORE_SESSION_LIMITS } from '../src/mcp/explore-session-state';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX } from '../src/mcp/server-instructions';
import { isTestFile } from '../src/search/query-utils';

function call(partial: Partial<ExploreCallRecord> & { query: string }): ExploreCallRecord {
  return {
    index: partial.index ?? 1,
    projectRoot: partial.projectRoot ?? '/repo',
    query: partial.query,
    files: partial.files ?? [],
    sourceBytes: partial.sourceBytes ?? 1000,
    responseBytes: partial.responseBytes ?? 5000,
    partial: partial.partial,
    nextAnchor: partial.nextAnchor,
    evidenceStatus: partial.evidenceStatus ?? (partial.partial ? 'partial' : 'complete'),
    coveredObligations: partial.coveredObligations,
    uncoveredObligations: partial.uncoveredObligations,
    locatedNodes: partial.locatedNodes,
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
    expect(queryTokenOverlapScore(a, b)).toBeGreaterThanOrEqual(0.45);
  });

  it('allows a differently scoped request even when query tokens overlap', () => {
    const state = prior([
      call({
        query: 'how is notification subscribe implemented multi thread',
        responseBytes: 6000,
      }),
    ]);
    const d = decideExploreRepeat(state, 'notification subscribe 多线程 实现');
    expect(d.refuse).toBe(false);
  });

  it('allows one tight Type follow-up after a single prior explore', () => {
    const state = prior([
      call({ query: 'how is notification subscribe implemented', responseBytes: 6000 }),
    ]);
    const d = decideExploreRepeat(state, 'NotificationBridgeEventManager');
    expect(d.refuse).toBe(false);
    expect(isTightExploreFollowUp('NotificationBridgeEventManager')).toBe(true);
    expect(novelAnchorsVsPriors('NotificationBridgeEventManager', state.calls).length).toBeGreaterThan(0);
  });

  it('hard-caps after two counted explores even with a novel Type name', () => {
    const state = prior([
      call({ index: 1, query: 'how is backup and restore implemented', responseBytes: 5000, partial: true }),
      call({ index: 2, query: 'BackupManager', responseBytes: 4500 }),
    ]);
    const d = decideExploreRepeat(state, 'RestoreController');
    expect(d.refuse).toBe(true);
    expect(d.reason).toBe('hard-cap');
    expect(formatExploreRepeatRefuse(d, 'RestoreController')).toMatch(/narrow Grep|Stop exploring/i);
  });

  it('allows one recovery even when Partial suggested an irrelevant Next anchor', () => {
    const state = prior([
      call({
        query: 'notification subscribe multi thread',
        responseBytes: 4000,
        partial: true,
        nextAnchor: 'NotificationSubscribeManager',
      }),
    ]);
    const d = decideExploreRepeat(state, '通知订阅 多线程 怎么实现');
    expect(d.refuse).toBe(false);
  });

  it('allows follow-up that names the Partial Next anchor', () => {
    const state = prior([
      call({
        query: 'notification subscribe multi thread',
        responseBytes: 4000,
        partial: true,
        nextAnchor: 'NotificationSubscribeManager',
      }),
    ]);
    const d = decideExploreRepeat(state, 'NotificationSubscribeManager');
    expect(d.refuse).toBe(false);
  });

  it('allows a newly scoped Type after Partial when Next anchor is omitted', () => {
    const state = prior([
      call({
        query: 'notification subscribe multi thread',
        responseBytes: 4000,
        partial: true,
        nextAnchor: 'NotificationSubscribeManager',
      }),
    ]);
    const d = decideExploreRepeat(state, 'NotificationBridgeEventManager');
    expect(d.refuse).toBe(false);
  });

  it('counts short empty attempts so one failed recovery cannot retry forever', () => {
    const state = prior([
      call({ query: 'badge manager source', responseBytes: 242, evidenceStatus: 'empty' }),
      call({ query: 'badge manager source', responseBytes: 242, evidenceStatus: 'empty' }),
    ]);
    const d = decideExploreRepeat(state, 'badge manager source');
    expect(d.refuse).toBe(true);
    expect(d.reason).toBe('hard-cap');
  });

  it('extracts Next anchor from Partial footer text', () => {
    expect(
      extractNextAnchorFromText(
        '> **Partial locator** — **Next anchor:** `FooManager` (class) — `a.ts:1`. ONE tighter',
      ),
    ).toBe('FooManager');
  });

  it('extracts retry anchors from query without DB', () => {
    const a = extractRetryAnchorsFromQuery(
      'FooBar.baz and @kit.ArkTS.taskpool in WidgetPage.ets via Mgr::run',
    );
    expect(a.some((x) => x.includes('@kit.ArkTS'))).toBe(true);
    expect(a).toContain('WidgetPage.ets');
    expect(a).toContain('FooBar');
  });

  it('formats Partial guidance toward narrow Grep, not a storm', () => {
    const text = formatPartialExploreGuidance({
      seconds: 15,
      query: 'AuthService login RefreshToken',
    });
    expect(text).toMatch(/Partial result/);
    expect(text).toMatch(/AuthService/);
    expect(text).toMatch(/narrow Grep/i);
    expect(text).toMatch(/one.*homegraph_node/i);
    expect(text).not.toMatch(/Grep storm/);
  });

  it('keeps data-source intent on Partial retry hints', () => {
    const text = formatPartialExploreGuidance({
      seconds: 25,
      query: 'BadgeManager 角标数据来源于哪个系统服务',
    });
    expect(text).toMatch(/BadgeManager/);
    expect(text).toMatch(/数据来源|系统服务|narrow Grep/i);
  });

  it('refuses depth tools after one call following a Partial explore', () => {
    const state = prior([
      call({
        query: 'how does subscribe work across threads',
        responseBytes: 5000,
        partial: true,
        nextAnchor: 'SubscribeManager',
      }),
    ]);
    expect(decideDepthToolFuse(state, 0, 'homegraph_node').refuse).toBe(false);
    const second = decideDepthToolFuse(state, 1, 'homegraph_node');
    expect(second.refuse).toBe(true);
    expect(second.reason).toBe('partial-depth-cap');
    expect(formatDepthToolRefuse(second, 'homegraph_node', 'Foo')).toMatch(/evidence may still be incomplete/);
  });

  it('allows one relation recovery after Partial with the shared depth budget', () => {
    const state = prior([
      call({
        query: 'how does subscribe work across threads',
        responseBytes: 5000,
        partial: true,
        nextAnchor: 'SubscribeManager',
      }),
    ]);
    const d = decideDepthToolFuse(state, 0, 'homegraph_callers');
    expect(d.refuse).toBe(false);
    expect(decideDepthToolFuse(state, 1, 'homegraph_callees').refuse).toBe(true);
  });

  it('does not fuse depth tools after a closed (non-Partial) explore', () => {
    const state = prior([
      call({ query: 'AuthService login', responseBytes: 5000, partial: false }),
    ]);
    expect(decideDepthToolFuse(state, 5, 'homegraph_node').refuse).toBe(false);
    expect(decideDepthToolFuse(state, 5, 'homegraph_callers').refuse).toBe(false);
  });
});

describe('ExploreSessionState depth counter', () => {
  it('resets depth window on Partial and clears on closed explore', () => {
    const s = new ExploreSessionState();
    s.record({
      projectRoot: '/repo',
      query: 'q1',
      files: [],
      sourceBytes: 0,
      responseBytes: 5000,
      partial: true,
      nextAnchor: 'Foo',
    });
    expect(s.depthToolCount('/repo')).toBe(0);
    expect(s.recordDepthTool('/repo')).toBe(1);
    expect(s.depthToolCount('/repo')).toBe(1);
    s.record({
      projectRoot: '/repo',
      query: 'Foo',
      files: [],
      sourceBytes: 0,
      responseBytes: 4000,
      partial: false,
      evidenceStatus: 'complete',
    });
    expect(s.depthToolCount('/repo')).toBe(0);
  });
});

describe('evidence-aware recovery receipts', () => {
  it.each(['empty', 'sdk-only', 'partial'] as const)('allows one recovery after %s evidence', (evidenceStatus) => {
    const s = new ExploreSessionState();
    s.record(call({ query: 'feedback feature bottom menu', evidenceStatus, responseBytes: 170 }));
    const state = s.forProject('/repo');
    expect(decideExploreRepeat(state, 'feedback feature bottom menu').refuse).toBe(false);
    expect(decideExploreRepeat(state, 'bottom navigation menu resources configuration').refuse).toBe(false);
    expect(decideDepthToolFuse(state, 0, 'homegraph_callers').refuse).toBe(false);
    s.record(call({ query: 'bottom navigation menu resources configuration', evidenceStatus, responseBytes: 120 }));
    expect(decideExploreRepeat(s.forProject('/repo'), 'FeedbackPage').reason).toBe('hard-cap');
  });

  it('deduplicates genuinely repeated requests once usable evidence was returned', () => {
    const state = prior([call({ query: 'FeedbackPage menu configuration', evidenceStatus: 'complete' })]);
    const d = decideExploreRepeat(state, '  FeedbackPage   menu configuration ');
    expect(d.refuse).toBe(true);
    expect(d.reason).toBe('overlap');
    expect(formatExploreRepeatRefuse(d, 'FeedbackPage menu configuration')).toMatch(/does not mean the task.*complete/);
    expect(decideExploreRepeat(state, 'FeedbackPage submission history routes').refuse).toBe(false);
  });

  it('does not deduplicate reversed relation requests with the same token bag', () => {
    const state = prior([call({ query: 'AlphaController calls BetaService', evidenceStatus: 'complete' })]);
    expect(decideExploreRepeat(state, 'BetaService calls AlphaController').refuse).toBe(false);
  });

  it('does not lose the lifetime retrieval budget when old call detail was evicted', () => {
    const state = prior([call({ query: 'one retained incomplete attempt', evidenceStatus: 'empty' })]);
    state.callCount = 10;
    expect(decideExploreRepeat(state, 'new obligation').reason).toBe('hard-cap');
  });

  it('infers empty and SDK-only legacy receipts from actual emitted source', () => {
    const empty = call({ query: 'playback button' });
    delete empty.evidenceStatus;
    expect(inferExploreEvidenceStatus(empty)).toBe('empty');
    empty.files = [{ path: 'ohos-sdk:api/@ohos.util.Stack.d.ts', bytes: 400, ranges: [{ start: 5, end: 10 }] }];
    expect(inferExploreEvidenceStatus(empty)).toBe('sdk-only');
    empty.files.push({ path: 'entry/src/main/ets/pages/Player.ets', bytes: 500, ranges: [{ start: 20, end: 40 }] });
    expect(inferExploreEvidenceStatus(empty)).toBe('complete');
    empty.partial = true;
    expect(inferExploreEvidenceStatus(empty)).toBe('partial');
  });

  it('preserves bounded evidence coverage and located nodes across the session worker view', () => {
    const s = new ExploreSessionState();
    const located = { id: 'local-player', name: 'Player', filePath: 'Player.ets', startLine: 10 };
    s.record(call({
      query: 'playback handler', evidenceStatus: 'complete', locatedNodes: [located],
      coveredObligations: ['handler', 'handler'],
      uncoveredObligations: Array.from({ length: 30 }, (_, i) => `missing ${i}`),
    }));
    const first = s.view().projects[0]!.calls[0]!;
    expect(first.partial).toBe(true);
    expect(first.evidenceStatus).toBe('partial');
    expect(first.locatedNodes).toEqual([located]);
    expect(first.coveredObligations).toEqual(['handler']);
    expect(first.uncoveredObligations).toHaveLength(EXPLORE_SESSION_LIMITS.MAX_OBLIGATIONS);
    first.locatedNodes![0]!.name = 'modified outside state';
    first.coveredObligations!.push('invented');
    expect(s.forProject('/repo')!.calls[0]!.locatedNodes![0]!.name).toBe('Player');
    expect(s.forProject('/repo')!.calls[0]!.coveredObligations).toEqual(['handler']);
  });

  it('server guidance keeps authorized coding and verification active after retrieval', () => {
    for (const instructions of [SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX]) {
      expect(instructions).toMatch(/Retrieval completion is not task completion/);
      expect(instructions).not.toMatch(/ANSWER NOW|must name the \*\*Next anchor\*\*|stop — do not retry/);
      expect(instructions).toMatch(/edits and validation/);
    }
  });
});

describe('pickBestDomainRoleAnchor', () => {
  it('prefers query-overlapping Manager over weak Subscriber helper', () => {
    const best = pickBestDomainRoleAnchor(
      [
        {
          name: 'LocationSubscriber',
          kind: 'class',
          filePath: 'feature/engineservice/src/LocationSubscriber.ets',
          startLine: 16,
        },
        {
          name: 'NotificationBridgeEventManager',
          kind: 'class',
          filePath: 'feature/notification/manager/NotificationBridgeEventManager.ets',
          startLine: 30,
        },
        {
          name: 'SubscriberUtils',
          kind: 'class',
          filePath: 'product/phonebase/SubscriberUtils.ets',
          startLine: 24,
        },
      ],
      'notification subscribe multi thread',
    );
    expect(best?.name).toBe('NotificationBridgeEventManager');
    expect(scoreDomainRoleForQuery(best!, 'notification subscribe')).toBeGreaterThan(
      scoreDomainRoleForQuery(
        { name: 'LocationSubscriber', kind: 'class', filePath: 'feature/engineservice/x.ets' },
        'notification subscribe',
      ),
    );
  });

  it('CJK 通知订阅 prefers SubscribeManager over screenlock StateManager', () => {
    const best = pickBestDomainRoleAnchor(
      [
        {
          name: 'NotificationStateManager',
          kind: 'class',
          filePath: 'feature/screenlock/manager/NotificationStateManager.ets',
          startLine: 10,
        },
        {
          name: 'NotificationSubscribeManager',
          kind: 'class',
          filePath: 'feature/notification/notificationcomponent/src/main/ets/manager/NotificationSubscribeManager.ets',
          startLine: 40,
        },
        {
          name: 'LocationSubscriber',
          kind: 'class',
          filePath: 'feature/notification/LocationSubscriber.ets',
          startLine: 5,
        },
      ],
      '项目中是如何实现通知订阅管理的，涉及的多线程或多进程是怎样的？',
    );
    expect(best?.name).toBe('NotificationSubscribeManager');
  });

  it('CJK 备份恢复 prefers BackupExtension over BackupEventManager', () => {
    const best = pickBestDomainRoleAnchor(
      [
        {
          name: 'BackupEventManager',
          kind: 'class',
          filePath: 'product/phonebase/src/main/ets/backup/BackupEventManager.ets',
          startLine: 12,
        },
        {
          name: 'BackupExtension',
          kind: 'class',
          filePath: 'product/phonebase/src/main/ets/backup/BackupExtension.ets',
          startLine: 20,
        },
      ],
      '项目中是如何实现备份与恢复的',
    );
    expect(best?.name).toBe('BackupExtension');
  });

  it('coarse and partial footers distinguish retrieval limits from coding completion', () => {
    expect(formatMechanismSoftCloseFooter({ name: 'FooManager', kind: 'class', filePath: 'a.ts' }))
      .toMatch(/Retrieval is not task completion/i);
    expect(formatMechanismSoftCloseFooter({ name: 'FooManager', kind: 'class', filePath: 'a.ts' }))
      .not.toMatch(/Partial locator/);
    expect(formatMechanismSoftCloseHeader()).toMatch(/Coarse source evidence/i);
    expect(formatMechanismSoftCloseHeader()).not.toMatch(/Partial locator/);
    expect(formatSecondPartialStopFooter('FooManager')).toMatch(/Evidence remains incomplete/);
    expect(formatSecondPartialStopFooter('FooManager')).toMatch(/continue the requested edits and validation/);
  });

  it('a textual completion slogan never clears reported partial evidence', () => {
    const text = [
      '> **Partial locator** — Manager / domain inventory below are anchors',
      '...digests...',
      '> **Coarse locate — ANSWER from anchors + digests above.** Primary Type: `FooManager`.',
    ].join('\n');
    const meta = inferExplorePartialMeta(text);
    expect(meta.partial).toBe(true);
    expect(meta.nextAnchor).toBeUndefined();
  });
});
