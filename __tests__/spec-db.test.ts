/**
 * Spec Database Tests
 *
 * Comprehensive Vitest tests for the Commit4Spec knowledge graph database
 * layer: schema initialisation, entity CRUD, relations, and FTS5 search.
 *
 * Uses in-memory SQLite via node:sqlite (the same backend as production).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase, SqliteDatabase } from '../src/db/sqlite-adapter';
import {
  initSpecSchema,
  getCurrentSpecVersion,
  runSpecMigrations,
  CURRENT_SPEC_SCHEMA_VERSION,
} from '../src/spec/db/schema';
import {
  insertSpecNode,
  findSpecById,
  updateSpecStatus,
  listAllSpecs,
  deleteSpec,
} from '../src/spec/db/spec-node';
import {
  insertCommitNode,
  findCommitByHash,
  listAllCommits,
} from '../src/spec/db/commit-node';
import {
  insertCodeFragment,
  findFragmentById,
} from '../src/spec/db/fragment-node';
import {
  insertSpecCommitRelation,
  findCommitsBySpec,
  insertCommitFragmentRelation,
  insertSpecSpecRelation,
  deleteSimilarToRelations,
} from '../src/spec/db/relations';
import {
  segmentCjk,
  escapeFtsQuery,
  searchSpecs,
  searchCodeFragments,
} from '../src/spec/db/fts';
import { SpecNode, CommitNode, CodeFragmentNode } from '../src/spec/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh in-memory SQLite database for each test. */
function createTestDb(): SqliteDatabase {
  return createDatabase(':memory:').db;
}

/** Create a minimal valid SpecNode for testing. */
function makeSpec(overrides: Partial<SpecNode> = {}): SpecNode {
  return {
    id: 'spec-1',
    title: 'Test Spec',
    subtitles: ['## Overview', '## Details'],
    status: 'active',
    version: 1,
    filePath: '/path/to/spec.md',
    timestamp: 1700000000000,
    ...overrides,
  };
}

/** Create a minimal valid CommitNode for testing. */
function makeCommit(overrides: Partial<CommitNode> = {}): CommitNode {
  return {
    hash: 'a'.repeat(40),
    message: 'feat: add something',
    author: 'Tester',
    timestamp: 1700000000000,
    ...overrides,
  };
}

/** Create a minimal valid CodeFragmentNode for testing. */
function makeFragment(overrides: Partial<CodeFragmentNode> = {}): CodeFragmentNode {
  return {
    id: '',
    changeType: 'MODIFY',
    filePath: 'src/foo.ts',
    startLine: 10,
    endLine: 20,
    codeDiff: '@@ -10,11 +10,11 @@\n- old\n+ new',
    ...overrides,
  };
}

// ===========================================================================
// 1. Schema
// ===========================================================================

