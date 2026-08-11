/**
 * Git commit history access for the spec module — commit listing, single
 * commit metadata, diffs, HEAD resolution, and ancestry checks.
 *
 * All Git operations use `execFileSync` with an args array (never template
 * strings) to avoid shell injection risks — matching the HomeGraph convention
 * in `src/sync/git-hooks.ts` and `src/sync/worktree.ts`.
 *
 * @module spec/git/commits
 */

import { execFileSync } from 'child_process';
import { gitExecOptions } from './exec';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitInfo {
  /** Full 40-char commit hash */
  hash: string;
  /**
   * Full commit message (may span multiple lines — subject + body).
   * Callers that only need the one-line subject should use the first line
   * (`message.split('\n', 1)[0]`).
   */
  message: string;
  /** Author name */
  author: string;
  /** Unix epoch milliseconds */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// git log parsing
// ---------------------------------------------------------------------------

/** NUL-separated `git log` format: hash, author ISO date, author name, full message. */
const GIT_LOG_FORMAT = '--format=%H%x00%aI%x00%an%x00%B%x00';

/**
 * Convert an ISO-8601 string to Unix epoch milliseconds.
 * Returns 0 for invalid or unparseable strings.
 */
function parseISOTimestamp(isoString: string): number {
  const ts = new Date(isoString).getTime();
  return isNaN(ts) ? 0 : ts;
}

/**
 * Parse NUL-separated `git log` output (see {@link GIT_LOG_FORMAT}) into
 * `CommitInfo` objects. Each commit occupies 4 fields.
 */
function parseGitLogOutput(stdout: string): CommitInfo[] {
  const parts = stdout.replace(/\0+$/, '').trim().split('\0');
  const commits: CommitInfo[] = [];

  for (let i = 0; i + 3 < parts.length; i += 4) {
    const hash = parts[i]!.trim();
    if (!hash) continue;

    commits.push({
      hash,
      timestamp: parseISOTimestamp(parts[i + 1]!.trim()),
      author: parts[i + 2]!.trim(),
      message: parts[i + 3]!.trim(),
    });
  }

  return commits;
}

/** Run `git log` with the shared NUL format; returns [] on any failure. */
function gitLog(repoPath: string, args: string[]): CommitInfo[] {
  try {
    const stdout = execFileSync(
      'git',
      ['log', ...args, GIT_LOG_FORMAT],
      gitExecOptions(repoPath),
    );
    return parseGitLogOutput(stdout);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Repository / HEAD
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

/**
 * Resolve the current HEAD commit hash. Returns `null` when HEAD cannot be
 * resolved (not a repo, unborn branch, etc.).
 */
export function getHeadHash(repoPath: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], gitExecOptions(repoPath)).trim();
  } catch {
    return null;
  }
}

/**
 * Check whether `ancestor` is an ancestor of `descendant` in the git history
 * (via `git merge-base --is-ancestor`).
 */
export function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', ancestor, descendant],
      gitExecOptions(repoPath),
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Commit listing
// ---------------------------------------------------------------------------

/**
 * Return every commit in `repoPath` as `CommitInfo` objects, in reverse
 * chronological order (most recent first), matching Git's default.
 *
 * An empty repo yields an empty array.
 */
export function getAllCommits(repoPath: string): CommitInfo[] {
  return gitLog(repoPath, []);
}

/**
 * Return every commit between `fromHash` (exclusive) and `toHash`
 * (inclusive) in chronological order (oldest first). Merge commits are
 * excluded. Returns an empty array when either hash is not found or the
 * range is empty.
 *
 * Callers should validate that `fromHash` is an ancestor of `toHash` before
 * calling this function (use {@link isAncestor}). Results are undefined when
 * the two hashes are on unrelated branches.
 */
export function getCommitRange(
  repoPath: string,
  fromHash: string,
  toHash: string,
): CommitInfo[] {
  return gitLog(repoPath, ['--no-merges', '--reverse', `${fromHash}..${toHash}`]);
}

/**
 * Return every commit reachable from `toHash` in chronological order
 * (oldest first). Merge commits are excluded.
 */
export function getCommitsUpTo(repoPath: string, toHash: string): CommitInfo[] {
  return gitLog(repoPath, ['--no-merges', '--reverse', toHash]);
}

/**
 * Retrieve metadata for a single commit.
 *
 * Runs `git show -s --format='%H%x00%aI%x00%an%x00%B%x00' <commitHash>`
 * (NUL-separated so the full message, which may span lines, survives).
 * Returns `null` when the command fails (hash not found, invalid repo, etc.).
 */
export function getCommitInfo(
  repoPath: string,
  commitHash: string,
): CommitInfo | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['show', '-s', '--format=%H%x00%aI%x00%an%x00%B%x00', commitHash],
      gitExecOptions(repoPath),
    );
  } catch {
    return null;
  }

  const parts = stdout.split('\0');
  if (parts.length < 4) return null;

  const hash = parts[0]!.trim();
  if (!hash) return null;

  return {
    hash,
    timestamp: parseISOTimestamp(parts[1]!.trim()),
    author: parts[2]!.trim(),
    message: parts[3]!.trim(),
  };
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/**
 * Get the parent hash(es) for a commit.
 * Returns an empty array for root commits or on failure.
 */
export function getParentHashes(repoPath: string, commitHash: string): string[] {
  try {
    const stdout = execFileSync(
      'git',
      ['log', '--pretty=%P', '-n', '1', commitHash],
      gitExecOptions(repoPath),
    );
    return stdout.trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Return the full unified diff introduced by `commitHash`.
 *
 * Strategy:
 * 1. Query the parent hash(es) via {@link getParentHashes}.
 * 2. If a parent exists, diff it against the commit: `git diff <parent> <commitHash>`.
 * 3. For an initial (root) commit with no parent, use `git diff <commitHash>`
 *    which shows all files added in that commit.
 *
 * Returns an empty string when any Git command fails.
 */
export function getCommitDiff(repoPath: string, commitHash: string): string {
  const parents = getParentHashes(repoPath, commitHash);

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
