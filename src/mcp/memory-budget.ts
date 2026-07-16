/**
 * Process-wide RSS budget for the HomeGraph MCP / daemon process.
 *
 * Large indexes (~hundreds of MB SQLite) + catch-up sync (tree-sitter re-parse)
 * + unbounded callers/explore graphs previously pushed a single Node process
 * into multi-GB RSS. Agents measure the parent process tree, so that shows up
 * as ~5GB "peaks". Cap the HomeGraph process itself so *no* query or background
 * path can quietly grow without bound.
 *
 * Override with `HOMEGRAPH_MAX_RSS_MB` (clamped 256–4096). Default 1024.
 */

import * as fs from 'fs';

const DEFAULT_MAX_RSS_MB = 1024;
const MIN_MAX_RSS_MB = 256;
const MAX_MAX_RSS_MB = 4096;

/** Index files at/above this size skip MCP catch-up sync unless forced. */
const LARGE_INDEX_SKIP_CATCHUP_BYTES = 64 * 1024 * 1024;

export function resolveMaxRssMb(): number {
  const raw = process.env.HOMEGRAPH_MAX_RSS_MB;
  if (raw === undefined || raw === '') return DEFAULT_MAX_RSS_MB;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RSS_MB;
  return Math.min(MAX_MAX_RSS_MB, Math.max(MIN_MAX_RSS_MB, Math.floor(n)));
}

export function getProcessRssMb(): number {
  try {
    return process.memoryUsage().rss / (1024 * 1024);
  } catch {
    return 0;
  }
}

export function isOverRssBudget(maxMb: number = resolveMaxRssMb()): boolean {
  return getProcessRssMb() >= maxMb;
}

/** Soft tripwire — stop growing (catch-up etc.) before the hard tool refusal. */
export function isNearRssBudget(maxMb: number = resolveMaxRssMb()): boolean {
  return getProcessRssMb() >= maxMb * 0.7;
}

export function rssBudgetPartialText(context?: string): string {
  const max = resolveMaxRssMb();
  const now = Math.round(getProcessRssMb());
  const where = context ? ` (${context})` : '';
  return (
    `⚠️ **Partial result** — HomeGraph hit its process memory budget ` +
    `(~${now}MB RSS, limit ${max}MB)${where}. This is NOT an error. ` +
    `Retry ONE tighter \`homegraph_explore\` / \`homegraph_callers\` with a concrete ` +
    `symbol name — do not fan out dozens of caller lookups, and do not grep the same symbols.`
  );
}

export function rssBudgetPartialResult(context?: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: false;
} {
  return {
    content: [{ type: 'text', text: rssBudgetPartialText(context) }],
    isError: false,
  };
}

/**
 * MCP catch-up sync re-scans + may re-parse dirty files — the multi-GB path on
 * large indexes. Skip unless explicitly forced.
 */
export function shouldSkipCatchUpSync(dbPath: string | null | undefined): boolean {
  const force = process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC;
  if (force === '1' || force === 'true' || force === 'yes') return false;
  const skip = process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC;
  if (skip === '1' || skip === 'true' || skip === 'yes') return true;
  if (isNearRssBudget()) return true;
  if (!dbPath) return false;
  try {
    if (fs.statSync(dbPath).size >= LARGE_INDEX_SKIP_CATCHUP_BYTES) return true;
  } catch {
    /* missing — allow catch-up attempt */
  }
  return false;
}