describe('Spec Schema (schema.ts)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  const expectedTables = [
    'spec_nodes',
    'commit_nodes',
    'code_fragment_nodes',
    'spec_commit_relations',
    'commit_fragment_relations',
    'spec_spec_relations',
    'specs_fts',
    'spec_schema_versions',
  ];

  it('initSpecSchema creates all required tables', () => {
    initSpecSchema(db);

    for (const table of expectedTables) {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?"
        )
        .get(table);
      expect(row).not.toBeUndefined();
    }
  });

  it('initSpecSchema can be called without errors on first invocation', () => {
    expect(() => initSpecSchema(db)).not.toThrow();
  });

  it('foreign keys are enabled after initSpecSchema', () => {
    initSpecSchema(db);

    const row = db.pragma('foreign_keys') as Record<string, unknown>;
    // node:sqlite returns the pragma value; check it is truthy
    const val = Object.values(row)[0];
    expect(val).toBe(1);
  });

  it('can insert and query from spec_nodes table', () => {
    initSpecSchema(db);
    db.prepare(
      'INSERT INTO spec_nodes (id, title, subtitles, status, version, file_path, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('spec-a', 'Title A', '[]', 'active', 1, '/a.md', 1000);

    const row = db.prepare('SELECT id, title FROM spec_nodes WHERE id = ?').get('spec-a') as
      | { id: string; title: string }
      | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.id).toBe('spec-a');
    expect(row!.title).toBe('Title A');
  });

  it('can insert and query from commit_nodes table', () => {
    initSpecSchema(db);
    db.prepare(
      'INSERT INTO commit_nodes (hash, message, author, timestamp) VALUES (?, ?, ?, ?)'
    ).run('b'.repeat(40), 'fix: bug', 'Alice', 2000);

    const row = db.prepare('SELECT hash, message FROM commit_nodes WHERE hash = ?').get(
      'b'.repeat(40)
    ) as { hash: string; message: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.hash).toBe('b'.repeat(40));
  });

  it('can insert and query from code_fragment_nodes table', () => {
    initSpecSchema(db);
    db.prepare(
      'INSERT INTO code_fragment_nodes (id, change_type, file_path, start_line, end_line, code_diff) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('frag-1', 'ADD', 'src/new.ts', 1, 5, '+ new code');

    const row = db
      .prepare('SELECT id, change_type FROM code_fragment_nodes WHERE id = ?')
      .get('frag-1') as { id: string; change_type: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.id).toBe('frag-1');
  });

  it('can insert and query from spec_commit_relations table', () => {
    initSpecSchema(db);
    // Need referenced rows first (foreign keys)
    db.prepare(
      'INSERT INTO spec_nodes (id, title, subtitles, status, version, file_path, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('s1', 'S1', '[]', 'active', 1, '/s1.md', 1000);
    db.prepare(
      'INSERT INTO commit_nodes (hash, message, author, timestamp) VALUES (?, ?, ?, ?)'
    ).run('c'.repeat(40), 'msg', 'A', 2000);
    db.prepare(
      'INSERT INTO spec_commit_relations (spec_id, commit_hash, relation_type) VALUES (?, ?, ?)'
    ).run('s1', 'c'.repeat(40), 'GENERATE');

    const row = db
      .prepare('SELECT spec_id, relation_type FROM spec_commit_relations WHERE spec_id = ?')
      .get('s1') as { spec_id: string; relation_type: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.relation_type).toBe('GENERATE');
  });

  it('can insert and query from commit_fragment_relations table', () => {
    initSpecSchema(db);
    db.prepare(
      'INSERT INTO commit_nodes (hash, message, author, timestamp) VALUES (?, ?, ?, ?)'
    ).run('d'.repeat(40), 'msg', 'A', 2000);
    db.prepare(
      'INSERT INTO code_fragment_nodes (id, change_type, file_path, start_line, end_line, code_diff) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('f1', 'MODIFY', 'f.ts', 1, 2, 'diff');
    db.prepare(
      'INSERT INTO commit_fragment_relations (commit_hash, fragment_id, relation_type) VALUES (?, ?, ?)'
    ).run('d'.repeat(40), 'f1', 'CONTAINS');

    const row = db
      .prepare('SELECT commit_hash, fragment_id FROM commit_fragment_relations WHERE fragment_id = ?')
      .get('f1') as { commit_hash: string; fragment_id: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.fragment_id).toBe('f1');
  });

  it('can insert and query from spec_spec_relations table', () => {
    initSpecSchema(db);
    db.prepare(
      'INSERT INTO spec_nodes (id, title, subtitles, status, version, file_path, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src', 'Source', '[]', 'active', 1, '/src.md', 1000);
    db.prepare(
      'INSERT INTO spec_nodes (id, title, subtitles, status, version, file_path, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('tgt', 'Target', '[]', 'active', 1, '/tgt.md', 2000);
    db.prepare(
      'INSERT INTO spec_spec_relations (source_id, target_id, relation_type) VALUES (?, ?, ?)'
    ).run('src', 'tgt', 'SIMILAR_TO');

    const row = db
      .prepare('SELECT source_id, target_id, relation_type FROM spec_spec_relations WHERE source_id = ?')
      .get('src') as
      | { source_id: string; target_id: string; relation_type: string }
      | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.relation_type).toBe('SIMILAR_TO');
  });

  it('getCurrentSpecVersion returns 0 before schema init', () => {
    expect(getCurrentSpecVersion(db)).toBe(0);
  });

  it('getCurrentSpecVersion returns 2 after schema init', () => {
    initSpecSchema(db);
    expect(getCurrentSpecVersion(db)).toBe(2);
  });

  it('CURRENT_SPEC_SCHEMA_VERSION constant equals 2', () => {
    expect(CURRENT_SPEC_SCHEMA_VERSION).toBe(2);
  });

  it('runSpecMigrations does not throw (no pending migrations for v2)', () => {
    initSpecSchema(db);
    expect(() => runSpecMigrations(db, 2)).not.toThrow();
  });
});

// ===========================================================================
// 2. SpecNode CRUD
// ===========================================================================

describe('SpecNode CRUD (spec-node.ts)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  describe('insertSpecNode', () => {
    it('inserts a spec and returns it', () => {
      const spec = makeSpec();
      const result = insertSpecNode(db, spec);

      expect(result.id).toBe(spec.id);
      expect(result.title).toBe(spec.title);
    });

    it('insert OR REPLACE overwrites an existing spec with the same id', () => {
      const spec1 = makeSpec({ id: 'dup', title: 'First', version: 1 });
      const spec2 = makeSpec({ id: 'dup', title: 'Second', version: 2 });

      insertSpecNode(db, spec1);
      insertSpecNode(db, spec2);

      const found = findSpecById(db, 'dup');
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Second');
      expect(found!.version).toBe(2);
    });

    it('updates FTS5 index on insert', () => {
      const spec = makeSpec({ id: 'fts-test', title: 'User Authentication Flow' });
      insertSpecNode(db, spec);

      // The FTS table should contain the CJK-segmented title
      const ftsRow = db
        .prepare('SELECT id, title FROM specs_fts WHERE id = ?')
        .get('fts-test') as { id: string; title: string } | undefined;
      expect(ftsRow).not.toBeUndefined();
      // ASCII text passes through unchanged in segmentCjk
      expect(ftsRow!.title).toContain('User');
    });

    it('replaces FTS entry on re-insert (no duplicate FTS rows)', () => {
      const spec = makeSpec({ id: 'fts-dup', title: 'Login' });
      insertSpecNode(db, spec);
      insertSpecNode(db, { ...spec, title: 'Login Updated' });

      const rows = db.prepare('SELECT COUNT(*) as cnt FROM specs_fts WHERE id = ?').get('fts-dup') as
        | { cnt: number }
        | undefined;
      expect(rows).not.toBeUndefined();
      expect(rows!.cnt).toBe(1);
    });
  });

  describe('findSpecById', () => {
    it('returns the spec when found', () => {
      const spec = makeSpec({ id: 'found', title: 'My Title', subtitles: ['## Sub A', '## Sub B'] });
      insertSpecNode(db, spec);

      const result = findSpecById(db, 'found');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('found');
      expect(result!.title).toBe('My Title');
      expect(result!.subtitles).toEqual(['## Sub A', '## Sub B']);
      expect(result!.status).toBe('active');
    });

    it('returns null when spec is not found', () => {
      const result = findSpecById(db, 'nonexistent');
      expect(result).toBeNull();
    });

    it('parses subtitles JSON correctly', () => {
      const spec = makeSpec({ id: 'json-test', subtitles: ['## Section 1', '### Subsection 1.1'] });
      insertSpecNode(db, spec);

      const result = findSpecById(db, 'json-test');
      expect(result!.subtitles).toEqual(['## Section 1', '### Subsection 1.1']);
    });

    it('returns empty array for corrupted subtitles JSON', () => {
      // Insert a row with bad JSON via raw SQL to simulate corruption
      db.prepare(
        'INSERT INTO spec_nodes (id, title, subtitles, status, version, file_path, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('bad-json', 'Bad JSON Spec', '{not valid', 'active', 1, '/bad.md', 1000);

      const result = findSpecById(db, 'bad-json');
      expect(result).not.toBeNull();
      expect(result!.subtitles).toEqual([]);
    });

    it('returns empty array for null/empty subtitles', () => {
      db.prepare(
        'INSERT INTO spec_nodes (id, title, subtitles, status, version, file_path, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('empty-subs', 'Empty Subs', '', 'active', 1, '/empty.md', 1000);

      const result = findSpecById(db, 'empty-subs');
      expect(result).not.toBeNull();
      expect(result!.subtitles).toEqual([]);
    });
  });

  describe('listAllSpecs', () => {
    it('returns all specs ordered by id (ascending)', () => {
      insertSpecNode(db, makeSpec({ id: 'c', title: 'C Spec' }));
      insertSpecNode(db, makeSpec({ id: 'a', title: 'A Spec' }));
      insertSpecNode(db, makeSpec({ id: 'b', title: 'B Spec' }));

      const specs = listAllSpecs(db);
      expect(specs).toHaveLength(3);
      expect(specs.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array when no specs exist', () => {
      const specs = listAllSpecs(db);
      expect(specs).toEqual([]);
    });
  });

  describe('updateSpecStatus', () => {
    it('updates the status of a spec', () => {
      const spec = makeSpec({ id: 'status-test', status: 'active' });
      insertSpecNode(db, spec);

      updateSpecStatus(db, 'status-test', 'deprecated');

      const updated = findSpecById(db, 'status-test');
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('deprecated');
    });

    it('does not throw when updating a non-existent spec', () => {
      expect(() => updateSpecStatus(db, 'no-such-spec', 'deprecated')).not.toThrow();
    });
  });

  describe('deleteSpec', () => {
    it('deletes a spec and its FTS entry', () => {
      const spec = makeSpec({ id: 'to-delete' });
      insertSpecNode(db, spec);

      deleteSpec(db, 'to-delete');

      expect(findSpecById(db, 'to-delete')).toBeNull();
      const ftsRow = db.prepare('SELECT id FROM specs_fts WHERE id = ?').get('to-delete');
      expect(ftsRow).toBeUndefined();
    });

    it('does not throw when deleting a non-existent spec', () => {
      expect(() => deleteSpec(db, 'no-such-spec')).not.toThrow();
    });
  });
});

// ===========================================================================
// 3. CommitNode CRUD
// ===========================================================================

describe('CommitNode CRUD (commit-node.ts)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  describe('insertCommitNode', () => {
    it('inserts a commit and returns it', () => {
      const commit = makeCommit();
      const result = insertCommitNode(db, commit);

      expect(result.hash).toBe(commit.hash);
      expect(result.message).toBe(commit.message);
    });

    it('INSERT OR REPLACE overwrites an existing commit with the same hash', () => {
      const hash = '1'.repeat(40);
      const c1 = makeCommit({ hash, message: 'First message' });
      const c2 = makeCommit({ hash, message: 'Second message' });

      insertCommitNode(db, c1);
      insertCommitNode(db, c2);

      const found = findCommitByHash(db, hash);
      expect(found).not.toBeNull();
      expect(found!.message).toBe('Second message');
    });
  });

  describe('findCommitByHash', () => {
    it('returns the commit when found', () => {
      const commit = makeCommit({ hash: '2'.repeat(40), message: 'fix: crash', author: 'Bob' });
      insertCommitNode(db, commit);

      const result = findCommitByHash(db, '2'.repeat(40));
      expect(result).not.toBeNull();
      expect(result!.hash).toBe('2'.repeat(40));
      expect(result!.message).toBe('fix: crash');
      expect(result!.author).toBe('Bob');
      expect(result!.timestamp).toBe(1700000000000);
    });

    it('returns null when commit is not found', () => {
      const result = findCommitByHash(db, '3'.repeat(40));
      expect(result).toBeNull();
    });
  });

  describe('listAllCommits', () => {
    it('returns all commits ordered by timestamp DESC', () => {
      insertCommitNode(db, makeCommit({ hash: '1'.repeat(40), timestamp: 1000 }));
      insertCommitNode(db, makeCommit({ hash: '2'.repeat(40), timestamp: 3000 }));
      insertCommitNode(db, makeCommit({ hash: '3'.repeat(40), timestamp: 2000 }));

      const commits = listAllCommits(db);
      expect(commits).toHaveLength(3);
      expect(commits.map((c) => c.timestamp)).toEqual([3000, 2000, 1000]);
    });

    it('returns empty array when no commits exist', () => {
      const commits = listAllCommits(db);
      expect(commits).toEqual([]);
    });
  });
});

