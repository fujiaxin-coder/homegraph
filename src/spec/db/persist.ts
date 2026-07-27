/**
 * Composed write operations for the spec knowledge graph — shared by the
 * build, mine, and evolve pipelines so the "spec node from metadata" and
 * "commit fragments + CONTAINS relations" write sequences live in exactly
 * one place.
 *
 * All inserts are idempotent (INSERT OR REPLACE / INSERT OR IGNORE), so
 * re-running a pipeline against the same commits is safe.
 *
 * @module spec/db/persist
 */

import { SqliteDatabase } from '../../db/sqlite-adapter';
import { CodeFragmentNode } from '../types';
import { insertSpecNode } from './spec-node';
import { insertCodeFragment } from './fragment-node';
import { insertCommitFragmentRelation } from './relations';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal spec metadata needed to upsert a SpecNode. */
export interface SpecMetadataInput {
  specId: string;
  title: string;
  subtitles: string[];
  filePath: string;
}

/** A diff fragment to persist (id is auto-generated). */
export type FragmentInput = Omit<CodeFragmentNode, 'id'>;

// ---------------------------------------------------------------------------
// upsertSpecFromMetadata
// ---------------------------------------------------------------------------

/**
 * Insert or replace an active, version-1 SpecNode from extracted metadata.
 *
 * With INSERT OR REPLACE semantics, when the same spec is written multiple
 * times the last write (callers process commits oldest-first, so the most
 * recent commit) wins the timestamp.
 */
export function upsertSpecFromMetadata(
  db: SqliteDatabase,
  metadata: SpecMetadataInput,
  timestamp: number,
): void {
  insertSpecNode(db, {
    id: metadata.specId,
    title: metadata.title,
    subtitles: metadata.subtitles,
    status: 'active',
    version: 1,
    filePath: metadata.filePath,
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// persistCommitFragments
// ---------------------------------------------------------------------------

/**
 * Persist diff fragments for a commit and link them with CONTAINS relations.
 *
 * @param db          - Open SQLite database handle.
 * @param commitHash  - The commit the fragments belong to.
 * @param fragments   - Diff fragments to insert (ids are auto-generated).
 * @param filterFiles - Optional allow-list of file paths; fragments for
 *   other files are skipped.
 * @returns Counts of inserted fragments and created relations.
 */
export function persistCommitFragments(
  db: SqliteDatabase,
  commitHash: string,
  fragments: FragmentInput[],
  filterFiles?: Set<string>,
): { fragmentsInserted: number; relationsCreated: number } {
  let fragmentsInserted = 0;
  let relationsCreated = 0;

  for (const frag of fragments) {
    if (filterFiles && !filterFiles.has(frag.filePath)) continue;

    const inserted = insertCodeFragment(db, { id: '', ...frag });
    fragmentsInserted++;
    insertCommitFragmentRelation(db, commitHash, inserted.id, 'CONTAINS');
    relationsCreated++;
  }

  return { fragmentsInserted, relationsCreated };
}
