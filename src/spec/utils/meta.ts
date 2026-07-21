/**
 * Spec meta.json read/write — the incremental-anchor file under
 * `${SPEC_DATA_DIR}/meta.json`.
 *
 * @module spec/utils/meta
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../../errors';
import { SPEC_DATA_DIR } from './fs';

// =============================================================================
// Interfaces
// =============================================================================

export interface SpecMeta {
  repoPath: string;
  specStoragePath: string;
  currentCommitID?: string; // HEAD commit hash at mining time
  createdAt?: string; // ISO-8601 string
  updatedAt: string;  // ISO-8601 string (always set on write)
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
