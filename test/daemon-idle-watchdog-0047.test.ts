/**
 * Spec 0047 — watchdog opt-in helpers + daemon idle / build-gate decisions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isLivenessWatchdogEnabled,
} from '../src/mcp/liveness-watchdog';
import {
  decideIdleExitAction,
  defaultDaemonIdleTimeoutMs,
  isBuildPhaseBlockingIdle,
} from '../src/mcp/daemon';

describe('isLivenessWatchdogEnabled (Spec 0047)', () => {
  it('is off by default', () => {
    expect(isLivenessWatchdogEnabled({})).toBe(false);
  });

  it('turns on with HOMEGRAPH_WATCHDOG=1', () => {
    expect(isLivenessWatchdogEnabled({ HOMEGRAPH_WATCHDOG: '1' })).toBe(true);
    expect(isLivenessWatchdogEnabled({ HOMEGRAPH_WATCHDOG: 'true' })).toBe(true);
  });

  it('HOMEGRAPH_NO_WATCHDOG wins over WATCHDOG', () => {
    expect(isLivenessWatchdogEnabled({
      HOMEGRAPH_WATCHDOG: '1',
      HOMEGRAPH_NO_WATCHDOG: '1',
    })).toBe(false);
  });
});

describe('daemon idle + build gate (Spec 0047)', () => {
  let prevIdle: string | undefined;

  beforeEach(() => {
    prevIdle = process.env.HOMEGRAPH_DAEMON_IDLE_TIMEOUT_MS;
    delete process.env.HOMEGRAPH_DAEMON_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (prevIdle === undefined) delete process.env.HOMEGRAPH_DAEMON_IDLE_TIMEOUT_MS;
    else process.env.HOMEGRAPH_DAEMON_IDLE_TIMEOUT_MS = prevIdle;
  });

  it('default idle linger is 60s', () => {
    expect(defaultDaemonIdleTimeoutMs()).toBe(60_000);
  });

  it('building_fast / indexing block idle exit', () => {
    expect(isBuildPhaseBlockingIdle('building_fast')).toBe(true);
    expect(isBuildPhaseBlockingIdle('indexing')).toBe(true);
    expect(isBuildPhaseBlockingIdle('fast')).toBe(false);
    expect(isBuildPhaseBlockingIdle('full')).toBe(false);
    expect(isBuildPhaseBlockingIdle('none')).toBe(false);
  });

  it('decideIdleExitAction: clients keep daemon; build defers; else exit', () => {
    expect(decideIdleExitAction({ clientCount: 1, buildBlocking: false })).toBe('rearm-idle');
    expect(decideIdleExitAction({ clientCount: 1, buildBlocking: true })).toBe('rearm-idle');
    expect(decideIdleExitAction({ clientCount: 0, buildBlocking: true })).toBe('poll-build');
    expect(decideIdleExitAction({ clientCount: 0, buildBlocking: false })).toBe('exit');
  });
});
