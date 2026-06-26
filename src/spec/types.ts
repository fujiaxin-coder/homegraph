/**
 * Commit4Spec Type Definitions
 *
 * Core types for the Spec knowledge graph — a higher-level semantic overlay
 * on top of HomeGraph's code-symbol graph. Tracks design documents (Specs),
 * Git commits, and code-change fragments, linked through a three-layer
 * relationship model.
 *
 * These types mirror the Python dataclasses in Commit4Spec's
 * `db/models/*.py` and are stored in separate SQLite tables from
 * HomeGraph's `nodes` / `edges` core graph.
 */

// =============================================================================
// Entity Types
// =============================================================================

/**
 * A design Spec — a higher-level document describing system behavior,
 * discovered from either commit-message scopes or spec files on disk.
 */
export interface SpecNode {
  /** Unique spec identifier (e.g. "spec28", "auth-module") */
  id: string;

  /** Title extracted from the spec document's first heading */
  title: string;

  /** Subtitle entries — markdown headings with content previews */
  subtitles: string[];

  /** Lifecycle status */
  status: 'active' | 'deprecated';

  /** Version number (incremented on each self-evolution rewrite) */
  version: number;

  /** Filesystem path to the spec document */
  filePath: string;

  /** Unix epoch millisecond timestamp of last update */
  timestamp: number;
}

/**
 * A Git commit — metadata extracted from the repository history.
 */
export interface CommitNode {
  /** Full commit hash (40-char hex) */
  hash: string;

  /** Commit message (first line) */
  message: string;

  /** Commit author name */
  author: string;

  /** Unix epoch millisecond timestamp */
  timestamp: number;
}

/**
 * A code-change fragment — a single file's diff from a commit,
 * tracked as a coarse-grained range (not AST-level).
 */
export interface CodeFragmentNode {
  /** 12-character hex identifier (auto-generated UUID prefix) */
  id: string;

  /** Kind of change */
  changeType: 'ADD' | 'MODIFY' | 'DELETE';

  /** Changed file path relative to repo root */
  filePath: string;

  /** First changed line (1-indexed) */
  startLine: number;

  /** Last changed line (1-indexed) */
  endLine: number;

  /** Unified diff text for this fragment */
  codeDiff: string;
}

// =============================================================================
// Relation Types
// =============================================================================

/**
 * Relationship types between Spec entities.
 *
 *  - GENERATE:       commit → spec (parsed from commit message scope)
 *  - SUMMARIZED_FROM: spec → commit (discovered during mining)
 *  - SIMILAR_TO:      spec ↔ spec  (semantic similarity match)
 *  - EVOLVED_FROM:    new spec → old/deprecated spec (self-evolve)
 *  - CONTAINS:        commit → code fragment
 */
export type RelationType =
  | 'GENERATE'
  | 'SUMMARIZED_FROM'
  | 'SIMILAR_TO'
  | 'EVOLVED_FROM'
  | 'CONTAINS';

/**
 * A link between a Spec and a Commit.
 */
export interface SpecCommitRelation {
  specId: string;
  commitHash: string;
  relationType: RelationType;
}

/**
 * A link between a Commit and a CodeFragment.
 */
export interface CommitFragmentRelation {
  commitHash: string;
  fragmentId: string;
}

/**
 * A link between two Specs.
 */
export interface SpecSpecRelation {
  sourceId: string;
  targetId: string;
  relationType: RelationType;
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Full context for a Spec — the spec itself, all linked commits,
 * and the code fragments each commit touched.
 */
export interface SpecContext {
  spec: SpecNode;
  commits: SpecCommitContext[];
}

/**
 * A commit with its relation type and code fragments, all bound
 * to a specific spec.
 */
export interface SpecCommitContext {
  commit: CommitNode;
  relationType: RelationType;
  fragments: CodeFragmentNode[];
}

/**
 * A compact commit reference (hash + message only) for lightweight
 * context serialisation.
 */
export interface CommitReference {
  hash: string;
  message: string;
  timestamp: number;
}

// =============================================================================
// Search Types
// =============================================================================

/**
 * A search result for a spec with scoring metadata.
 */
export interface SpecSearchResult {
  /** Matching spec */
  id: string;
  title: string;
  subtitles: string[];

  /** Relevance score — 3.0 (exact title) → 1.0 (subtitles-only match) */
  _score: number;

  /** Which search stage produced this result */
  _method?: 'fts5' | 'like' | 'all' | 'discovery';

  /** LIKE tier label (only for LIKE results) */
  _tier?: 'exact_title' | 'starts_with_title' | 'contains_title' | 'contains_subtitle';
}

// =============================================================================
// Database Stats Types
// =============================================================================

/**
 * Statistics about the Spec knowledge graph.
 */
export interface SpecStats {
  specCount: number;
  commitCount: number;
  fragmentCount: number;
  relationCount: number;
  activeSpecCount: number;
  deprecatedSpecCount: number;
}
