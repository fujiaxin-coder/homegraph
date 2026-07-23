/**
 * Spec Database Layer — Barrel Export
 *
 * Re-exports all CRUD operations, schema initialisation, and FTS5
 * search so consumers can `import { ... } from '../spec/db'`.
 */

// Schema
export { initSpecSchema, getCurrentSpecVersion, runSpecMigrations, CURRENT_SPEC_SCHEMA_VERSION } from './schema';

// Entity CRUD
export {
  insertSpecNode,
  findSpecById,
  updateSpecStatus,
  updateSpecVersion,
  deleteSpec,
  listAllSpecs,
  countSpecsByStatus,
  parseSubtitlesJson,
} from './spec-node';

export {
  insertCommitNode,
  findCommitByHash,
  listAllCommits,
  countCommits,
} from './commit-node';

export {
  insertCodeFragment,
  findFragmentById,
  findFragmentsByCommit,
  countFragments,
} from './fragment-node';

// Relations
export {
  insertSpecCommitRelation,
  findCommitsBySpec,
  transferSpecCommitRelations,
  insertCommitFragmentRelation,
  insertSpecSpecRelation,
  deleteSimilarToRelations,
  transferSpecSpecRelations,
  countAllRelations,
  findSpecIdsByFragmentPath,
  findSpecsByFilePath,
  FindSpecsByFilePathResult,
  findSpecCandidatesByFilePath,
  SpecCandidate,
  findSpecIdsByFragmentIds,
  findFragmentPathsBySpec,
  findActiveSpecIds,
} from './relations';

// FTS5 Search
export {
  searchSpecs,
  searchCodeFragments,
  escapeFtsQuery,
  segmentCjk,
} from './fts';

// SQL helpers
export { escapeLike } from './sql-utils';

// Composed writes
export {
  upsertSpecFromMetadata,
  persistCommitFragments,
  SpecMetadataInput,
  FragmentInput,
} from './persist';
