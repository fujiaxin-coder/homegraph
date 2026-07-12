/**
 * Mine Persist — writes `spec mine` results into commit4spec.db.
 *
 * For each generated spec, persists a SpecNode, all linked CommitNodes,
 * per-file DiffFragments as CodeFragmentNodes, and the corresponding
 * spec_commit / commit_fragment relations.
 *
 * Reuses the existing DB persistence infrastructure from `src/spec/db/`.
 *
 * @module spec/mine/persist
 */

import * as path from 'path';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { SpecNode, CommitNode, CodeFragmentNode } from '../types';
import { insertSpecNode } from '../db/spec-node';
import { insertCommitNode } from '../db/commit-node';
import { insertCodeFragment, findFragmentsByCommit } from '../db/fragment-node';
import {
  insertSpecCommitRelation,
  insertCommitFragmentRelation,
} from '../db/relations';
import { initSpecSchema } from '../db/schema';
import { analyzeCommitDiff } from '../build/diff-parser';
import { extractMarkdownHeadings } from '../build/spec-extractor';
import { GeneratedSpec } from './generator';
import { CommitCluster } from './clusterer';
import { logDebug, logWarn } from '../../errors';
import type { MineProgressCallback } from './progress';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistResult {
  specsWritten: number;
  commitsWritten: number;
  fragmentsWritten: number;
  relationsWritten: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a title from the first `# ` heading in generated markdown content.
 * Falls back to `specId` if no heading is found.
 */
function extractTitle(content: string, specId: string): string {
  const firstH1Match = content.match(/^#\s+(.*)/m);
  if (firstH1Match && firstH1Match[1]) {
    const title = firstH1Match[1].trim().replace(/\s*SPEC\s*$/i, '');
    if (title) return title;
  }
  return specId;
}

// ---------------------------------------------------------------------------
// persistToGraph
// ---------------------------------------------------------------------------

/**
 * Persist `spec mine` results to the commit4spec.db knowledge graph.
 *
 * Idempotent — INSERT OR REPLACE / INSERT OR IGNORE semantics ensure
 * re-running the pipeline against the same commits is safe.
 *
 * @param db        - Open SQLite database handle.
 * @param repoPath  - Path to the git repository.
 * @param specs     - Generated specs from the LLM phase.
 * @param clusters  - Commit clusters (must align with specs by clusterId).
 * @param outputDir - Directory where generated spec markdown files were written.
 * @param onProgress - Optional progress callback (called per spec).
 * @returns Counts of written nodes and relations.
 */
export function persistToGraph(
  db: SqliteDatabase,
  repoPath: string,
  specs: GeneratedSpec[],
  clusters: CommitCluster[],
  outputDir: string,
  onProgress?: MineProgressCallback,
): PersistResult {
  // Ensure schema exists (idempotent)
  initSpecSchema(db);

  // Build a lookup map: clusterId → CommitCluster
  const clusterMap = new Map<number, CommitCluster>();
  for (const c of clusters) {
    clusterMap.set(c.id, c);
  }

  // Deduplication — commits can appear in multiple clusters (low threshold)
  const seenCommitHashes = new Set<string>();

  let specsWritten = 0;
  let commitsWritten = 0;
  let fragmentsWritten = 0;
  let relationsWritten = 0;
  const totalSpecs = specs.length;

  for (let si = 0; si < specs.length; si++) {
    const spec = specs[si]!;
    onProgress?.({
      phase: 'persisting',
      current: si + 1,
      total: totalSpecs,
      message: spec.specId,
    });
    const cluster = clusterMap.get(spec.clusterId);
    if (!cluster) {
      logDebug('persistToGraph: spec has no matching cluster', {
        specId: spec.specId,
        clusterId: spec.clusterId,
      });
      continue;
    }

    // ---- SpecNode ----
    const specNode: SpecNode = {
      id: spec.specId,
      title: extractTitle(spec.content, spec.specId),
      subtitles: extractMarkdownHeadings(spec.content),
      status: 'active',
      version: 1,
      filePath: path.join(outputDir, `${spec.specId}.md`),
      timestamp: cluster.timeRange.end,
    };
    insertSpecNode(db, specNode);
    specsWritten++;

    // ---- Commits & Fragments ----
    // Collect all file paths referenced in this commit's FileChanges for filtering
    // fragments to only relevant files (avoids inserting irrelevant diff hunks).
    const relevantFiles = new Set<string>();
    for (const cc of cluster.commits) {
      for (const fc of cc.fileChanges) {
        relevantFiles.add(fc.filePath);
      }
    }

    for (const cc of cluster.commits) {
      // CommitNode — must be inserted before the relation because
      // node:sqlite enforces FOREIGN KEY constraints eagerly and
      // INSERT OR IGNORE throws on FK violations in Node's SQLite.
      if (!seenCommitHashes.has(cc.commitHash)) {
        seenCommitHashes.add(cc.commitHash);

        const commitNode: CommitNode = {
          hash: cc.commitHash,
          message: cc.commitMessage,
          author: cc.author,
          timestamp: cc.timestamp,
        };
        insertCommitNode(db, commitNode);
        commitsWritten++;
      }

      // Spec → Commit relation
      insertSpecCommitRelation(db, spec.specId, cc.commitHash, 'SUMMARIZED_FROM');
      relationsWritten++;

      // Diff fragments — only files that appear in this commit's AST changes.
      // Skip git diff if fragments were already persisted in a previous run.
      const existingFragments = findFragmentsByCommit(db, cc.commitHash);
      if (existingFragments.length > 0) {
        for (const frag of existingFragments) {
          if (!relevantFiles.has(frag.filePath)) continue;
          insertCommitFragmentRelation(db, cc.commitHash, frag.id, 'CONTAINS');
          relationsWritten++;
        }
      } else {
        let fragments;
        try {
          fragments = analyzeCommitDiff(repoPath, cc.commitHash);
        } catch (err) {
          logWarn(`persistToGraph: analyzeCommitDiff failed for ${cc.commitHash.slice(0, 7)}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        for (const frag of fragments) {
          if (!relevantFiles.has(frag.filePath)) continue;

          const fragmentNode: CodeFragmentNode = {
            id: '', // auto-generated by insertCodeFragment
            changeType: frag.changeType,
            filePath: frag.filePath,
            startLine: frag.startLine,
            endLine: frag.endLine,
            codeDiff: frag.codeDiff,
          };
          const inserted = insertCodeFragment(db, fragmentNode);
          fragmentsWritten++;

          insertCommitFragmentRelation(db, cc.commitHash, inserted.id, 'CONTAINS');
          relationsWritten++;
        }
      }
    }
  }

  return { specsWritten, commitsWritten, fragmentsWritten, relationsWritten };
}
