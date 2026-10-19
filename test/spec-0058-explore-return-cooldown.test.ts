/**
 * Spec 0058 — explore refuses only during the 10s return cooldown.
 */

import { describe, expect, it } from 'vitest';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import {
  EXPLORE_COOLDOWN_MS,
  decideExploreRepeat,
  exploreCooldownSeconds,
} from '../src/mcp/explore-repeat-guard';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';
import { formatExploreCallBudgetNote } from '../src/mcp/tools';

describe('Spec 0058 explore return cooldown', () => {
  it('quotes a 10 second wait for every indexed repo size', () => {
    expect(EXPLORE_COOLDOWN_MS).toBe(10_000);
    expect(exploreCooldownSeconds()).toBe(10);
    expect(formatExploreCallBudgetNote(1)).toBe(
      'Wait 10 seconds after homegraph_explore returns before calling it again (1 files indexed).',
    );
    expect(formatExploreCallBudgetNote(20000)).toContain('Wait 10 seconds');
    expect(formatExploreCallBudgetNote(20000)).not.toMatch(/at most \d+ calls/);
    expect(SERVER_INSTRUCTIONS).toMatch(/wait 10 seconds before calling it again/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/≤2 `homegraph_explore`/);
  });

  it('starts the clock when the result is recorded, and does not extend it on a refused call', () => {
    const session = new ExploreSessionState();
    const before = Date.now();
    session.record({
      projectRoot: '/repo',
      query: 'how backup works',
      files: [],
      sourceBytes: 100,
      responseBytes: 800,
      evidenceStatus: 'complete',
    });
    const recorded = session.forProject('/repo')!.calls[0]!;
    expect(recorded.returnedAt).toBeGreaterThanOrEqual(before);
    const during = decideExploreRepeat(session.forProject('/repo'), 'RestoreController', recorded.returnedAt! + 9_999);
    expect(during.reason).toBe('cooldown');
    const later = decideExploreRepeat(session.forProject('/repo'), 'RestoreController', recorded.returnedAt! + EXPLORE_COOLDOWN_MS);
    expect(later.refuse).toBe(false);
    const same = decideExploreRepeat(session.forProject('/repo'), 'how backup works', recorded.returnedAt! + EXPLORE_COOLDOWN_MS);
    expect(same.reason).toBe('overlap');
  });
});
