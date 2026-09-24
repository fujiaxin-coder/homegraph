/**
 * Spec 0046 — runtime lifecycle / daemon.log helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  DAEMON_LOG_MAX_BYTES,
  appendProjectDaemonLog,
  formatRuntimeLogLine,
  getDaemonLogPath,
  isHomegraphDebugEnabled,
  logLifecycle,
  logToolDebug,
  maybeRotateDaemonLog,
} from '../src/runtime-log';

describe('runtime-log (Spec 0046)', () => {
  let prevDebug: string | undefined;

  beforeEach(() => {
    prevDebug = process.env.HOMEGRAPH_DEBUG;
    delete process.env.HOMEGRAPH_DEBUG;
  });

  afterEach(() => {
    if (prevDebug === undefined) delete process.env.HOMEGRAPH_DEBUG;
    else process.env.HOMEGRAPH_DEBUG = prevDebug;
  });

  it('formats a stable ISO line with truncated context', () => {
    const now = new Date('2026-09-21T09:00:00.000Z');
    const line = formatRuntimeLogLine(
      'info',
      'mcp.start',
      { mode: 'direct', query: 'x'.repeat(100) },
      now,
    );
    expect(line).toMatch(/^2026-09-21T09:00:00\.000Z \[HomeGraph\] info mcp\.start /);
    expect(line).toContain('mode=direct');
    expect(line).toMatch(/query=x{80}…/);
    expect(line).not.toContain('x'.repeat(81));
  });

  it('isHomegraphDebugEnabled respects HOMEGRAPH_DEBUG', () => {
    expect(isHomegraphDebugEnabled()).toBe(false);
    process.env.HOMEGRAPH_DEBUG = '1';
    expect(isHomegraphDebugEnabled()).toBe(true);
    process.env.HOMEGRAPH_DEBUG = '0';
    expect(isHomegraphDebugEnabled()).toBe(false);
  });

  it('logToolDebug is a no-op without HOMEGRAPH_DEBUG', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-rtlog-'));
    fs.mkdirSync(path.join(dir, '.homegraph'), { recursive: true });
    logToolDebug('homegraph_explore', { projectRoot: dir, durationMs: 12, query: 'hello' });
    const logPath = getDaemonLogPath(dir);
    expect(fs.existsSync(logPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appendProjectDaemonLog writes and rotates oversized files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-rtlog-'));
    const logPath = getDaemonLogPath(dir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'x'.repeat(DAEMON_LOG_MAX_BYTES + 10));
    maybeRotateDaemonLog(logPath, DAEMON_LOG_MAX_BYTES);
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.existsSync(logPath)).toBe(false);

    appendProjectDaemonLog(dir, 'fresh-line');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('fresh-line');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appendProjectDaemonLog does not create .homegraph when absent (Spec 0049)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-rtlog-empty-'));
    appendProjectDaemonLog(dir, 'should-not-mkdir');
    expect(fs.existsSync(path.join(dir, '.homegraph'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('logLifecycle appends when projectRoot is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-rtlog-'));
    fs.mkdirSync(path.join(dir, '.homegraph'), { recursive: true });
    logLifecycle('mcp.start', { projectRoot: dir, mode: 'direct' });
    const text = fs.readFileSync(getDaemonLogPath(dir), 'utf8');
    expect(text).toMatch(/\[HomeGraph\] info mcp\.start/);
    expect(text).toContain('mode=direct');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('logToolDebug writes under HOMEGRAPH_DEBUG', () => {
    process.env.HOMEGRAPH_DEBUG = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-rtlog-'));
    fs.mkdirSync(path.join(dir, '.homegraph'), { recursive: true });
    logToolDebug('homegraph_search', {
      projectRoot: dir,
      durationMs: 5,
      isError: false,
      query: 'alpha',
    });
    const text = fs.readFileSync(getDaemonLogPath(dir), 'utf8');
    expect(text).toMatch(/\[HomeGraph\] debug tool\.homegraph_search/);
    expect(text).toContain('durationMs=5');
    expect(text).toContain('query=alpha');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
