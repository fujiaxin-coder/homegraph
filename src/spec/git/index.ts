/**
 * Git layer for the spec module — barrel export.
 *
 * Low-level, spec-agnostic Git access shared by the build, mine, and evolve
 * pipelines.
 */

export { gitExecOptions } from './exec';
export {
  CommitInfo,
  isGitRepo,
  getHeadHash,
  isAncestor,
  getAllCommits,
  getCommitRange,
  getCommitsUpTo,
  getCommitInfo,
  getParentHashes,
  getCommitDiff,
} from './commits';