// ===========================================================================
// 4. CodeFragment CRUD
// ===========================================================================

describe('CodeFragment CRUD (fragment-node.ts)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  describe('insertCodeFragment', () => {
    it('auto-generates a 12-character hex ID when id is empty', () => {
      const fragment = makeFragment({ id: '' });
      const result = insertCodeFragment(db, fragment);

      expect(result.id).toHaveLength(12);
      // Should be lowercase hex
      expect(result.id).toMatch(/^[0-9a-f]{12}$/);
    });

    it('uses the provided explicit ID when non-empty', () => {
      const fragment = makeFragment({ id: 'abc123def456' });
      const result = insertCodeFragment(db, fragment);

      expect(result.id).toBe('abc123def456');
    });

    it('returns the inserted fragment with all fields', () => {
      const fragment = makeFragment({
        id: '',
        changeType: 'ADD',
        filePath: 'src/new.ts',
        startLine: 5,
        endLine: 15,
        codeDiff: '+ new code here',
      });
      const result = insertCodeFragment(db, fragment);

      expect(result.changeType).toBe('ADD');
      expect(result.filePath).toBe('src/new.ts');
      expect(result.startLine).toBe(5);
      expect(result.endLine).toBe(15);
      expect(result.codeDiff).toBe('+ new code here');
    });

    it('INSERT OR REPLACE overwrites with the same id', () => {
      const f1 = makeFragment({ id: 'fixed-id-01', filePath: 'src/a.ts' });
      const f2 = makeFragment({ id: 'fixed-id-01', filePath: 'src/b.ts' });

      insertCodeFragment(db, f1);
      insertCodeFragment(db, f2);

      const found = findFragmentById(db, 'fixed-id-01');
      expect(found).not.toBeNull();
      expect(found!.filePath).toBe('src/b.ts');
    });
  });

  describe('findFragmentById', () => {
    it('returns the fragment when found', () => {
      const fragment = makeFragment({ id: 'my-frag-id-1' });
      insertCodeFragment(db, fragment);

      const result = findFragmentById(db, 'my-frag-id-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('my-frag-id-1');
      expect(result!.changeType).toBe('MODIFY');
    });

    it('returns null when fragment is not found', () => {
      const result = findFragmentById(db, 'no-such-frag');
      expect(result).toBeNull();
    });
  });
});

