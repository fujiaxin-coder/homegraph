/**
 * commit-spec-analyzer.ts — Batch analysis of incremental commits.
 *
 * References build pipeline's scan() Strategy A pattern: iterate commits,
 * resolve scopes, extract metadata, parse diffs — all before any DB writes.
 *
 * @module spec/evolve/commit-spec-analyzer
 */

import { SpecConfig } from '../config';
import { CommitInfo, getCommitDiff } from '../build/git-scanner';
import { resolveScopeToSpec } from '../build/scope-resolver';
import { extractSpecMetadata, SpecMetadata } from '../build/spec-extractor';
import { analyzeCommitDiff, DiffFragment } from '../build/diff-parser';

// =============================================================================
// Types
// =============================================================================

/** Result of analyzing a single commit for spec match. */
export interface CommitSpecAnalysis {
  /** The commit being analyzed. */
  commit: CommitInfo;
  /** Whether the commit's scope matched a local spec. */
  matched: boolean;
  /** Resolved spec ID (only when matched). */
  specId?: string;
  /** Extracted spec metadata (only when matched). */
  metadata?: SpecMetadata;
  /** Parsed diff fragments (only when matched). */
  fragments?: DiffFragment[];
  /** Human-readable reason for non-match. */
  skipReason?: string;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Batch-analyze a list of incremental commits for spec matching.
 *
 * For each commit:
 * 1. Resolve scope from commit message.
 * 2. If scope matches a local spec file, extract metadata and parse the diff.
 * 3. Return a CommitSpecAnalysis for every commit (matched or not).
 *
 * This function performs NO database writes.  All side effects are read-only:
 * `getCommitDiff()` and `analyzeCommitDiff()` read from the git repo's
 * object store but do not modify anything.
 *
 * The most expensive operations (`getCommitDiff` + `analyzeCommitDiff`) are
 * only performed for scope-matched commits so that unmatched commits are
 * nearly zero-cost during scan.
 *
 * @param repoPath        - Absolute path to the git repository.
 * @param specStoragePath - Path to spec storage directory.
 * @param commits         - Incremental commits to analyze (chronological order).
 * @param config          - Resolved SpecConfig.
 * @returns Array of CommitSpecAnalysis, one per input commit.
 */
export function analyzeIncrementalCommits(
  repoPath: string,
  specStoragePath: string,
  commits: CommitInfo[],
  config: SpecConfig,
): CommitSpecAnalysis[] {
  const results: CommitSpecAnalysis[] = [];

  for (const commit of commits) {
    // 1. Scope resolution
    const specId = resolveScopeToSpec(commit.message, specStoragePath, config);
    if (!specId) {
      results.push({
        commit,
        matched: false,
        skipReason: 'Commit message scope did not match any local spec',
      });
      continue;
    }

    // 2. Extract spec metadata
    const metadata = extractSpecMetadata(specStoragePath, specId, config);
    if (!metadata) {
      results.push({
        commit,
        matched: false,
        skipReason: `Scope "${specId}" matched but no valid spec metadata found`,
      });
      continue;
    }

    // 3. Parse diff (only for matched commits — the expensive step)
    let fragments: DiffFragment[];
    try {
      const diff = getCommitDiff(repoPath, commit.hash);
      fragments = analyzeCommitDiff(repoPath, commit.hash, diff);
    } catch (err) {
      results.push({
        commit,
        matched: false,
        skipReason: `Diff analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    results.push({
      commit,
      matched: true,
      specId,
      metadata,
      fragments,
    });
  }

  return results;
}
