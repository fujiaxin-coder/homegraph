/**
 * Spec 0046 — coarse lifecycle lines + optional HOMEGRAPH_DEBUG tool traces.
 *
 * Sink: `.homegraph/daemon.log` (same file daemon stdio already uses) when a
 * project root is known; always mirror to stderr. Soft-rotate at ~5 MiB.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getHomeGraphDir } from './directory';

/** Soft rotate threshold for `.homegraph/daemon.log` (Spec 0046). */
export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Truncate free-text fields in log context (queries, messages). */
export const RUNTIME_LOG_TEXT_MAX = 80;

export type RuntimeLogLevel = 'info' | 'warn' | 'error' | 'debug';

export function getDaemonLogPath(projectRoot: string): string {
  return path.join(getHomeGraphDir(projectRoot), 'daemon.log');
}

/** Compact `k=v` pairs; strings truncated; omit undefined/null. */
export function formatRuntimeLogContext(context?: Record<string, unknown>): string {
  if (!context) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(context)) {
    if (raw === undefined || raw === null) continue;
    let value: string;
    if (typeof raw === 'string') {
      value = raw.length > RUNTIME_LOG_TEXT_MAX
        ? `${raw.slice(0, RUNTIME_LOG_TEXT_MAX)}…`
        : raw;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      value = String(raw);
    } else {
      try {
        const json = JSON.stringify(raw);
        value = json.length > RUNTIME_LOG_TEXT_MAX
          ? `${json.slice(0, RUNTIME_LOG_TEXT_MAX)}…`
          : json;
      } catch {
        value = String(raw);
      }
    }
    // Keep one token: spaces → _
    value = value.replace(/\s+/g, '_');
    parts.push(`${key}=${value}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Stable one-line format (Spec 0046):
 * `ISO8601Z [HomeGraph] <level> <event> key=value …`
 */
export function formatRuntimeLogLine(
  level: RuntimeLogLevel,
  event: string,
  context?: Record<string, unknown>,
  now: Date = new Date(),
): string {
  const iso = now.toISOString();
  return `${iso} [HomeGraph] ${level} ${event}${formatRuntimeLogContext(context)}`;
}

/** Rename oversized log to `daemon.log.1` (overwrite prior `.1`). */
export function maybeRotateDaemonLog(logPath: string, maxBytes = DAEMON_LOG_MAX_BYTES): void {
  try {
    const st = fs.statSync(logPath);
    if (st.size < maxBytes) return;
    const rotated = `${logPath}.1`;
    try {
      fs.unlinkSync(rotated);
    } catch {
      /* no prior .1 */
    }
    fs.renameSync(logPath, rotated);
  } catch {
    /* missing or unreadable — append will create */
  }
}

/**
 * Append one line to `.homegraph/daemon.log` under `projectRoot`.
 * Never throws to callers — logging must not break MCP.
 */
export function appendProjectDaemonLog(projectRoot: string | null | undefined, line: string): void {
  if (!projectRoot) return;
  try {
    const dir = getHomeGraphDir(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, 'daemon.log');
    maybeRotateDaemonLog(logPath);
    fs.appendFileSync(logPath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
  } catch {
    /* ignore I/O errors */
  }
}

function writeStderr(line: string): void {
  try {
    fs.writeSync(2, `${line}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Always-on coarse event: stderr + daemon.log when `projectRoot` is set.
 */
export function logLifecycle(
  event: string,
  context?: Record<string, unknown> & { projectRoot?: string },
): void {
  const { projectRoot, ...rest } = context ?? {};
  const line = formatRuntimeLogLine('info', event, {
    ...(projectRoot ? { root: projectRoot } : {}),
    ...rest,
  });
  writeStderr(line);
  appendProjectDaemonLog(projectRoot, line);
}

/**
 * Always-on error-shaped lifecycle (still info-level event name namespace).
 */
export function logLifecycleError(
  event: string,
  context?: Record<string, unknown> & { projectRoot?: string },
): void {
  const { projectRoot, ...rest } = context ?? {};
  const line = formatRuntimeLogLine('error', event, {
    ...(projectRoot ? { root: projectRoot } : {}),
    ...rest,
  });
  writeStderr(line);
  appendProjectDaemonLog(projectRoot, line);
}

/** True when fine-grained tool traces should emit (Spec 0046). */
export function isHomegraphDebugEnabled(): boolean {
  const v = process.env.HOMEGRAPH_DEBUG?.trim();
  if (!v) return false;
  return v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'off';
}

/**
 * Tool-call summary — only when `HOMEGRAPH_DEBUG` is set.
 * Does not dump full query/body; truncates query text.
 */
export function logToolDebug(
  toolName: string,
  context: {
    projectRoot?: string;
    durationMs: number;
    isError?: boolean;
    evidenceStatus?: string;
    query?: string;
  },
): void {
  if (!isHomegraphDebugEnabled()) return;
  const { projectRoot, query, ...rest } = context;
  const line = formatRuntimeLogLine('debug', `tool.${toolName}`, {
    ...(projectRoot ? { root: projectRoot } : {}),
    ...rest,
    ...(query !== undefined ? { query } : {}),
  });
  writeStderr(line);
  appendProjectDaemonLog(projectRoot, line);
}