// ===========================================================================
// 5. Relations
// ===========================================================================

describe('Relations (relations.ts)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  // Helper: insert a spec + commit pair for relation testing
  function seedSpecAndCommit(specId: string, commitHash: string) {
    insertSpecNode(db, makeSpec({ id: specId }));
    insertCommitNode(db, makeCommit({ hash: commitHash }));
  }

  function seedTwoSpecs() {
    insertSpecNode(db, makeSpec({ id: 'spec-a', title: 'Spec A' }));
    insertSpecNode(db, makeSpec({ id: 'spec-b', title: 'Spec B' }));
  }

  describe('insertSpecCommitRelation', () => {
    it('creates a relation between a spec and a commit', () => {
      seedSpecAndCommit('s1', 'a'.repeat(40));

      insertSpecCommitRelation(db, 's1', 'a'.repeat(40), 'GENERATE');

      const row = db
        .prepare(
          'SELECT spec_id, commit_hash, relation_type FROM spec_commit_relations WHERE spec_id = ?'
        )
        .get('s1') as
        | { spec_id: string; commit_hash: string; relation_type: string }
        | undefined;
      expect(row).not.toBeUndefined();
      expect(row!.relation_type).toBe('GENERATE');
    });

    it('silently ignores duplicate relations (INSERT OR IGNORE)', () => {
      seedSpecAndCommit('s2', 'b'.repeat(40));

      insertSpecCommitRelation(db, 's2', 'b'.repeat(40), 'SUMMARIZED_FROM');
      // Second insert with same (spec_id, commit_hash, relation_type) should be ignored
      expect(() =>
        insertSpecCommitRelation(db, 's2', 'b'.repeat(40), 'SUMMARIZED_FROM')
      ).not.toThrow();

      const rows = db
        .prepare('SELECT COUNT(*) as cnt FROM spec_commit_relations WHERE spec_id = ?')
        .get('s2') as { cnt: number } | undefined;
      expect(rows!.cnt).toBe(1);
    });
  });

  describe('findCommitsBySpec', () => {
    it('returns commits linked to a spec ordered by timestamp ASC', () => {
      // Insert all commits with ascending timestamps so ASC order is predictable
      insertSpecNode(db, makeSpec({ id: 's-find' }));
      insertCommitNode(db, makeCommit({ hash: 'c1'.padEnd(40, '1'), timestamp: 1000 }));
      insertCommitNode(db, makeCommit({ hash: 'c2'.padEnd(40, '2'), timestamp: 2000 }));
      insertCommitNode(db, makeCommit({ hash: 'c3'.padEnd(40, '3'), timestamp: 3000 }));

      insertSpecCommitRelation(db, 's-find', 'c1'.padEnd(40, '1'), 'GENERATE');
      insertSpecCommitRelation(db, 's-find', 'c2'.padEnd(40, '2'), 'SUMMARIZED_FROM');
      insertSpecCommitRelation(db, 's-find', 'c3'.padEnd(40, '3'), 'GENERATE');

      const results = findCommitsBySpec(db, 's-find');
      expect(results).toHaveLength(3);
      // Ordered by timestamp ASC
      expect(results.map((r) => r.commitHash)).toEqual([
        'c1'.padEnd(40, '1'),
        'c2'.padEnd(40, '2'),
        'c3'.padEnd(40, '3'),
      ]);
    });

    it('returns commit message, author, and timestamp fields', () => {
      seedSpecAndCommit('s-extra', 'c-extra'.padEnd(40, 'e'));
      insertSpecCommitRelation(db, 's-extra', 'c-extra'.padEnd(40, 'e'), 'GENERATE');

      const results = findCommitsBySpec(db, 's-extra');
      expect(results).toHaveLength(1);
      expect(results[0]!.message).toBe('feat: add something');
      expect(results[0]!.author).toBe('Tester');
      expect(results[0]!.timestamp).toBe(1700000000000);
    });

    it('returns empty array when spec has no commits', () => {
      insertSpecNode(db, makeSpec({ id: 'lonely-spec' }));
      const results = findCommitsBySpec(db, 'lonely-spec');
      expect(results).toEqual([]);
    });

    it('returns empty array for non-existent spec', () => {
      const results = findCommitsBySpec(db, 'no-such-spec');
      expect(results).toEqual([]);
    });
  });

  describe('specs by commit (via raw query)', () => {
    it('finds specs linked to a commit', () => {
      seedSpecAndCommit('spec-x', 'commit-x'.padEnd(40, 'x'));
      seedSpecAndCommit('spec-y', 'commit-x'.padEnd(40, 'x'));

      insertSpecCommitRelation(db, 'spec-x', 'commit-x'.padEnd(40, 'x'), 'GENERATE');
      insertSpecCommitRelation(db, 'spec-y', 'commit-x'.padEnd(40, 'x'), 'SUMMARIZED_FROM');

      const rows = db
        .prepare(
          `SELECT s.id, s.title, r.relation_type
           FROM spec_commit_relations r
           JOIN spec_nodes s ON s.id = r.spec_id
           WHERE r.commit_hash = ?
           ORDER BY s.id`
        )
        .all('commit-x'.padEnd(40, 'x')) as Array<{
        id: string;
        title: string;
        relation_type: string;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id)).toEqual(['spec-x', 'spec-y']);
    });
  });

  describe('insertCommitFragmentRelation', () => {
    it('creates a relation between a commit and a code fragment', () => {
      insertCommitNode(db, makeCommit({ hash: 'f'.repeat(40) }));
      const frag = insertCodeFragment(db, makeFragment({ id: '' }));

      insertCommitFragmentRelation(db, 'f'.repeat(40), frag.id, 'CONTAINS');

      const row = db
        .prepare(
          'SELECT commit_hash, fragment_id FROM commit_fragment_relations WHERE fragment_id = ?'
        )
        .get(frag.id) as { commit_hash: string; fragment_id: string } | undefined;
      expect(row).not.toBeUndefined();
      expect(row!.commit_hash).toBe('f'.repeat(40));
    });

    it('silently ignores duplicate relations', () => {
      insertCommitNode(db, makeCommit({ hash: 'g'.repeat(40) }));
      const frag = insertCodeFragment(db, makeFragment({ id: '' }));

      insertCommitFragmentRelation(db, 'g'.repeat(40), frag.id, 'CONTAINS');
      expect(() =>
        insertCommitFragmentRelation(db, 'g'.repeat(40), frag.id, 'CONTAINS')
      ).not.toThrow();

      const rows = db
        .prepare(
          'SELECT COUNT(*) as cnt FROM commit_fragment_relations WHERE fragment_id = ?'
        )
        .get(frag.id) as { cnt: number } | undefined;
      expect(rows!.cnt).toBe(1);
    });
  });

  describe('fragments by commit (via findFragmentsByCommit from fragment-node)', () => {
    it('returns fragments linked to a commit', async () => {
      // Need to import findFragmentsByCommit from fragment-node
      const { findFragmentsByCommit } = await import('../src/spec/db/fragment-node');

      insertCommitNode(db, makeCommit({ hash: 'h'.repeat(40) }));
      const frag1 = insertCodeFragment(
        db,
        makeFragment({ id: '', filePath: 'src/a.ts', startLine: 1 })
      );
      const frag2 = insertCodeFragment(
        db,
        makeFragment({ id: '', filePath: 'src/b.ts', startLine: 10 })
      );

      insertCommitFragmentRelation(db, 'h'.repeat(40), frag1.id, 'CONTAINS');
      insertCommitFragmentRelation(db, 'h'.repeat(40), frag2.id, 'CONTAINS');

      const results = findFragmentsByCommit(db, 'h'.repeat(40));
      expect(results).toHaveLength(2);
      expect(results.map((f) => f.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('returns empty array when commit has no fragments', async () => {
      const { findFragmentsByCommit } = await import('../src/spec/db/fragment-node');
      insertCommitNode(db, makeCommit({ hash: 'i'.repeat(40) }));
      const results = findFragmentsByCommit(db, 'i'.repeat(40));
      expect(results).toEqual([]);
    });
  });

  describe('insertSpecSpecRelation', () => {
    it('creates a relation between two specs', () => {
      seedTwoSpecs();

      insertSpecSpecRelation(db, 'spec-a', 'spec-b', 'SIMILAR_TO');

      const row = db
        .prepare(
          'SELECT source_id, target_id, relation_type FROM spec_spec_relations WHERE source_id = ?'
        )
        .get('spec-a') as
        | { source_id: string; target_id: string; relation_type: string }
        | undefined;
      expect(row).not.toBeUndefined();
      expect(row!.target_id).toBe('spec-b');
      expect(row!.relation_type).toBe('SIMILAR_TO');
    });

    it('supports EVOLVED_FROM relation type', () => {
      seedTwoSpecs();

      insertSpecSpecRelation(db, 'spec-a', 'spec-b', 'EVOLVED_FROM');

      const row = db
        .prepare('SELECT relation_type FROM spec_spec_relations WHERE source_id = ?')
        .get('spec-a') as { relation_type: string } | undefined;
      expect(row!.relation_type).toBe('EVOLVED_FROM');
    });

    it('silently ignores duplicate relations', () => {
      seedTwoSpecs();

      insertSpecSpecRelation(db, 'spec-a', 'spec-b', 'SIMILAR_TO');
      expect(() =>
        insertSpecSpecRelation(db, 'spec-a', 'spec-b', 'SIMILAR_TO')
      ).not.toThrow();

      const rows = db
        .prepare('SELECT COUNT(*) as cnt FROM spec_spec_relations')
        .get() as { cnt: number } | undefined;
      expect(rows!.cnt).toBe(1);
    });
  });

  describe('related specs (via raw query)', () => {
    it('finds specs related to a given spec', () => {
      seedTwoSpecs();
      insertSpecNode(db, makeSpec({ id: 'spec-c', title: 'Spec C' }));

      insertSpecSpecRelation(db, 'spec-a', 'spec-b', 'SIMILAR_TO');
      insertSpecSpecRelation(db, 'spec-a', 'spec-c', 'SIMILAR_TO');

      const rows = db
        .prepare(
          `SELECT s.id, s.title, r.relation_type
           FROM spec_spec_relations r
           JOIN spec_nodes s ON s.id = r.target_id
           WHERE r.source_id = ?
           ORDER BY s.id`
        )
        .all('spec-a') as Array<{ id: string; title: string; relation_type: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id)).toEqual(['spec-b', 'spec-c']);
    });

    it('finds specs by relation type (bidirectional)', () => {
      seedTwoSpecs();

      insertSpecSpecRelation(db, 'spec-a', 'spec-b', 'SIMILAR_TO');

      // Filter by SIMILAR_TO
      const rows = db
        .prepare(
          `SELECT s.id FROM spec_spec_relations r
           JOIN spec_nodes s ON s.id = r.target_id
           WHERE r.source_id = ? AND r.relation_type = ?`
        )
        .all('spec-a', 'SIMILAR_TO') as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('spec-b');
    });

    it('returns empty results when spec has no relations', () => {
      seedTwoSpecs();
      const rows = db
        .prepare('SELECT * FROM spec_spec_relations WHERE source_id = ? OR target_id = ?')
        .all('spec-a', 'spec-a');
      expect(rows).toEqual([]);
    });
  });

  describe('deleteSimilarToRelations', () => {
    it('deletes SIMILAR_TO relations involving a spec (as source or target)', () => {
      seedTwoSpecs();
      insertSpecNode(db, makeSpec({ id: 'spec-c', title: 'Spec C' }));

      insertSpecSpecRelation(db, 'spec-a', 'spec-b', 'SIMILAR_TO');
      insertSpecSpecRelation(db, 'spec-c', 'spec-a', 'SIMILAR_TO');
      insertSpecSpecRelation(db, 'spec-b', 'spec-c', 'EVOLVED_FROM');

      deleteSimilarToRelations(db, 'spec-a');

      const remaining = db
        .prepare('SELECT * FROM spec_spec_relations ORDER BY source_id')
        .all() as Array<{ source_id: string; target_id: string; relation_type: string }>;
      // Only the EVOLVED_FROM relation should remain
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.relation_type).toBe('EVOLVED_FROM');
      expect(remaining[0]!.source_id).toBe('spec-b');
    });

    it('does not throw when spec has no relations', () => {
      seedTwoSpecs();
      expect(() => deleteSimilarToRelations(db, 'spec-a')).not.toThrow();
    });
  });

  describe('delete all relations for a spec (via direct DELETE)', () => {
    it('deletes all spec_commit_relations and spec_spec_relations for a spec', () => {
      seedSpecAndCommit('s-del', 'c-del'.padEnd(40, 'd'));
      insertSpecCommitRelation(db, 's-del', 'c-del'.padEnd(40, 'd'), 'GENERATE');
      insertSpecNode(db, makeSpec({ id: 's-del-2' }));
      insertSpecSpecRelation(db, 's-del', 's-del-2', 'SIMILAR_TO');

      // Delete all relations for 's-del'
      db.prepare('DELETE FROM spec_commit_relations WHERE spec_id = ?').run('s-del');
      db.prepare(
        'DELETE FROM spec_spec_relations WHERE source_id = ? OR target_id = ?'
      ).run('s-del', 's-del');

      const commitRels = findCommitsBySpec(db, 's-del');
      expect(commitRels).toEqual([]);

      const specRels = db
        .prepare(
          'SELECT * FROM spec_spec_relations WHERE source_id = ? OR target_id = ?'
        )
        .all('s-del', 's-del');
      expect(specRels).toEqual([]);
    });
  });
});

