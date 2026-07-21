/**
 * Per-commit feature extraction for clustering — symbol names, file paths,
 * directory prefixes, ticket references, change counts, and cohesion.
 *
 * @module spec/mine/clustering/features
 */

import { CommitChange } from '../scanner';
import { isTestFile } from '../../../search/query-utils';

/** Minimum number of changed symbols (added + removed + modified) required
 *  for a solo commit to be promoted into its own cluster.  Commits below
 *  this threshold go to `unclustered` — they are too small to warrant a
 *  standalone spec document. */
export const MIN_SYMBOLS_FOR_SOLO_CLUSTER = 2;

/** Collect all symbol names across all file changes in a commit. */
export function collectSymbolNames(change: CommitChange): string[] {
  const names = new Set<string>();
  for (const fc of change.fileChanges) {
    for (const s of fc.addedSymbols) names.add(s.name);
    for (const s of fc.removedSymbols) names.add(s.name);
    for (const m of fc.modifiedSymbols) {
      names.add(m.old.name);
      names.add(m.new.name);
    }
  }
  return Array.from(names);
}

/** Collect all file paths changed in a commit. */
export function collectFilePaths(change: CommitChange): string[] {
  const paths = new Set<string>();
  for (const fc of change.fileChanges) {
    paths.add(fc.filePath);
  }
  return Array.from(paths);
}

/** Collect directory prefixes (first 2 path segments) for module proximity.
 *  For single-segment paths (root-level files) the filename itself is used as
 *  the key — this prevents unrelated root-level files from falsely sharing an
 *  empty "directory" and being grouped together. */
export function collectDirectoryPrefixes(change: CommitChange): string[] {
  const dirs = new Set<string>();
  for (const fc of change.fileChanges) {
    const parts = fc.filePath.split('/');
    if (parts.length === 1) {
      dirs.add(parts[0]!);
    } else {
      dirs.add(parts.slice(0, 2).join('/'));
    }
  }
  return Array.from(dirs);
}

/** Count total changed symbols across all file changes in a commit. */
export function countChangedSymbols(change: CommitChange): number {
  let count = 0;
  for (const fc of change.fileChanges) {
    count += fc.addedSymbols.length;
    count += fc.removedSymbols.length;
    count += fc.modifiedSymbols.length;
  }
  return count;
}

/** Compute the cohesion ratio for a commit — symbols changed per file touched.
 *  Low cohesion (< 1.0) suggests a mechanical refactor across many files;
 *  high cohesion (≥ 2.0) suggests concentrated feature work. */
export function computeCohesion(change: CommitChange): number {
  const totalSymbols = countChangedSymbols(change);
  const filesTouched = change.fileChanges.length || 1;
  return totalSymbols / filesTouched;
}

/** Extract ticket references (e.g., PROJ-123, #456) from a commit message. */
export function extractTicketRefs(message: string): string[] {
  const refs: string[] = [];
  const jiraRe = /[A-Z]+-\d+/g;
  const ghRe = /#\d+/g;
  let m: RegExpExecArray | null;
  while ((m = jiraRe.exec(message)) !== null) refs.push(m[0]);
  while ((m = ghRe.exec(message)) !== null) refs.push(m[0]);
  return Array.from(new Set(refs));
}

/**
 * Fallback quality gate: true when a commit has at least one new file that
 * is not a test file.  Used when the symbol-level change count is below the
 * solo-cluster threshold — a commit that adds non-test source files carries
 * structural intent even when the extractor could not produce symbols
 * (e.g. ArkTS files without an active extraction context).
 */
export function hasNewNonTestFiles(change: CommitChange): boolean {
  for (const fc of change.fileChanges) {
    if (fc.isNewFile && !isTestFile(fc.filePath)) {
      return true;
    }
  }
  return false;
}
