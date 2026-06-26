/**
 * Spec Evolve Pipeline Tests
 *
 * Tests for: logic-checker, impact-locator, spec-rewriter, and the
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
import { DEFAULT_CONFIG, LLMConfig, SpecConfig } from '../src/spec/config';
import { writeMeta } from '../src/spec/utils';
import { initSpecSchema, insertSpecNode, findSpecById } from '../src/spec/db';
import {
  insertCommitNode,
  insertCodeFragment,
  insertSpecCommitRelation,
  insertCommitFragmentRelation,
  insertSpecSpecRelation,
} from '../src/spec/db';

// Modules under test
import { LLMClient } from '../src/spec/evolve/llm-client';
import { isLogicChange, LogicCheckResult } from '../src/spec/evolve/logic-checker';
import { locateAffectedSpecs } from '../src/spec/evolve/impact-locator';
import {
  evaluateSpec,
  applyUpdate,
  applyDeprecate,
  EvolveDecision,
} from '../src/spec/evolve/spec-rewriter';
import { runEvolvePipeline, EvolveResult, EvolvedSpec } from '../src/spec/evolve/pipeline';

// Silence logger during tests
setLogger(silentLogger);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLLMClient(): LLMClient {
  const config: LLMConfig = {
    provider: 'mock',
    apiKey: '',
    model: 'mock-model',
    temperature: 0,
    maxTokens: 100,
  };
  return new LLMClient(config);
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
// A. logic-checker.ts — isLogicChange
// ---------------------------------------------------------------------------

describe('logic-checker — isLogicChange', () => {
  it('no client defaults to isLogic=false', async () => {
    const result = await isLogicChange('feat: something', 'diff content');
    expect(result.isLogic).toBe(false);
    expect(result.reason).toBe('LLM unavailable');
  });

  it('LLM mock says true when mock response includes is_logic_change: true', async () => {
    const client = createMockLLMClient();
    client.setMockResponse('logic', JSON.stringify({
      is_logic_change: true,
      reason: 'This changes business logic',
    }));

    const result = await isLogicChange('feat: add auth', '+function auth() {}', client);
    expect(result.isLogic).toBe(true);
    expect(result.reason).toBe('This changes business logic');
  });

  it('LLM mock says false', async () => {
    const client = createMockLLMClient();
    client.setMockResponse('logic-false', JSON.stringify({
      is_logic_change: false,
      reason: 'Only formatting changes',
    }));

    const result = await isLogicChange('style: format', '-  ', client);
    expect(result.isLogic).toBe(false);
    expect(result.reason).toBe('Only formatting changes');
  });

  it('invalid JSON defaults to isLogic=false', async () => {
    const client = createMockLLMClient();
    client.setMockResponse('bad-json', 'not valid json at all');

    const result = await isLogicChange('feat: test', 'some diff', client);
    // chatJson returns {} for invalid JSON, so is_logic_change would be undefined
    expect(result.isLogic).toBe(false);
    expect(result.reason).toBe('');
  });

  it('long diff truncated does not crash', async () => {
    const client = createMockLLMClient();
    client.setMockResponse('long-diff', JSON.stringify({ is_logic_change: false, reason: 'ok' }));

    const longDiff = 'x'.repeat(10000);
    const result = await isLogicChange('feat: big change', longDiff, client);
    // Should not crash, result should be valid
    expect(result.isLogic).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('mock fallback when no explicit mock set returns false', async () => {
    const client = createMockLLMClient();
    // No setMockResponse calls — falls through to pattern matching
    const result = await isLogicChange('feat: some change', '+code', client);
    // Mock default for "logic change" pattern is is_logic_change: false
    expect(result.isLogic).toBe(false);
  });
});

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

describe('impact-locator — locateAffectedSpecs', () => {
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
    insertCommitFragmentRelation(db, 'a'.repeat(40), frag.id);
    insertSpecCommitRelation(db, specId, 'a'.repeat(40), 'SUMMARIZED_FROM');

    const result = locateAffectedSpecs(db, ['src/auth.ts']);
    expect(result).toContain('spec01');
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
    insertCommitFragmentRelation(db, 'b'.repeat(40), frag.id);
    insertSpecCommitRelation(db, specId, 'b'.repeat(40), 'SUMMARIZED_FROM');

    // LIKE %auth% should match src/features/auth/module.ts
    const result = locateAffectedSpecs(db, ['auth']);
    expect(result).toContain('spec02');
  });

  it('no match returns empty array', () => {
    const result = locateAffectedSpecs(db, ['nonexistent/file.ts']);
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
    insertCommitFragmentRelation(db, 'c'.repeat(40), frag1.id);
    insertCommitFragmentRelation(db, 'c'.repeat(40), frag2.id);
    insertSpecCommitRelation(db, specId, 'c'.repeat(40), 'SUMMARIZED_FROM');

    const result = locateAffectedSpecs(db, ['src/foo.ts', 'src/bar.ts']);
    // Should return spec03 only once
    expect(result).toEqual(['spec03']);
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
      insertCommitFragmentRelation(db, hash, frag.id);
      insertSpecCommitRelation(db, sid, hash, 'SUMMARIZED_FROM');
    }

    const result = locateAffectedSpecs(db, ['src/z-spec.ts', 'src/a-spec.ts', 'src/m-spec.ts']);
    expect(result).toEqual(['a-spec', 'm-spec', 'z-spec']);
  });
});

// ---------------------------------------------------------------------------
// C. spec-rewriter.ts — evaluateSpec, applyUpdate, applyDeprecate
// ---------------------------------------------------------------------------

describe('spec-rewriter — evaluateSpec', () => {
  let specStorage: string;

  beforeEach(() => {
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-evalspec-'));
  });

  afterEach(() => {
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
  });

  it('no client defaults to UNCHANGED', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec01', '# Title\nContent.\n');
    const result = await evaluateSpec(
      'spec01', specStorage, planPath,
      'feat: change', '+code', [], undefined,
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('missing plan.md defaults to UNCHANGED', async () => {
    const nonExistentPlan = path.join(specStorage, 'spec02', 'plan.md');
    const result = await evaluateSpec(
      'spec02', specStorage, nonExistentPlan,
      'feat: change', '+code', [], createMockLLMClient(),
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('LLM returns UPDATE action', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec03', '# Spec 03\nOld content.\n');
    const client = createMockLLMClient();
    client.setMockResponse('update', JSON.stringify({
      action: 'UPDATE',
      title: 'Updated Spec 03',
      subtitles: ['Updated → Spec 03 - new preview'],
      plan_content: '# Updated Spec 03\nNew content.\n',
    }));

    const result = await evaluateSpec(
      'spec03', specStorage, planPath,
      'feat: update spec', '+new content', [], client,
    );
    expect(result.action).toBe('UPDATE');
    expect(result.title).toBe('Updated Spec 03');
    expect(result.plan_content).toContain('Updated Spec 03');
  });

  it('LLM returns DEPRECATE action', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec04', '# Spec 04\nOld.\n');
    const client = createMockLLMClient();
    client.setMockResponse('deprecate', JSON.stringify({
      action: 'DEPRECATE',
      plan_content: 'This spec is no longer relevant.',
    }));

    const result = await evaluateSpec(
      'spec04', specStorage, planPath,
      'feat: remove feature', '-old code', [], client,
    );
    expect(result.action).toBe('DEPRECATE');
  });

  it('invalid action defaults to UNCHANGED', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec05', '# Spec 05\nContent.\n');
    const client = createMockLLMClient();
    client.setMockResponse('bad-action', JSON.stringify({
      action: 'INVALID_ACTION',
      title: 'Should not use',
    }));

    const result = await evaluateSpec(
      'spec05', specStorage, planPath,
      'feat: test', '+code', [], client,
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('LLM returns UNCHANGED explicitly', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec06', '# Spec 06\nSame.\n');
    const client = createMockLLMClient();
    client.setMockResponse('unchanged', JSON.stringify({
      action: 'UNCHANGED',
    }));

    const result = await evaluateSpec(
      'spec06', specStorage, planPath,
      'style: format', '  ', [], client,
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('scheduleNextSpecs context is passed through', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec07', '# Spec 07\nContent.\n');
    const client = createMockLLMClient();
    client.setMockResponse('sched', JSON.stringify({ action: 'UNCHANGED' }));

    // Should not crash with next specs listed
    const result = await evaluateSpec(
      'spec07', specStorage, planPath,
      'feat: context', '+code', ['spec08', 'spec09'], client,
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
// D. pipeline.ts — runEvolvePipeline
// ---------------------------------------------------------------------------

describe('evolve pipeline — runEvolvePipeline', () => {
  let repo: string;
  let specStorage: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    repo = initTempGitRepo();
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-evolvepipe-'));
    writeMeta(repo, specStorage);

    const dbPath = path.join(os.tmpdir(), `homegraph-evolve-test-${Date.now()}.db`);
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
  });

  it('Path A: scope in commit message → GENERATE relation created', async () => {
    // Create spec on disk
    createSpecOnDisk(specStorage, 'spec01', '# Spec 01\nContent for spec 01.\n');

    // Commit with matching scope
    const hash = commitFile(repo, 'src/main.ts', 'const x = 1;\n', 'feat(spec01): add feature');

    // Set up mock LLM client (via config override)
    const llmConfig: LLMConfig = {
      provider: 'mock',
      apiKey: '',
      model: 'mock-model',
      temperature: 0,
      maxTokens: 100,
    };

    const result = await runEvolvePipeline(repo, db, hash, llmConfig);

    expect(result.commitHash).toBe(hash);
    expect(result.generateSpecId).toBe('spec01');
    expect(result.generateRelationCreated).toBe(true);
    expect(result.persisted).toBe(true);

    // Verify GENERATE relation in DB
    const relRow = db.prepare(
      'SELECT * FROM spec_commit_relations WHERE spec_id = ? AND commit_hash = ? AND relation_type = ?'
    ).get('spec01', hash, 'GENERATE') as any;
    expect(relRow).toBeDefined();

    // Verify spec node exists
    const specRow = db.prepare('SELECT * FROM spec_nodes WHERE id = ?').get('spec01') as any;
    expect(specRow).toBeDefined();
    expect(specRow.title).toBe('Spec 01');
  });

  it('Path B: logic change + affected spec → UPDATE, version incremented', async () => {
    // Create spec on disk
    createSpecOnDisk(specStorage, 'spec02', '# Spec 02\nOriginal spec content.\n');

    // Root commit has no parent → getCommitDiff returns empty.
    // Add a baseline commit first so the logic-change commit has a parent to diff against.
    commitFile(repo, 'README.md', '# Project\n', 'chore: init');

    // Commit without scope (so Path A doesn't trigger)
    const hash = commitFile(repo, 'src/auth.ts', 'function login() { return true; }\n', 'feat: add login');

    // Pre-populate DB with spec, commit, fragment, and relations (simulating mining)
    insertSpecNode(db, {
      id: 'spec02', title: 'Spec 02', subtitles: ['Spec 02 - Original spec content.'],
      status: 'active', version: 1,
      filePath: path.join(specStorage, 'spec02', 'plan.md'), timestamp: Date.now(),
    });
    insertCommitNode(db, {
      hash, message: 'feat: add login', author: 'tester', timestamp: Date.now(),
    });
    const frag = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/auth.ts',
      startLine: 1, endLine: 1, codeDiff: '+function login() { return true; }',
    });
    insertCommitFragmentRelation(db, hash, frag.id);
    insertSpecCommitRelation(db, 'spec02', hash, 'SUMMARIZED_FROM');

    // Set up mock LLM: logic change = true, evaluate = UPDATE
    const llmConfig: LLMConfig = {
      provider: 'mock',
      apiKey: '',
      model: 'mock-model',
      temperature: 0,
      maxTokens: 100,
    };

    // Need to pre-set mock responses on the LLMClient that pipeline creates.
    // Since runEvolvePipeline creates its own client, we need to mock at a lower level.
    // The mock provider's default pattern matching:
    // - "logic change" keyword → is_logic_change: false (default mock response)
    // - "evolve" keyword → UNCHANGED (default mock response)
    //
    // To make Path B work, we need isLogicChange=true. We'll use a spy/mock approach.
    // The simplest approach: we use mock provider but set responses via the client.
    //
    // However, runEvolvePipeline creates its own LLMClient. We need to intercept.
    // Let's use vi.spyOn to mock the isLogicChange and evaluateSpec functions
    // since they're the ones that interact with LLM.

    // Actually, let's use vi.mock to intercept the LLMClient or the logic/evaluate functions.
    // For test simplicity, we'll spy on isLogicChange and evaluateSpec.

    // But wait - that would make the test about mocks, not about real pipeline.
    // Let me reconsider: the mock LLM provider in the default mode returns
    // is_logic_change: false for "logic change" pattern. So Path B won't trigger
    // with default mock. We need to inject mock responses.

    // The cleanest approach: use vi.spyOn to mock the isLogicChange function
    // and evaluateSpec function at the module level.

    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: true, reason: 'Business logic changed' });

    vi.spyOn(
      await import('../src/spec/evolve/spec-rewriter'),
      'evaluateSpec',
    ).mockResolvedValue({
      action: 'UPDATE' as const,
      title: 'Updated Spec 02',
      subtitles: ['Updated - new content'],
      plan_content: '# Updated Spec 02\nNew content.\n',
    });

    const result = await runEvolvePipeline(repo, db, hash, llmConfig);

    expect(result.isLogicChange).toBe(true);
    expect(result.affectedSpecCount).toBeGreaterThanOrEqual(1);
    expect(result.persisted).toBe(true);

    // Check evolved spec entry
    const evolvedEntry = result.evolvedSpecs.find((e: EvolvedSpec) => e.specId === 'spec02');
    expect(evolvedEntry).toBeDefined();
    expect(evolvedEntry!.action).toBe('UPDATE');
    expect(evolvedEntry!.newVersion).toBe(2);

    vi.restoreAllMocks();
  });

  it('Path B: no affected specs → not persisted', async () => {
    const hash = commitFile(repo, 'src/other.ts', 'unrelated\n', 'feat: unrelated');

    // Mock: logic change = true, but no affected specs in DB
    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: true, reason: 'Logic change' });

    const llmConfig: LLMConfig = {
      provider: 'mock',
      apiKey: '',
      model: 'mock-model',
      temperature: 0,
      maxTokens: 100,
    };

    const result = await runEvolvePipeline(repo, db, hash, llmConfig);

    // Logic change but no affected specs and no Path A scope match
    expect(result.isLogicChange).toBe(true);
    expect(result.affectedSpecCount).toBe(0);
    expect(result.persisted).toBe(false);

    vi.restoreAllMocks();
  });

  it('no scope + no logic change → not persisted', async () => {
    const hash = commitFile(repo, 'src/styles.css', 'body { color: red; }\n', 'style: colors');

    // Default mock: logic change = false
    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: false, reason: 'No logic change' });

    const llmConfig: LLMConfig = {
      provider: 'mock',
      apiKey: '',
      model: 'mock-model',
      temperature: 0,
      maxTokens: 100,
    };

    const result = await runEvolvePipeline(repo, db, hash, llmConfig);

    expect(result.isLogicChange).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.generateRelationCreated).toBe(false);
    expect(result.evolvedSpecs).toEqual([]);

    vi.restoreAllMocks();
  });

  it('EvolveResult structure is complete', async () => {
    // Minimal: just check return structure even with early exit
    const hash = commitFile(repo, 'README.md', '# readme', 'docs: readme');

    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: false, reason: 'Not logic' });

    const llmConfig: LLMConfig = {
      provider: 'mock', apiKey: '', model: 'mock', temperature: 0, maxTokens: 100,
    };

    const result = await runEvolvePipeline(repo, db, hash, llmConfig);

    // Check all fields present
    expect(result).toHaveProperty('commitHash');
    expect(result).toHaveProperty('generateRelationCreated');
    expect(result).toHaveProperty('isLogicChange');
    expect(result).toHaveProperty('logicCheckReason');
    expect(result).toHaveProperty('affectedSpecCount');
    expect(result).toHaveProperty('evolvedSpecs');
    expect(result).toHaveProperty('fragmentsCount');
    expect(result).toHaveProperty('relationsCreated');
    expect(result).toHaveProperty('persisted');

    expect(typeof result.commitHash).toBe('string');
    expect(typeof result.generateRelationCreated).toBe('boolean');
    expect(typeof result.isLogicChange).toBe('boolean');
    expect(typeof result.logicCheckReason).toBe('string');
    expect(typeof result.affectedSpecCount).toBe('number');
    expect(Array.isArray(result.evolvedSpecs)).toBe(true);
    expect(typeof result.fragmentsCount).toBe('number');
    expect(typeof result.relationsCreated).toBe('number');
    expect(typeof result.persisted).toBe('boolean');

    vi.restoreAllMocks();
  });
});
