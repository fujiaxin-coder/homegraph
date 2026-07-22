/**
 * Mining Git Scanner — AST-level diff parsing for the `spec mine` pipeline.
 *
 * For each commit in a range this module extracts changed files, AST-parses
 * both the old and new versions, and computes symbol-level (structural) diffs.
 * It reuses the existing `extractFromSource` and the git utilities from
 * `spec/git`.
 *
 * @module spec/mine/scanner
 */

import { execFileSync } from 'child_process';
import {
  CommitInfo,
  getCommitRange,
  getCommitsUpTo,
  getParentHashes,
  gitExecOptions,
} from '../git';
import { listChangedFiles } from '../build/diff-parser';
import { extractFromSource } from '../../extraction/tree-sitter';
import { detectLanguage, isLanguageSupported } from '../../extraction/grammars';
import { NodeKind, Language, Node, ExtractionResult } from '../../types';
import { logDebug, logWarn } from '../../errors';
import { isTestFile } from '../../search/query-utils';
import type { ProgressCallback } from '../ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single symbol that changed (added, removed, or modified) in a commit. */
export interface ChangedSymbol {
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  /** Structural fingerprint for detecting content changes even when line ranges are unchanged. */
  fingerprint: string;
  /** Function/method signature (e.g. "authenticate(token: string): Promise<User>"). */
  signature?: string;
  /** Visibility modifier. */
  visibility?: 'public' | 'private' | 'protected' | 'internal';
}

/** AST-level structural changes for one file in a commit. */
export interface FileChange {
  filePath: string;
  language: Language;
  addedSymbols: ChangedSymbol[];
  removedSymbols: ChangedSymbol[];
  modifiedSymbols: { old: ChangedSymbol; new: ChangedSymbol }[];
  /** True when the file did not exist in the parent commit. */
  isNewFile?: boolean;
}

