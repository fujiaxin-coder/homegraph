/**
 * Spec file-system utilities — file I/O, spec discovery, DB path resolution.
 *
 * @module spec/utils/fs
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../../errors';

// =============================================================================
// Interfaces
// =============================================================================

export interface SpecEntry {
  specId: string;
  entryType: 'directory' | 'file';
  path: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Root directory for spec data, relative to the repository root. */
export const SPEC_DATA_DIR = '.homegraph/commit4spec';

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
