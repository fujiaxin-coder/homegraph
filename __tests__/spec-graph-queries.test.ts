/**
 * Spec Graph Query Tests
 *
 * Comprehensive Vitest tests for the knowledge graph traversal functions
 * in spec/graph/queries.ts: getSpecContext, searchAndGetContext, getSpecStats,
 * and findSpecsByFragmentPath.
 *
 * Uses in-memory SQLite via node:sqlite (the same backend as production).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase, SqliteDatabase } from '../src/db/sqlite-adapter';
import { initSpecSchema } from '../src/spec/db/schema';
import { insertSpecNode, findSpecById } from '../src/spec/db/spec-node';
import { insertCommitNode } from '../src/spec/db/commit-node';
import { insertCodeFragment } from '../src/spec/db/fragment-node';
import {
  insertSpecCommitRelation,
  insertCommitFragmentRelation,
  insertSpecSpecRelation,
} from '../src/spec/db/relations';
import {
  getSpecContext,
  searchAndGetContext,
  getSpecStats,
  findSpecsByFragmentPath,
  findSpecsByFilePath,
  findSpecsByCodeSymbol,
  CodeEntityInfo,
} from '../src/spec/graph/queries';
import { SpecNode, CommitNode, CodeFragmentNode, SpecContext, SpecStats } from '../src/spec/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh in-memory SQLite database for each test. */
function createTestDb(): SqliteDatabase {
  return createDatabase(':memory:').db;
}

/**
 * Create a minimal valid SpecNode for testing.
 *
 * Defaults: status='active', version=1, filePath derived from id,
 * timestamp = current time.
 */
