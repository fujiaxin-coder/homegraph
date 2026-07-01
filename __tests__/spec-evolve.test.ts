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
import { writeMeta, readMeta } from '../src/spec/utils';
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
import { isLogicChange, LogicCheckResult } from '../src/spec/evolve/logic-checker';
import { locateAffectedSpecs } from '../src/spec/evolve/impact-locator';
import {
  evaluateSpec,
  applyUpdate,
  applyDeprecate,
  EvolveDecision,
} from '../src/spec/evolve/spec-rewriter';
import { EvolveResult, EvolvedSpec } from '../src/spec/evolve/pipeline';
import { runBatchEvolvePipeline, BatchEvolveResult } from '../src/spec/evolve/pipeline';

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
// A. logic-checker.ts — isLogicChange
// ---------------------------------------------------------------------------

describe('logic-checker — isLogicChange', () => {
  it('no client defaults to isLogic=false', async () => {
    const result = await isLogicChange('feat: something', 'diff content');
    expect(result.isLogic).toBe(false);
    expect(result.reason).toBe('LLM unavailable');
  });

  it('LLM mock says true when mock response includes is_logic_change: true', async () => {
    const client = createMockLlmClient(async () => ({
      is_logic_change: true,
      reason: 'This changes business logic',
    }));

    const result = await isLogicChange('feat: add auth', '+function auth() {}', client);
    expect(result.isLogic).toBe(true);
    expect(result.reason).toBe('This changes business logic');
  });

  it('LLM mock says false', async () => {
    const client = createMockLlmClient(async () => ({
      is_logic_change: false,
      reason: 'Only formatting changes',
    }));

    const result = await isLogicChange('style: format', '-  ', client);
    expect(result.isLogic).toBe(false);
    expect(result.reason).toBe('Only formatting changes');
  });

  it('invalid JSON defaults to isLogic=false', async () => {
    const client = createMockLlmClient(async () => 'not valid json at all' as unknown as Record<string, unknown>);

    const result = await isLogicChange('feat: test', 'some diff', client);
    // chatJson returns {} for invalid JSON, so is_logic_change would be undefined
    expect(result.isLogic).toBe(false);
    expect(result.reason).toBe('');
  });

  it('long diff truncated does not crash', async () => {
    const client = createMockLlmClient(async () => ({ is_logic_change: false, reason: 'ok' }));

    const longDiff = 'x'.repeat(10000);
    const result = await isLogicChange('feat: big change', longDiff, client);
    // Should not crash, result should be valid
    expect(result.isLogic).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('mock fallback when no explicit mock set returns false', async () => {
    const client = createMockLlmClient();
    // chatJson returns {} by default
    const result = await isLogicChange('feat: some change', '+code', client);
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
      'feat: change', '+code', [], createMockLlmClient(),
    );
    expect(result.action).toBe('UNCHANGED');
  });

  it('LLM returns UPDATE action', async () => {
    const planPath = createSpecOnDisk(specStorage, 'spec03', '# Spec 03\nOld content.\n');
    const client = createMockLlmClient(async () => ({
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
    const client = createMockLlmClient(async () => ({
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
    const client = createMockLlmClient(async () => ({
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
    const client = createMockLlmClient(async () => ({
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
    const client = createMockLlmClient(async () => ({ action: 'UNCHANGED' }));

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
// E. pipeline.ts — runBatchEvolvePipeline
// ---------------------------------------------------------------------------

describe('evolve pipeline — runBatchEvolvePipeline', () => {
  let repo: string;
  let specStorage: string;
  let db: SqliteDatabase;

  const llmConfig: LLMConfig = {
    provider: 'openai',
    apiKey: '',
    model: 'mock-model',
    temperature: 0,
    maxTokens: 100,
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
      runBatchEvolvePipeline(repo, db, llmConfig),
    ).rejects.toThrow(/No meta.json found/);
  });

  it('no currentCommitID in meta → processes HEAD and updates meta', async () => {
    // Simulate old meta without currentCommitID
    writeMeta(repo, specStorage); // currentCommitID = undefined

    // Create a commit
    const hash = commitFile(repo, 'README.md', '# hello', 'docs: init');

    // Mock: not a logic change (no LLM needed)
    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: false, reason: 'Not logic' });

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    expect(result.fromCommit).toBeNull();
    expect(result.toCommit).toBe(hash);
    expect(result.commitsProcessed).toBe(1);
    expect(result.perCommitResults).toHaveLength(1);
    expect(result.metaUpdated).toBe(true);

    // Verify meta.json is updated
    const meta = readMeta(repo);
    expect(meta).not.toBeNull();
    expect(meta!.currentCommitID).toBe(hash);
  });

  it('no new commits (currentCommitID === HEAD) → 0 processed, meta unchanged', async () => {
    // Create a commit, then mark meta as already evolved to that commit
    const hash = commitFile(repo, 'README.md', '# hello', 'docs: init');
    writeMeta(repo, specStorage, hash);

    const originalMeta = readMeta(repo);
    expect(originalMeta).not.toBeNull();

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    expect(result.commitsProcessed).toBe(0);
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

  it('1 new commit after last evolve → processes it and updates meta', async () => {
    // Baseline commit (already evolved)
    const baselineHash = commitFile(repo, 'README.md', '# baseline', 'docs: baseline');
    writeMeta(repo, specStorage, baselineHash);

    // New commit (not yet evolved)
    const newHash = commitFile(repo, 'src/main.ts', 'const x = 1;', 'feat: new feature');

    // Mock: not a logic change
    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: false, reason: 'Not logic' });

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    expect(result.fromCommit).toBe(baselineHash);
    expect(result.toCommit).toBe(newHash);
    expect(result.commitsProcessed).toBe(1);
    expect(result.perCommitResults[0]!.commitHash).toBe(newHash);
    expect(result.metaUpdated).toBe(true);

    // Verify meta.json updated to new HEAD
    const meta = readMeta(repo);
    expect(meta!.currentCommitID).toBe(newHash);
  });

  it('3 new commits → processes all in chronological order, updates meta', async () => {
    // Baseline
    const baselineHash = commitFile(repo, 'README.md', '# base', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // 3 new commits
    const hash1 = commitFile(repo, 'a.ts', 'a', 'feat: A');
    const hash2 = commitFile(repo, 'b.ts', 'b', 'feat: B');
    const hash3 = commitFile(repo, 'c.ts', 'c', 'feat: C');

    // Mock: not logic changes
    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: false, reason: 'Not logic' });

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    expect(result.fromCommit).toBe(baselineHash);
    expect(result.toCommit).toBe(hash3);
    expect(result.commitsProcessed).toBe(3);
    expect(result.metaUpdated).toBe(true);

    // Verify chronological order (oldest first)
    expect(result.perCommitResults[0]!.commitHash).toBe(hash1);
    expect(result.perCommitResults[1]!.commitHash).toBe(hash2);
    expect(result.perCommitResults[2]!.commitHash).toBe(hash3);

    // Verify meta.json updated to HEAD
    const meta = readMeta(repo);
    expect(meta!.currentCommitID).toBe(hash3);
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
      runBatchEvolvePipeline(repo, db, llmConfig),
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
    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: false, reason: 'Not logic' });

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    expect(result.commitsProcessed).toBe(1);
    expect(result.perCommitResults[0]!.generateSpecId).toBe('spec01');
    expect(result.perCommitResults[0]!.generateRelationCreated).toBe(true);
    expect(result.metaUpdated).toBe(true);

    // Verify meta.json updated
    const meta = readMeta(repo);
    expect(meta!.currentCommitID).toBe(newHash);
  });

  it('processes all commits even when some produce no changes', async () => {
    // Baseline
    const baselineHash = commitFile(repo, 'README.md', '# base', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    // 3 new commits — none match any spec or trigger logic change
    const hash1 = commitFile(repo, 'a.ts', 'a', 'chore: task A');
    const hash2 = commitFile(repo, 'b.ts', 'b', 'chore: task B');
    const hash3 = commitFile(repo, 'c.ts', 'c', 'chore: task C');

    // Mock: not logic changes
    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: false, reason: 'No logic change' });

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    // All 3 processed, none persisted (no spec matches, no logic changes)
    expect(result.commitsProcessed).toBe(3);
    expect(result.perCommitResults).toHaveLength(3);
    for (const r of result.perCommitResults) {
      expect(r.persisted).toBe(false);
    }
    // All succeeded (no errors) → meta updated to HEAD
    expect(result.metaUpdated).toBe(true);

    const meta = readMeta(repo);
    expect(meta!.currentCommitID).toBe(hash3);
  });

  it('JSON output contains BatchEvolveResult structure', async () => {
    writeMeta(repo, specStorage);

    const hash = commitFile(repo, 'README.md', '# hello', 'docs: init');

    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: false, reason: 'Not logic' });

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    // Verify BatchEvolveResult shape
    expect(result).toHaveProperty('fromCommit');
    expect(result).toHaveProperty('toCommit');
    expect(result).toHaveProperty('commitsProcessed');
    expect(result).toHaveProperty('perCommitResults');
    expect(result).toHaveProperty('metaUpdated');

    expect(result.fromCommit === null || typeof result.fromCommit === 'string').toBe(true);
    expect(typeof result.toCommit).toBe('string');
    expect(typeof result.commitsProcessed).toBe('number');
    expect(Array.isArray(result.perCommitResults)).toBe(true);
    expect(typeof result.metaUpdated).toBe('boolean');

    // Verify per-commit results have EvolveResult shape
    if (result.perCommitResults.length > 0) {
      const r = result.perCommitResults[0]!;
      expect(r).toHaveProperty('commitHash');
      expect(r).toHaveProperty('isLogicChange');
      expect(r).toHaveProperty('persisted');
    }
  });

  it('Path B: logic change + affected spec → UPDATE via batch', async () => {
    // Baseline commit + meta
    const baselineHash = commitFile(repo, 'README.md', '# Project\n', 'chore: init');
    writeMeta(repo, specStorage, baselineHash);

    // Create spec on disk
    createSpecOnDisk(specStorage, 'spec02', '# Spec 02\nOriginal spec content.\n');

    // New commit without scope (Path A won't trigger)
    const newHash = commitFile(repo, 'src/auth.ts', 'function login() { return true; }\n', 'feat: add login');

    // Pre-populate DB with mining data
    insertSpecNode(db, {
      id: 'spec02', title: 'Spec 02', subtitles: ['Spec 02 - Original spec content.'],
      status: 'active', version: 1,
      filePath: path.join(specStorage, 'spec02', 'plan.md'), timestamp: Date.now(),
    });
    insertCommitNode(db, {
      hash: newHash, message: 'feat: add login', author: 'tester', timestamp: Date.now(),
    });
    const frag = insertCodeFragment(db, {
      id: '', changeType: 'MODIFY', filePath: 'src/auth.ts',
      startLine: 1, endLine: 1, codeDiff: '+function login() { return true; }',
    });
    insertCommitFragmentRelation(db, newHash, frag.id);
    insertSpecCommitRelation(db, 'spec02', newHash, 'SUMMARIZED_FROM');

    // Mock LLM
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

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    expect(result.commitsProcessed).toBe(1);
    const r = result.perCommitResults[0]!;
    expect(r.isLogicChange).toBe(true);
    expect(r.persisted).toBe(true);

    const evolvedEntry = r.evolvedSpecs.find((e: EvolvedSpec) => e.specId === 'spec02');
    expect(evolvedEntry).toBeDefined();
    expect(evolvedEntry!.action).toBe('UPDATE');
    expect(evolvedEntry!.newVersion).toBe(2);
    expect(result.metaUpdated).toBe(true);

    vi.restoreAllMocks();
  });

  it('Path B: no affected specs → not persisted (batch)', async () => {
    const baselineHash = commitFile(repo, 'README.md', '# base', 'docs: base');
    writeMeta(repo, specStorage, baselineHash);

    const newHash = commitFile(repo, 'src/other.ts', 'unrelated\n', 'feat: unrelated');

    vi.spyOn(
      await import('../src/spec/evolve/logic-checker'),
      'isLogicChange',
    ).mockResolvedValue({ isLogic: true, reason: 'Logic change' });

    const result = await runBatchEvolvePipeline(repo, db, llmConfig);

    expect(result.commitsProcessed).toBe(1);
    const r = result.perCommitResults[0]!;
    expect(r.isLogicChange).toBe(true);
    expect(r.affectedSpecCount).toBe(0);
    expect(r.persisted).toBe(false);
    // All "succeeded" (no error thrown), so meta updated
    expect(result.metaUpdated).toBe(true);

    vi.restoreAllMocks();
  });
});
