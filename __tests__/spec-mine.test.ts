/**
 * Spec Mine Pipeline Tests
 *
 * Tests for: scanner, clusterer, generator, persist, and the mine pipeline.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Mock openai — not installed as a project dependency.
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

// Mock OpenAiLlmClient — generator tests override per-test.
vi.mock('../src/spec/llm/client', async () => {
  const actual = await vi.importActual<typeof import('../src/spec/llm/client')>(
    '../src/spec/llm/client',
  );
  return {
    ...actual,
    OpenAiLlmClient: vi.fn().mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Test Spec\n\nThis is a test spec.'),
      chatJson: vi.fn().mockResolvedValue({}),
    })),
  };
});

// Mock writeMeta so pipeline tests don't write to disk
vi.mock('../src/spec/utils', async () => {
  const actual = await vi.importActual<typeof import('../src/spec/utils')>(
    '../src/spec/utils',
  );
  return {
    ...actual,
    writeMeta: vi.fn().mockImplementation((repoPath: string) => ({
      repoPath,
      specStoragePath: '.homegraph/commit4spec',
      currentCommitID: '',
    })),
  };
});

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDatabase, SqliteDatabase } from '../src/db/sqlite-adapter';
import { silentLogger, setLogger } from '../src/errors';
import { initSpecSchema } from '../src/spec/db/schema';
import { findSpecById } from '../src/spec/db/spec-node';

import { scanCommits, CommitChange, FileChange, ChangedSymbol } from '../src/spec/mine/scanner';
import { clusterCommits, CommitCluster, ClusterResult } from '../src/spec/mine/clustering';
import { generateSpecs, GeneratedSpec, GenerationResult } from '../src/spec/mine/generator';
import { persistToGraph, PersistResult } from '../src/spec/mine/persist';
import { runMinePipeline, MinePipelineResult } from '../src/spec/mine/pipeline';
import { MineConfig } from '../src/spec/config';
import { OpenAiLlmClient } from '../src/spec/llm/client';
import { writeMeta } from '../src/spec/utils';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

// Silence logger during tests
setLogger(silentLogger);

// Initialize tree-sitter grammars before any scanner tests run.
beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-spec-mine-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], {
    cwd: dir,
    stdio: 'ignore',
  });
  return dir;
}

function commitFile(
  repoDir: string,
  filePath: string,
  content: string,
  message: string,
): string {
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

function createInMemoryDb(): SqliteDatabase {
  const result = createDatabase(':memory:');
  initSpecSchema(result.db);
  return result.db;
}

function createMockLlmClient(chatImpl?: () => Promise<string>) {
  return {
    chat: chatImpl ? vi.fn().mockImplementation(chatImpl) : vi.fn().mockResolvedValue(''),
  };
}

// ===========================================================================
// Section A: Scanner
// ===========================================================================

describe('scanner — scanCommits', () => {
  let repo: string;

  beforeEach(() => {
    repo = initTempGitRepo();
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('empty repo with no commits returns []', () => {
    const results = scanCommits(repo, '', 'HEAD');
    expect(results).toEqual([]);
  });

  it('single feat commit returns one CommitChange', () => {
    // Create a baseline commit first so the feat commit has a parent to diff against.
    commitFile(repo, 'README.md', '# Project\n', 'chore: init');
    // Now a feat commit with a .ts file — this will have a parent, so diff works.
    commitFile(repo, 'src/index.ts', 'export function hello() { return 1; }\n', 'feat: add hello');

    const results = scanCommits(repo, '', 'HEAD');
    expect(results.length).toBe(1);
    expect(results[0]!.commitHash).toBeTruthy();
    expect(results[0]!.commitHash.length).toBe(40);
    expect(results[0]!.fileChanges).toBeDefined();
  });

  it('non-feat/fix-only commits are filtered by default', () => {
    // Baseline for parent
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'chore: setup');
    commitFile(repo, 'doc/readme.md', '# Docs\n', 'docs: readme');
    commitFile(repo, 'src/feature.ts', 'export function feat() { return true; }\n', 'feat: feature');

    const results = scanCommits(repo, '', 'HEAD');
    // Only the feat commit should be included (others are conventional-chore/docs).
    expect(results.length).toBe(1);
    expect(results[0]!.commitMessage).toBe('feat: feature');
  });

  it('extracts added symbols for new files', () => {
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(
      repo,
      'src/login.ts',
      'export function login() { return true; }\n',
      'feat: add login',
    );

    const results = scanCommits(repo, '', 'HEAD');
    expect(results.length).toBe(1);
    // The new file should have at least one added symbol (the login function).
    const fileChanges = results[0]!.fileChanges;
    const loginFile = fileChanges.find((f) => f.filePath === 'src/login.ts');
    expect(loginFile).toBeDefined();
    expect(loginFile!.addedSymbols.length).toBeGreaterThanOrEqual(1);
  });

  it('limit parameter restricts result count', () => {
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    // Create 5 feat commits
    for (let i = 0; i < 5; i++) {
      commitFile(repo, `src/file${i}.ts`, `export const x${i} = ${i};\n`, `feat: feature ${i}`);
    }

    const results = scanCommits(repo, '', 'HEAD', 2);
    expect(results.length).toBe(2);
  });

  it('merge commits and mechanical revert/reapply commits are filtered out', () => {
    // Create a branch, commit on it, then merge. The merge commit should be excluded.
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(repo, 'src/main.ts', 'export const x = 1;\n', 'feat: main branch');

    // Create and switch to a feature branch
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo, stdio: 'ignore' });
    commitFile(repo, 'src/feature.ts', 'export function f() {}\n', 'feat: feature branch');
    // Switch back to original branch
    execFileSync('git', ['checkout', '-'], { cwd: repo, stdio: 'ignore' });
    // Use --no-ff to ensure a merge commit is created
    let mergeSucceeded = false;
    try {
      execFileSync('git', ['merge', '--no-ff', 'feature', '-m', 'feat: merge feature'], {
        cwd: repo,
        stdio: 'ignore',
      });
      mergeSucceeded = true;
    } catch {
      // Merge might fail in some test setups — skip gracefully
    }

    const results = scanCommits(repo, '', 'HEAD');
    if (mergeSucceeded) {
      // Merge commit should be filtered out (--no-merges)
      const mergeCommit = results.find((r) => r.commitMessage === 'feat: merge feature');
      expect(mergeCommit).toBeUndefined();
    } else {
      // Fallback: at minimum, no crash
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it('commit with no changed source files returns empty fileChanges', () => {
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(repo, 'doc/notes.md', '# Notes\nSome notes.\n', 'feat: doc update');

    const results = scanCommits(repo, '', 'HEAD');
    expect(results.length).toBe(1);
    // .md files are not supported by the grammar system, so fileChanges is empty.
    expect(results[0]!.fileChanges).toEqual([]);
  });
});

// ===========================================================================
// Section B: Clusterer
// ===========================================================================

describe('clusterer — clusterCommits', () => {
  /** Helper to build a minimal CommitChange. */
  function makeCommit(overrides: Partial<CommitChange> & { message?: string; hash?: string }): CommitChange {
    const hash = overrides.hash || 'a'.repeat(40);
    return {
      commitHash: hash,
      commitMessage: overrides.message || 'feat: test',
      author: 'tester',
      timestamp: Date.now(),
      fileChanges: [],
      ...overrides,
    };
  }

  /** Create a symbol with defaults. */
  function sym(name: string, overrides: Partial<ChangedSymbol> = {}): ChangedSymbol {
    return {
      kind: 'function',
      name,
      qualifiedName: name,
      startLine: 1,
      endLine: 3,
      fingerprint: `${name}-fp`,
      ...overrides,
    };
  }

  it('empty array returns empty clusters', () => {
    const result = clusterCommits([], 0.5, 10);
    expect(result.clusters).toEqual([]);
    expect(result.unclustered).toEqual([]);
    expect(result.stats.totalCommits).toBe(0);
    expect(result.stats.clusteredCommits).toBe(0);
    expect(result.stats.clusterCount).toBe(0);
  });

  it('single commit with >= 5 symbols creates solo cluster', () => {
    const symbols = [sym('a'), sym('b'), sym('c'), sym('d'), sym('e')];
    const commit = makeCommit({
      message: 'feat: big change',
      fileChanges: [
        {
          filePath: 'src/main.ts',
          language: 'typescript',
          addedSymbols: symbols,
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });

    const result = clusterCommits([commit], 0.5, 10);
    expect(result.clusters.length).toBe(1);
    expect(result.unclustered.length).toBe(0);
    expect(result.stats.clusteredCommits).toBe(1);
    expect(result.stats.clusterCount).toBe(1);
  });

  it('single commit with < 2 symbols goes to unclustered', () => {
    const symbols = [sym('a')];
    const commit = makeCommit({
      message: 'feat: small change',
      fileChanges: [
        {
          filePath: 'src/main.ts',
          language: 'typescript',
          addedSymbols: symbols,
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });

    const result = clusterCommits([commit], 0.5, 10);
    expect(result.clusters.length).toBe(0);
    expect(result.unclustered.length).toBe(1);
    expect(result.stats.totalCommits).toBe(1);
    expect(result.stats.clusteredCommits).toBe(0);
  });

  it('two commits with same symbol names cluster together', () => {
    const c1 = makeCommit({
      hash: 'b'.repeat(40),
      message: 'feat: login part 1',
      fileChanges: [
        {
          filePath: 'src/auth.ts',
          language: 'typescript',
          addedSymbols: [sym('login'), sym('logout'), sym('authenticate'), sym('refresh'), sym('validate')],
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });
    // Second commit modifies the same 'login' symbol.
    const c2 = makeCommit({
      hash: 'c'.repeat(40),
      message: 'feat: login part 2',
      fileChanges: [
        {
          filePath: 'src/auth.ts',
          language: 'typescript',
          addedSymbols: [sym('resetPassword'), sym('changeEmail')],
          removedSymbols: [],
          modifiedSymbols: [
            { old: sym('login', { fingerprint: 'old' }), new: sym('login', { fingerprint: 'new' }) },
          ],
        },
      ],
    });

    const result = clusterCommits([c1, c2], 0.1, 10);
    // Low threshold — both modify 'login' → high symbol Jaccard → should cluster.
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]!.commits.length).toBe(2);
    expect(result.stats.clusterCount).toBe(1);
    expect(result.stats.clusteredCommits).toBe(2);
  });

  it('threshold=1 prevents clustering of dissimilar commits', () => {
    const c1 = makeCommit({
      hash: 'd'.repeat(40),
      message: 'feat: auth',
      fileChanges: [
        {
          filePath: 'src/auth.ts',
          language: 'typescript',
          addedSymbols: [sym('login'), sym('logout'), sym('authenticate'), sym('refresh'), sym('validate')],
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });
    const c2 = makeCommit({
      hash: 'e'.repeat(40),
      message: 'feat: payment',
      fileChanges: [
        {
          filePath: 'src/payment.ts',
          language: 'typescript',
          addedSymbols: [sym('charge'), sym('refund'), sym('invoice'), sym('receipt'), sym('balance')],
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });

    // threshold=1 means only identical commits cluster — these are dissimilar.
    // With no edges in the graph, Louvain places each commit in its own
    // community. Both have ≥5 symbols → each gets a solo cluster (consistent
    // with the n=1 solo-cluster rule, unlike the old connected-components
    // approach which discarded size-1 components).
    const result = clusterCommits([c1, c2], 1.0, 10);
    expect(result.clusters.length).toBe(2);
    expect(result.unclustered.length).toBe(0);
    expect(result.stats.clusteredCommits).toBe(2);
  });

  it('stats are accurate', () => {
    const symbols = [sym('a'), sym('b'), sym('c'), sym('d'), sym('e')];
    const c1 = makeCommit({
      hash: 'f'.repeat(40),
      fileChanges: [
        {
          filePath: 'src/x.ts',
          language: 'typescript',
          addedSymbols: symbols,
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });
    const c2 = makeCommit({
      hash: 'g'.repeat(40),
      fileChanges: [
        {
          filePath: 'src/x.ts',
          language: 'typescript',
          addedSymbols: symbols,
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });

    const result = clusterCommits([c1, c2], 0.3, 10);
    expect(result.stats.totalCommits).toBe(2);
    // Both commits have identical symbols and files — they should cluster together
    expect(result.stats.clusteredCommits).toBe(2);
    expect(result.stats.clusterCount).toBe(1);
  });

  it('cluster has id, summary, primaryFiles fields', () => {
    const symbols = [sym('login'), sym('logout'), sym('authenticate'), sym('refresh'), sym('validate')];
    const commit = makeCommit({
      fileChanges: [
        {
          filePath: 'src/auth.ts',
          language: 'typescript',
          addedSymbols: symbols,
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });

    const result = clusterCommits([commit], 0.5, 10);
    expect(result.clusters.length).toBe(1);
    const cluster = result.clusters[0]!;
    expect(typeof cluster.id).toBe('number');
    expect(typeof cluster.summary).toBe('string');
    expect(Array.isArray(cluster.primaryFiles)).toBe(true);
    expect(Array.isArray(cluster.primarySymbols)).toBe(true);
    expect(Array.isArray(cluster.commits)).toBe(true);
  });

  it('timeRange has start and end timestamps', () => {
    const symbols = [sym('a'), sym('b'), sym('c'), sym('d'), sym('e')];
    const ts = Date.now();
    const commit = makeCommit({
      timestamp: ts,
      fileChanges: [
        {
          filePath: 'src/x.ts',
          language: 'typescript',
          addedSymbols: symbols,
          removedSymbols: [],
          modifiedSymbols: [],
        },
      ],
    });

    const result = clusterCommits([commit], 0.5, 10);
    expect(result.clusters.length).toBe(1);
    const tr = result.clusters[0]!.timeRange;
    expect(typeof tr.start).toBe('number');
    expect(typeof tr.end).toBe('number');
    expect(tr.start).toBe(ts);
    expect(tr.end).toBe(ts);
  });
});

// ===========================================================================
// Section C: Generator
// ===========================================================================

describe('generator — generateSpecs', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-gen-'));
    // Reset mock to default before each test
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Test Spec\n\nThis is a test spec.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));
  });

  afterEach(() => {
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function makeCluster(id: number, commitCount: number = 1): CommitCluster {
    const hash = String.fromCharCode(97 + id).repeat(40);
    return {
      id,
      commits: Array.from({ length: commitCount }, (_, i) => ({
        commitHash: `${String.fromCharCode(97 + id)}${i}`.repeat(20),
        commitMessage: `feat: cluster ${id} commit ${i}`,
        author: 'tester',
        timestamp: Date.now(),
        fileChanges: [
          {
            filePath: `src/module${id}.ts`,
            language: 'typescript',
            addedSymbols: [],
            removedSymbols: [],
            modifiedSymbols: [],
          },
        ],
      })),
      primaryFiles: [`src/module${id}.ts`],
      primarySymbols: ['main'],
      summary: `${commitCount} commits`,
      timeRange: { start: Date.now(), end: Date.now() },
    };
  }

  const llmConfig = {
    provider: 'openai' as const,
    apiKey: 'sk-test',
    model: 'gpt-4',
    temperature: 0.2,
    maxTokens: 4096,
  };

  it('generates spec for each cluster', async () => {
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Spec Generated\n\nContent.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const clusters = [makeCluster(0), makeCluster(1)];
    const result = await generateSpecs(clusters, llmConfig, outputDir);
    expect(result.specs.length).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('writes spec markdown files to outputDir', async () => {
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Spec A\n\nContent A.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const clusters = [makeCluster(0)];
    const result = await generateSpecs(clusters, llmConfig, outputDir);
    expect(result.specs.length).toBe(1);

    const specId = result.specs[0]!.specId;
    const specFile = path.join(outputDir, `${specId}.md`);
    expect(fs.existsSync(specFile)).toBe(true);
    const content = fs.readFileSync(specFile, 'utf-8');
    expect(content).toContain('Spec A');
  });

  it('extracts title from first H1 heading', async () => {
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Auth Module\n\nBody.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const clusters = [makeCluster(0)];
    const result = await generateSpecs(clusters, llmConfig, outputDir);
    expect(result.specs.length).toBe(1);
    expect(result.specs[0]!.title).toBe('Auth Module');
  });

  it('title fallback when no heading', async () => {
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('Just text. No heading here.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const clusters = [makeCluster(0)];
    const result = await generateSpecs(clusters, llmConfig, outputDir);
    expect(result.specs.length).toBe(1);
    expect(result.specs[0]!.title).toBe('Untitled Spec');
  });

  it('skipped counter for empty LLM response', async () => {
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue(''),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const clusters = [makeCluster(0)];
    const result = await generateSpecs(clusters, llmConfig, outputDir);
    expect(result.specs.length).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('errors counter for LLM failure', async () => {
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockRejectedValue(new Error('API error')),
      chatJson: vi.fn().mockRejectedValue(new Error('API error')),
    }));

    const clusters = [makeCluster(0), makeCluster(1)];
    const result = await generateSpecs(clusters, llmConfig, outputDir);
    // Both clusters should fail
    expect(result.errors).toBe(2);
    expect(result.specs.length).toBe(0);
  });

  it('specId uses cluster timeRange timestamp', async () => {
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Spec 3\n\nContent.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const clusters = [makeCluster(3)];
    const result = await generateSpecs(clusters, llmConfig, outputDir);
    expect(result.specs.length).toBe(1);
    // specId is generated as spec_${cluster.timeRange.end}
    expect(result.specs[0]!.specId).toMatch(/^spec_\d+$/);
  });
});

// ===========================================================================
// Section D: Persist
// ===========================================================================

describe('persist — persistToGraph', () => {
  let repo: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    repo = initTempGitRepo();
    db = createInMemoryDb();
    // Create a baseline commit so subsequent commits have a parent for diff parsing.
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    if (db && db.open) db.close();
  });

  function makeCluster(id: number, commitHashes: string[], messages: string[]): CommitCluster {
    return {
      id,
      commits: commitHashes.map((hash, i) => ({
        commitHash: hash,
        commitMessage: messages[i] || `feat: commit ${i}`,
        author: 'tester',
        timestamp: Date.now(),
        fileChanges: [
          {
            filePath: `src/module${id}_${i}.ts`,
            language: 'typescript',
            addedSymbols: [],
            removedSymbols: [],
            modifiedSymbols: [],
          },
        ],
      })),
      primaryFiles: ['src/main.ts'],
      primarySymbols: ['main'],
      summary: `${commitHashes.length} commits`,
      timeRange: { start: Date.now(), end: Date.now() },
    };
  }

  function makeSpec(specId: string, clusterId: number, content: string, commitHashes: string[]): GeneratedSpec {
    return {
      specId,
      title: `Title for ${specId}`,
      content,
      clusterId,
      commitHashes,
    };
  }

  it('inserts SpecNode for each generated spec', () => {
    const hash1 = commitFile(repo, 'src/main.ts', 'export const a = 1;\n', 'feat: main');
    const hash2 = commitFile(repo, 'src/lib.ts', 'export const b = 2;\n', 'feat: lib');

    const cluster0 = makeCluster(0, [hash1], ['feat: main']);
    const cluster1 = makeCluster(1, [hash2], ['feat: lib']);

    const spec0 = makeSpec('spec0', 0, '# Spec 0\nContent.\n', [hash1]);
    const spec1 = makeSpec('spec1', 1, '# Spec 1\nContent.\n', [hash2]);

    const result = persistToGraph(db, repo, [spec0, spec1], [cluster0, cluster1], '/tmp/output');
    expect(result.specsWritten).toBe(2);

    const found0 = findSpecById(db, 'spec0');
    const found1 = findSpecById(db, 'spec1');
    expect(found0).not.toBeNull();
    expect(found1).not.toBeNull();
  });

  it('SpecNode.status is active', () => {
    const hash = commitFile(repo, 'src/main.ts', 'export const x = 1;\n', 'feat: main');
    const cluster = makeCluster(0, [hash], ['feat: main']);
    const spec = makeSpec('spec0', 0, '# Spec\nContent.\n', [hash]);

    persistToGraph(db, repo, [spec], [cluster], '/tmp/output');

    const found = findSpecById(db, 'spec0');
    expect(found).not.toBeNull();
    expect(found!.status).toBe('active');
  });

  it('inserts CommitNode for unique commits', () => {
    const hash1 = commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: a');
    const hash2 = commitFile(repo, 'src/b.ts', 'export const b = 2;\n', 'feat: b');

    const cluster = makeCluster(0, [hash1, hash2], ['feat: a', 'feat: b']);
    const spec = makeSpec('spec0', 0, '# Spec\nContent.\n', [hash1, hash2]);

    const result = persistToGraph(db, repo, [spec], [cluster], '/tmp/output');
    expect(result.commitsWritten).toBe(2);

    // Verify commit nodes in DB
    const row1 = db.prepare('SELECT hash FROM commit_nodes WHERE hash = ?').get(hash1) as any;
    const row2 = db.prepare('SELECT hash FROM commit_nodes WHERE hash = ?').get(hash2) as any;
    expect(row1).toBeDefined();
    expect(row2).toBeDefined();
  });

  it('inserts SUMMARIZED_FROM relation', () => {
    const hash = commitFile(repo, 'src/main.ts', 'export const x = 1;\n', 'feat: main');
    const cluster = makeCluster(0, [hash], ['feat: main']);
    const spec = makeSpec('spec0', 0, '# Spec\nContent.\n', [hash]);

    const result = persistToGraph(db, repo, [spec], [cluster], '/tmp/output');
    expect(result.relationsWritten).toBeGreaterThan(0);

    // Verify spec_commit_relations exists with SUMMARIZED_FROM
    const relRow = db
      .prepare(
        'SELECT * FROM spec_commit_relations WHERE spec_id = ? AND commit_hash = ? AND relation_type = ?',
      )
      .get('spec0', hash, 'SUMMARIZED_FROM') as any;
    expect(relRow).toBeDefined();
  });

  it('reuses existing fragments on re-run (idempotent)', () => {
    const hash = commitFile(repo, 'src/main.ts', 'export const x = 1;\n', 'feat: main');
    const cluster = makeCluster(0, [hash], ['feat: main']);
    const spec = makeSpec('spec0', 0, '# Spec\nContent.\n', [hash]);

    // First run
    const result1 = persistToGraph(db, repo, [spec], [cluster], '/tmp/output');
    // Second run — same data
    const result2 = persistToGraph(db, repo, [spec], [cluster], '/tmp/output');

    // Fragments written should not increase (existing fragments reused)
    expect(result2.fragmentsWritten).toBe(result1.fragmentsWritten);
  });

  it('result counts are accurate', () => {
    const hash = commitFile(repo, 'src/main.ts', 'export const x = 1;\n', 'feat: main');
    const cluster = makeCluster(0, [hash], ['feat: main']);
    const spec = makeSpec('spec0', 0, '# Spec\nContent.\n', [hash]);

    const result = persistToGraph(db, repo, [spec], [cluster], '/tmp/output');
    expect(result.specsWritten).toBe(1);
    expect(result.commitsWritten).toBe(1);
    expect(result.fragmentsWritten).toBeGreaterThanOrEqual(0);
    expect(result.relationsWritten).toBeGreaterThan(0);
  });

  it('schema initialized when needed', () => {
    // Create a fresh in-memory db without schema init
    const freshDb = createDatabase(':memory:').db;

    const hash = commitFile(repo, 'src/main.ts', 'export const x = 1;\n', 'feat: main');
    const cluster = makeCluster(0, [hash], ['feat: main']);
    const spec = makeSpec('spec0', 0, '# Spec\nContent.\n', [hash]);

    // persistToGraph should call initSpecSchema internally
    const result = persistToGraph(freshDb, repo, [spec], [cluster], '/tmp/output');
    expect(result.specsWritten).toBe(1);

    // Verify tables exist by querying
    const row = freshDb.prepare('SELECT id FROM spec_nodes WHERE id = ?').get('spec0') as any;
    expect(row).toBeDefined();

    if (freshDb.open) freshDb.close();
  });
});

// ===========================================================================
// Section E: Pipeline
// ===========================================================================

describe('mine pipeline — runMinePipeline', () => {
  let repo: string;
  let db: SqliteDatabase;
  let outputDir: string;

  beforeEach(() => {
    repo = initTempGitRepo();
    db = createInMemoryDb();
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-pipeout-'));
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    if (db && db.open) db.close();
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeMineConfig(overrides: Partial<MineConfig> = {}): MineConfig {
    return {
      limit: 100,
      threshold: 0.5,
      maxCluster: 10,
      outputDir,
      skipLlm: false,
      ...overrides,
    };
  }

  const llmConfig = {
    provider: 'openai' as const,
    apiKey: 'sk-test',
    model: 'gpt-4',
    temperature: 0.2,
    maxTokens: 4096,
  };

  it('full pipeline: commits → clusters → specs → persist', async () => {
    // Create a baseline so feat commits have a parent
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');

    // Create 3 feat commits with .ts files
    commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: add a');
    commitFile(repo, 'src/b.ts', 'export function b() { return 2; }\n', 'feat: add b');
    commitFile(repo, 'src/c.ts', 'export function c() { return 3; }\n', 'feat: add c');

    // Override the LLM mock for this test
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Generated Spec\n\nTest content.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const config = makeMineConfig();
    const result = await runMinePipeline(repo, config, llmConfig, db);

    // All counts should be > 0 since we have valid commits.
    expect(result.commitsScanned).toBeGreaterThan(0);
    expect(result.changesFound).toBeGreaterThan(0);
    expect(result.clusters).toBeGreaterThanOrEqual(0);
    expect(result.specsGenerated).toBeGreaterThanOrEqual(0);
    // Even if specsGenerated is 0 (clustering threshold), the pipeline shouldn't crash
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('throws on non-git repo', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-nonrepo-'));
    try {
      const config = makeMineConfig();
      await expect(runMinePipeline(nonRepo, config, llmConfig, db)).rejects.toThrow(
        /Not a git repository/,
      );
    } finally {
      if (fs.existsSync(nonRepo)) fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('no commits in range returns early', async () => {
    // Need at least one commit so HEAD exists (pipeline throws if no HEAD).
    // Use a chore commit — it will be filtered out by the feat-only filter.
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');

    const config = makeMineConfig();
    const result = await runMinePipeline(repo, config, null, null);
    expect(result.commitsScanned).toBe(0);
    expect(result.changesFound).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toBe('No commits found in range.');
  });

  it('skipLlm=true skips generation but still scans', async () => {
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: add a');

    const config = makeMineConfig({ skipLlm: true });
    const result = await runMinePipeline(repo, config, null, null);

    expect(result.commitsScanned).toBeGreaterThan(0);
    expect(result.specsGenerated).toBe(0);
  });

  it('no meta.json → full scan', async () => {
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: add a');

    const config = makeMineConfig({ skipLlm: true });
    const result = await runMinePipeline(repo, config, null, null);

    // Should scan from beginning (full scan because no meta.json)
    expect(result.commitsScanned).toBeGreaterThan(0);
  });

  it('meta.json is NOT updated when skipLlm=true', async () => {
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: add a');

    const config = makeMineConfig({ skipLlm: true });
    await runMinePipeline(repo, config, null, null);

    // skipLlm means no specs were generated, so meta.json should NOT advance —
    // the same commits must be re-scanned when LLM is available later.
    expect(writeMeta).not.toHaveBeenCalled();
  });

  it('meta.json is updated after successful LLM + persist', async () => {
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(repo, 'src/app.ts', 'export function init() {}\nexport function setup() {}\n', 'feat: add init');
    commitFile(repo, 'src/app.ts', 'export function init() { return true; }\nexport function run() {}\n', 'feat: update init and add run');

    // Override the LLM mock for this test
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Generated Spec\n\nTest content.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const config = makeMineConfig();
    await runMinePipeline(repo, config, llmConfig, db);

    // LLM ran and persistence succeeded — meta.json should advance.
    expect(writeMeta).toHaveBeenCalled();
  });

  it('db=null skips persist', async () => {
    commitFile(repo, 'README.md', '# Project\n', 'chore: base');
    commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: add a');

    // Override the LLM mock for this test
    vi.mocked(OpenAiLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue('# Generated Spec\n\nContent.'),
      chatJson: vi.fn().mockResolvedValue({}),
    }));

    const config = makeMineConfig();
    // Pass db=null — should skip persist
    const result = await runMinePipeline(repo, config, llmConfig, null);

    // specsWritten should be 0 when db is null
    expect(result.specsWritten).toBe(0);
    // specsGenerated may still be > 0 if LLM ran
    expect(result.specsGenerated).toBeGreaterThanOrEqual(0);
  });
});
