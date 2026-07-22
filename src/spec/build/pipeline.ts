/**
 * Build pipeline orchestrator — main entry point for building spec
 * knowledge from Git history.
 *
 * Replaces `commit4spec/reverse_engineer/pipeline.py`.  Discovers spec↔commit
 * pairs via `scan()`, persists them into the SQLite knowledge graph, and
 * writes a `.homegraph/commit4spec/meta.json` anchor so the self-evolve pipeline can
 * pick up where build left off.
 *
 * @module spec/build/pipeline
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { loadSpecConfig } from '../config';
import { writeMeta, discoverSpecs, readMeta } from '../utils';
import { initSpecSchema } from '../db/schema';
import { insertCommitNode } from '../db/commit-node';
import { insertSpecCommitRelation } from '../db/relations';
import { upsertSpecFromMetadata, persistCommitFragments } from '../db/persist';
import { scan } from './scan';
import { getCommitDiff, getHeadHash } from '../git';
import { analyzeCommitDiff } from './diff-parser';
import { logDebug, logWarn } from '../../errors';
import type { ProgressCallback } from '../ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildResult {
  specsFound: number;
  commitsFound: number;
  fragmentsFound: number;
  relationsCreated: number;
  totalEntries: number;
  skippedEntries: Array<{ specId: string; reason: string }>;
  upToDate?: boolean;
}

// ---------------------------------------------------------------------------
// runBuildPipeline
// ---------------------------------------------------------------------------

/**
 * Run the full build pipeline.
 *
 * Steps (ported from `pipeline.py:49-151`):
 *
 * 1. Initialise the spec knowledge-graph schema in the database.
 * 2. Discover all specs on disk (for the `totalEntries` count).
 * 3. Scan the repository for spec↔commit pairs.
 * 4. Sort pairs by commit timestamp ascending so that `INSERT OR REPLACE`
 *    gives the most-recent commit the final word for each spec node.
 * 5. Process each pair:
 *    - Insert a SpecNode (once per specId; deduplicated by commit timestamp).
 *    - Insert a CommitNode (once per commit hash).
 *    - Insert a SUMMARIZED_FROM relation.
 *    - Parse the commit diff into code fragments and persist them.
 * 6. Build a list of specs discovered on disk but never matched to a commit.
 * 7. Write `.homegraph/commit4spec/meta.json`.
 * 8. Return the `BuildResult` with all counts.
 *
 * Edge cases:
 * - Empty pairs → zero counts, write meta anyway, return result.
 * - Pair with commit metadata but no spec metadata → commit and fragments
 *   are still persisted; SpecNode and spec_commit_relation are skipped.
 * - Pair with spec metadata but no commit metadata → entire pair is skipped.
 * - Same spec in multiple pairs → only counted once in `specsFound`, but
 *   every commit relation is created.
 */
export function runBuildPipeline(
  repoPath: string,
  specStoragePath: string,
  db: SqliteDatabase,
  onProgress?: ProgressCallback,
): BuildResult {
  // Pre-check: if meta.json exists and HEAD hasn't changed since the last
  // build, the knowledge graph is already current — skip the full rebuild.
  const existingMeta = readMeta(repoPath);
  if (existingMeta?.currentCommitID) {
    const headHash = getHeadHash(repoPath);
    if (headHash && headHash === existingMeta.currentCommitID) {
      logDebug('Skipping spec build: knowledge graph is up to date', {
        currentCommitID: existingMeta.currentCommitID,
      });
      return {
        specsFound: 0,
        commitsFound: 0,
        fragmentsFound: 0,
        relationsCreated: 0,
        totalEntries: discoverSpecs(specStoragePath).length,
        skippedEntries: [],
        upToDate: true,
      };
    }
  }

  // ---- Step 1: init schema ----
  initSpecSchema(db);

  // ---- Step 2: discover specs (for totalEntries) ----
  const allEntries = discoverSpecs(specStoragePath);
  const totalEntries = allEntries.length;

  // ---- Step 3: scan for pairs ----
  const pairs = scan(repoPath, specStoragePath, loadSpecConfig(repoPath), onProgress);

  // ---- Step 4: sort by commit timestamp ascending (oldest first) ----
  // INSERT OR REPLACE is used for SpecNode — when the same spec appears
  // in multiple pairs, the LAST write (most-recent commit) naturally wins.
  pairs.sort((a, b) => {
    const aTs = a.commitMetadata?.timestamp ?? 0;
    const bTs = b.commitMetadata?.timestamp ?? 0;
    return aTs - bTs;
  });

  // ---- Step 5: process pairs ----
  const writtenSpecIds = new Set<string>();
  const seenCommitHashes = new Set<string>();
  let specsFound = 0;
  let commitsFound = 0;
  let fragmentsFound = 0;
  let relationsCreated = 0;

  const pairsTotal = pairs.length;
  let pairsCurrent = 0;

  for (const pair of pairs) {
    pairsCurrent++;
    onProgress?.({
      phase: 'persisting',
      current: pairsCurrent,
      total: pairsTotal,
      message: `${pair.specId} @ ${pair.commitHash.slice(0, 7)}`,
    });

    // Skip if no commit metadata (no data to insert).
    const cm = pair.commitMetadata;
    if (!cm) {
      continue;
    }

    const sm = pair.specMetadata;

    // Insert SpecNode if spec metadata is present.
    // INSERT OR REPLACE lets the most-recent commit (last in ascending
    // order) overwrite the timestamp. We still track writtenSpecIds to
    // correctly count distinct specs (not overwrites).
    if (sm) {
      logDebug('Processing pair: inserting SpecNode', {
        specId: sm.specId,
        title: sm.title,
      });

      upsertSpecFromMetadata(db, sm, cm.timestamp);
      if (!writtenSpecIds.has(pair.specId)) {
        writtenSpecIds.add(pair.specId);
        specsFound++;
      }
    }

    // Insert CommitNode if not yet seen.
    if (!seenCommitHashes.has(cm.hash)) {
      insertCommitNode(db, {
        hash: cm.hash,
        message: cm.message,
        author: cm.author,
        timestamp: cm.timestamp,
      });
      seenCommitHashes.add(cm.hash);
      commitsFound++;
    }

    // Insert spec_commit_relation (only when spec metadata exists).
    if (sm) {
      insertSpecCommitRelation(db, pair.specId, cm.hash, 'SUMMARIZED_FROM');
      relationsCreated++;
    }

    // ---- Analyze diff and insert fragments ----
    const preFetchedDiff = getCommitDiff(repoPath, cm.hash);
    const fragments = analyzeCommitDiff(repoPath, cm.hash, preFetchedDiff);
    const persisted = persistCommitFragments(db, cm.hash, fragments);
    fragmentsFound += persisted.fragmentsInserted;
    relationsCreated += persisted.relationsCreated;
  }

  // ---- Step 6: build skipped entries ----
  const skippedEntries = allEntries
    .filter((e) => !writtenSpecIds.has(e.specId))
    .map((e) => ({ specId: e.specId, reason: 'No matching commits found' }));

  for (const skipped of skippedEntries) {
    logWarn('Spec discovered on disk but no matching commits found', {
      specId: skipped.specId,
    });
  }

  // ---- Step 7: write meta ----
  const headHash = getHeadHash(repoPath) ?? undefined;
  writeMeta(repoPath, specStoragePath, headHash);

  onProgress?.({ phase: 'done', current: 0, total: 0 });

  // ---- Step 8: return result ----
  return {
    specsFound,
    commitsFound,
    fragmentsFound,
    relationsCreated,
    totalEntries,
    skippedEntries,
  };
}