/** Aggregated AST change data for a single commit. */
export interface CommitChange {
  commitHash: string;
  commitMessage: string;
  author: string;
  timestamp: number;
  fileChanges: FileChange[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve file content at a specific commit using `git show <hash>:<path>`.
 * Returns null when the file did not exist at that commit.
 */
function getFileAtCommit(
  repoPath: string,
  commitHash: string,
  filePath: string,
): string | null {
  try {
    return execFileSync(
      'git',
      ['show', `${commitHash}:${filePath}`],
      gitExecOptions(repoPath),
    );
  } catch {
    return null;
  }
}

/**
 * Check whether a file can be structurally diffed.
 *
 * Delegates to the grammar system's `detectLanguage` + `isLanguageSupported`
 * so the supported language set is always aligned — any language the grammar
 * system supports is automatically supported here.
 */
function isDiffableFile(filePath: string): boolean {
  return isLanguageSupported(detectLanguage(filePath));
}

/**
 * Compute a structural fingerprint from key AST-level properties.
 * Captures signature, docstring, visibility, decorators, type parameters,
 * and async/static/abstract modifiers — so content changes are detected
 * even when line ranges happen to stay the same.
 */
function computeFingerprint(node: Node): string {
  const parts = [
    node.kind,
    node.signature ?? '',
    node.docstring ?? '',
    node.visibility ?? '',
    node.isExported ? 'exported' : '',
    node.isAsync ? 'async' : '',
    node.isStatic ? 'static' : '',
    node.isAbstract ? 'abstract' : '',
    (node.decorators ?? []).join(','),
    (node.typeParameters ?? []).join(','),
    node.returnType ?? '',
  ];
  return parts.join('|');
}

/**
 * Convert an ExtractionResult node to a simplified ChangedSymbol.
 */
function nodeToSymbol(node: Node): ChangedSymbol {
  return {
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    startLine: node.startLine,
    endLine: node.endLine,
    fingerprint: computeFingerprint(node),
    signature: node.signature,
    visibility: node.visibility,
  };
}

/**
 * Compare two sets of symbols (from old and new file versions) and produce
 * added / removed / modified lists.
 *
 * Uses two-phase matching:
 * 1. Exact match on qualifiedName + startLine — handles overloads and
 *    symbols that haven't moved.
 * 2. For unmatched symbols, match by qualifiedName alone. When exactly one
 *    old and one new symbol share a qualifiedName they are treated as the
 *    same symbol that relocated (modified).  N:M pairs are treated as
 *    genuine additions / removals (e.g. multiple overloads added / removed).
 */
function compareSymbolSets(
  oldSymbols: ChangedSymbol[],
  newSymbols: ChangedSymbol[],
): {
  added: ChangedSymbol[];
  removed: ChangedSymbol[];
  modified: { old: ChangedSymbol; new: ChangedSymbol }[];
} {
  // Phase 1: Exact match by qualifiedName + startLine.
  const oldMap = new Map<string, ChangedSymbol>();
  for (const s of oldSymbols) oldMap.set(`${s.qualifiedName}:${s.startLine}`, s);

  const newMap = new Map<string, ChangedSymbol>();
  for (const s of newSymbols) newMap.set(`${s.qualifiedName}:${s.startLine}`, s);

  const added: ChangedSymbol[] = [];
  const removed: ChangedSymbol[] = [];
  const modified: { old: ChangedSymbol; new: ChangedSymbol }[] = [];

  const matchedOldKeys = new Set<string>();

  for (const [key, newSym] of newMap) {
    const oldSym = oldMap.get(key);
    if (oldSym) {
      matchedOldKeys.add(key);
      if (
        oldSym.endLine !== newSym.endLine ||
        oldSym.fingerprint !== newSym.fingerprint
      ) {
        modified.push({ old: oldSym, new: newSym });
      }
    }
  }

  // Phase 2: Handle relocated symbols (same qualifiedName, different startLine).
  const unmatchedOld: ChangedSymbol[] = [];
  for (const [key, sym] of oldMap) {
    if (!matchedOldKeys.has(key)) unmatchedOld.push(sym);
  }
  const unmatchedNew: ChangedSymbol[] = [];
  for (const [key, sym] of newMap) {
    if (!oldMap.has(key)) unmatchedNew.push(sym);
  }

  // Group unmatched by qualifiedName
  const oldByName = new Map<string, ChangedSymbol[]>();
  for (const s of unmatchedOld) {
    const arr = oldByName.get(s.qualifiedName);
    if (arr) arr.push(s);
    else oldByName.set(s.qualifiedName, [s]);
  }
  const newByName = new Map<string, ChangedSymbol[]>();
  for (const s of unmatchedNew) {
    const arr = newByName.get(s.qualifiedName);
    if (arr) arr.push(s);
    else newByName.set(s.qualifiedName, [s]);
  }

  // 1:1 pairs → relocated (modified). N:M → genuine add/remove.
  for (const [qname, oldList] of oldByName) {
    const newList = newByName.get(qname);
    if (newList && oldList.length === 1 && newList.length === 1) {
      modified.push({ old: oldList[0]!, new: newList[0]! });
    } else {
      for (const s of oldList) removed.push(s);
    }
  }

  // Remaining new symbols are genuine additions
  for (const [qname, newList] of newByName) {
    const oldList = oldByName.get(qname);
    if (!oldList || oldList.length !== 1 || newList.length !== 1) {
      for (const s of newList) added.push(s);
    }
  }

  return { added, removed, modified };
}

/**
 * Node kinds that carry structural design intent and are tracked as
 * significant changes during commit scanning.
 *
 * - OOP/data containers: class, struct, trait, interface, protocol
 * - Behaviour: function, method, component
 * - Type system: type_alias, enum
 * - Data: variable, constant
 * - Organisation: namespace, module
 * - Web API surface: route
 */
const SIGNIFICANT_KINDS: ReadonlySet<NodeKind> = new Set([
  'function', 'class', 'method', 'interface', 'type_alias',
  'struct', 'trait', 'protocol', 'route', 'module',
  'variable', 'constant', 'enum', 'component', 'namespace',
]);

function extractSignificantSymbols(result: ExtractionResult): ChangedSymbol[] {
  const symbols: ChangedSymbol[] = [];
  for (const node of result.nodes) {
    if (SIGNIFICANT_KINDS.has(node.kind)) {
      symbols.push(nodeToSymbol(node));
    }
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Conventional commit prefix regex.
 * Matches: type[(scope)][!]: description
 * Kept groups: feat, fix, refactor, chore, docs, test, style, build, ci, perf, revert
 */
const CONVENTIONAL_PREFIX =
  /^(feat|fix|refactor|chore|docs|test|style|build|ci|perf|revert)(?:\([^)]*\))?[!]?:\s/;

/** Conventional commit types that involve source-code structural changes
 *  and may carry design intent worth documenting as a spec. */
const DESIGN_RELEVANT_TYPES: ReadonlySet<string> = new Set([
  'feat',
  'fix',
  'refactor',
  'perf',
]);

/**
 * Git-generated mechanical-commit prefixes that carry no design intent.
 *
 * - `Revert "..."` — `git revert` undo commits
 * - `Reapply "..."` — cherry-pick re-application of a previously reverted commit
 */
const MECHANICAL_COMMIT_PREFIX = /^(Revert|Reapply)\s+"/;

/**
 * Determine whether a commit message represents a design-relevant change.
 *
 * Filtered out:
 * - Git-generated mechanical commits (Revert / Reapply).
 * - Conventional-commit types that rarely introduce new symbols or material
 *   design intent: chore, docs, test, style, build, ci, revert.
 *
 * Kept:
 * - Conventional-commit types with structural source-code impact:
 *   feat, fix, refactor, perf.
 * - Non-conventional messages (no prefix match) — conservatively treated as
 *   unstructured feature work.
 */
function isDesignRelevant(message: string): boolean {
  // Git mechanical commits (Revert / Reapply) — no design intent
  if (MECHANICAL_COMMIT_PREFIX.test(message)) return false;

  const m = message.match(CONVENTIONAL_PREFIX);
  if (!m) return true;                      // Non-standard format — keep
  return DESIGN_RELEVANT_TYPES.has(m[1]!);
}

/**
 * Scan commits in a range and produce AST-level structural change data.
 *
 * @param repoPath - Path to the git repository.
 * @param fromHash - Starting commit hash (exclusive). Use empty string for root.
 * @param toHash - Ending commit hash (inclusive), typically 'HEAD'.
 * @param limit - If set, only the most recent N commits are processed.
 * @param onProgress - Optional progress callback (called per commit).
 * @returns Aggregated AST change data for each commit.
 */
export function scanCommits(
  repoPath: string,
  fromHash: string,
  toHash: string,
  limit?: number,
  onProgress?: ProgressCallback,
): CommitChange[] {
  let commits: CommitInfo[];

  if (fromHash) {
    commits = getCommitRange(repoPath, fromHash, toHash);
  } else {
    // No anchor — get all commits reachable from toHash.
    commits = getCommitsUpTo(repoPath, toHash);
  }

  if (commits.length === 0) return [];

  // Apply limit — take most recent commits
  if (limit !== undefined && limit > 0 && commits.length > limit) {
    commits = commits.slice(commits.length - limit);
  }

  // Filter to design-relevant commits (feat / fix / refactor / perf) for
  // conventional-commit messages. Non-conventional messages are kept.
  const before = commits.length;
  commits = commits.filter((c) => isDesignRelevant(c.message));
  const skipped = before - commits.length;
  if (skipped > 0) {
    logDebug('Mine scan: filtered non-design commits', {
      kept: commits.length,
      skipped,
    });
  }

  const changes: CommitChange[] = [];
  let parseErrorCount = 0;
  const totalCommits = commits.length;

  for (let ci = 0; ci < commits.length; ci++) {
    const commit = commits[ci]!;
    onProgress?.({
      phase: 'scanning',
      current: ci + 1,
      total: totalCommits,
      message: `${commit.hash.slice(0, 7)} ${commit.message.slice(0, 50)}`,
    });
    logDebug('Mine scan: processing commit', {
      hash: commit.hash.slice(0, 7),
      message: commit.message,
    });

    const parents = getParentHashes(repoPath, commit.hash);
    const parentHashes = parents.length > 0 ? parents : [null as string | null];

    // Collect file changes from all parents, deduplicating by file path.
    // Each file uses the first parent that includes it for old-content retrieval.
    const seenFiles = new Set<string>();
    const fileChanges: FileChange[] = [];

    for (const parentHash of parentHashes) {
      let diff: string;
      try {
        if (parentHash) {
          diff = execFileSync(
            'git',
            ['diff', parentHash, commit.hash],
            gitExecOptions(repoPath),
          );
        } else {
          diff = execFileSync(
            'git',
            ['diff', commit.hash],
            gitExecOptions(repoPath),
          );
        }
      } catch {
        continue;
      }

      if (!diff) continue;

      const changedFiles = listChangedFiles(diff)
        .filter(isDiffableFile)
        .filter((fp) => !isTestFile(fp))
        .filter((fp) => !seenFiles.has(fp));

      for (const filePath of changedFiles) {
        seenFiles.add(filePath);

        try {
          const oldContent = parentHash
            ? getFileAtCommit(repoPath, parentHash, filePath)
            : null;
          const newContent = getFileAtCommit(repoPath, commit.hash, filePath);

          if (newContent === null) {
            // File was deleted — no new version to parse
            if (oldContent !== null) {
              const oldResult = extractFromSource(filePath, oldContent);
              const oldSymbols = extractSignificantSymbols(oldResult);
              fileChanges.push({
                filePath,
                language: detectLanguage(filePath, oldContent),
                addedSymbols: [],
                removedSymbols: oldSymbols,
                modifiedSymbols: [],
              });
            }
            continue;
          }

          const language = detectLanguage(filePath, newContent);
          const newResult = extractFromSource(filePath, newContent);
          const newSymbols = extractSignificantSymbols(newResult);

          if (oldContent === null) {
            // New file — all symbols are added
            fileChanges.push({
              filePath,
              language,
              addedSymbols: newSymbols,
              removedSymbols: [],
              modifiedSymbols: [],
              isNewFile: true,
            });
            continue;
          }

          const oldResult = extractFromSource(filePath, oldContent);
          const oldSymbols = extractSignificantSymbols(oldResult);

          const { added, removed, modified } = compareSymbolSets(oldSymbols, newSymbols);

          if (added.length > 0 || removed.length > 0 || modified.length > 0) {
            fileChanges.push({
              filePath,
              language,
              addedSymbols: added,
              removedSymbols: removed,
              modifiedSymbols: modified,
            });
          }
        } catch (err) {
          parseErrorCount++;
          logWarn(`Mine scan: error parsing ${filePath} in commit ${commit.hash.slice(0, 7)}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    changes.push({
      commitHash: commit.hash,
      commitMessage: commit.message,
      author: commit.author,
      timestamp: commit.timestamp,
      fileChanges,
    });
  }

  logDebug('Mine scan: parse errors', { parseErrorCount });
  return changes;
}
