/**
 * Spec utility functions — replaces `file_utils.py`, `meta.py`, and
 * `truncate.py` from Python Commit4Spec.
 *
 * Covers file I/O, meta.json read/write, text/diff truncation, and budget
 * computation. All functions are synchronous and use Node.js built-ins.
 *
 * @module spec/utils
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../errors';

// =============================================================================
// Interfaces
// =============================================================================

export interface SpecEntry {
  specId: string;
  entryType: 'directory' | 'file';
  path: string;
}

export interface SpecMeta {
  repoPath: string;
  specStoragePath: string;
  currentCommitID?: string; // HEAD commit hash at mining time
  createdAt?: string; // ISO-8601 string
  updatedAt: string;  // ISO-8601 string (always set on write)
}

export interface BudgetProfile {
  tier: 'tiny' | 'small' | 'medium' | 'large' | 'vlarge';
  maxFragments: number;
  maxContents: number;
  contentBudget: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Root directory for spec data, relative to the repository root. */
export const SPEC_DATA_DIR = '.homegraph/commit4spec';

const TRUNCATION_SUFFIX = '  …(truncated)';
const TRUNCATION_SUFFIX_LENGTH = TRUNCATION_SUFFIX.length;

// =============================================================================
// File I/O
// =============================================================================

/**
 * Read a UTF-8 file synchronously.
 *
 * Returns `null` for ENOENT (not found), EISDIR (is a directory), or EACCES
 * (permission denied). Other errors propagate.
 */
export function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'EACCES') {
      return null;
    }
    throw err;
  }
}

/**
 * Write a UTF-8 file synchronously, creating parent directories as needed.
 *
 * Parent directories are created with `fs.mkdirSync({ recursive: true })`.
 * If the parent exists but is not a directory the underlying error propagates.
 */
export function writeFileContent(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

// =============================================================================
// Commit-info.md parsing
// =============================================================================

/**
 * Regex matching commit-hash annotations in commit-info.md content.
 *
 * Matches lines like:
 *   commit: abc123def456...
 *   commit-id: abc123def456...
 *   commit_id: abc123def456...
 *   commit-id=abc123def456...
 *   abc123def456789... (bare 40-char hex on its own line)
 */
const COMMIT_HASH_RE = /^commit[-_ ]?(?:id)?[:= ]\s*([a-f0-9]{7,40})\s*$/i;
const BARE_HASH_RE = /^([a-f0-9]{40})\s*$/i;

/**
 * Parse commit-info.md content for a commit hash.
 *
 * Searches line by line for one of:
 * - `commit: HASH`
 * - `commit-id: HASH`
 * - `commit_id: HASH`
 * - a bare 40-char hex hash on its own line
 *
 * Returns the first matched hash (7–40 hex chars), or `null` if no hash is
 * found. Empty or whitespace-only input returns `null`.
 */
export function parseCommitInfoMd(content: string): string | null {
  if (!content) return null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try annotated hash first
    const match = COMMIT_HASH_RE.exec(trimmed);
    if (match) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return match[1]!.toLowerCase();
    }

    // Try bare 40-char hex
    const bareMatch = BARE_HASH_RE.exec(trimmed);
    if (bareMatch) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return bareMatch[1]!.toLowerCase();
    }
  }

  return null;
}

// =============================================================================
// Spec discovery
// =============================================================================

/**
 * Discover specs in a storage directory.
 *
 * A "spec" is any `.md` file OR any subdirectory. For `.md` files the
 * `specId` is the basename without the extension. For subdirectories the
 * `specId` is the directory name.
 *
 * Returns an empty array when `specStoragePath` does not exist or is not a
 * directory.
 */
export function discoverSpecs(specStoragePath: string): SpecEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(specStoragePath, { withFileTypes: true });
  } catch (err: any) {
    // Non-existent or not a directory → empty list
    return [];
  }

  const result: SpecEntry[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      result.push({
        specId: entry.name,
        entryType: 'directory',
        path: path.join(specStoragePath, entry.name),
      });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      result.push({
        specId: entry.name.slice(0, -3), // strip ".md"
        entryType: 'file',
        path: path.join(specStoragePath, entry.name),
      });
    }
    // Symlinks, other file types, and dot-files are silently skipped.
  }

  return result;
}

// =============================================================================
// Database path resolution
// =============================================================================

/**
 * Resolve the database path.
 *
 * Priority:
 * 1. If `explicitDbPath` is given, return it as-is (no side effects).
 * 2. If `repoPath` is given, default to `{repoPath}/${SPEC_DATA_DIR}/commit4spec.db`
 *    and ensure `${SPEC_DATA_DIR}/.gitignore` exists containing `"*"`.
 * 3. If neither is given, return `"./commit4spec.db"`.
 */
