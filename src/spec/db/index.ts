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
} from './relations';

// FTS5 Search
export {
  searchSpecs,
  escapeFtsQuery,
  segmentCjk,
} from './fts';
