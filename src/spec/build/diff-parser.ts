/**
 * Unified diff parser — converts `git diff` output into structured code
 * fragments.
 *
 * Replaces `commit4spec/reverse_engineer/change_analyzer.py`.  Parses
 * unified diff output and extracts file-level change information (change
 * type, line range, diff text).
 *
 * @module spec/build/diff-parser
 */

import { getCommitDiff } from './git-scanner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffFragment {
  /** Path of the changed file (no `a/` / `b/` prefix). */
  filePath: string;
  /** Kind of change: added, modified, or deleted. */
  changeType: 'ADD' | 'MODIFY' | 'DELETE';
  /** First new-line number in this diff fragment (1-based). */
  startLine: number;
  /** Last new-line number covered by this fragment (1-based). */
  endLine: number;
  /** Raw unified diff text for this file. */
  codeDiff: string;
}

// ---------------------------------------------------------------------------
// analyzeCommitDiff
// ---------------------------------------------------------------------------

/**
 * Retrieve and parse the diff for a single commit.
 *
 * 1. Call `getCommitDiff(repoPath, commitHash)` to get raw diff text.
 * 2. Parse the diff into structured `DiffFragment` objects.
 * 3. Return the fragments.
 *
 * Returns an empty array when the diff cannot be retrieved or is empty.
 */
export function analyzeCommitDiff(
  repoPath: string,
  commitHash: string,
  preFetchedDiff?: string,
): DiffFragment[] {
  const diff = preFetchedDiff ?? getCommitDiff(repoPath, commitHash);
  if (!diff) {
    return [];
  }
  return _parseDiff(diff);
}

// ---------------------------------------------------------------------------
// _parseDiff
// ---------------------------------------------------------------------------

/**
 * State-machine parser for unified diff format.
 *
 * Walks through the diff line-by-line, tracking the current file, change
 * type, and line-number range.  Accumulates lines into a buffer and emits a
 * `DiffFragment` each time a new `diff --git` section begins (or when the
 * input is exhausted).
 */
function _parseDiff(diff: string): DiffFragment[] {
  const lines = diff.split('\n');

  // ---- state ----
  const fragments: DiffFragment[] = [];
  let buf: string[] = [];
  let currentFilePath: string | null = null;
  let currentChangeType: 'ADD' | 'MODIFY' | 'DELETE' = 'MODIFY';
  let currentStartLine = 0;
  let currentEndLine = 0;
  let inHunk = false;

  // ---- flush helper ----
  const _flush = (): void => {
    if (buf.length === 0 || currentFilePath === null) {
      buf = [];
      return;
    }

    // DELETE files have no lines in the new version — use [0, 0].
    let startLine: number;
    let endLine: number;
    if (currentChangeType === 'DELETE') {
      startLine = 0;
      endLine = 0;
    } else {
      // When no hunk was ever encountered, default startLine to 1.
      startLine = currentStartLine === 0 ? 1 : currentStartLine;
      endLine = currentEndLine;
    }

    fragments.push({
      filePath: currentFilePath,
      changeType: currentChangeType,
      startLine,
      endLine,
      codeDiff: buf.join('\n'),
    });

    buf = [];
  };

  // ---- line-by-line parser ----
  for (const line of lines) {

    // Rule 1 — new file section: flush the previous file.
    if (line.startsWith('diff --git ')) {
      _flush();
      buf = [line];
      currentFilePath = null;
      currentChangeType = 'MODIFY';
      currentStartLine = 0;
      currentEndLine = 0;
      inHunk = false;
      continue;
    }

    // Rule 2 — new file mode → change type is ADD.
    if (line.startsWith('new file mode ')) {
      currentChangeType = 'ADD';
      buf.push(line);
      continue;
    }

    // Rule 3 — deleted file mode → change type is DELETE.
    if (line.startsWith('deleted file mode ')) {
      currentChangeType = 'DELETE';
      buf.push(line);
      continue;
    }

    // Rule 4 — file path lines (--- a/path or +++ b/path).
    if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      const isPlus = line.startsWith('+++ b/');

      // Extract the path, skipping `/dev/null`.
      let pathPart = '';
      if (isPlus) {
        pathPart = line.slice(6); // '+++ b/'.length
      } else {
        pathPart = line.slice(6); // '--- a/'.length
      }

      if (pathPart !== '/dev/null') {
        currentFilePath = pathPart;
      }

      buf.push(line);
      continue;
    }

    // Rule 5 — hunk header: @@ -oldStart[,oldCount] +newStart[,newCount] @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      const newStart = parseInt(hunkMatch[1]!, 10);
      if (currentStartLine === 0) {
        currentStartLine = newStart;
      }
      currentEndLine = newStart;
      inHunk = true;
      buf.push(line);
      continue;
    }

    // Rule 6 — added lines (start with '+', but not '+++').
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (inHunk) {
        currentEndLine++;
      }
      buf.push(line);
      continue;
    }

    // Rule 7 — removed lines (start with '-', but not '---').
    if (line.startsWith('-') && !line.startsWith('---')) {
      buf.push(line);
      continue;
    }

    // Rule 8 — context lines (start with a space).
    if (line.startsWith(' ')) {
      if (inHunk) {
        currentEndLine++;
      }
      buf.push(line);
      continue;
    }

    // Rule 9 — all other lines (e.g. `rename from` / `rename to`,
    // `similarity index`, `Binary files differ`, `\ No newline at end of
    // file`, blank lines between sections, etc.).
    buf.push(line);
  }

  // Flush the final file.
  _flush();

  return fragments;
}
