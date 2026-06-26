-- Commit4Spec Schema for HomeGraph
-- Version 1
--
-- Independent tables that coexist alongside HomeGraph's `nodes`/`edges`
-- core graph. These tables form a three-layer Spec→Commit→CodeFragment
-- relationship model — a higher-level semantic overlay on the code graph.
--
-- FTS5 uses a standalone virtual table (not external content) because
-- Spec text needs CJK character-level segmentation before indexing.

-- =============================================================================
-- Entity Tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS spec_nodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subtitles TEXT NOT NULL,        -- JSON array of markdown heading + preview
    status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'deprecated'
    version INTEGER NOT NULL DEFAULT 1,
    file_path TEXT NOT NULL,
    timestamp INTEGER NOT NULL      -- Unix epoch milliseconds
);

CREATE TABLE IF NOT EXISTS commit_nodes (
    hash TEXT PRIMARY KEY,          -- Full 40-char commit hash
    message TEXT NOT NULL,          -- First line of commit message
    author TEXT NOT NULL,
    timestamp INTEGER NOT NULL      -- Unix epoch milliseconds
);

CREATE TABLE IF NOT EXISTS code_fragment_nodes (
    id TEXT PRIMARY KEY,            -- 12-char hex UUID prefix
    change_type TEXT NOT NULL,      -- 'ADD' | 'MODIFY' | 'DELETE'
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    code_diff TEXT NOT NULL         -- Unified diff text
);

-- =============================================================================
-- Relation Tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS spec_commit_relations (
    spec_id TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    relation_type TEXT NOT NULL,    -- 'GENERATE' | 'SUMMARIZED_FROM'
    PRIMARY KEY (spec_id, commit_hash, relation_type),
    FOREIGN KEY (spec_id) REFERENCES spec_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (commit_hash) REFERENCES commit_nodes(hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commit_fragment_relations (
    commit_hash TEXT NOT NULL,
    fragment_id TEXT NOT NULL,
    PRIMARY KEY (commit_hash, fragment_id),
    FOREIGN KEY (commit_hash) REFERENCES commit_nodes(hash) ON DELETE CASCADE,
    FOREIGN KEY (fragment_id) REFERENCES code_fragment_nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS spec_spec_relations (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,    -- 'SIMILAR_TO' | 'EVOLVED_FROM'
    PRIMARY KEY (source_id, target_id, relation_type),
    FOREIGN KEY (source_id) REFERENCES spec_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES spec_nodes(id) ON DELETE CASCADE
);

-- =============================================================================
-- Full-Text Search (standalone — CJK-segmented on insert)
-- =============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS specs_fts USING fts5(
    id,
    title,
    subtitles
);

-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_spec_nodes_status ON spec_nodes(status);
CREATE INDEX IF NOT EXISTS idx_spec_nodes_file_path ON spec_nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_commit_nodes_timestamp ON commit_nodes(timestamp);
CREATE INDEX IF NOT EXISTS idx_code_fragment_file_path ON code_fragment_nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_scr_spec_id ON spec_commit_relations(spec_id);
CREATE INDEX IF NOT EXISTS idx_scr_commit_hash ON spec_commit_relations(commit_hash);
CREATE INDEX IF NOT EXISTS idx_cfr_commit_hash ON commit_fragment_relations(commit_hash);
CREATE INDEX IF NOT EXISTS idx_cfr_fragment_id ON commit_fragment_relations(fragment_id);
CREATE INDEX IF NOT EXISTS idx_ssr_source ON spec_spec_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_ssr_target ON spec_spec_relations(target_id);

-- =============================================================================
-- Schema Version
-- =============================================================================

CREATE TABLE IF NOT EXISTS spec_schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

INSERT OR IGNORE INTO spec_schema_versions (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial Commit4Spec schema');
