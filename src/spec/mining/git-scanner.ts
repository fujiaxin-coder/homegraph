/**
 * Git commit history scanning and spec↔commit pairing.
 *
 * Replaces `commit4spec/reverse_engineer/git_scanner.py` and
 * `commit4spec/reverse_engineer/git_utils.py`. Discovers spec↔commit pairs via
 * two strategies:
 *
 *  - **Strategy A — commit message scope:** extract conventional-commit scopes
 *    from commit messages and resolve them to spec IDs on disk.
 *  - **Strategy B — commit-info.md:** discover specs on disk, read their
 *    `commit-info.md` for linked commit hashes, and verify those commits exist.
 *
 * All Git operations use `execFileSync` with an args array (never template
 * strings) to avoid shell injection risks — matching the HomeGraph convention
 * in `src/sync/git-hooks.ts` and `src/sync/worktree.ts`.
 *
 * @module spec/mining/git-scanner
 */

import { execFileSync, type StdioOptions } from 'child_process';
import { SpecConfig } from '../config';
import { discoverSpecs } from '../utils';
import { resolveScopeToSpec } from './scope-resolver';
import { extractSpecMetadata, SpecMetadata } from './spec-extractor';
import { logDebug, logWarn } from '../../errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitInfo {
  /** Full 40-char commit hash */
  hash: string;
  /** First line of commit message */
  message: string;
  /** Author name */
  author: string;
  /** Unix epoch milliseconds */
  timestamp: number;
}

export interface SpecCommitPair {
  specId: string;
  commitHash: string;
  specMetadata: SpecMetadata | null;
  commitMetadata: CommitInfo | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared options for all `execFileSync` Git calls. */
function gitExecOptions(repoPath: string) {
  const stdio: StdioOptions = ['ignore', 'pipe', 'ignore'];
  return {
    cwd: repoPath,
    encoding: 'utf8' as const,
    stdio,
    windowsHide: true,
  };
}

/**
 * Convert an ISO-8601 string to Unix epoch milliseconds.
 * Returns 0 for invalid or unparseable strings.
 */
function parseISOTimestamp(isoString: string): number {
  const ts = new Date(isoString).getTime();
  return isNaN(ts) ? 0 : ts;
}

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

/**
 * Check whether `repoPath` is a git repository.
 *
 * Runs `git rev-parse --git-dir` and returns `true` on success, `false`
 * when the command fails (not a repo, git not installed, etc.).
 */
export function isGitRepo(repoPath: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], gitExecOptions(repoPath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// getAllCommits
// ---------------------------------------------------------------------------

/**
 * Return every commit in `repoPath` as `CommitInfo` objects.
 *
 * Runs `git log --format='%H%n%aI%n%an%n%s%n---END---'` and parses the
 * output one five-line block per commit.  Commits are returned in reverse
 * chronological order (most recent first), matching Git's default.
 *
 * An empty repo yields an empty array.
 */
export function getAllCommits(repoPath: string): CommitInfo[] {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['log', "--format=%H%n%aI%n%an%n%s%n---END---"],
      gitExecOptions(repoPath),
    );
  } catch {
    return [];
  }

  const lines = stdout.trim().split('\n');
  const commits: CommitInfo[] = [];

  // Each commit occupies 5 lines: hash, ISO timestamp, author, subject, separator.
  for (let i = 0; i + 4 < lines.length; i += 5) {
    const hash = lines[i]!.trim();
    const isoString = lines[i + 1]!.trim();
    const author = lines[i + 2]!.trim();
    const message = lines[i + 3]!.trim();
    // lines[i+4] is the ---END--- separator — skip it.

    if (!hash) continue;

    commits.push({
      hash,
      message,
      author,
      timestamp: parseISOTimestamp(isoString),
    });
  }

  return commits;
}

// ---------------------------------------------------------------------------
// getCommitInfo
// ---------------------------------------------------------------------------

/**
 * Retrieve metadata for a single commit.
 *
 * Runs `git show -s --format='%H%n%aI%n%an%n%s' <commitHash>`.  Returns
 * `null` when the command fails (hash not found, invalid repo, etc.).
 */
export function getCommitInfo(
  repoPath: string,
  commitHash: string,
): CommitInfo | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['show', '-s', "--format=%H%n%aI%n%an%n%s", commitHash],
      gitExecOptions(repoPath),
    );
  } catch {
    return null;
  }

  const lines = stdout.trim().split('\n');
  if (lines.length < 4) return null;

  const hash = lines[0]!.trim();
  const isoString = lines[1]!.trim();
  const author = lines[2]!.trim();
  const message = lines[3]!.trim();

  if (!hash) return null;

  return {
    hash,
    message,
    author,
    timestamp: parseISOTimestamp(isoString),
  };
}

