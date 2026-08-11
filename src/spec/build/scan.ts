/**
 * Spec↔commit pairing — discovers which commits reference which specs via
 * conventional-commit scope extraction.
 *
 * Replaces `commit4spec/reverse_engineer/git_scanner.py`'s `scan()` (Strategy
 * A). Shared by the build pipeline and the evolve pipeline's incremental
 * commit analyzer.
 *
 * @module spec/build/scan
 */

import { SpecConfig } from '../config';
import { CommitInfo, getAllCommits } from '../git';
import { discoverSpecs } from '../utils';
import type { ProgressCallback } from '../ui';
import { resolveScopeToSpec } from './scope-resolver';
import { extractSpecMetadata, SpecMetadata } from './spec-extractor';
import { logDebug } from '../../errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecCommitPair {
  specId: string;
  commitHash: string;
  specMetadata: SpecMetadata | null;
  commitMetadata: CommitInfo | null;
}

/** Result of matching a single commit message against the on-disk specs. */
export interface SpecMatch {
  /** Resolved spec ID, or null when the commit scope matched nothing. */
  specId: string | null;
  /** Extracted spec metadata (null when the spec doc could not be read). */
  metadata: SpecMetadata | null;
}

// ---------------------------------------------------------------------------
// matchCommitToSpec
// ---------------------------------------------------------------------------

/**
 * Match a single commit message to an on-disk spec: resolve the
 * conventional-commit scope to a spec ID, then extract that spec's metadata.
 *
 * This is the shared per-commit matching step used by both {@link scan}
 * (build) and the evolve pipeline's incremental analyzer.
 */
export function matchCommitToSpec(
  message: string,
  specIds: Set<string>,
  specStoragePath: string,
  config: SpecConfig,
): SpecMatch {
  const specId = resolveScopeToSpec(message, specIds, config);
  if (!specId) {
    return { specId: null, metadata: null };
  }
  return {
    specId,
    metadata: extractSpecMetadata(specStoragePath, specId, config),
  };
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

/**
 * Main scanning function — discovers spec↔commit pairs from commit history.
 *
 * Iterates every commit in the repo, extracts a conventional-commit scope from
 * its message, normalizes it, and checks whether the resulting spec ID exists
 * on disk. When a match is found the pair is recorded with full spec and
 * commit metadata.
 *
 * Duplicates (identical specId + commitHash) are de-duplicated via a
 * `Map` keyed on `"${specId}|${commitHash}"`.
 */
export function scan(
  repoPath: string,
  specStoragePath: string,
  config: SpecConfig,
  onProgress?: ProgressCallback,
): SpecCommitPair[] {
  const pairs = new Map<string, SpecCommitPair>();

  // Hoist the directory read out of the per-commit loop.
  const specIds = new Set(discoverSpecs(specStoragePath).map((e) => e.specId));

  const commits = getAllCommits(repoPath);
  const total = commits.length;
  let current = 0;

  for (const commit of commits) {
    current++;
    onProgress?.({
      phase: 'scanning',
      current,
      total,
      message: `${commit.hash.slice(0, 7)} ${(commit.message.split('\n', 1)[0] ?? '').slice(0, 30)}`,
    });

    const { specId, metadata } = matchCommitToSpec(
      commit.message, specIds, specStoragePath, config,
    );
    if (!specId) {
      logDebug('scan: no scope match', {
        commitHash: commit.hash.slice(0, 7),
        message: commit.message,
      });
      continue;
    }

    const key = `${specId}|${commit.hash}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        specId,
        commitHash: commit.hash,
        specMetadata: metadata,
        commitMetadata: commit,
      });
    }
  }

  return Array.from(pairs.values());
}
