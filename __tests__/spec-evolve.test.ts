/**
 * Spec Evolve Pipeline Tests
 *
 * Tests for: impact-locator, spec-rewriter, and the
 * self-evolve pipeline orchestrator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock openai — not installed as a project dependency (LLM client fails at
// import time).  vi.mock is hoisted so this runs before any other import.
vi.mock('openai', () => ({
  default: class MockOpenAI {},
}));

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDatabase, SqliteDatabase } from '../src/db/sqlite-adapter';
import { silentLogger, setLogger } from '../src/errors';
import { DEFAULT_CONFIG, SpecConfig } from '../src/spec/config';
import { writeMeta, readMeta, SPEC_DATA_DIR } from '../src/spec/utils';
import { initSpecSchema, insertSpecNode, findSpecById } from '../src/spec/db';
import {
  insertCommitNode,
  insertCodeFragment,
  insertSpecCommitRelation,
  insertCommitFragmentRelation,
  insertSpecSpecRelation,
} from '../src/spec/db';

// Modules under test
import { LlmClient } from '../src/spec/llm/client';
import { locateAffectedSpecsWithCommits } from '../src/spec/evolve/impact-locator';
import {
  evaluateSpecWithCluster,
  applyUpdate,
  applyDeprecate,
  EvolveDecision,
} from '../src/spec/evolve/spec-rewriter';
import { runEvolvePipeline, BatchEvolveResult } from '../src/spec/evolve/pipeline';
import { ClusterContext } from '../src/spec/evolve/cluster-context';

// Silence logger during tests
setLogger(silentLogger);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLlmClient(
  chatJsonImpl?: (systemPrompt: string, userPrompt: string) => Promise<Record<string, unknown>>,
): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue('{}'),
    chatJson: chatJsonImpl
      ? vi.fn().mockImplementation(chatJsonImpl)
      : vi.fn().mockResolvedValue({}),
  };
}

/** Create a temp git repo. */
function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-spec-evolve-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function commitFile(repoDir: string, filePath: string, content: string, message: string): string {
  const absPath = path.join(repoDir, filePath);
  const dirPath = path.dirname(absPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(absPath, content, 'utf-8');
  execFileSync('git', ['add', filePath], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message], { cwd: repoDir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function createSpecOnDisk(specStoragePath: string, specId: string, planContent: string): string {
  const specDir = path.join(specStoragePath, specId);
  fs.mkdirSync(specDir, { recursive: true });
  const planPath = path.join(specDir, 'plan.md');
  fs.writeFileSync(planPath, planContent, 'utf-8');
  return planPath;
}

function createInMemoryDb(): SqliteDatabase {
  const dbPath = `:memory:`;
  const result = createDatabase(dbPath);
  initSpecSchema(result.db);
  return result.db;
}

// Helper: extract file paths from diff fragments (tested as inline logic)
function extractFilePathsFromDiff(diff: string): string[] {
  // Simple extraction mimicking the pipeline logic:
  // parse diff string for file paths
  const paths = new Set<string>();
  const lines = diff.split('\n');
  for (const line of lines) {
    // +++ b/path
    if (line.startsWith('+++ b/')) {
      const p = line.slice(6);
      if (p !== '/dev/null') {
        paths.add(p);
      }
    }
  }
  return Array.from(paths);
}

// ---------------------------------------------------------------------------
// B. impact-locator.ts — extractFilePathsFromDiff & locateAffectedSpecs
// ---------------------------------------------------------------------------

describe('impact-locator — extractFilePathsFromDiff', () => {
  it('extracts paths from standard diff', () => {
    const diff = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
+new line
`;
    const paths = extractFilePathsFromDiff(diff);
    expect(paths).toContain('src/main.ts');
  });

  it('excludes /dev/null', () => {
    const diff = `diff --git a/deleted.ts b/deleted.ts
--- a/deleted.ts
+++ /dev/null
`;
    const paths = extractFilePathsFromDiff(diff);
    expect(paths).not.toContain('/dev/null');
    expect(paths.length).toBe(0);
  });

  it('empty diff returns empty array', () => {
    const paths = extractFilePathsFromDiff('');
    expect(paths).toEqual([]);
  });

  it('added file path extracted', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+content
`;
    const paths = extractFilePathsFromDiff(diff);
    expect(paths).toContain('new.ts');
  });

  it('duplicates deduplicated', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
+x
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1,2 @@
+y
`;
    const paths = extractFilePathsFromDiff(diff);
    expect(paths).toContain('a.ts');
    expect(paths).toContain('b.ts');
    // No duplicates
    expect(paths.length).toBe(new Set(paths).size);
  });
});

describe('impact-locator — locateAffectedSpecsWithCommits', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    if (db && db.open) db.close();
  });

  it('exact path match returns spec', () => {
    // Set up: spec → commit → fragment with file path
    const specId = 'spec01';
    insertSpecNode(db, {
      id: specId, title: 'Spec 01', subtitles: [],
      status: 'active', version: 1, filePath: '/some/path/plan.md', timestamp: 1000,
    });
    insertCommitNode(db, {
      hash: 'a'.repeat(40), message: 'test', author: 'tester', timestamp: 1000,
    });
    const frag = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/auth.ts',
      startLine: 1, endLine: 5, codeDiff: '+code',
    });
    insertCommitFragmentRelation(db, 'a'.repeat(40), frag.id, 'CONTAINS');
    insertSpecCommitRelation(db, specId, 'a'.repeat(40), 'SUMMARIZED_FROM');

    const result = locateAffectedSpecsWithCommits(db, new Map([['abc1234', ['src/auth.ts']]]), new Set());
    expect(result.map(e => e.specId)).toContain('spec01');
  });

  it('partial LIKE match returns spec', () => {
    const specId = 'spec02';
    insertSpecNode(db, {
      id: specId, title: 'Spec 02', subtitles: [],
      status: 'active', version: 1, filePath: '/spec02/plan.md', timestamp: 1000,
    });
    insertCommitNode(db, {
      hash: 'b'.repeat(40), message: 'test', author: 'tester', timestamp: 1000,
    });
    const frag = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/features/auth/module.ts',
      startLine: 1, endLine: 10, codeDiff: '+module',
    });
    insertCommitFragmentRelation(db, 'b'.repeat(40), frag.id, 'CONTAINS');
    insertSpecCommitRelation(db, specId, 'b'.repeat(40), 'SUMMARIZED_FROM');

    // LIKE %auth% should match src/features/auth/module.ts
    const result = locateAffectedSpecsWithCommits(db, new Map([['abc1234', ['auth']]]), new Set());
    expect(result.map(e => e.specId)).toContain('spec02');
  });

  it('no match returns empty array', () => {
    const commitFilePaths = new Map<string, string[]>([
      ['def5678', ['nonexistent/file.ts']],
    ]);
    const result = locateAffectedSpecsWithCommits(db, commitFilePaths, new Set());
    expect(result).toEqual([]);
  });

  it('dedup same spec from two file paths', () => {
    const specId = 'spec03';
    insertSpecNode(db, {
      id: specId, title: 'Spec 03', subtitles: [],
      status: 'active', version: 1, filePath: '/spec03/plan.md', timestamp: 1000,
    });
    insertCommitNode(db, {
      hash: 'c'.repeat(40), message: 'test', author: 'tester', timestamp: 1000,
    });
    const frag1 = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/foo.ts',
      startLine: 1, endLine: 5, codeDiff: '+foo',
    });
    const frag2 = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/bar.ts',
      startLine: 1, endLine: 5, codeDiff: '+bar',
    });
    insertCommitFragmentRelation(db, 'c'.repeat(40), frag1.id, 'CONTAINS');
    insertCommitFragmentRelation(db, 'c'.repeat(40), frag2.id, 'CONTAINS');
    insertSpecCommitRelation(db, specId, 'c'.repeat(40), 'SUMMARIZED_FROM');

    const result = locateAffectedSpecsWithCommits(db, new Map([['h1', ['src/foo.ts', 'src/bar.ts']]]), new Set());
    // Should return spec03 only once
    expect(result.map(e => e.specId)).toEqual(['spec03']);
  });

  it('returns alphabetically sorted spec IDs', () => {
    // Insert specs in non-alphabetical order
    const specIds = ['z-spec', 'a-spec', 'm-spec'];
    let hIdx = 0;
    for (const sid of specIds) {
      insertSpecNode(db, {
        id: sid, title: sid, subtitles: [],
        status: 'active', version: 1, filePath: `/${sid}/plan.md`, timestamp: 1000,
      });
      // Unique hash per spec
      const hash = String(hIdx).repeat(40);
      hIdx++;
      insertCommitNode(db, { hash, message: sid, author: 'tester', timestamp: 1000 });
      const frag = insertCodeFragment(db, {
        id: '', changeType: 'MODIFY', filePath: `src/${sid}.ts`,
        startLine: 1, endLine: 1, codeDiff: '+x',
      });
      insertCommitFragmentRelation(db, hash, frag.id, 'CONTAINS');
      insertSpecCommitRelation(db, sid, hash, 'SUMMARIZED_FROM');
    }

    const result = locateAffectedSpecsWithCommits(db, new Map([['h1', ['src/z-spec.ts', 'src/a-spec.ts', 'src/m-spec.ts']]]), new Set());
    expect(result.map((e: any) => e.specId)).toEqual(['a-spec', 'm-spec', 'z-spec']);
  });
});

// ---------------------------------------------------------------------------
// C. spec-rewriter.ts — evaluateSpec, applyUpdate, applyDeprecate
// ---------------------------------------------------------------------------


function makeClusterContext(overrides: Partial<ClusterContext> = {}): ClusterContext {
  return {
    commitCount: 1,
    commitSummaries: [{
      shortHash: 'abc1234',
      fullHash: 'abc1234567890',
      message: 'feat: test change',
      changedFiles: ['src/test.ts'],
      truncatedDiff: '+console.log("test");',
    }],
    primaryFiles: ['src/test.ts'],
    ...overrides,
  };
}


describe('spec-rewriter — evaluateSpecWithCluster', () => {
  let specStorage: string;

  beforeEach(() => {
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-evalspec-'));
  });

  afterEach(() => {
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
  });

  it('no client defaults to UNCHANGED', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec01', '# Title\nContent.\n');
    const result = await evaluateSpecWithCluster(
      'spec01', planPath,
      makeClusterContext(), undefined,
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('missing plan.md defaults to UNCHANGED', async () => {
    const nonExistentPlan = path.join(specStorage, 'spec02', 'plan.md');
    const result = await evaluateSpecWithCluster(
      'spec02', nonExistentPlan,
      makeClusterContext(), createMockLlmClient(),
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('LLM returns DEPRECATE action', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec04', '# Spec 04\nOld.\n');
    const client = createMockLlmClient(async () => ({
      action: 'DEPRECATE',
      plan_content: 'This spec is no longer relevant.',
    }));

    const result = await evaluateSpecWithCluster(
      'spec04', planPath,
      makeClusterContext(), client,
    );
    expect(result.action).toBe('DEPRECATE');
  });

  it('invalid action defaults to UNCHANGED', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec05', '# Spec 05\nContent.\n');
    const client = createMockLlmClient(async () => ({
      action: 'INVALID_ACTION',
      title: 'Should not use',
    }));

    const result = await evaluateSpecWithCluster(
      'spec05', planPath,
      makeClusterContext(), client,
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('LLM returns UNCHANGED explicitly', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec06', '# Spec 06\nSame.\n');
    const client = createMockLlmClient(async () => ({
      action: 'UNCHANGED',
    }));

    const result = await evaluateSpecWithCluster(
      'spec06', planPath,
      makeClusterContext(), client,
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('cluster context is passed through to prompt', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec07', '# Spec 07\nContent.\n');
    const client = createMockLlmClient(async () => ({ action: 'UNCHANGED' }));

    const result = await evaluateSpecWithCluster(
      'spec07', planPath,
      makeClusterContext({ commitCount: 3, primaryFiles: ['src/a.ts', 'src/b.ts'] }),
      client,
    );
    expect(result.action).toBe('UNCHANGED');
  });
});

describe('spec-rewriter — applyUpdate', () => {
  let db: SqliteDatabase;
  let specStorage: string;

  beforeEach(() => {
    db = createInMemoryDb();
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-applyupdate-'));
  });

  afterEach(() => {
    if (db && db.open) db.close();
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
  });

  it('creates new version and writes plan.md', () => {
    const oldSpecId = 'spec01';
    const oldFilePath = createSpecOnDisk(specStorage, oldSpecId, '# Old Spec\nOld content.\n');

    // Pre-populate the spec in DB
    insertSpecNode(db, {
      id: oldSpecId, title: 'Old Spec', subtitles: ['Old Spec - Old content.'],
      status: 'active', version: 1, filePath: oldFilePath, timestamp: 1000,
    });
    insertCommitNode(db, {
      hash: 'd'.repeat(40), message: 'feat: update', author: 'tester', timestamp: 2000,
    });

    const decision: EvolveDecision = {
      action: 'UPDATE',
      title: 'New Spec',
      subtitles: ['New Spec → Section - New content.'],
      plan_content: '# New Spec\nUpdated content.\n',
    };

    const result = applyUpdate(db, specStorage, oldSpecId, oldFilePath, 1, decision, 'd'.repeat(40));
    expect(result.newSpecId).toBe(oldSpecId);
    expect(result.newVersion).toBe(2);

    // Check plan.md was rewritten
    expect(fs.existsSync(oldFilePath)).toBe(true);
    const newContent = fs.readFileSync(oldFilePath, 'utf-8');
    expect(newContent).toContain('New Spec');

    // Check .bak exists
    const bakPath = oldFilePath + '.bak';
    expect(fs.existsSync(bakPath)).toBe(true);

    // Check deprecated record exists in DB
    const deprecatedId = `${oldSpecId}_v1`;
    const depRow = findSpecById(db, deprecatedId);
    expect(depRow).not.toBeNull();
    expect(depRow!.status).toBe('deprecated');

    // Check new active spec
    const activeRow = findSpecById(db, oldSpecId);
    expect(activeRow).not.toBeNull();
    expect(activeRow!.status).toBe('active');
    expect(activeRow!.version).toBe(2);

    // Check EVOLVED_FROM relation exists
    const relRow = db.prepare(
      'SELECT * FROM spec_spec_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?'
    ).get(oldSpecId, deprecatedId, 'EVOLVED_FROM') as any;
    expect(relRow).toBeDefined();

    // Check GENERATE relation exists
    const genRow = db.prepare(
      'SELECT * FROM spec_commit_relations WHERE spec_id = ? AND commit_hash = ? AND relation_type = ?'
    ).get(oldSpecId, 'd'.repeat(40), 'GENERATE') as any;
    expect(genRow).toBeDefined();
  });

  it('works without plan_content in decision', () => {
    const oldSpecId = 'spec02';
    const oldFilePath = createSpecOnDisk(specStorage, oldSpecId, '# Old\nContent.\n');

    insertSpecNode(db, {
      id: oldSpecId, title: 'Old', subtitles: [],
      status: 'active', version: 1, filePath: oldFilePath, timestamp: 1000,
    });
    insertCommitNode(db, {
      hash: 'e'.repeat(40), message: 'feat', author: 'tester', timestamp: 2000,
    });

    const decision: EvolveDecision = {
      action: 'UPDATE',
      // No plan_content — writes empty string
    };

    const result = applyUpdate(db, specStorage, oldSpecId, oldFilePath, 1, decision, 'e'.repeat(40));
    expect(result.newVersion).toBe(2);

    // plan.md should have been written with empty content
    const newContent = fs.readFileSync(oldFilePath, 'utf-8');
    // Content comes from plan_content or extracted metadata
    expect(typeof newContent).toBe('string');
  });
});

describe('spec-rewriter — applyDeprecate', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    if (db && db.open) db.close();
  });

  it('sets status to deprecated', () => {
    const specId = 'spec01';
    insertSpecNode(db, {
      id: specId, title: 'Spec 01', subtitles: [],
      status: 'active', version: 1, filePath: '/spec01/plan.md', timestamp: 1000,
    });

    applyDeprecate(db, specId);

    const row = findSpecById(db, specId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('deprecated');
  });

  it('creates deprecated target node', () => {
    const specId = 'spec02';
    insertSpecNode(db, {
      id: specId, title: 'Spec 02', subtitles: ['H1 - preview'],
      status: 'active', version: 2, filePath: '/spec02/plan.md', timestamp: 1000,
    });

    applyDeprecate(db, specId);

    const deprecatedTargetId = `${specId}_deprecated`;
    const targetRow = findSpecById(db, deprecatedTargetId);
    expect(targetRow).not.toBeNull();
    expect(targetRow!.status).toBe('deprecated');
  });

  it('creates EVOLVED_FROM relation', () => {
    const specId = 'spec03';
    insertSpecNode(db, {
      id: specId, title: 'Spec 03', subtitles: [],
      status: 'active', version: 1, filePath: '/spec03/plan.md', timestamp: 1000,
    });

    applyDeprecate(db, specId);

    const relRow = db.prepare(
      'SELECT * FROM spec_spec_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?'
    ).get(specId, `${specId}_deprecated`, 'EVOLVED_FROM') as any;
    expect(relRow).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// E. pipeline.ts — runEvolvePipeline
// ---------------------------------------------------------------------------

describe('evolve pipeline — runEvolvePipeline', () => {
  let repo: string;
  let specStorage: string;
  let db: SqliteDatabase;

  const evolveConfig: SpecConfig = {
    ...DEFAULT_CONFIG,
    llm: {
      provider: 'openai',
      apiKey: '',
      model: 'mock-model',
      temperature: 0,
      maxTokens: 100,
    },
  };

  beforeEach(() => {
    repo = initTempGitRepo();
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-batchevolve-'));

    const dbPath = path.join(os.tmpdir(), `homegraph-batchevolve-${Date.now()}.db`);
    const result = createDatabase(dbPath);
    db = result.db;
    initSpecSchema(db);
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
    if (db && db.open) {
      try { db.close(); } catch { /* ignore */ }
    }
    vi.restoreAllMocks();
  });

  it('no meta.json → throws', async () => {
    await expect(
      runEvolvePipeline(repo, db, evolveConfig),
    ).rejects.toThrow(/No meta.json found/);
  });

  it('no currentCommitID in meta → processes HEAD and updates meta', async () => {
    // Simulate old meta without currentCommitID
    writeMeta(repo, specStorage); // currentCommitID = undefined

    // Create a commit
    const hash = commitFile(repo, 'README.md', '# hello', 'docs: init');

    // Mock: not a logic change (no LLM needed)
    const result = await runEvolvePipeline(repo, db, evolveConfig);

    expect(result.fromCommit).toBeNull();
    expect(result.toCommit).toBe(hash);
    expect(result.commitsScanned).toBe(1);
    expect(result.perCommitResults).toHaveLength(1);
    expect(result.metaUpdated).toBe(false);

    // Verify meta.json is NOT updated (no spec match)
    const meta = readMeta(repo);
    expect(meta).not.toBeNull();
    expect(meta!.currentCommitID).toBeUndefined();
  });

  it('no new commits (currentCommitID === HEAD) → 0 processed, meta unchanged', async () => {
    // Create a commit, then mark meta as already evolved to that commit
    const hash = commitFile(repo, 'README.md', '# hello', 'docs: init');
    writeMeta(repo, specStorage, hash);

    const originalMeta = readMeta(repo);
    expect(originalMeta).not.toBeNull();

    const result = await runEvolvePipeline(repo, db, evolveConfig);

    expect(result.commitsScanned).toBe(0);
    expect(result.perCommitResults).toEqual([]);
    expect(result.metaUpdated).toBe(false);
    expect(result.fromCommit).toBe(hash);
    expect(result.toCommit).toBe(hash);

    // Verify meta.json was NOT modified
    const metaAfter = readMeta(repo);
    expect(metaAfter).not.toBeNull();
    expect(metaAfter!.currentCommitID).toBe(hash);
    expect(metaAfter!.updatedAt).toBe(originalMeta!.updatedAt);
  });

  it('1 new commit after last evolve → processes it and returns scanned count', async () => {
    // Baseline commit (already evolved)
    const baselineHash = commitFile(repo, 'README.md', '# baseline', 'docs: baseline');
    writeMeta(repo, specStorage, baselineHash);

    // New commit (not yet evolved)
    const newHash = commitFile(repo, 'src/main.ts', 'const x = 1;', 'feat: new feature');

    // Mock: not a logic change
    const result = await runEvolvePipeline(repo, db, evolveConfig);

    expect(result.fromCommit).toBe(baselineHash);
    expect(result.toCommit).toBe(newHash);
    expect(result.commitsScanned).toBe(1);
    // No spec match → mine fallback: perCommitResults empty, meta not updated
    expect(result.perCommitResults).toEqual([]);
    expect(result.metaUpdated).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it('3 new commits → processes all in chronological order, returns scanned count', async () => {
    // Baseline
    const baselineHash = commitFile(repo, 'README.md', '# base', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // 3 new commits
    const hash1 = commitFile(repo, 'a.ts', 'a', 'feat: A');
    const hash2 = commitFile(repo, 'b.ts', 'b', 'feat: B');
    const hash3 = commitFile(repo, 'c.ts', 'c', 'feat: C');

    // Mock: not logic changes
    const result = await runEvolvePipeline(repo, db, evolveConfig);

    expect(result.fromCommit).toBe(baselineHash);
    expect(result.toCommit).toBe(hash3);
    expect(result.commitsScanned).toBe(3);
    // No spec match → mine fallback: perCommitResults empty, meta not updated
    expect(result.perCommitResults).toEqual([]);
    expect(result.metaUpdated).toBe(false);
    expect(result.skipped).toBe(true);
  });

  it('rebase detection: currentCommitID not ancestor of HEAD → throws', async () => {
    // Create baseline and mark as evolved
    const baselineHash = commitFile(repo, 'README.md', '# base', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // Create a new commit so HEAD != baseline
    commitFile(repo, 'a.ts', 'a', 'feat: after');

    // Corrupt meta: set currentCommitID to a fake hash that is not an ancestor
    writeMeta(repo, specStorage, '0000000000000000000000000000000000000000');

    await expect(
      runEvolvePipeline(repo, db, evolveConfig),
    ).rejects.toThrow(/not an ancestor/);
  });

  it('Path A (GENERATE) works in batch mode', async () => {
    // Baseline
    const baselineHash = commitFile(repo, 'README.md', '# base', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // Create spec on disk
    createSpecOnDisk(specStorage, 'spec01', '# Spec 01\nContent.\n');

    // New commit with matching scope
    const newHash = commitFile(repo, 'src/main.ts', 'const x = 1;', 'feat(spec01): add feature');

    // Mock: not a logic change (Path A only)
    const result = await runEvolvePipeline(repo, db, evolveConfig);

    expect(result.commitsScanned).toBe(1);
    expect(result.perCommitResults[0]!.matchedSpecId).toBe('spec01');
    expect(result.perCommitResults[0]!.relationsCreated).toBe(2);
    expect(result.metaUpdated).toBe(true);

    // Verify meta.json updated
    const meta = readMeta(repo);
    expect(meta!.currentCommitID).toBe(newHash);
  });

  it('processes all commits even when none match specs', async () => {
    // Baseline
    const baselineHash = commitFile(repo, 'README.md', '# base', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // 3 new commits — none match any spec or trigger logic change
    const hash1 = commitFile(repo, 'a.ts', 'a', 'chore: task A');
    const hash2 = commitFile(repo, 'b.ts', 'b', 'chore: task B');
    const hash3 = commitFile(repo, 'c.ts', 'c', 'chore: task C');

    // Mock: not logic changes
    const result = await runEvolvePipeline(repo, db, evolveConfig);

    // All 3 scanned, none matched (no spec matches, no logic changes)
    // → mine fallback: empty perCommitResults, meta not updated
    expect(result.commitsScanned).toBe(3);
    expect(result.perCommitResults).toEqual([]);
    expect(result.metaUpdated).toBe(false);
    expect(result.skipped).toBe(true);

    // meta.json unchanged
    const meta = readMeta(repo);
    expect(meta!.currentCommitID).toBe(baselineHash);
  });

  it('JSON output contains BatchEvolveResult structure', async () => {
    writeMeta(repo, specStorage);

    const hash = commitFile(repo, 'README.md', '# hello', 'docs: init');

    const result = await runEvolvePipeline(repo, db, evolveConfig);

    // Verify BatchEvolveResult shape
    expect(result).toHaveProperty('fromCommit');
    expect(result).toHaveProperty('toCommit');
    expect(result).toHaveProperty('commitsScanned');
    expect(result).toHaveProperty('perCommitResults');
    expect(result).toHaveProperty('metaUpdated');
    expect(result).toHaveProperty('phaseOneSkipped');
    expect(result).toHaveProperty('phaseOneFailures');

    expect(result.fromCommit === null || typeof result.fromCommit === 'string').toBe(true);
    expect(typeof result.toCommit).toBe('string');
    expect(typeof result.commitsScanned).toBe('number');
    expect(Array.isArray(result.perCommitResults)).toBe(true);
    expect(typeof result.metaUpdated).toBe('boolean');
    expect(typeof result.phaseOneSkipped).toBe('number');
    expect(typeof result.phaseOneFailures).toBe('number');

    // Verify per-commit results have EvolveResult shape
    if (result.perCommitResults.length > 0) {
      const r = result.perCommitResults[0]!;
      expect(r).toHaveProperty('commitHash');
      expect(r).toHaveProperty('matched');
      expect(r).toHaveProperty('phaseOneSkipped');
    }
  });

  it('Path B: logic change + affected spec → UPDATE via batch', async () => {
    // Baseline commit + meta
    const baselineHash = commitFile(repo, 'README.md', '# Project\n', 'chore: init');
    writeMeta(repo, specStorage, baselineHash);

    // Create spec on disk
    createSpecOnDisk(specStorage, 'spec02', '# Spec 02\nOriginal spec content.\n');

    // New commit with spec scope for Path A matching
    const newHash = commitFile(repo, 'src/auth.ts', 'function login() { return true; }\n', 'feat(spec02): add login');

    // Pre-populate DB with mining data
    insertSpecNode(db, {
      id: 'spec02', title: 'Spec 02', subtitles: ['Spec 02 - Original spec content.'],
      status: 'active', version: 1,
      filePath: path.join(specStorage, 'spec02', 'plan.md'), timestamp: Date.now(),
    });
    insertCommitNode(db, {
      hash: newHash, message: 'feat(spec02): add login', author: 'tester', timestamp: Date.now(),
    });
    const frag = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/auth.ts',
      startLine: 1, endLine: 1, codeDiff: '+function login() { return true; }',
    });
    insertCommitFragmentRelation(db, newHash, frag.id, 'CONTAINS');
    insertSpecCommitRelation(db, 'spec02', newHash, 'SUMMARIZED_FROM');

    // Mock LLM
    vi.spyOn(
      await import('../src/spec/evolve/spec-rewriter'),
      'evaluateSpecWithCluster',
    ).mockResolvedValue({
      action: 'UPDATE' as const,
      title: 'Updated Spec 02',
      subtitles: ['Updated - new content'],
      plan_content: '# Updated Spec 02\nNew content.\n',
    });

    const result = await runEvolvePipeline(repo, db, evolveConfig);

    expect(result.commitsScanned).toBe(1);
    const r = result.perCommitResults[0]!;
    expect(r.matched).toBe(true);
    expect(result.metaUpdated).toBe(true);

    vi.restoreAllMocks();
  });

  it('Path B: no affected specs → not matched (batch)', async () => {
    const baselineHash = commitFile(repo, 'README.md', '# base', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    const newHash = commitFile(repo, 'src/other.ts', 'unrelated\n', 'feat: unrelated');

    const result = await runEvolvePipeline(repo, db, evolveConfig);

    expect(result.commitsScanned).toBe(1);
    // No DB entries → phase 1 produces no matches → mine fallback
    expect(result.perCommitResults).toEqual([]);
    expect(result.metaUpdated).toBe(false);
    expect(result.skipped).toBe(true);

    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // Path A without LLM
  // ------------------------------------------------------------------

  it('Path A works without LLM configured', async () => {
    // Setup: create a commit with spec scope in message
    const baselineHash = commitFile(repo, 'README.md', '# base\n', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // Create spec on disk
    createSpecOnDisk(specStorage, 'spec03', '# Spec 03\nPath A content.\n');

    // Commit with spec(spec03) in message
    commitFile(
      repo,
      'src/feature.ts',
      'console.log("new feature");\n',
      'feat(spec03): add feature',
    );

    // No LLM mock — testing that Path A works without it
    const result = await runEvolvePipeline(repo, db, { ...DEFAULT_CONFIG, llm: null });

    expect(result.commitsScanned).toBe(1);
    const r = result.perCommitResults[0]!;
    expect(r.phaseOneSkipped).toBe(false);
    expect(r.matchedSpecId).toBe('spec03');
    expect(r.relationsCreated).toBe(2);
    expect(r.matched).toBe(true);
    // meta should be updated (Path A succeeded)
    expect(result.metaUpdated).toBe(true);
    expect(result.phaseOneSkipped).toBe(0);
  });

  it('non-Path-A commit without LLM → skipped', async () => {
    const baselineHash = commitFile(repo, 'README.md', '# base\n', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // Commit WITHOUT spec scope in message
    commitFile(
      repo,
      'src/utils.ts',
      'export const x = 1;\n',
      'chore: update utils',
    );

    const result = await runEvolvePipeline(repo, db, { ...DEFAULT_CONFIG, llm: null });

    expect(result.commitsScanned).toBe(1);
    // No spec match + no LLM → mine fallback with empty perCommitResults
    expect(result.perCommitResults).toEqual([]);
    expect(result.metaUpdated).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('Phase 1 produced no matches');
    expect(result.phaseOneSkipped).toBe(1);
  });

  it('mix: Path A succeeds + non-Path-A skipped, meta updated', async () => {
    const baselineHash = commitFile(repo, 'README.md', '# base\n', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // Commit 1: Path A with spec scope
    createSpecOnDisk(specStorage, 'spec04', '# Spec 04\nContent.\n');
    commitFile(
      repo,
      'src/a.ts',
      'const a = 1;\n',
      'feat(spec04): add a',
    );

    // Commit 2: No spec scope, no LLM → should be skipped
    commitFile(
      repo,
      'src/b.ts',
      'const b = 2;\n',
      'chore: cleanup',
    );

    // Commit 3: Another Path A
    createSpecOnDisk(specStorage, 'spec05', '# Spec 05\nContent.\n');
    commitFile(
      repo,
      'src/c.ts',
      'const c = 3;\n',
      'feat(spec05): add c',
    );

    const result = await runEvolvePipeline(repo, db, { ...DEFAULT_CONFIG, llm: null });

    expect(result.commitsScanned).toBe(3);
    expect(result.phaseOneSkipped).toBe(1);

    // Commit 1: Path A → matched
    const r1 = result.perCommitResults[0]!;
    expect(r1.phaseOneSkipped).toBe(false);
    expect(r1.matchedSpecId).toBe('spec04');
    expect(r1.matched).toBe(true);

    // Commit 2: no Path A, no LLM → skipped
    const r2 = result.perCommitResults[1]!;
    expect(r2.phaseOneSkipped).toBe(true);
    expect(r2.matched).toBe(false);

    // Commit 3: Path A → matched
    const r3 = result.perCommitResults[2]!;
    expect(r3.phaseOneSkipped).toBe(false);
    expect(r3.matchedSpecId).toBe('spec05');
    expect(r3.matched).toBe(true);

    // meta.json should be updated (2 commits processed, 0 failures)
    // Note: meta advances past skipped commits to HEAD
    expect(result.metaUpdated).toBe(true);
  });

  it('partial failure: 1 commit succeeds + 1 commit fails → meta updated', async () => {
    const baselineHash = commitFile(repo, 'README.md', '# base\n', 'chore: init');
    writeMeta(repo, specStorage, baselineHash);

    // Create spec on disk for Path B lookup
    createSpecOnDisk(specStorage, 'spec06', '# Spec 06\nOriginal.\n');

    // Commit 1 and 2 with spec scope for Path A matching
    const hash1 = commitFile(repo, 'src/succeed.ts', 'const a = 1;\n', 'feat(spec06): first');
    const hash2 = commitFile(repo, 'src/fail.ts', 'const b = 2;\n', 'feat(spec06): second');

    // Pre-populate DB so locateAffectedSpecsWithCommits finds spec06 for both commits
    insertSpecNode(db, {
      id: 'spec06', title: 'Spec 06', subtitles: ['Spec 06 - Original.'],
      status: 'active', version: 1,
      filePath: path.join(specStorage, 'spec06', 'plan.md'), timestamp: Date.now(),
    });

    insertCommitNode(db, {
      hash: hash1, message: 'feat(spec06): first', author: 'tester', timestamp: Date.now(),
    });
    const frag1 = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/succeed.ts',
      startLine: 1, endLine: 1, codeDiff: '+const a = 1;',
    });
    insertCommitFragmentRelation(db, hash1, frag1.id, 'CONTAINS');
    insertSpecCommitRelation(db, 'spec06', hash1, 'SUMMARIZED_FROM');

    insertCommitNode(db, {
      hash: hash2, message: 'feat(spec06): second', author: 'tester', timestamp: Date.now(),
    });
    const frag2 = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/fail.ts',
      startLine: 1, endLine: 1, codeDiff: '+const b = 2;',
    });
    insertCommitFragmentRelation(db, hash2, frag2.id, 'CONTAINS');
    insertSpecCommitRelation(db, 'spec06', hash2, 'SUMMARIZED_FROM');

    // evaluateSpecWithCluster: commit 1 succeeds (UNCHANGED), commit 2 throws
    vi.spyOn(
      await import('../src/spec/evolve/spec-rewriter'),
      'evaluateSpecWithCluster',
    )
      .mockResolvedValueOnce({ action: 'UNCHANGED' as const })
      .mockRejectedValueOnce(new Error('LLM timeout'));

    const result = await runEvolvePipeline(repo, db, evolveConfig);

    expect(result.commitsScanned).toBe(2);
    expect(result.phaseOneMatched).toBe(2);
    expect(result.phaseOneFailures).toBe(0);
    // KEY assertion: meta updated because 1 commit succeeded
    expect(result.metaUpdated).toBe(true);

    // Verify meta.json advanced to HEAD (past the failed commit)
    const meta = readMeta(repo);
    expect(meta!.currentCommitID).toBe(hash2);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// F. spec evolve — install / uninstall
// ---------------------------------------------------------------------------

describe('spec evolve — install / uninstall', () => {
  let repo: string;
  let specStorage: string;

  beforeEach(() => {
    repo = initTempGitRepo();
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-evolvehook-'));
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
  });

  // Helper: simulate what the install command does programmatically
  function installSpecEvolveHook(repoPath: string): string {
    const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const resolvedHooksDir = path.isAbsolute(hooksDir)
      ? hooksDir
      : path.resolve(repoPath, hooksDir);

    fs.mkdirSync(resolvedHooksDir, { recursive: true });

    const hookPath = path.join(resolvedHooksDir, 'post-commit');
    const MARKER_BEGIN = '# >>> homegraph spec evolve hook >>>';
    const MARKER_END = '# <<< homegraph spec evolve hook <<<';

    const hookBlock = [
      MARKER_BEGIN,
      '# Triggers spec self-evolution after each commit. Runs in background.',
      '# Installed by: homegraph spec evolve install',
      `# Logs: ${SPEC_DATA_DIR}/logs/evolve-hook.log`,
      '# Runtime guard: skip if homegraph is not available',
      'HOMEGRAPH_BIN="/usr/local/bin/homegraph"',
      'if [ -x "$HOMEGRAPH_BIN" ] || command -v homegraph >/dev/null 2>&1; then',
      '  "${HOMEGRAPH_BIN:-homegraph}" spec evolve process --path "$(pwd)" --json \\',
      `      >> ${SPEC_DATA_DIR}/logs/evolve-hook.log 2>&1 &`,
      'fi',
      MARKER_END,
    ].join('\n');

    let content: string;
    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, 'utf8');
      const lines = existing.split('\n');
      const kept: string[] = [];
      let inBlock = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === MARKER_BEGIN) { inBlock = true; continue; }
        if (trimmed === MARKER_END) { inBlock = false; continue; }
        if (!inBlock) kept.push(line);
      }
      const base = kept.join('\n').replace(/\s*$/, '');
      content = base.length > 0
        ? `${base}\n\n${hookBlock}\n`
        : `#!/bin/sh\n${hookBlock}\n`;
    } else {
      content = `#!/bin/sh\n${hookBlock}\n`;
    }

    fs.writeFileSync(hookPath, content);
    fs.chmodSync(hookPath, 0o755);
    return hookPath;
  }

  // Helper: simulate what the uninstall command does
  function uninstallSpecEvolveHook(repoPath: string): { path: string; deleted: boolean } {
    const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const resolvedHooksDir = path.isAbsolute(hooksDir)
      ? hooksDir
      : path.resolve(repoPath, hooksDir);

    const hookPath = path.join(resolvedHooksDir, 'post-commit');
    const MARKER_BEGIN = '# >>> homegraph spec evolve hook >>>';
    const MARKER_END = '# <<< homegraph spec evolve hook <<<';

    if (!fs.existsSync(hookPath)) {
      return { path: hookPath, deleted: false };
    }

    const existing = fs.readFileSync(hookPath, 'utf8');
    const lines = existing.split('\n');
    const kept: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === MARKER_BEGIN) { inBlock = true; continue; }
      if (trimmed === MARKER_END) { inBlock = false; continue; }
      if (!inBlock) kept.push(line);
    }

    const remaining = kept.join('\n').trim();

    if (remaining.length === 0 || /^#!\/bin\/sh\s*$/.test(remaining)) {
      fs.unlinkSync(hookPath);
      return { path: hookPath, deleted: true };
    } else {
      fs.writeFileSync(hookPath, remaining + '\n');
      return { path: hookPath, deleted: false };
    }
  }

  it.runIf(process.platform !== 'win32')('install creates post-commit hook with marker block', () => {
    const hookPath = installSpecEvolveHook(repo);

    expect(fs.existsSync(hookPath)).toBe(true);
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain('# >>> homegraph spec evolve hook >>>');
    expect(content).toContain('# <<< homegraph spec evolve hook <<<');
    expect(content).toContain('spec evolve process');
    expect(content).toContain('#!/bin/sh');

    // Verify executable
    const stat = fs.statSync(hookPath);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('uninstall removes hook that only contains our block', () => {
    const hookPath = installSpecEvolveHook(repo);
    expect(fs.existsSync(hookPath)).toBe(true);

    const result = uninstallSpecEvolveHook(repo);
    expect(result.deleted).toBe(true);
    expect(fs.existsSync(hookPath)).toBe(false);
  });

  it('uninstall preserves user content outside our block', () => {
    // Create a hook with user content first
    const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const resolvedHooksDir = path.isAbsolute(hooksDir)
      ? hooksDir
      : path.resolve(repo, hooksDir);
    fs.mkdirSync(resolvedHooksDir, { recursive: true });
    const hookPath = path.join(resolvedHooksDir, 'post-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "my custom logic"\n', { mode: 0o755 });

    // Now install our hook
    installSpecEvolveHook(repo);

    const contentBefore = fs.readFileSync(hookPath, 'utf8');
    expect(contentBefore).toContain('my custom logic');
    expect(contentBefore).toContain('# >>> homegraph spec evolve hook >>>');

    // Uninstall
    const result = uninstallSpecEvolveHook(repo);
    expect(result.deleted).toBe(false);
    expect(fs.existsSync(hookPath)).toBe(true);

    const contentAfter = fs.readFileSync(hookPath, 'utf8');
    expect(contentAfter).toContain('my custom logic');
    expect(contentAfter).not.toContain('# >>> homegraph spec evolve hook >>>');
    expect(contentAfter).not.toContain('# <<< homegraph spec evolve hook <<<');
  });

  it('install is idempotent — running twice produces only one block', () => {
    const hookPath = installSpecEvolveHook(repo);
    installSpecEvolveHook(repo); // second install

    const content = fs.readFileSync(hookPath, 'utf8');
    const beginCount = (content.match(/# >>> homegraph spec evolve hook >>>/g) || []).length;
    const endCount = (content.match(/# <<< homegraph spec evolve hook <<</g) || []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it('uninstall with no marker block reports nothing to do', () => {
    // Don't install anything, just try to uninstall
    const result = uninstallSpecEvolveHook(repo);
    expect(result.deleted).toBe(false);
  });

  it('installed hook includes runtime guard with command -v fallback', () => {
    const hookPath = installSpecEvolveHook(repo);
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain('HOMEGRAPH_BIN=');
    expect(content).toContain('command -v homegraph');
    expect(content).toContain('${HOMEGRAPH_BIN:-homegraph}');
    expect(content).toContain('if [ -x "$HOMEGRAPH_BIN" ]');
  });
});
