/**
 * Git commit history scanning and spec↔commit pairing.
 *
 * Replaces `commit4spec/reverse_engineer/git_scanner.py` and
 * `commit4spec/reverse_engineer/git_utils.py`. Discovers spec↔commit pairs via
 * conventional-commit scope extraction: extracts scopes from commit messages
 * and resolves them to spec IDs on disk.
 *
 * All Git operations use `execFileSync` with an args array (never template
 * strings) to avoid shell injection risks — matching the HomeGraph convention
 * in `src/sync/git-hooks.ts` and `src/sync/worktree.ts`.
 *
 * @module spec/build/git-scanner
 */

import { execFileSync } from 'child_process';
import { SpecConfig } from '../config';
import { resolveScopeToSpec } from './scope-resolver';
import { extractSpecMetadata, SpecMetadata } from './spec-extractor';
import { logDebug } from '../../errors';
import { gitExecOptions } from '../git-utils';

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
      ['log', "--format=%H%x00%aI%x00%an%x00%s%x00"],
      gitExecOptions(repoPath),
    );
  } catch {
    return [];
  }

  const parts = stdout.replace(/\0+$/, '').trim().split('\0');
  const commits: CommitInfo[] = [];

  // Each commit occupies 4 NUL-separated fields: hash, timestamp, author, message
  for (let i = 0; i + 3 < parts.length; i += 4) {
    const hash = parts[i]!.trim();
    const isoString = parts[i + 1]!.trim();
    const author = parts[i + 2]!.trim();
    const message = parts[i + 3]!.trim();

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
      const diffs: string[] = [];
      for (const parent of parents) {
        try {
          diffs.push(
            execFileSync(
              'git',
              ['diff', parent, commitHash],
              gitExecOptions(repoPath),
            ),
          );
        } catch {
          // Skip diffs that fail for an individual parent
        }
      }
      return diffs.join('\n');
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
// getCommitRange
// ---------------------------------------------------------------------------

/**
 * Return every commit between `fromHash` (exclusive) and `toHash`
 * (inclusive) in chronological order (oldest first).
 *
 * Runs `git log --reverse --format="..." fromHash..toHash`. Returns an empty
 * array when either hash is not found or the range is empty.
 *
 * Callers should validate that `fromHash` is an ancestor of `toHash` before
 * calling this function (use `git merge-base --is-ancestor`).  Results are
 * undefined when the two hashes are on unrelated branches.
 */
export function getCommitRange(
  repoPath: string,
  fromHash: string,
  toHash: string,
): CommitInfo[] {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['log', '--no-merges', '--reverse', `--format=%H%x00%aI%x00%an%x00%s%x00`, `${fromHash}..${toHash}`],
      gitExecOptions(repoPath),
    );
  } catch {
    return [];
  }

  const parts = stdout.replace(/\0+$/, '').trim().split('\0');
  const commits: CommitInfo[] = [];

  // Each commit occupies 4 NUL-separated fields: hash, timestamp, author, message
  for (let i = 0; i + 3 < parts.length; i += 4) {
    const hash = parts[i]!.trim();
    const isoString = parts[i + 1]!.trim();
    const author = parts[i + 2]!.trim();
    const message = parts[i + 3]!.trim();

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
): SpecCommitPair[] {
  const pairs = new Map<string, SpecCommitPair>();

  const commits = getAllCommits(repoPath);

  for (const commit of commits) {
    const specId = resolveScopeToSpec(commit.message, specStoragePath, config);
    if (!specId) {
      logDebug('scan: no scope match', {
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

  return Array.from(pairs.values());
}
