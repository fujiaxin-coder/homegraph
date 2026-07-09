/**
 * cluster-context.ts — Build cluster-level context summary for LLM spec evaluation.
 *
 * References mine/generator.ts buildClusterPrompt for the multi-commit
 * context aggregation pattern, but uses simpler data (diff-based instead of
 * AST-based) since evolve works with unified diffs.
 *
 * @module spec/evolve/cluster-context
 */

import { readFileContent } from '../utils';

// =============================================================================
// Types
// =============================================================================

interface CommitSummary {
  /** Full commit hash (40 chars) — used for git operations like getCommitDiff. */
  fullHash: string;
  /** Short hash (7 chars) — used for display in LLM prompts. */
  shortHash: string;
  /** First line of commit message. */
  message: string;
  /** Changed file paths. */
  changedFiles: string[];
  /** Aggregated and truncated diff for this commit (populated by caller). */
  truncatedDiff: string;
}

export interface ClusterContext {
  /** The spec being evaluated. */
  specId: string;
  /** Full plan.md content (may be truncated at cluster level). */
  planContent: string;
  /** Number of commits in the cluster. */
  commitCount: number;
  /** Individual commit summaries. */
  commitSummaries: CommitSummary[];
  /** Top-N most frequently changed files across all commits. */
  primaryFiles: string[];
  /** Total character count of the context (for budget tracking). */
  totalChars: number;
}

/** Minimal info about a commit needed to build the cluster context. */
export interface CommitContextInput {
  commitHash: string;
  message?: string;
  filePaths: string[];
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum total characters for the cluster context (plan + commit summaries). */
const DEFAULT_MAX_CONTEXT_CHARS = 12000;

/** Reserve space for plan content. */
const MIN_PLAN_CHARS = 3000;

/** Number of top files reported in primaryFiles. */
const TOP_PRIMARY_FILES = 10;

// =============================================================================
// Public API
// =============================================================================

/**
 * Build a cluster context summary for a group of commits affecting the same spec.
 *
 * Steps:
 * 1. Read the spec's plan.md content (truncated to MIN_PLAN_CHARS if needed).
 * 2. For each affecting commit, build a CommitSummary with changed files.
 *    The `truncatedDiff` field is left as a placeholder — the caller is
 *    responsible for injecting actual diffs via `getCommitDiff()` + `truncateText()`.
 * 3. Compute primaryFiles: files changed in the most commits (top TOP_PRIMARY_FILES).
 * 4. Track totalChars for budget awareness.
 *
 * @param specId            - The spec ID being evaluated.
 * @param planFilePath      - Absolute path to the spec's plan.md.
 * @param affectingCommits  - Commit info for commits affecting this spec.
 * @param maxChars          - Maximum total characters (default 12000).
 * @returns ClusterContext ready for LLM prompt construction.
 */
export function buildClusterContext(params: {
  specId: string;
  planFilePath: string;
  affectingCommits: CommitContextInput[];
  maxChars?: number;
}): ClusterContext {
  const { specId, planFilePath, affectingCommits } = params;
  const maxChars = params.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;

  // 1. Read plan content
  let planContent = readFileContent(planFilePath) ?? '(plan.md not found)';
  const planBudget = Math.min(planContent.length, MIN_PLAN_CHARS);
  if (planContent.length > MIN_PLAN_CHARS) {
    const suffix = '  …(truncated)';
    planContent = planContent.slice(0, MIN_PLAN_CHARS - suffix.length) + suffix;
  }

  // 2. Build commit summaries
  const commitSummaries: CommitSummary[] = [];
  let usedBudget = planBudget;

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

  // 3. Compute primaryFiles (top-N by frequency)
  const primaryFiles = [...fileFrequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_PRIMARY_FILES)
    .map(([file]) => file);

  // 4. Compute totalChars (estimate)
  const totalChars = planBudget + commitSummaries.reduce((sum, cs) => {
    return sum + cs.truncatedDiff.length + cs.changedFiles.join(', ').length + 150;
  }, 0);

  return {
    specId,
    planContent,
    commitCount: affectingCommits.length,
    commitSummaries,
    primaryFiles,
    totalChars,
  };
}
