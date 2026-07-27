/**
 * cluster-context.ts — Build cluster-level context summary for LLM spec evaluation.
 *
 * References mine/generator.ts buildClusterPrompt for the multi-commit
 * context aggregation pattern, but uses simpler data (diff-based instead of
 * AST-based) since evolve works with unified diffs.
 *
 * The ClusterContext / CommitSummary / CommitContextInput types live in
 * `../types` so the LLM layer can depend on them without importing from a
 * pipeline module.
 *
 * @module spec/evolve/cluster-context
 */

import { ClusterContext, CommitSummary, CommitContextInput } from '../types';

export type { ClusterContext, CommitSummary, CommitContextInput };

// =============================================================================
// Constants
// =============================================================================

/** Maximum total characters for the cluster context (~12K tokens @ ~0.25 token/char). */
const DEFAULT_MAX_CONTEXT_CHARS = 48000;

/** Number of top files reported in primaryFiles. */
const TOP_PRIMARY_FILES = 10;

// =============================================================================
// Public API
// =============================================================================

/**
 * Build a cluster context summary for a group of commits affecting the same spec.
 *
 * Steps:
 * 1. For each affecting commit, build a CommitSummary with changed files.
 *    The `truncatedDiff` field is left as a placeholder — the caller is
 *    responsible for injecting actual diffs via `getCommitDiff()` + `truncateText()`.
 * 2. Compute primaryFiles: files changed in the most commits (top TOP_PRIMARY_FILES).
 *
 * @param affectingCommits - Commit info for commits affecting this spec.
 * @param maxChars         - Maximum total characters for commit summaries (default 12000).
 * @returns ClusterContext ready for LLM prompt construction.
 */
export function buildClusterContext(
  affectingCommits: CommitContextInput[],
  maxChars: number = DEFAULT_MAX_CONTEXT_CHARS,
): ClusterContext {
  // 1. Build commit summaries
  const commitSummaries: CommitSummary[] = [];
  let usedBudget = 0;

  // Track file frequency for primaryFiles
  const fileFrequency = new Map<string, number>();

  for (const input of affectingCommits) {
    const files = input.filePaths;
    for (const f of files) {
      fileFrequency.set(f, (fileFrequency.get(f) ?? 0) + 1);
    }

    // Per-commit overhead estimate: header + file list area
    const overhead = 150; // "### abc1234 — message\n\nFiles: ...\n\n```diff\n...```\n\n"
    const remainingForThis = maxChars - usedBudget - overhead;
    if (remainingForThis <= 0) break; // Budget exhausted

    const summary: CommitSummary = {
      fullHash: input.commitHash,
      shortHash: input.commitHash.slice(0, 7),
      message: input.message ?? input.commitHash.slice(0, 7),
      changedFiles: files,
      // Placeholder — caller populates with actual diff
      truncatedDiff: '',
    };

    commitSummaries.push(summary);
    usedBudget += overhead;
  }

  // 2. Compute primaryFiles (top-N by frequency)
  const primaryFiles = [...fileFrequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_PRIMARY_FILES)
    .map(([file]) => file);

  return {
    commitCount: affectingCommits.length,
    commitSummaries,
    primaryFiles,
  };
}
