/**
 * commit-spec-persister.ts — Per-commit graph persistence.
 *
 * Each commit is persisted in its own transaction so that a single failure
 * does not roll back other successful commits. This aligns with the
 * meta.json advancement rule: advance to the last commit whose phase-1
 * persistence succeeded.
 *
 * @module spec/evolve/commit-spec-persister
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { CommitSpecAnalysis } from './commit-spec-analyzer';
import { insertCommitNode } from '../db/commit-node';
import {
  insertSpecCommitRelation,
} from '../db/relations';
import { upsertSpecFromMetadata, persistCommitFragments } from '../db/persist';
import { logDebug, logWarn } from '../../errors';

// =============================================================================
// Types
// =============================================================================

export interface PersistResult {
  /** Commit hash being persisted. */
  commitHash: string;
  /** Always true in a PersistResult — only matched analyses are persisted. */
  matched: true;
  /** The spec ID that was persisted. */
  specId: string;
  /** File paths from the diff fragments (for phase 2 impact location). */
  filePaths: string[];
  /** Statistics. */
  stats: {
    fragmentsInserted: number;
    relationsCreated: number;
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Persist the knowledge graph entries for a single scope-matched commit.
 *
 * All INSERTs use OR REPLACE / OR IGNORE semantics so repeated calls with
 * the same data are idempotent.
 *
 * The caller is responsible for retry on failure — this function does
 * not retry internally.
 *
 * Steps (inside a single DB transaction):
 * 1. CommitNode (INSERT OR REPLACE)
 * 2. SpecNode (INSERT OR REPLACE)
 * 3. GENERATE relation (INSERT OR IGNORE)
 * 4. For each diff fragment:
 *    a. CodeFragment node (INSERT, auto-generated id)
 *    b. CONTAINS relation (INSERT OR IGNORE)
 *
 * @param db       - Active SQLite database handle.
 * @param analysis - CommitSpecAnalysis with matched=true.
 * @returns PersistResult on success.
 * @throws On transaction failure (caller decides whether to retry or skip).
 */
export function persistCommitSpecGraph(
  db: SqliteDatabase,
  analysis: CommitSpecAnalysis & { matched: true },
): PersistResult {
  const { commit } = analysis;
  const metadata = analysis.metadata!;
  const fragments = analysis.fragments!;
  const filePaths = fragments.map((f) => f.filePath);
  let fragmentsInserted = 0;
  let relationsCreated = 0;

  db.exec('BEGIN');
  try {
    // 1. CommitNode (idempotent — INSERT OR REPLACE)
    insertCommitNode(db, {
      hash: commit.hash,
      message: commit.message,
      author: commit.author,
      timestamp: commit.timestamp,
    });

    // 2. SpecNode (idempotent — INSERT OR REPLACE, last write wins for timestamp)
    upsertSpecFromMetadata(db, metadata, commit.timestamp);

    // 3. GENERATE relation (idempotent — INSERT OR IGNORE)
    insertSpecCommitRelation(db, metadata.specId, commit.hash, 'GENERATE');
    relationsCreated++;

    // 4. CodeFragment nodes + CONTAINS relations
    const persisted = persistCommitFragments(db, commit.hash, fragments);
    fragmentsInserted += persisted.fragmentsInserted;
    relationsCreated += persisted.relationsCreated;

    db.exec('COMMIT');

    logDebug('persistCommitSpecGraph: persisted', {
      commitHash: commit.hash.slice(0, 7),
      specId: metadata.specId,
      fragments: fragmentsInserted,
      relations: relationsCreated,
    });

    return {
      commitHash: commit.hash,
      matched: true,
      specId: metadata.specId,
      filePaths,
      stats: { fragmentsInserted, relationsCreated },
    };
  } catch (e) {
    db.exec('ROLLBACK');
    const msg = e instanceof Error ? e.message : String(e);
    logWarn('persistCommitSpecGraph: transaction failed', {
      commitHash: commit.hash.slice(0, 7),
      error: msg,
    });
    throw e; // Let the pipeline decide: skip this commit and advance or stop
  }
}