// ---------------------------------------------------------------------------
// getCommitDiff
// ---------------------------------------------------------------------------

/**
 * Return the full unified diff introduced by `commitHash`.
 *
 * Strategy:
 * 1. Query the parent hash(es) via `git log --pretty=%P -n 1 <commitHash>`.
 * 2. If a parent exists, diff it against the commit: `git diff <parent> <commitHash>`.
 * 3. For an initial (root) commit with no parent, use `git diff <commitHash>`
 *    which shows all files added in that commit.
 *
 * Returns an empty string when any Git command fails.
 */
export function getCommitDiff(repoPath: string, commitHash: string): string {
  // Step 1 — get parent hashes.
  let parentStdout: string;
  try {
    parentStdout = execFileSync(
      'git',
      ['log', '--pretty=%P', '-n', '1', commitHash],
      gitExecOptions(repoPath),
    );
  } catch {
    return '';
  }

  const parents = parentStdout.trim().split(/\s+/).filter(Boolean);

  // Step 2 & 3 — run the appropriate diff.
  try {
    if (parents.length > 0) {
      const parent = parents[0]!;
      return execFileSync(
        'git',
        ['diff', parent, commitHash],
        gitExecOptions(repoPath),
      );
    }

    // Initial commit — no parent.
    return execFileSync(
      'git',
      ['diff', commitHash],
      gitExecOptions(repoPath),
    );
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

/**
 * Main scanning function — discovers spec↔commit pairs using two strategies.
 *
 * **Strategy A — commit message scope:**
 * Iterates every commit in the repo, extracts a conventional-commit scope from
 * its message, normalizes it, and checks whether the resulting spec ID exists
 * on disk. When a match is found the pair is recorded with full spec and
 * commit metadata.
 *
 * **Strategy B — commit-info.md:**
 * Discovers all specs on disk that were **not** already paired by Strategy A,
 * reads their metadata (which may include a commit hash from `commit-info.md`),
 * and verifies the commit exists in the repo. Verified pairs are added.
 *
 * Duplicates (identical specId + commitHash) are de-duplicated via a
 * `Map` keyed on `"${specId}|${commitHash}"`.
 */
export function scan(
  repoPath: string,
  specStoragePath: string,
  config: SpecConfig,
): SpecCommitPair[] {
  const pairs = new Map<string, SpecCommitPair>();

  // ---- Strategy A: commit message scope ----

  const commits = getAllCommits(repoPath);

  for (const commit of commits) {
    const specId = resolveScopeToSpec(commit.message, specStoragePath, config);
    if (!specId) {
      logDebug('Strategy A: no scope match', {
        commitHash: commit.hash.slice(0, 7),
        message: commit.message,
      });
      continue;
    }

    const specMetadata = extractSpecMetadata(specStoragePath, specId, config);

    const key = `${specId}|${commit.hash}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        specId,
        commitHash: commit.hash,
        specMetadata,
        commitMetadata: commit,
      });
    }
  }

  // ---- Strategy B: commit-info.md ----

  // Collect specIds already paired by Strategy A.
  const pairedSpecIds = new Set<string>();
  for (const pair of pairs.values()) {
    pairedSpecIds.add(pair.specId);
  }

  const specs = discoverSpecs(specStoragePath);

  for (const spec of specs) {
    if (pairedSpecIds.has(spec.specId)) {
      continue;
    }

    const metadata = extractSpecMetadata(specStoragePath, spec.specId, config);
    if (!metadata) {
      // extractSpecMetadata already logs the reason.
      continue;
    }

    if (!metadata.commitHash) {
      logDebug('Strategy B: no commit hash in spec metadata', {
        specId: spec.specId,
      });
      continue;
    }

    const commitInfo = getCommitInfo(repoPath, metadata.commitHash);
    if (!commitInfo) {
      logWarn('Strategy B: commit-info.md hash does not match any known commit', {
        specId: spec.specId,
        commitHash: metadata.commitHash,
      });
      continue;
    }

    const key = `${spec.specId}|${metadata.commitHash}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        specId: spec.specId,
        commitHash: metadata.commitHash,
        specMetadata: metadata,
        commitMetadata: commitInfo,
      });
    }
  }

  return Array.from(pairs.values());
}
