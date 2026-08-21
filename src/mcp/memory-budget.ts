/**
 * Catch-up sync skip policy for the HomeGraph MCP / daemon process.
 *
 * Process RSS soft ceilings were removed (spec 0015): Windows Working Set and
 * macOS resident_size are not comparable, and RSS gates falsely Partial'd tools
 * on large indexes. Growth is still bounded by SQLite `mmap_size = 0`, small
 * page cache, and default query-pool concurrency of 1.
 *
 * Catch-up sync may still skip for explicit env or large on-disk indexes —
 * re-parsing a dirty multi-hundred-MB tree remains expensive regardless of RSS.
 */

import * as fs from 'fs';

/** Index files at/above this size skip MCP catch-up sync unless forced. */
const LARGE_INDEX_SKIP_CATCHUP_BYTES = 64 * 1024 * 1024;

/**
 * MCP catch-up sync re-scans + may re-parse dirty files. Skip unless explicitly
 * forced when the operator opts out or the on-disk index is large.
 */
export function shouldSkipCatchUpSync(dbPath: string | null | undefined): boolean {
  const force = process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC;
  if (force === '1' || force === 'true' || force === 'yes') return false;
  const skip = process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC;
  if (skip === '1' || skip === 'true' || skip === 'yes') return true;
  if (!dbPath) return false;
  try {
    if (fs.statSync(dbPath).size >= LARGE_INDEX_SKIP_CATCHUP_BYTES) return true;
  } catch {
    /* missing — allow catch-up attempt */
  }
  return false;
}