// ===========================================================================
// 6. FTS5 Search
// ===========================================================================

describe('FTS (fts.ts)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  describe('segmentCjk', () => {
    it('inserts spaces between CJK characters', () => {
      const result = segmentCjk('用户认证流程');
      expect(result).toBe('用 户 认 证 流 程');
    });

    it('passes through ASCII text unchanged', () => {
      const result = segmentCjk('User Authentication Flow');
      expect(result).toBe('User Authentication Flow');
    });

    it('handles mixed CJK and ASCII text', () => {
      const result = segmentCjk('用户 Login 系统');
      expect(result).toBe('用 户 Login 系 统');
    });

    it('handles empty string', () => {
      const result = segmentCjk('');
      expect(result).toBe('');
    });

    it('handles single CJK character', () => {
      const result = segmentCjk('中');
      expect(result).toBe('中');
    });

    it('handles consecutive CJK runs separated by spaces', () => {
      const result = segmentCjk('用户 认证');
      expect(result).toBe('用 户 认 证');
    });
  });

  describe('escapeFtsQuery', () => {
    it('wraps tokens in double quotes for FTS5', () => {
      const result = escapeFtsQuery('user auth');
      expect(result).toBe('"user" "auth"');
    });

    it('segments CJK and quotes each character', () => {
      const result = escapeFtsQuery('认证');
      expect(result).toBe('"认" "证"');
    });

    it('handles mixed CJK and ASCII', () => {
      const result = escapeFtsQuery('用户 login');
      expect(result).toBe('"用" "户" "login"');
    });

    it('returns empty quoted string for empty input', () => {
      const result = escapeFtsQuery('');
      expect(result).toBe('""');
    });

    it('returns empty quoted string for whitespace-only input', () => {
      const result = escapeFtsQuery('   ');
      expect(result).toBe('""');
    });
  });

  describe('searchSpecs', () => {
    it('returns empty results on an empty database', () => {
      const results = searchSpecs(db, 'anything', 10);
      // Discovery fallback returns empty when the table is empty
      expect(results).toHaveLength(0);
    });

    it('respects the limit parameter', () => {
      // Insert 5 specs
      for (let i = 0; i < 5; i++) {
        insertSpecNode(
          db,
          makeSpec({ id: `spec-limit-${i}`, title: `Searchable Spec ${i}` })
        );
      }

      const results = searchSpecs(db, 'Searchable', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('searches by title (FTS5)', () => {
      insertSpecNode(
        db,
        makeSpec({ id: 'auth-spec', title: 'Authentication Module' })
      );
      insertSpecNode(
        db,
        makeSpec({ id: 'data-spec', title: 'Data Layer' })
      );

      const results = searchSpecs(db, 'Authentication', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const ids = results.map((r) => r.id);
      expect(ids).toContain('auth-spec');
    });

    it('searches by subtitle content', () => {
      insertSpecNode(
        db,
        makeSpec({
          id: 'payment-spec',
          title: 'Payments',
          subtitles: ['## Stripe Integration', '## PayPal Setup'],
        })
      );

      const results = searchSpecs(db, 'Stripe', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.id).toBe('payment-spec');
    });

    it('returns result with correct structure (id, title, subtitles, _score, _method)', () => {
      insertSpecNode(
        db,
        makeSpec({ id: 'struct-spec', title: 'Test Structure', subtitles: ['## Part 1'] })
      );

      const results = searchSpecs(db, 'Test', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const result = results[0]!;

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('subtitles');
      expect(result).toHaveProperty('_score');
      expect(typeof result._score).toBe('number');
      // _method might be 'fts5', 'like', or 'all'
      expect(result).toHaveProperty('_method');
    });

    it('returns all specs (discovery fallback) for empty query', () => {
      insertSpecNode(db, makeSpec({ id: 'd1', title: 'One' }));
      insertSpecNode(db, makeSpec({ id: 'd2', title: 'Two' }));

      const results = searchSpecs(db, '', 10);
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r._method === 'all')).toBe(true);
    });

    it('empty database with empty query returns empty array', () => {
      const results = searchSpecs(db, '', 10);
      expect(results).toEqual([]);
    });

    it('tiered scoring: exact title match scores highest', () => {
      insertSpecNode(
        db,
        makeSpec({ id: 'exact-match', title: 'ExactTitle' })
      );
      // Insert specs with partial matches to ensure exact match is scored highest
      insertSpecNode(
        db,
        makeSpec({ id: 'partial', title: 'ExactTitleSuffix' })
      );

      const results = searchSpecs(db, 'ExactTitle', 10);
      expect(results.length).toBeGreaterThanOrEqual(2);

      // The exact match (if via LIKE) or FTS5 should be scored highest
      const exactResult = results.find((r) => r.id === 'exact-match');
      const partialResult = results.find((r) => r.id === 'partial');

      if (exactResult && partialResult) {
        expect(exactResult._score).toBeGreaterThanOrEqual(partialResult._score);
      }
    });
  });
});

// ===========================================================================
// 7. Code Fragment FTS5 Search (searchCodeFragments)
// ===========================================================================

describe('searchCodeFragments', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  it('returns empty array on empty database', () => {
    const results = searchCodeFragments(db, 'authenticate');
    expect(results).toEqual([]);
  });

  it('returns empty array for empty query', () => {
    insertCodeFragment(db, makeFragment({
      filePath: 'src/auth.ts',
      codeDiff: '@@ -1,5 +1,6 @@\n+function authenticate() {',
    }));

    const results = searchCodeFragments(db, '');
    expect(results).toEqual([]);
  });

  it('finds fragments by function name in code diff', () => {
    const frag1 = insertCodeFragment(db, makeFragment({
      filePath: 'src/auth.ts',
      codeDiff: '@@ -1,5 +1,6 @@\n+function authenticate() {\n+  return true;\n+}',
    }));
    insertCodeFragment(db, makeFragment({
      filePath: 'src/log.ts',
      codeDiff: '@@ -10,5 +10,6 @@\n+function logMessage(msg) {',
    }));

    const results = searchCodeFragments(db, 'authenticate');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results).toContain(frag1.id);
  });

  it('finds fragments by class name in code diff', () => {
    const frag = insertCodeFragment(db, makeFragment({
      filePath: 'src/user.ts',
      codeDiff: '@@ -1,3 +1,10 @@\n+class UserService {\n+  getUser() {}\n+}',
    }));

    const results = searchCodeFragments(db, 'UserService');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results).toContain(frag.id);
  });

  it('inserting a fragment populates code_fragments_fts index', () => {
    const frag = insertCodeFragment(db, makeFragment({
      filePath: 'src/calc.ts',
      codeDiff: '@@ -5,3 +5,7 @@\n+function calculateTotal(items) {',
    }));

    // Verify the FTS index contains the fragment
    const ftsRow = db
      .prepare('SELECT id FROM code_fragments_fts WHERE id = ?')
      .get(frag.id) as { id: string } | undefined;
    expect(ftsRow).toBeDefined();
    expect(ftsRow!.id).toBe(frag.id);
  });

  it('re-inserting a fragment replaces its FTS entry (DELETE + INSERT pattern)', () => {
    // The fragment-node.ts now uses DELETE + INSERT (not INSERT OR REPLACE)
    // which properly replaces the FTS entry without accumulating stale rows.
    const frag = makeFragment({
      filePath: 'src/dup.ts',
      codeDiff: '@@ -1,3 +1,5 @@\n+function handleDuplicate() {}',
    });

    const explicitId = 'deadbeef1234';
    insertCodeFragment(db, { ...frag, id: explicitId });
    insertCodeFragment(db, { ...frag, id: explicitId });

    // After DELETE + INSERT, FTS should have exactly one entry
    const rows = db
      .prepare('SELECT COUNT(*) as cnt FROM code_fragments_fts WHERE id = ?')
      .get(explicitId) as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('returns fragment IDs ordered by FTS5 relevance rank', () => {
    // Fragment with more occurrences of the search term should rank higher
    const frag1 = insertCodeFragment(db, makeFragment({
      filePath: 'src/a.ts',
      codeDiff: '@@ -1,3 +1,3 @@\n+function validatePassword() {}\n+// validatePassword checks input',
    }));
    const frag2 = insertCodeFragment(db, makeFragment({
      filePath: 'src/b.ts',
      codeDiff: '@@ -1,2 +1,2 @@\n+validatePassword(input);\n+',
    }));

    const results = searchCodeFragments(db, 'validatePassword');
    // Both should be found, and frag1 should rank before frag2 (more matches)
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]).toBe(frag1.id);
  });

  it('returns empty array when query does not match any fragment', () => {
    insertCodeFragment(db, makeFragment({
      filePath: 'src/a.ts',
      codeDiff: '@@ -1,3 +1,3 @@\n+function foo() {}',
    }));

    const results = searchCodeFragments(db, 'nonexistent_function');
    expect(results).toEqual([]);
  });
});