export function resolveDbPath(repoPath?: string, explicitDbPath?: string): string {
  if (explicitDbPath) {
    return explicitDbPath;
  }

  if (repoPath) {
    const commit4specDir = path.join(repoPath, SPEC_DATA_DIR);
    const gitignorePath = path.join(commit4specDir, '.gitignore');
    const dbPath = path.join(commit4specDir, 'commit4spec.db');

    // Ensure ${SPEC_DATA_DIR} directory exists
    try {
      fs.mkdirSync(commit4specDir, { recursive: true });
    } catch {
      // Directory may already exist; ok.
    }

    // Write .gitignore if it doesn't exist
    if (!fs.existsSync(gitignorePath)) {
      try {
        fs.writeFileSync(gitignorePath, '*\n', 'utf-8');
      } catch (err) {
        logWarn(`Failed to write ${SPEC_DATA_DIR}/.gitignore`, {
          path: gitignorePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return dbPath;
  }

  return './commit4spec.db';
}

// =============================================================================
// Meta read / write
// =============================================================================

/**
 * Read `${SPEC_DATA_DIR}/meta.json` from `repoPath`.
 *
 * Returns `null` when the file is missing, unreadable, or contains invalid
 * JSON or a JSON value that is not a plain object.
 */
export function readMeta(repoPath: string): SpecMeta | null {
  const metaPath = path.join(repoPath, SPEC_DATA_DIR, 'meta.json');

  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logWarn(`Ignoring ${SPEC_DATA_DIR}/meta.json: not valid JSON`, {
      path: metaPath,
    });
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logWarn(
      `Ignoring ${SPEC_DATA_DIR}/meta.json: top-level value must be a JSON object`,
      { path: metaPath },
    );
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required string fields
  if (typeof obj.repoPath !== 'string' || typeof obj.specStoragePath !== 'string') {
    logWarn(
      `Ignoring ${SPEC_DATA_DIR}/meta.json: repoPath and specStoragePath must be strings`,
      { path: metaPath },
    );
    return null;
  }

  return {
    repoPath: obj.repoPath,
    specStoragePath: obj.specStoragePath,
    currentCommitID: typeof obj.currentCommitID === 'string' ? obj.currentCommitID : undefined,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };
}

/**
 * Write `${SPEC_DATA_DIR}/meta.json` to `repoPath`.
 *
 * If existing meta has a `createdAt` field it is preserved; otherwise the
 * current time is used as the creation timestamp. `updatedAt` is always set
 * to the current time. The `${SPEC_DATA_DIR}` directory is created if it does
 * not exist.
 *
 * Returns the full `SpecMeta` that was written.
 */
export function writeMeta(
  repoPath: string,
  specStoragePath: string,
  currentCommitID?: string,
): SpecMeta {
  const metaDir = path.join(repoPath, SPEC_DATA_DIR);
  const metaPath = path.join(metaDir, 'meta.json');

  const now = new Date().toISOString();

  // Preserve createdAt from existing meta; use now for new files
  const existing = readMeta(repoPath);
  const createdAt = (existing?.createdAt) || now;

  const meta: SpecMeta = {
    repoPath,
    specStoragePath,
    currentCommitID,
    createdAt,
    updatedAt: now,
  };

  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

  return meta;
}

// =============================================================================
// Truncation utilities
// =============================================================================

/**
 * Truncate a unified diff at a sensible boundary.
 *
 * The algorithm prefers semantic boundaries to keep diffs readable:
 *
 * 1. If the diff is shorter than `maxChars` (default 3800), return it unchanged.
 * 2. Try: find the **last** `@@` hunk header in the trailing 50% portion of
 *    the diff and cut right before it.
 * 3. Fallback: find the **last** newline in the trailing 80% portion and cut
 *    after it.
 * 4. Hard fallback: cut exactly at `maxChars`.
 *
 * Always appends `"  …(truncated)"` when truncation occurs.
 *
 * @param diff    - The unified diff text to truncate.
 * @param maxChars - Maximum allowed characters (including suffix). Default 3800.
 * @returns The (possibly truncated) diff text.
 */
export function truncateCodeDiff(diff: string, maxChars: number = 3800): string {
  if (diff.length <= maxChars) {
    return diff;
  }

  const suffix = TRUNCATION_SUFFIX;
  const effectiveMax = maxChars - TRUNCATION_SUFFIX_LENGTH;
  if (effectiveMax <= 0) {
    return diff.slice(0, Math.max(0, maxChars - 1)) + suffix;
  }

  // Step 2: find last "@@" hunk header in trailing 50%
  const halfPoint = Math.floor(diff.length * 0.5);
  // We search for "\n@@" or "@@" at the very start.  Use a regex that
  // matches a line starting with "@@" (after optional leading whitespace in
  // some edge cases, but standard diffs have "@@" at column 0).
  const hunkHeaderRe = /(^|\n)@@/g;
  let lastHunkHeaderPos = -1;
  let match: RegExpExecArray | null;

  // Reset lastIndex and scan from the beginning; we only accept matches whose
  // index is >= halfPoint.
  hunkHeaderRe.lastIndex = 0;
  while ((match = hunkHeaderRe.exec(diff)) !== null) {
    const cap = match[1]; // the newline-or-start anchor
    const pos = match.index + (cap ? cap.length : 0); // position of "@@"
    if (pos >= halfPoint && pos <= effectiveMax) {
      lastHunkHeaderPos = pos;
    }
  }

  if (lastHunkHeaderPos > 0) {
    return diff.slice(0, lastHunkHeaderPos) + suffix;
  }

  // Step 3: find last "\n" in trailing 80%
  const eightyPoint = Math.floor(diff.length * 0.2);
  for (let i = effectiveMax - 1; i >= eightyPoint; i--) {
    if (diff[i] === '\n' && i < effectiveMax) {
      return diff.slice(0, i + 1) + suffix;
    }
  }

  // Step 4: hard cut
  return diff.slice(0, effectiveMax) + suffix;
}

/**
 * Truncate plain text with newline-awareness.
 *
 * When the text is longer than `maxChars`, it is cut at the last newline
 * found before `maxChars` (minus the suffix length). If no suitable newline
 * exists, a hard cut is made.
 *
 * The suffix `"  …(truncated)"` is appended only when truncation occurs.
 *
 * @param text     - The text to truncate.
 * @param maxChars - Maximum allowed characters (including suffix).
 * @returns The (possibly truncated) text.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const suffix = TRUNCATION_SUFFIX;
  const effectiveMax = maxChars - TRUNCATION_SUFFIX_LENGTH;
  if (effectiveMax <= 0) {
    return text.slice(0, Math.max(0, maxChars - 1)) + suffix;
  }

  // Try to find the last newline within the budget
  for (let i = effectiveMax - 1; i >= 0; i--) {
    if (text[i] === '\n') {
      return text.slice(0, i) + suffix;
    }
  }

  // Hard cut
  return text.slice(0, effectiveMax) + suffix;
}

/**
 * Truncate a subtitles array.
 *
 * 1. If the array has more than `maxEntries`, it is sliced to `maxEntries`.
 * 2. Each remaining entry that exceeds `maxChars` is individually truncated
 *    via `truncateText`.
 *
 * Entries that already fit within both limits are left unchanged.
 *
 * @param subtitles  - Array of subtitle strings.
 * @param maxChars   - Maximum characters per entry (including suffix).
 * @param maxEntries - Maximum number of entries to keep.
 * @returns The truncated subtitles array (always a new array).
 */
export function truncateSubtitles(
  subtitles: string[],
  maxChars: number,
  maxEntries: number,
): string[] {
  // Cap entry count
  const capped = subtitles.length > maxEntries ? subtitles.slice(0, maxEntries) : [...subtitles];

  // Truncate each entry
  return capped.map((entry) => truncateText(entry, maxChars));
}

// =============================================================================
// Budget profile
// =============================================================================

/**
 * Compute a budget profile based on spec and optional fragment counts.
 *
 * The profile determines how many fragments, contents, and characters the
 * pipeline should budget when building LLM prompts. Higher counts produce
 * tighter budgets to keep prompts manageable.
 *
 * Thresholds (matching `truncate.py:38-57`):
 *
 * | specCount | tier    | maxFragments | maxContents | contentBudget |
 * |-----------|---------|--------------|-------------|---------------|
 * | ≤ 3       | tiny    | 12           | 16          | 48000         |
 * | ≤ 8       | small   | 10           | 14          | 40000         |
 * | ≤ 15      | medium  | 8            | 12          | 32000         |
 * | ≤ 30      | large   | 6            | 10          | 24000         |
 * | > 30      | vlarge  | 0            | 0           | 16000         |
 *
 * The `vlarge` tier disables fragment/contents inclusion entirely (0 values).
 *
 * @param specCount     - Number of specs in the knowledge graph.
 * @param fragmentCount - (Unused) reserved for future per-fragment weighting.
 * @returns The budget profile for the given scale.
 */
export function computeBudgetProfile(
  specCount: number,
  _fragmentCount?: number,
): BudgetProfile {
  if (specCount <= 3) {
    return { tier: 'tiny', maxFragments: 12, maxContents: 16, contentBudget: 48000 };
  }
  if (specCount <= 8) {
    return { tier: 'small', maxFragments: 10, maxContents: 14, contentBudget: 40000 };
  }
  if (specCount <= 15) {
    return { tier: 'medium', maxFragments: 8, maxContents: 12, contentBudget: 32000 };
  }
  if (specCount <= 30) {
    return { tier: 'large', maxFragments: 6, maxContents: 10, contentBudget: 24000 };
  }
  return { tier: 'vlarge', maxFragments: 0, maxContents: 0, contentBudget: 16000 };
}
