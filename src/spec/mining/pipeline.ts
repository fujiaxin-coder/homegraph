/**
 * Mining pipeline orchestrator — main entry point for reverse-mining spec
 * knowledge from Git history.
 *
 * Replaces `commit4spec/reverse_engineer/pipeline.py`.  Discovers spec↔commit
 * pairs via `scan()`, persists them into the SQLite knowledge graph, and
 * writes a `.commit4spec/meta.json` anchor so the self-evolve pipeline can
 * pick up where mining left off.
 *
 * @module spec/mining/pipeline
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { SpecConfig, loadSpecConfig } from '../config';
import { writeMeta, discoverSpecs } from '../utils';
import { initSpecSchema } from '../db/schema';
import { insertSpecNode } from '../db/spec-node';
import { insertCommitNode } from '../db/commit-node';
import { insertCodeFragment } from '../db/fragment-node';
import {
  insertSpecCommitRelation,
  insertCommitFragmentRelation,
} from '../db/relations';
import { scan } from './git-scanner';
import { analyzeCommitDiff } from './diff-parser';
import { logDebug, logWarn } from '../../errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiningResult {
  specsFound: number;
  commitsFound: number;
  fragmentsFound: number;
  relationsCreated: number;
  totalEntries: number;
  skippedEntries: Array<{ specId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// runMiningPipeline
// ---------------------------------------------------------------------------

/**
 * Run the full reverse-mining pipeline.
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
 * 7. Write `.commit4spec/meta.json`.
 * 8. Return the `MiningResult` with all counts.
 *
 * Edge cases:
 * - Empty pairs → zero counts, write meta anyway, return result.
 * - Pair with commit metadata but no spec metadata → commit and fragments
 *   are still persisted; SpecNode and spec_commit_relation are skipped.
 * - Pair with spec metadata but no commit metadata → entire pair is skipped.
 * - Same spec in multiple pairs → only counted once in `specsFound`, but
 *   every commit relation is created.
 */
export function runMiningPipeline(
  repoPath: string,
  specStoragePath: string,
  db: SqliteDatabase,
  config?: SpecConfig,
): MiningResult {
  // Resolve config once — guarantee a valid SpecConfig for downstream consumers.
  const resolvedConfig = config ?? loadSpecConfig(repoPath);

  // ---- Step 1: init schema ----
  initSpecSchema(db);

  // ---- Step 2: discover specs (for totalEntries) ----
  const allEntries = discoverSpecs(specStoragePath);
  const totalEntries = allEntries.length;

  // ---- Step 3: scan for pairs ----
  const pairs = scan(repoPath, specStoragePath, resolvedConfig);

  // ---- Step 4: sort by commit timestamp ascending ----
  // CRITICAL: when the same spec appears in multiple pairs, the last one
  // written (i.e. the pair with the most-recent commit) wins for the
  // SpecNode timestamp because `insertSpecNode` uses INSERT OR REPLACE.
  pairs.sort((a, b) => {
    const aTs = a.commitMetadata?.timestamp ?? 0;
    const bTs = b.commitMetadata?.timestamp ?? 0;
    return aTs - bTs;
  });

  // ---- Step 5: process pairs ----
  const seenSpecIds = new Set<string>();
  const seenCommitHashes = new Set<string>();
  let specsFound = 0;
  let commitsFound = 0;
  let fragmentsFound = 0;
  let relationsCreated = 0;

  for (const pair of pairs) {
    // Skip if no commit metadata (no data to insert).
    const cm = pair.commitMetadata;
    if (!cm) {
      continue;
    }

    const sm = pair.specMetadata;

    // Insert SpecNode if spec metadata is present and not yet seen.
    if (sm && !seenSpecIds.has(pair.specId)) {
      logDebug('Processing pair: inserting SpecNode', {
        specId: sm.specId,
        title: sm.title,
      });

      insertSpecNode(db, {
        id: sm.specId,
        title: sm.title,
        subtitles: sm.subtitles,
        status: 'active',
        version: 1,
        filePath: sm.filePath,
        timestamp: cm.timestamp,
      });
      seenSpecIds.add(pair.specId);
      specsFound++;
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
    const fragments = analyzeCommitDiff(repoPath, cm.hash);
    for (const frag of fragments) {
      // insertCodeFragment auto-generates an id when the `id` field is empty.
      const inserted = insertCodeFragment(db, {
        id: '',
        changeType: frag.changeType,
        filePath: frag.filePath,
        startLine: frag.startLine,
        endLine: frag.endLine,
        codeDiff: frag.codeDiff,
      });
      fragmentsFound++;
      insertCommitFragmentRelation(db, cm.hash, inserted.id);
      relationsCreated++;
    }
  }

  // ---- Step 6: build skipped entries ----
  const skippedEntries = allEntries
    .filter((e) => !seenSpecIds.has(e.specId))
    .map((e) => ({ specId: e.specId, reason: 'No matching commits found' }));

  for (const skipped of skippedEntries) {
    logWarn('Spec discovered on disk but no matching commits found', {
      specId: skipped.specId,
    });
  }

  // ---- Step 7: write meta ----
  writeMeta(repoPath, specStoragePath);

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