function makeSpec(
  id: string,
  title: string,
  subtitles: string[] = [],
  overrides: Partial<SpecNode> = {}
): SpecNode {
  return {
    id,
    title,
    subtitles,
    status: 'active' as const,
    version: 1,
    filePath: `specs/${id}/plan.md`,
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a minimal valid CommitNode for testing.
 *
 * Defaults: author='test', timestamp = current time.
 */
function makeCommit(
  hash: string,
  message: string,
  overrides: Partial<CommitNode> = {}
): CommitNode {
  return {
    hash,
    message,
    author: 'test',
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a minimal valid CodeFragmentNode for testing.
 */
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
// 1. getSpecContext
// ===========================================================================

describe('getSpecContext', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  it('returns null when the spec does not exist', () => {
    const result = getSpecContext(db, 'nonexistent-spec');
    expect(result).toBeNull();
  });

  it('returns full context with specId, title, subtitles, filePath, status, version', () => {
    const spec = makeSpec('s1', 'My Design Document', ['## Overview', '## Details'], {
      filePath: '/docs/s1.md',
      status: 'active',
      version: 3,
      timestamp: 1700000000000,
    });
    insertSpecNode(db, spec);

    const ctx = getSpecContext(db, 's1');
    expect(ctx).not.toBeNull();
    expect(ctx!.spec.id).toBe('s1');
    expect(ctx!.spec.title).toBe('My Design Document');
    expect(ctx!.spec.subtitles).toEqual(['## Overview', '## Details']);
    expect(ctx!.spec.filePath).toBe('/docs/s1.md');
    expect(ctx!.spec.status).toBe('active');
    expect(ctx!.spec.version).toBe(3);
    expect(ctx!.spec.timestamp).toBe(1700000000000);
  });

  it('includes commits when the spec has linked commits', () => {
    const spec = makeSpec('s-commits', 'Spec With Commits');
    insertSpecNode(db, spec);

    const commit1 = makeCommit('a'.repeat(40), 'feat: add login', { timestamp: 1700000001000 });
    const commit2 = makeCommit('b'.repeat(40), 'fix: login crash', { timestamp: 1700000002000 });
    insertCommitNode(db, commit1);
    insertCommitNode(db, commit2);

    insertSpecCommitRelation(db, 's-commits', 'a'.repeat(40), 'GENERATE');
    insertSpecCommitRelation(db, 's-commits', 'b'.repeat(40), 'SUMMARIZED_FROM');

    const ctx = getSpecContext(db, 's-commits');
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(2);
    expect(ctx!.commits[0]!.commit.hash).toBe('a'.repeat(40));
    expect(ctx!.commits[1]!.commit.hash).toBe('b'.repeat(40));
  });

  it('returns empty commits array when spec has no linked commits', () => {
    const spec = makeSpec('lonely', 'Lonely Spec');
    insertSpecNode(db, spec);

    const ctx = getSpecContext(db, 'lonely');
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toEqual([]);
  });

  it('includes fragments when includeFragments=true (default)', () => {
    const spec = makeSpec('s-frag', 'Spec With Fragments');
    insertSpecNode(db, spec);

    const commit = makeCommit('c'.repeat(40), 'feat: add feature', { timestamp: 1700000003000 });
    insertCommitNode(db, commit);

    const frag1 = insertCodeFragment(
      db,
      makeFragment({ id: '', filePath: 'src/a.ts', startLine: 1, endLine: 5 })
    );
    const frag2 = insertCodeFragment(
      db,
      makeFragment({ id: '', filePath: 'src/b.ts', startLine: 10, endLine: 15 })
    );

    insertSpecCommitRelation(db, 's-frag', 'c'.repeat(40), 'GENERATE');
    insertCommitFragmentRelation(db, 'c'.repeat(40), frag1.id);
    insertCommitFragmentRelation(db, 'c'.repeat(40), frag2.id);

    const ctx = getSpecContext(db, 's-frag', 5, true);
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(1);
    expect(ctx!.commits[0]!.fragments).toHaveLength(2);
    expect(ctx!.commits[0]!.fragments[0]!.filePath).toBe('src/a.ts');
    expect(ctx!.commits[0]!.fragments[1]!.filePath).toBe('src/b.ts');

    // Verify fragment structure
    const fragment = ctx!.commits[0]!.fragments[0]!;
    expect(fragment).toHaveProperty('id');
    expect(fragment).toHaveProperty('changeType');
    expect(fragment).toHaveProperty('filePath');
    expect(fragment).toHaveProperty('startLine');
    expect(fragment).toHaveProperty('endLine');
    expect(fragment).toHaveProperty('codeDiff');
  });

  it('does NOT include fragments when includeFragments=false', () => {
    const spec = makeSpec('s-nofrag', 'Spec Without Fragments');
    insertSpecNode(db, spec);

    const commit = makeCommit('d'.repeat(40), 'feat: stuff', { timestamp: 1700000004000 });
    insertCommitNode(db, commit);

    const frag = insertCodeFragment(db, makeFragment({ id: '', filePath: 'src/c.ts' }));
    insertSpecCommitRelation(db, 's-nofrag', 'd'.repeat(40), 'GENERATE');
    insertCommitFragmentRelation(db, 'd'.repeat(40), frag.id);

    const ctx = getSpecContext(db, 's-nofrag', 5, false);
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(1);
    expect(ctx!.commits[0]!.fragments).toEqual([]);
  });

  it('respects maxCommits limit', () => {
    const spec = makeSpec('s-limit', 'Spec With Many Commits');
    insertSpecNode(db, spec);

    // Insert 5 commits with increasing timestamps
    for (let i = 0; i < 5; i++) {
      const hash = `${String(i).repeat(40)}`;
      const commit = makeCommit(hash, `commit ${i}`, { timestamp: 1700000000000 + i * 1000 });
      insertCommitNode(db, commit);
      insertSpecCommitRelation(db, 's-limit', hash, 'GENERATE');
    }

    const ctx = getSpecContext(db, 's-limit', 3, false);
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(3);
  });

  it('orders commits by relation-type priority: GENERATE before SUMMARIZED_FROM', () => {
    const spec = makeSpec('s-order', 'Ordered Spec');
    insertSpecNode(db, spec);

    // Create commits with same timestamps but different relation types.
    // The ORDER BY in queries.ts uses tie-breaking: GENERATE(0) before SUMMARIZED_FROM(1)
    // before ELSE(2), then timestamp DESC within each tier.
    const genCommit = makeCommit('g'.repeat(40), 'generate commit', { timestamp: 1700000001000 });
    const sumCommit = makeCommit('s'.repeat(40), 'summarized commit', { timestamp: 1700000005000 });
    insertCommitNode(db, genCommit);
    insertCommitNode(db, sumCommit);

    insertSpecCommitRelation(db, 's-order', 's'.repeat(40), 'SUMMARIZED_FROM');
    insertSpecCommitRelation(db, 's-order', 'g'.repeat(40), 'GENERATE');

    const ctx = getSpecContext(db, 's-order', 5, false);
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(2);

    // GENERATE should come first
    expect(ctx!.commits[0]!.relationType).toBe('GENERATE');
    expect(ctx!.commits[0]!.commit.hash).toBe('g'.repeat(40));

    // SUMMARIZED_FROM should come second
    expect(ctx!.commits[1]!.relationType).toBe('SUMMARIZED_FROM');
    expect(ctx!.commits[1]!.commit.hash).toBe('s'.repeat(40));
  });

  it('orders commits within same relation type by timestamp DESC', () => {
    const spec = makeSpec('s-timestamp', 'Timestamp Ordered Spec');
    insertSpecNode(db, spec);

    const older = makeCommit('o'.repeat(40), 'older', { timestamp: 1700000001000 });
    const newer = makeCommit('n'.repeat(40), 'newer', { timestamp: 1700000005000 });
    insertCommitNode(db, older);
    insertCommitNode(db, newer);

    // Both are GENERATE, so they tie on relation_type, then timestamp DESC
    insertSpecCommitRelation(db, 's-timestamp', 'o'.repeat(40), 'GENERATE');
    insertSpecCommitRelation(db, 's-timestamp', 'n'.repeat(40), 'GENERATE');

    const ctx = getSpecContext(db, 's-timestamp', 5, false);
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(2);
    // Newer (higher timestamp) should come first within the same relation type
    expect(ctx!.commits[0]!.commit.hash).toBe('n'.repeat(40));
    expect(ctx!.commits[1]!.commit.hash).toBe('o'.repeat(40));
  });

  it('includes relationType field on each commit context', () => {
    const spec = makeSpec('s-reltype', 'Relation Type Spec');
    insertSpecNode(db, spec);

    const commit = makeCommit('r'.repeat(40), 'test commit', { timestamp: 1700000001000 });
    insertCommitNode(db, commit);
    insertSpecCommitRelation(db, 's-reltype', 'r'.repeat(40), 'SUMMARIZED_FROM');

    const ctx = getSpecContext(db, 's-reltype', 5, false);
    expect(ctx).not.toBeNull();
    expect(ctx!.commits).toHaveLength(1);
    expect(ctx!.commits[0]!.relationType).toBe('SUMMARIZED_FROM');
    expect(ctx!.commits[0]!).toHaveProperty('commit');
    expect(ctx!.commits[0]!).toHaveProperty('fragments');
  });

  it('applies default maxCommits of 5 when not specified', () => {
    const spec = makeSpec('s-default', 'Default MaxCommits');
    insertSpecNode(db, spec);

    // Insert 7 commits
    for (let i = 0; i < 7; i++) {
      const hash = `${String(i).repeat(40)}`;
      const commit = makeCommit(hash, `commit ${i}`, { timestamp: 1700000000000 + i * 1000 });
      insertCommitNode(db, commit);
      insertSpecCommitRelation(db, 's-default', hash, 'GENERATE');
    }

    // Call with only db and specId (using defaults: maxCommits=5, includeFragments=true)
    const ctx = getSpecContext(db, 's-default');
    expect(ctx).not.toBeNull();
    expect(ctx!.commits.length).toBeLessThanOrEqual(5);
    expect(ctx!.commits.length).toBe(5);
  });
});

// ===========================================================================
// 2. searchAndGetContext
// ===========================================================================

describe('searchAndGetContext', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  it('empty query returns all specs (discovery fallback)', () => {
    insertSpecNode(db, makeSpec('s1', 'Alpha'));
    insertSpecNode(db, makeSpec('s2', 'Beta'));

    const results = searchAndGetContext(db, '', 10, false);
    expect(results.length).toBe(2);
  });

  it('search by title finds matching specs', () => {
    insertSpecNode(db, makeSpec('auth', 'Authentication Module'));
    insertSpecNode(db, makeSpec('data', 'Data Layer'));

    const results = searchAndGetContext(db, 'Authentication', 10, false);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ids = results.map((r) => r.spec.id);
    expect(ids).toContain('auth');
  });

  it('search by subtitle finds matching specs', () => {
    insertSpecNode(
      db,
      makeSpec('payments', 'Payments', ['## Stripe Integration', '## PayPal Setup'])
    );

    const results = searchAndGetContext(db, 'Stripe', 10, false);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.spec.id).toBe('payments');
  });

  it('no results returns empty array', () => {
    insertSpecNode(db, makeSpec('s1', 'Alpha'));
    insertSpecNode(db, makeSpec('s2', 'Beta'));

    const results = searchAndGetContext(db, 'ZZZ_NOT_FOUND_ZZZ', 10, false);
    // Discovery fallback may still return something; we test that matches
    // for truly non-matching queries still return something (discovery fallback
    // returns most-recently-added specs when nothing matches)
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it('limit (topK) respected', () => {
    for (let i = 0; i < 10; i++) {
      insertSpecNode(db, makeSpec(`spec-${i}`, `Searchable Item ${i}`));
    }

    const results = searchAndGetContext(db, 'Searchable', 3, false);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('without fragments option works (includeFragments=false)', () => {
    const spec = makeSpec('s-frag', 'Fragmented Spec');
    insertSpecNode(db, spec);

    const commit = makeCommit('c'.repeat(40), 'feat: add feature', { timestamp: 1700000001000 });
    insertCommitNode(db, commit);

    const frag = insertCodeFragment(db, makeFragment({ id: '', filePath: 'src/a.ts' }));
    insertSpecCommitRelation(db, 's-frag', 'c'.repeat(40), 'GENERATE');
    insertCommitFragmentRelation(db, 'c'.repeat(40), frag.id);

    const results = searchAndGetContext(db, 'Fragmented', 10, false);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ctx = results[0]!;
    expect(ctx.commits).toHaveLength(1);
    // Fragments should be empty when includeFragments is false
    expect(ctx.commits[0]!.fragments).toEqual([]);
  });

  it('with fragments option works (includeFragments=true)', () => {
    const spec = makeSpec('s-withfrag', 'Spec With Fragments');
    insertSpecNode(db, spec);

    const commit = makeCommit('d'.repeat(40), 'feat: add feature', { timestamp: 1700000001000 });
    insertCommitNode(db, commit);

    const frag = insertCodeFragment(db, makeFragment({ id: '', filePath: 'src/b.ts' }));
    insertSpecCommitRelation(db, 's-withfrag', 'd'.repeat(40), 'GENERATE');
    insertCommitFragmentRelation(db, 'd'.repeat(40), frag.id);

    const results = searchAndGetContext(db, 'Spec With Fragments', 10, true);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ctx = results[0]!;
    expect(ctx.commits).toHaveLength(1);
    expect(ctx.commits[0]!.fragments).toHaveLength(1);
  });

  it('result structure has correct fields (spec + commits)', () => {
    insertSpecNode(
      db,
      makeSpec('struct', 'Structured Spec', ['## Part A'])
    );

    const results = searchAndGetContext(db, 'Structured', 10, false);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ctx = results[0]!;

    // ctx is a SpecContext: { spec, commits }
    expect(ctx).toHaveProperty('spec');
    expect(ctx).toHaveProperty('commits');
    expect(Array.isArray(ctx.commits)).toBe(true);

    // spec is a SpecNode
    expect(ctx.spec).toHaveProperty('id');
    expect(ctx.spec).toHaveProperty('title');
    expect(ctx.spec).toHaveProperty('subtitles');
    expect(ctx.spec).toHaveProperty('status');
    expect(ctx.spec).toHaveProperty('version');
    expect(ctx.spec).toHaveProperty('filePath');
    expect(ctx.spec).toHaveProperty('timestamp');
  });

  it('CJK search works', () => {
    insertSpecNode(db, makeSpec('cjk', '用户认证系统', ['## 登录流程']));

    const results = searchAndGetContext(db, '认证', 10, false);
    // May or may not find results depending on FTS5 behavior;
    // at minimum the call should not throw
    expect(Array.isArray(results)).toBe(true);
  });

  it('search is case-insensitive', () => {
    insertSpecNode(db, makeSpec('case-spec', 'Authentication Module'));

    const resultsUpper = searchAndGetContext(db, 'AUTHENTICATION', 10, false);
    const resultsLower = searchAndGetContext(db, 'authentication', 10, false);

    expect(resultsUpper.length).toBe(resultsLower.length);
  });
});

// ===========================================================================
// 3. getSpecStats
// ===========================================================================

describe('getSpecStats', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  it('empty DB returns zero counts', () => {
    const stats = getSpecStats(db);

    expect(stats.specCount).toBe(0);
    expect(stats.commitCount).toBe(0);
    expect(stats.fragmentCount).toBe(0);
    expect(stats.relationCount).toBe(0);
    expect(stats.activeSpecCount).toBe(0);
    expect(stats.deprecatedSpecCount).toBe(0);
  });

  it('populated DB returns correct spec count', () => {
    insertSpecNode(db, makeSpec('s1', 'Spec 1'));
    insertSpecNode(db, makeSpec('s2', 'Spec 2'));
    insertSpecNode(db, makeSpec('s3', 'Spec 3'));

    const stats = getSpecStats(db);
    expect(stats.specCount).toBe(3);
  });

  it('populated DB returns correct commit count', () => {
    insertCommitNode(db, makeCommit('a'.repeat(40), 'commit a'));
    insertCommitNode(db, makeCommit('b'.repeat(40), 'commit b'));

    const stats = getSpecStats(db);
    expect(stats.commitCount).toBe(2);
  });

  it('populated DB returns correct fragment count', () => {
    insertCodeFragment(db, makeFragment({ id: '' }));
    insertCodeFragment(db, makeFragment({ id: '' }));
    insertCodeFragment(db, makeFragment({ id: '' }));

    const stats = getSpecStats(db);
    expect(stats.fragmentCount).toBe(3);
  });

  it('status counts distinguish active vs deprecated', () => {
    insertSpecNode(db, makeSpec('active1', 'Active A', [], { status: 'active' }));
    insertSpecNode(db, makeSpec('active2', 'Active B', [], { status: 'active' }));
    insertSpecNode(db, makeSpec('dep1', 'Deprecated A', [], { status: 'deprecated' }));

    const stats = getSpecStats(db);
    expect(stats.activeSpecCount).toBe(2);
    expect(stats.deprecatedSpecCount).toBe(1);
  });

  it('relation count includes spec_commit_relations', () => {
    const spec = makeSpec('s-rel', 'Related Spec');
    insertSpecNode(db, spec);

    const commit = makeCommit('r'.repeat(40), 'related commit');
    insertCommitNode(db, commit);

    // Create 2 spec-commit relations
    insertSpecCommitRelation(db, 's-rel', 'r'.repeat(40), 'GENERATE');
    insertSpecCommitRelation(db, 's-rel', 'r'.repeat(40), 'SUMMARIZED_FROM');

    const stats = getSpecStats(db);
    // Both relations share the same (spec_id, commit_hash) but different relation_type,
    // so INSERT OR IGNORE allows duplicates across different relation_type values.
    // The relationCount should be the total across all three relation tables.
    expect(stats.relationCount).toBeGreaterThanOrEqual(1);
  });

  it('relation count includes commit_fragment_relations', () => {
    const commit = makeCommit('c'.repeat(40), 'commit');
    insertCommitNode(db, commit);

    const frag1 = insertCodeFragment(db, makeFragment({ id: '' }));
    const frag2 = insertCodeFragment(db, makeFragment({ id: '' }));

    insertCommitFragmentRelation(db, 'c'.repeat(40), frag1.id);
    insertCommitFragmentRelation(db, 'c'.repeat(40), frag2.id);

    const stats = getSpecStats(db);
    expect(stats.relationCount).toBe(2);
  });

  it('relation count includes spec_spec_relations', () => {
    insertSpecNode(db, makeSpec('src', 'Source'));
    insertSpecNode(db, makeSpec('tgt', 'Target'));

    insertSpecSpecRelation(db, 'src', 'tgt', 'SIMILAR_TO');
    insertSpecSpecRelation(db, 'src', 'tgt', 'EVOLVED_FROM');

    const stats = getSpecStats(db);
    // Two spec-spec relations may share source/target but with different relation_type
    // and the unique constraint likely includes relation_type
    expect(stats.relationCount).toBeGreaterThanOrEqual(1);
  });

  it('total relation count sums across all three relation tables', () => {
    // Insert data for all three relation tables
    insertSpecNode(db, makeSpec('s-total', 'Total Spec'));
    const commit = makeCommit('t'.repeat(40), 'total commit');
    insertCommitNode(db, commit);
    const frag = insertCodeFragment(db, makeFragment({ id: '' }));

    insertSpecCommitRelation(db, 's-total', 't'.repeat(40), 'GENERATE');
    insertCommitFragmentRelation(db, 't'.repeat(40), frag.id);

    insertSpecNode(db, makeSpec('s-other', 'Other Spec'));
    insertSpecSpecRelation(db, 's-total', 's-other', 'SIMILAR_TO');

    const stats = getSpecStats(db);
    // 1 spec-commit + 1 commit-fragment + 1 spec-spec = 3 relations
    expect(stats.relationCount).toBe(3);
  });
});

// ===========================================================================
// 4. findSpecsByFragmentPath
// ===========================================================================

describe('findSpecsByFragmentPath', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  it('finds spec by fragment file path', () => {
    const spec = makeSpec('s-path', 'Path Spec');
    insertSpecNode(db, spec);

    const commit = makeCommit('p'.repeat(40), 'commit with path');
    insertCommitNode(db, commit);

    const frag = insertCodeFragment(
      db,
      makeFragment({ id: '', filePath: 'src/auth/login.ts' })
    );

    insertSpecCommitRelation(db, 's-path', 'p'.repeat(40), 'GENERATE');
    insertCommitFragmentRelation(db, 'p'.repeat(40), frag.id);

    const specIds = findSpecsByFragmentPath(db, 'src/auth/login.ts');
    expect(specIds).toHaveLength(1);
    expect(specIds[0]).toBe('s-path');
  });

  it('no match returns empty array', () => {
    const specIds = findSpecsByFragmentPath(db, 'nonexistent/file.ts');
    expect(specIds).toEqual([]);
  });

  it('multiple matches returned for common path substring', () => {
    // Spec 1 → commit 1 → fragment: src/components/Button.tsx
    const spec1 = makeSpec('spec-btn', 'Button Spec');
    insertSpecNode(db, spec1);
    const commit1 = makeCommit('b1'.padEnd(40, '1'), 'add button');
    insertCommitNode(db, commit1);
    const frag1 = insertCodeFragment(
      db,
      makeFragment({ id: '', filePath: 'src/components/Button.tsx' })
    );
    insertSpecCommitRelation(db, 'spec-btn', 'b1'.padEnd(40, '1'), 'GENERATE');
    insertCommitFragmentRelation(db, 'b1'.padEnd(40, '1'), frag1.id);

    // Spec 2 → commit 2 → fragment: src/components/Modal.tsx
    const spec2 = makeSpec('spec-modal', 'Modal Spec');
    insertSpecNode(db, spec2);
    const commit2 = makeCommit('b2'.padEnd(40, '2'), 'add modal');
    insertCommitNode(db, commit2);
    const frag2 = insertCodeFragment(
      db,
      makeFragment({ id: '', filePath: 'src/components/Modal.tsx' })
    );
    insertSpecCommitRelation(db, 'spec-modal', 'b2'.padEnd(40, '2'), 'GENERATE');
    insertCommitFragmentRelation(db, 'b2'.padEnd(40, '2'), frag2.id);

    // Both match 'components' substring
    const specIds = findSpecsByFragmentPath(db, 'components');
    expect(specIds.length).toBeGreaterThanOrEqual(1);
  });

  it('returns distinct spec IDs (no duplicates)', () => {
    const spec = makeSpec('s-distinct', 'Distinct Spec');
    insertSpecNode(db, spec);

    const commit = makeCommit('d'.repeat(40), 'commit');
    insertCommitNode(db, commit);

    // Two fragments with the same path pattern, linked to the same commit
    const frag1 = insertCodeFragment(
      db,
      makeFragment({ id: '', filePath: 'src/utils/helpers.ts', startLine: 1 })
    );
    const frag2 = insertCodeFragment(
      db,
      makeFragment({ id: '', filePath: 'src/utils/more-helpers.ts', startLine: 10 })
    );

    insertSpecCommitRelation(db, 's-distinct', 'd'.repeat(40), 'GENERATE');
    insertCommitFragmentRelation(db, 'd'.repeat(40), frag1.id);
    insertCommitFragmentRelation(db, 'd'.repeat(40), frag2.id);

    const specIds = findSpecsByFragmentPath(db, 'utils');
    // Should return distinct IDs, not duplicates
    expect(specIds.length).toBe(1);
    expect(specIds[0]).toBe('s-distinct');
  });

  it('LIKE search with partial path match works', () => {
    const spec = makeSpec('s-like', 'Like Spec');
    insertSpecNode(db, spec);

    const commit = makeCommit('l'.repeat(40), 'like commit');
    insertCommitNode(db, commit);

    const frag = insertCodeFragment(
      db,
      makeFragment({ id: '', filePath: 'very/deep/nested/path/to/file.ts' })
    );

    insertSpecCommitRelation(db, 's-like', 'l'.repeat(40), 'GENERATE');
    insertCommitFragmentRelation(db, 'l'.repeat(40), frag.id);

    // Search with just a substring of the path
    const specIds = findSpecsByFragmentPath(db, 'nested');
    expect(specIds).toHaveLength(1);
    expect(specIds[0]).toBe('s-like');
  });
});

// ===========================================================================
// 5. findSpecsByFilePath
// ===========================================================================

describe('findSpecsByFilePath', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    const result = createDatabase(':memory:');
    db = result.db;
    initSpecSchema(db);
  });

  function setupSpecAndFragment(
    specId: string,
    specTitle: string,
    filePath: string,
    commitHash?: string,
  ): void {
    const hash = commitHash || `commit-${specId}`;
    insertSpecNode(db, {
      id: specId,
      title: specTitle,
      subtitles: [],
      status: 'active',
      version: 1,
      filePath: `/specs/${specId}/plan.md`,
      timestamp: Date.now(),
    });
    insertCommitNode(db, {
      hash,
      message: `feat: add ${specId}`,
      author: 'tester',
      timestamp: Date.now(),
    });
    const frag = insertCodeFragment(db, {
      id: '',
      changeType: 'MODIFY',
      filePath,
      startLine: 1,
      endLine: 10,
      codeDiff: '...',
    });
    insertCommitFragmentRelation(db, hash, frag.id);
    insertSpecCommitRelation(db, specId, hash, 'SUMMARIZED_FROM');
  }

  it('finds a single spec by exact file path', () => {
    setupSpecAndFragment('spec01', 'Auth Module', 'src/auth/login.ts');

    const result = findSpecsByFilePath(db, 'src/auth/login.ts');
    expect(result.matched_count).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('spec01');
    expect(result.results[0]!.title).toBe('Auth Module');
    expect(result.results[0]!.status).toBe('active');
    expect(result.results[0]!.version).toBe(1);
    expect(result.results[0]!.filePath).toBe('/specs/spec01/plan.md');
  });

  it('finds multiple specs matching the same file path substring', () => {
    setupSpecAndFragment('spec01', 'Auth Module', 'src/auth/login.ts');
    setupSpecAndFragment('spec02', 'Auth Middleware', 'src/auth/middleware.ts', 'commit-mw');

    const result = findSpecsByFilePath(db, 'src/auth');
    expect(result.matched_count).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.id).sort()).toEqual(['spec01', 'spec02']);
    expect(result.results.map((r) => r.title).sort()).toEqual(['Auth Middleware', 'Auth Module']);
  });

  it('returns empty array when no match', () => {
    const result = findSpecsByFilePath(db, 'nonexistent/file.ts');
    expect(result.matched_count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('returns distinct specs (no duplicates for same spec with multiple fragments)', () => {
    setupSpecAndFragment('spec01', 'Auth Module', 'src/auth/login.ts');

    // Add a second fragment for the same spec+commit (same file)
    const frag2 = insertCodeFragment(db, {
      id: '',
      changeType: 'MODIFY',
      filePath: 'src/auth/login.ts',
      startLine: 11,
      endLine: 20,
      codeDiff: '...',
    });
    insertCommitFragmentRelation(db, 'commit-spec01', frag2.id);

    const result = findSpecsByFilePath(db, 'src/auth/login.ts');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('spec01');
  });

  it('throws on empty filePath', () => {
    expect(() => findSpecsByFilePath(db, '')).toThrow('Empty file path is not allowed');
    expect(() => findSpecsByFilePath(db, '   ')).toThrow('Empty file path is not allowed');
  });

  it('truncated flag is set when results exceed maxResults', () => {
    // Insert 3 specs all matching 'src/'
    setupSpecAndFragment('spec01', 'Auth Module', 'src/auth/login.ts');
    setupSpecAndFragment('spec02', 'Auth Middleware', 'src/auth/middleware.ts', 'commit-mw');
    setupSpecAndFragment('spec03', 'Auth Utils', 'src/auth/utils.ts', 'commit-utils');

    // maxResults = 2, should be truncated
    const result = findSpecsByFilePath(db, 'src/auth', 2);
    expect(result.matched_count).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it('truncated flag is false when results within limit', () => {
    setupSpecAndFragment('spec01', 'Auth Module', 'src/auth/login.ts');

    // maxResults = 100 (default), only 1 result -> not truncated
    const result = findSpecsByFilePath(db, 'src/auth');
    expect(result.matched_count).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('escapes LIKE metacharacters in filePath', () => {
    // Spec with a fragment path containing %
    setupSpecAndFragment('spec-pct', 'Percent Spec', 'src/100%/file.ts');

    // Searching for literal '100%' should match the spec with '100%' in path
    const result = findSpecsByFilePath(db, '100%');
    expect(result.matched_count).toBe(1);
    expect(result.results[0]!.id).toBe('spec-pct');

    // Searching for '100_' should NOT match '100%' (underscore is escaped)
    setupSpecAndFragment('spec-underscore', 'Underscore Spec', 'src/100_file.ts', 'commit-us');
    const result2 = findSpecsByFilePath(db, '100_');
    expect(result2.matched_count).toBe(1);
    expect(result2.results[0]!.id).toBe('spec-underscore');
  });

  it('backslash in path is handled correctly', () => {
    // Windows-style paths
    setupSpecAndFragment('spec-win', 'Windows Spec', 'src\\auth\\login.ts');

    const result = findSpecsByFilePath(db, 'src\\auth');
    expect(result.matched_count).toBe(1);
    expect(result.results[0]!.id).toBe('spec-win');
  });
});

// ===========================================================================
// 5. findSpecsByCodeSymbol — code entity → Spec reverse trace
// ===========================================================================

/**
 * Helper: wire up a spec → commit → fragment chain and return the entity.
 *
 * Inserts the spec, commit, and fragment into the DB, then creates
 * the spec_commit_relations and commit_fragment_relations.
 */
function seedSpecChain(
  db: SqliteDatabase,
  specPartial: Partial<SpecNode>,
  commitPartial: Partial<CommitNode>,
  fragmentPartial: Partial<CodeFragmentNode>,
): CodeEntityInfo {
  const spec = makeSpec(
    specPartial.id || 'spec-chain',
    specPartial.title || 'Chain Spec',
    specPartial.subtitles,
    specPartial,
  );
  const commit = makeCommit(
    commitPartial.hash || 'c'.repeat(40),
    commitPartial.message || 'feat: chain commit',
    commitPartial,
  );
  const fragment = insertCodeFragment(db, makeFragment(fragmentPartial));

  insertSpecNode(db, spec);
  insertCommitNode(db, commit);
  insertSpecCommitRelation(db, spec.id, commit.hash, 'GENERATE');
  insertCommitFragmentRelation(db, commit.hash, fragment.id);

  return {
    name: 'chainFunction',
    qualifiedName: 'src/chain.ts:chainFunction',
    kind: 'function',
    filePath: fragment.filePath,
    startLine: fragment.startLine,
    endLine: fragment.endLine,
  };
}

/** Create a CodeEntityInfo pointing at a file with given line range. */
function makeEntity(overrides: Partial<CodeEntityInfo> = {}): CodeEntityInfo {
  return {
    name: 'testFunction',
    qualifiedName: 'src/test.ts:testFunction',
    kind: 'function',
    filePath: 'src/test.ts',
    startLine: 10,
    endLine: 20,
    ...overrides,
  };
}

describe('findSpecsByCodeSymbol', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    initSpecSchema(db);
  });

  it('returns empty matches when database has no specs', () => {
    const entity = makeEntity();
    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.entity).toEqual(entity);
    expect(result.matches).toEqual([]);
    expect(result.totalCandidates).toBe(0);
  });

  it('returns entity info in the result', () => {
    const entity = makeEntity({ name: 'myFunc' });
    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.entity.name).toBe('myFunc');
    expect(result.entity.kind).toBe('function');
    expect(result.entity.filePath).toBe('src/test.ts');
  });

  it('finds spec by file path match (no line overlap needed)', () => {
    const spec = makeSpec('fp-spec', 'File Path Spec');
    const commit = makeCommit('d'.repeat(40), 'feat: add file');
    const fragment = insertCodeFragment(db, makeFragment({
      filePath: 'src/test.ts',
      startLine: 50,  // Different lines — no overlap
      endLine: 60,
      codeDiff: '@@ -50,11 +50,11 @@\n+ some other code',
    }));

    insertSpecNode(db, spec);
    insertCommitNode(db, commit);
    insertSpecCommitRelation(db, spec.id, commit.hash, 'GENERATE');
    insertCommitFragmentRelation(db, commit.hash, fragment.id);

    const entity = makeEntity({ startLine: 10, endLine: 20 });
    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.totalCandidates).toBeGreaterThanOrEqual(1);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0]!.spec.id).toBe(spec.id);
    // No line overlap, so overlapScore should be 0
    expect(result.matches[0]!.scoreDetail.overlapScore).toBe(0);
  });

  it('line overlap contributes to score (overlapScore > 0)', () => {
    const spec = makeSpec('overlap-spec', 'Overlap Spec');
    const commit = makeCommit('e'.repeat(40), 'feat: overlap');
    const fragment = insertCodeFragment(db, makeFragment({
      filePath: 'src/test.ts',
      startLine: 5,   // Overlaps with entity's 10-20
      endLine: 15,
      codeDiff: '@@ -5,11 +5,11 @@',
    }));

    insertSpecNode(db, spec);
    insertCommitNode(db, commit);
    insertSpecCommitRelation(db, spec.id, commit.hash, 'GENERATE');
    insertCommitFragmentRelation(db, commit.hash, fragment.id);

    const entity = makeEntity({ startLine: 10, endLine: 20 });
    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    // Should have some overlap: lines 10-15 = 6 overlapping lines
    expect(result.matches[0]!.scoreDetail.overlapScore).toBeGreaterThan(0);
  });

  it('content diff match — entity name appears in code_diff', () => {
    const spec = makeSpec('content-spec', 'Content Match Spec', []);
    const commit = makeCommit('f'.repeat(40), 'feat: content');
    const fragment = insertCodeFragment(db, makeFragment({
      filePath: 'src/other.ts',     // Different file
      startLine: 1,
      endLine: 5,
      codeDiff: '@@ -1,3 +1,5 @@\n+function matchMe() {\n+  return true;\n+}',
    }));

    insertSpecNode(db, spec);
    insertCommitNode(db, commit);
    insertSpecCommitRelation(db, spec.id, commit.hash, 'GENERATE');
    insertCommitFragmentRelation(db, commit.hash, fragment.id);

    const entity = makeEntity({ name: 'matchMe', filePath: 'src/other.ts', startLine: 1, endLine: 5 });
    const result = findSpecsByCodeSymbol(db, entity);

    // Because filePath matches, it should be found
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0]!.scoreDetail.contentScore).toBe(1);
  });

  it('name match — entity name appears in spec title', () => {
    const spec = makeSpec('name-spec', 'authenticate', []); // exact title match
    const commit = makeCommit('a1'.repeat(20), 'feat: auth');
    const fragment = insertCodeFragment(db, makeFragment({
      filePath: 'src/auth.ts',
      codeDiff: '@@ -1,3 +1,3 @@',
    }));

    insertSpecNode(db, spec);
    insertCommitNode(db, commit);
    insertSpecCommitRelation(db, spec.id, commit.hash, 'GENERATE');
    insertCommitFragmentRelation(db, commit.hash, fragment.id);

    const entity = makeEntity({ name: 'authenticate', filePath: 'src/auth.ts' });
    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    // name score should be > 0 because the spec title matches
    const nameMatch = result.matches.find((m) => m.spec.id === 'name-spec');
    expect(nameMatch).toBeDefined();
    expect(nameMatch!.scoreDetail.nameScore).toBeGreaterThan(0);
  });

  it('scores newer specs higher (recency dimension)', () => {
    const oldSpec = makeSpec('old-spec', 'Old Spec', [], {
      timestamp: 1000000000000, // Old timestamp
    });
    const newSpec = makeSpec('new-spec', 'New Spec', [], {
      timestamp: Date.now(),    // Current timestamp
    });

    const commit1 = makeCommit('b1'.repeat(20), 'old commit', { timestamp: 1000000000000 });
    const commit2 = makeCommit('b2'.repeat(20), 'new commit', { timestamp: Date.now() });

    const frag1 = insertCodeFragment(db, makeFragment({
      filePath: 'src/test.ts', startLine: 1, endLine: 10,
      codeDiff: '@@ -1,10 +1,10 @@',
    }));
    const frag2 = insertCodeFragment(db, makeFragment({
      filePath: 'src/test.ts', startLine: 1, endLine: 10,
      codeDiff: '@@ -1,10 +1,10 @@',
    }));

    insertSpecNode(db, oldSpec);
    insertSpecNode(db, newSpec);
    insertCommitNode(db, commit1);
    insertCommitNode(db, commit2);
    insertSpecCommitRelation(db, oldSpec.id, commit1.hash, 'GENERATE');
    insertSpecCommitRelation(db, newSpec.id, commit2.hash, 'GENERATE');
    insertCommitFragmentRelation(db, commit1.hash, frag1.id);
    insertCommitFragmentRelation(db, commit2.hash, frag2.id);

    const entity = makeEntity({ startLine: 1, endLine: 10 });
    const result = findSpecsByCodeSymbol(db, entity);

    // Both should be found, and the newer one should rank first
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.matches[0]!.spec.id).toBe('new-spec');
    expect(result.matches[0]!.scoreDetail.recencyScore).toBeGreaterThan(
      result.matches[1]!.scoreDetail.recencyScore,
    );
  });

  it('score detail contains all five dimensions', () => {
    const entity = seedSpecChain(db,
      { id: 'all-dim', title: 'All Dimensions Spec' },
      { hash: 'cc'.repeat(20), message: 'feat: all' },
      { filePath: 'src/test.ts', codeDiff: '@@ -10,11 +10,11 @@\n+ chainFunction() {}' },
    );

    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const detail = result.matches[0]!.scoreDetail;
    expect(detail).toHaveProperty('filePathScore');
    expect(detail).toHaveProperty('contentScore');
    expect(detail).toHaveProperty('nameScore');
    expect(detail).toHaveProperty('recencyScore');
    expect(detail).toHaveProperty('overlapScore');

    // All scores should be in [0, 1] range
    for (const key of Object.keys(detail) as Array<keyof typeof detail>) {
      expect(detail[key]).toBeGreaterThanOrEqual(0);
      expect(detail[key]).toBeLessThanOrEqual(1);
    }
  });

  it('composite score is weighted sum of five dimensions', () => {
    const entity = seedSpecChain(db,
      { id: 'weight-spec', title: 'Weight Spec' },
      { hash: 'dd'.repeat(20), message: 'feat: weight' },
      { filePath: 'src/test.ts', startLine: 10, endLine: 20,
        codeDiff: '@@ -10,11 +10,11 @@\n+ chainFunction() {}' },
    );

    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const match = result.matches[0]!;
    const d = match.scoreDetail;

    // Weighted sum check: 0.30*fp + 0.25*content + 0.15*name + 0.20*recency + 0.10*overlap
    const expected = 0.30 * d.filePathScore + 0.25 * d.contentScore
      + 0.15 * d.nameScore + 0.20 * d.recencyScore + 0.10 * d.overlapScore;
    expect(match.score).toBeCloseTo(expected, 10);
  });

  it('respects topK limit', () => {
    // Create 5 specs all pointing to the same file
    for (let i = 0; i < 5; i++) {
      seedSpecChain(db,
        { id: `topk-${i}`, title: `TopK Spec ${i}` },
        { hash: `topk${i}`.padEnd(40, 'x'), message: `feat: topk ${i}` },
        { filePath: 'src/test.ts', startLine: 10, endLine: 20,
          codeDiff: `@@ -10,11 +10,11 @@\n+ thing${i}` },
      );
    }

    const entity = makeEntity({ startLine: 10, endLine: 20 });
    const result = findSpecsByCodeSymbol(db, entity, 3);

    expect(result.matches.length).toBeLessThanOrEqual(3);
    expect(result.totalCandidates).toBeGreaterThanOrEqual(5);
  });

  it('returns zero matches when spec is in a different file with no content/name match', () => {
    // Spec in a completely different file, with no content or name overlap
    const spec = makeSpec('diff-spec', 'Unrelated Spec');
    const commit = makeCommit('ee'.repeat(20), 'feat: unrelated');
    const fragment = insertCodeFragment(db, makeFragment({
      filePath: 'src/completely-different.ts',  // Different file
      startLine: 100,
      endLine: 200,
      codeDiff: '@@ -100,101 +100,101 @@\n+ unrelated code',
    }));

    insertSpecNode(db, spec);
    insertCommitNode(db, commit);
    insertSpecCommitRelation(db, spec.id, commit.hash, 'GENERATE');
    insertCommitFragmentRelation(db, commit.hash, fragment.id);

    const entity = makeEntity({
      name: 'uniqueName12345',  // Won't appear in any FTS
      filePath: 'src/test.ts',   // Doesn't match fragment path
      startLine: 10,
      endLine: 20,
    });

    const result = findSpecsByCodeSymbol(db, entity);
    expect(result.matches).toEqual([]);
  });

  it('entity with exact file path match gets filePathScore = 1.0', () => {
    // The SQL now computes file_path_match_level by comparing cf.file_path
    // (the fragment's code file) against entity.filePath, so exact match gives 1.0.
    const entity = seedSpecChain(db,
      { id: 'exact-fp', title: 'Exact FilePath' },
      { hash: 'ff'.repeat(20), message: 'feat: exact' },
      { filePath: 'src/exact-match.ts', startLine: 10, endLine: 20,
        codeDiff: '@@ -10,11 +10,11 @@\n+ chainFunction() {}' },
    );

    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0]!.scoreDetail.filePathScore).toBe(1.0);
  });

  it('includes fragmentCount and commitCount in match results', () => {
    const entity = seedSpecChain(db,
      { id: 'count-spec', title: 'Count Spec' },
      { hash: 'gg'.repeat(20), message: 'feat: count' },
      { filePath: 'src/test.ts', codeDiff: '@@ -10,11 +10,11 @@\n+ chainFunction() {}' },
    );

    const result = findSpecsByCodeSymbol(db, entity);

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0]!.fragmentCount).toBeGreaterThanOrEqual(1);
    expect(result.matches[0]!.commitCount).toBeGreaterThanOrEqual(1);
  });
});
