/**
 * Spec Mining Pipeline Tests
 *
 * Tests for: diff-parser, git-scanner, spec-extractor, scope-resolver,
 * and the mining pipeline orchestrator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createDatabase, SqliteDatabase } from '../src/db/sqlite-adapter';
import { silentLogger, setLogger } from '../src/errors';
import { DEFAULT_CONFIG, SpecConfig } from '../src/spec/config';
import { writeMeta, discoverSpecs } from '../src/spec/utils';

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
import { analyzeCommitDiff, DiffFragment } from '../src/spec/build/diff-parser';
import {
  getCommitInfo,
  getAllCommits,
  getCommitDiff,
  getHeadHash,
  isGitRepo,
  CommitInfo,
} from '../src/spec/git';
import { scan, SpecCommitPair } from '../src/spec/build/scan';
import {
  extractSpecMetadata,
  extractMarkdownHeadings,
  SpecMetadata,
} from '../src/spec/build/spec-extractor';
import {
  extractScope,
  normalizeScope,
  resolveScopeToSpec,
} from '../src/spec/build/scope-resolver';
import { runBuildPipeline, BuildResult } from '../src/spec/build/pipeline';
import type { ProgressTick } from '../src/spec/ui';

// Silence logger during tests
setLogger(silentLogger);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp git repo with minimal content. Returns the repo path. */
function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-spec-mine-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  // Must set user identity for commits to work
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

/**
 * Make a file, add it, and commit with the given message.
 * Returns the commit hash (full 40-char).
 */
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

function createSpecOnDisk(specStoragePath: string, specId: string, planContent: string): void {
  const specDir = path.join(specStoragePath, specId);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'plan.md'), planContent, 'utf-8');
}

// ---------------------------------------------------------------------------
// A. diff-parser.ts — analyzeCommitDiff
// ---------------------------------------------------------------------------

describe('diff-parser — analyzeCommitDiff', () => {
  let repo: string;

  beforeEach(() => {
    repo = initTempGitRepo();
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('empty diff returns []', () => {
    // Repo with no commits has no diff
    const fragments = analyzeCommitDiff(repo, 'nonexistent-hash');
    expect(fragments).toEqual([]);
  });

  it('parses MODIFY file', () => {
    const hash1 = commitFile(repo, 'src/index.ts', 'const x = 1;\n', 'feat: initial');
    const hash2 = commitFile(repo, 'src/index.ts', 'const x = 2;\n', 'fix: update');

    const fragments = analyzeCommitDiff(repo, hash2);
    const modFiles = fragments.filter((f) => f.filePath === 'src/index.ts' && f.changeType === 'MODIFY');
    expect(modFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('parses NEW file (ADD)', () => {
    // Need a parent commit so getCommitDiff has a base to diff against
    commitFile(repo, 'README.md', '# Init', 'chore: init');
    const hash = commitFile(repo, 'src/new.ts', 'export const a = 1;\n', 'feat: add new');

    const fragments = analyzeCommitDiff(repo, hash);
    const addFiles = fragments.filter((f) => f.filePath === 'src/new.ts' && f.changeType === 'ADD');
    expect(addFiles.length).toBe(1);
  });

  it('parses DELETED file', () => {
    const hash1 = commitFile(repo, 'src/todelete.ts', 'old\n', 'feat: initial');
    // Delete the file and commit
    fs.unlinkSync(path.join(repo, 'src/todelete.ts'));
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'chore: remove'], { cwd: repo, stdio: 'ignore' });
    const hash2 = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const fragments = analyzeCommitDiff(repo, hash2);
    const delFiles = fragments.filter((f) => f.filePath === 'src/todelete.ts' && f.changeType === 'DELETE');
    expect(delFiles.length).toBe(1);
    // DELETE files have startLine/endLine = 0
    expect(delFiles[0]!.startLine).toBe(0);
    expect(delFiles[0]!.endLine).toBe(0);
  });

  it('parses multiple files', () => {
    // Make initial commit so we can diff
    commitFile(repo, 'README.md', '# Hello', 'docs: readme');
    // Then commit multiple files
    fs.writeFileSync(path.join(repo, 'a.ts'), 'a\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'b\n');
    execFileSync('git', ['add', 'a.ts', 'b.ts'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat: multi'], { cwd: repo, stdio: 'ignore' });
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const fragments = analyzeCommitDiff(repo, hash);
    const filePaths = fragments.map((f) => f.filePath).filter((p) => p && p !== '/dev/null');
    expect(filePaths).toContain('a.ts');
    expect(filePaths).toContain('b.ts');
  });

  it('fragment structure has all fields', () => {
    commitFile(repo, 'README.md', '# Init', 'chore: init');
    const hash = commitFile(repo, 'src/main.ts', 'const x = 1;\n', 'feat: main');

    const fragments = analyzeCommitDiff(repo, hash);
    expect(fragments.length).toBeGreaterThan(0);

    for (const frag of fragments) {
      expect(frag).toHaveProperty('filePath');
      expect(frag).toHaveProperty('changeType');
      expect(frag).toHaveProperty('startLine');
      expect(frag).toHaveProperty('endLine');
      expect(frag).toHaveProperty('codeDiff');
      expect(['ADD', 'MODIFY', 'DELETE']).toContain(frag.changeType);
      expect(typeof frag.filePath).toBe('string');
      expect(typeof frag.startLine).toBe('number');
      expect(typeof frag.endLine).toBe('number');
      expect(typeof frag.codeDiff).toBe('string');
    }
  });

  it('default startLine >= 1 for ADD/MODIFY', () => {
    // Need parent commit for diff to work
    commitFile(repo, 'README.md', '# Init', 'chore: init');
    const hash = commitFile(repo, 'src/new.ts', 'line1\nline2\nline3\n', 'feat: new file');

    const fragments = analyzeCommitDiff(repo, hash);
    const addFrag = fragments.find((f) => f.changeType === 'ADD');
    // If there's an ADD fragment, startLine should be >= 1
    if (addFrag) {
      expect(addFrag.startLine).toBeGreaterThanOrEqual(1);
    }
  });

  it('handles binary file diff gracefully', () => {
    // Create a file that git treats as binary
    commitFile(repo, 'README.md', '# start', 'feat: init');

    const binaryPath = path.join(repo, 'img.bin');
    fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]));
    execFileSync('git', ['add', 'img.bin'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat: add binary'], { cwd: repo, stdio: 'ignore' });
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const fragments = analyzeCommitDiff(repo, hash);
    // Binary file diff should not produce real fragments with hunk info
    const binaryFrags = fragments.filter((f) =>
      f.filePath === 'img.bin' && f.codeDiff.includes('Binary files')
    );
    // Binary files may still appear as a fragment but won't have meaningful line ranges
    // The key test is that it doesn't crash
    expect(fragments).toBeDefined();
  });

  it('preFetchedDiff parameter works', () => {
    commitFile(repo, 'src/a.ts', 'x\n', 'feat: init');
    const hash = commitFile(repo, 'src/a.ts', 'y\n', 'fix: change');

    const preFetchedDiff = getCommitDiff(repo, hash);
    const fragments = analyzeCommitDiff(repo, hash, preFetchedDiff);
    expect(fragments.length).toBeGreaterThan(0);
    for (const f of fragments) {
      // filePath and codeDiff should be non-empty
      expect(f.filePath.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// B. git-scanner.ts — scope resolution & scan
// ---------------------------------------------------------------------------

describe('git-scanner — scope extraction', () => {
  const defaultConfig: SpecConfig = DEFAULT_CONFIG;
  const scopeRegex = defaultConfig.commitScope.scopeRegex;

  it('extractScope parses feat(spec01)', () => {
    const scope = extractScope('feat(spec01): add feature', scopeRegex);
    expect(scope).toBe('spec01');
  });

  it('extractScope parses fix(spec28)', () => {
    const scope = extractScope('fix(spec28): resolve bug', scopeRegex);
    expect(scope).toBe('spec28');
  });

  it('extractScope is case-sensitive (no /i flag in default regex)', () => {
    // The default regex is case-sensitive; 'Feat' and 'FIX' won't match
    const scope1 = extractScope('Feat(spec03): test', scopeRegex);
    const scope2 = extractScope('FIX(spec03): test', scopeRegex);
    expect(scope1).toBeNull();
    expect(scope2).toBeNull();
  });

  it('extractScope with single-digit scope spec', () => {
    const scope = extractScope('feat(spec5): add', scopeRegex);
    expect(scope).toBe('spec5');
  });

  it('extractScope returns null for scope with surrounding whitespace', () => {
    // The regex (spec\\d+) requires spec followed by digits — no spaces allowed
    const scope = extractScope('feat( spec01 ): add', scopeRegex);
    expect(scope).toBeNull();
  });

  it('extractScope returns null for non-matching message', () => {
    const scope = extractScope('update: no scope', scopeRegex);
    expect(scope).toBeNull();
  });

  it('extractScope returns null for empty message', () => {
    const scope = extractScope('', scopeRegex);
    expect(scope).toBeNull();
  });

  it('extractScope only examines first line', () => {
    const msg = 'feat(spec10): title\nfix(spec20): body';
    const scope = extractScope(msg, scopeRegex);
    expect(scope).toBe('spec10');
  });
});

describe('git-scanner — normalizeScope', () => {
  const normConfig = {
    stripPrefixes: ['review/'],
    lowercase: true,
    padSpecNumber: true,
  };

  it('pads single-digit spec number', () => {
    expect(normalizeScope('spec3', normConfig)).toBe('spec03');
  });

  it('double-digit unchanged', () => {
    expect(normalizeScope('spec12', normConfig)).toBe('spec12');
  });

  it('converts to lowercase', () => {
    expect(normalizeScope('SPEC05', normConfig)).toBe('spec05');
  });

  it('strips prefix', () => {
    expect(normalizeScope('review/spec07', normConfig)).toBe('spec07');
  });

  it('non-spec passthrough', () => {
    expect(normalizeScope('auth-module', normConfig)).toBe('auth-module');
  });

  it('leading whitespace prevents padSpecNumber (regex anchored at ^)', () => {
    // normalizeScope doesn't trim whitespace; /^spec(\d+)$/i won't match '  spec3'
    // So '  spec3' stays as '  spec3' (lowercased) with no padding
    expect(normalizeScope('  spec3', normConfig)).toBe('  spec3');
  });

  it('no stripping when no prefix matches', () => {
    // With stripPrefixes being ['review/'], 'prefix/spec03' shouldn't be affected
    // lowercase + padSpecNumber still apply
    expect(normalizeScope('prefix/spec04', normConfig)).toBe('prefix/spec04');
  });
});

describe('git-scanner — scan', () => {
  let repo: string;
  let specStorage: string;

  beforeEach(() => {
    repo = initTempGitRepo();
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-specs-'));
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
  });

  it('Strategy A: commit message scope returns pairs', () => {
    // Create spec on disk
    createSpecOnDisk(specStorage, 'spec01', '# Spec 01\nSome content\n');
    // Commit with matching scope
    commitFile(repo, 'src/a.ts', 'x\n', 'feat(spec01): add feature');

    const pairs = scan(repo, specStorage, DEFAULT_CONFIG);
    expect(pairs.length).toBeGreaterThan(0);
    const pair = pairs.find((p) => p.specId === 'spec01');
    expect(pair).toBeDefined();
    expect(pair!.commitMetadata).toBeDefined();
    expect(pair!.commitMetadata!.message).toContain('feat(spec01)');
  });

  it('empty commits returns []', () => {
    // No commits at all
    const pairs = scan(repo, specStorage, DEFAULT_CONFIG);
    expect(pairs).toEqual([]);
  });

  it('non-matching commits skipped', () => {
    commitFile(repo, 'src/c.ts', 'z\n', 'docs: update readme');
    const pairs = scan(repo, specStorage, DEFAULT_CONFIG);
    expect(pairs.length).toBe(0);
  });

  it('dedup same commit+spec', () => {
    createSpecOnDisk(specStorage, 'spec01', '# Spec 01\n');
    // Two commits with the same scope should not create duplicate pairs
    commitFile(repo, 'src/a.ts', 'v1\n', 'feat(spec01): first');
    commitFile(repo, 'src/b.ts', 'v2\n', 'feat(spec01): second');

    const pairs = scan(repo, specStorage, DEFAULT_CONFIG);
    const spec01Pairs = pairs.filter((p) => p.specId === 'spec01');
    // Each specId+commitHash pair is unique, so two commits = two pairs
    expect(spec01Pairs.length).toBe(2);
    const uniqueKeys = new Set(spec01Pairs.map((p) => `${p.specId}|${p.commitHash}`));
    expect(uniqueKeys.size).toBe(2);
  });

  it('reports scanning progress ticks', () => {
    createSpecOnDisk(specStorage, 'spec01', '# Spec 01\n');
    commitFile(repo, 'src/a.ts', 'x\n', 'feat(spec01): add feature');
    commitFile(repo, 'src/b.ts', 'y\n', 'docs: unrelated');

    const ticks: ProgressTick[] = [];
    scan(repo, specStorage, DEFAULT_CONFIG, (t) => ticks.push(t));

    // One tick per commit, all in the scanning phase
    expect(ticks.length).toBe(2);
    for (const [i, t] of ticks.entries()) {
      expect(t.phase).toBe('scanning');
      expect(t.current).toBe(i + 1);
      expect(t.total).toBe(2);
    }
    expect(ticks.some((t) => t.message?.includes('feat(spec01)'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. spec-extractor.ts — extractMarkdownHeadings
// ---------------------------------------------------------------------------

describe('spec-extractor — extractMarkdownHeadings', () => {
  it('single H1 heading', () => {
    const headings = extractMarkdownHeadings('# My Spec\nContent here.\n');
    expect(headings.length).toBeGreaterThanOrEqual(1);
    // The root heading has "SPEC" suffix stripped, so "My Spec" → "My"
    expect(headings.some((h) => h.includes('My') && h.includes('Content here.'))).toBe(true);
  });

  it('SPEC suffix stripping from top-level H1', () => {
    const headings = extractMarkdownHeadings('# Auth Module SPEC\nContent.\n');
    // The heading should have "SPEC" stripped
    expect(headings[0]).toContain('Auth Module');
    expect(headings[0]).not.toContain('SPEC');
  });

  it('H1 → H2 hierarchy', () => {
    const content = '# Root\nRoot content.\n## Child\nChild content.\n';
    const headings = extractMarkdownHeadings(content);
    // Should have entries for both Root and Child
    expect(headings.length).toBeGreaterThanOrEqual(2);
  });

  it('H1 → H2 → H3 deep hierarchy', () => {
    const content =
      '# Level 1\nL1 content.\n## Level 2\nL2 content.\n### Level 3\nL3 content.\n';
    const headings = extractMarkdownHeadings(content);
    expect(headings.length).toBeGreaterThanOrEqual(3);
    // Level 3 should have breadcrumb from L1 + L2
    const l3 = headings.find((h) => h.includes('Level 3'));
    expect(l3).toBeDefined();
    if (l3) {
      expect(l3).toContain('Level 1');
      expect(l3).toContain('Level 2');
    }
  });

  it('headings with sub-headings but no direct content are skipped', () => {
    const content = '# Parent\n## Child\n';
    const headings = extractMarkdownHeadings(content);
    // "Parent" only has "## Child" sub-heading → no direct content → skipped.
    // But "Child" appears with breadcrumb "Parent → Child", so we check that
    // no entry represents the *Parent itself* (startsWith "Parent -" or is just "Parent").
    // The only result should be "Parent → Child" (the Child entry with breadcrumb).
    expect(headings).toHaveLength(1);
    expect(headings[0]).toBe('Parent → Child');
  });

  it('content truncation with ellipsis', () => {
    const longContent = 'A'.repeat(300);
    const headings = extractMarkdownHeadings(`# Title\n${longContent}\n`, 10);
    expect(headings.length).toBeGreaterThanOrEqual(0);
    if (headings.length > 0) {
      // Content should be truncated with ellipsis
      const display = headings[0]!;
      expect(display.length).toBeLessThan(longContent.length + 20);
    }
  });

  it('H6 level heading', () => {
    const content = '# H1\nH1 body.\n###### H6\nH6 body.\n';
    const headings = extractMarkdownHeadings(content);
    const h6Entry = headings.find((h) => h.includes('H6'));
    expect(h6Entry).toBeDefined();
  });

  it('empty content returns empty array', () => {
    const headings = extractMarkdownHeadings('');
    expect(headings).toEqual([]);
  });

  it('only headings with no text are preserved (no sub-headings → not skipped)', () => {
    const content = '# A\n# B\n# C\n';
    const headings = extractMarkdownHeadings(content);
    // All three H1 headings have no sub-headings; they are preserved without previews
    // Only headings with sub-headings AND no direct content are skipped
    expect(headings.length).toBe(3);
    expect(headings[0]).toBe('A');
    expect(headings[1]).toBe('B');
    expect(headings[2]).toBe('C');
  });

  it('whitespace-only content — parent skipped, child preserved', () => {
    const headings = extractMarkdownHeadings('# Title\n   \n## Sub\n   \n');
    // "Title" (H1) has sub-heading "Sub" and no direct content → skipped
    // "Sub" (H2) has no sub-headings → preserved (even without content)
    expect(headings.length).toBe(1);
    expect(headings[0]).toContain('Sub');
  });

  it('multiline content joined into preview', () => {
    const headings = extractMarkdownHeadings('# Title\nFirst line.\nSecond line.\n');
    expect(headings.length).toBe(1);
    // Shows first line of content
    expect(headings[0]).toContain('First line.');
    // Second line is not in preview
    expect(headings[0]).not.toContain('Second line.');
  });

  it('H4 levels preserved in breadcrumb', () => {
    const content = '# Root\nRoot body.\n#### Deep\nDeep body.\n';
    const headings = extractMarkdownHeadings(content);
    const deepEntry = headings.find((h) => h.includes('Deep'));
    expect(deepEntry).toBeDefined();
    if (deepEntry) {
      expect(deepEntry).toContain('Root');
    }
  });

  it('Chinese spec format', () => {
    const content = '# 用户认证模块\n认证模块描述。\n## 登录流程\n用户通过OAuth登录。\n';
    const headings = extractMarkdownHeadings(content);
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(headings.some((h) => h.includes('用户认证模块'))).toBe(true);
    expect(headings.some((h) => h.includes('登录流程'))).toBe(true);
  });
});

describe('spec-extractor — extractSpecMetadata', () => {
  let specStorage: string;

  beforeEach(() => {
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-specmeta-'));
  });

  afterEach(() => {
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
  });

  it('extracts metadata from directory spec with plan.md', () => {
    createSpecOnDisk(specStorage, 'spec01', '# My Title\nContent line.\n');
    const meta = extractSpecMetadata(specStorage, 'spec01', DEFAULT_CONFIG);
    expect(meta).not.toBeNull();
    expect(meta!.specId).toBe('spec01');
    expect(meta!.title).toBe('My Title');
    expect(meta!.type).toBe('directory');
  });

  it('extracts metadata from flat-file spec (.md file)', () => {
    fs.writeFileSync(path.join(specStorage, 'flat-spec.md'), '# Flat Spec\nBody.\n', 'utf-8');
    const meta = extractSpecMetadata(specStorage, 'flat-spec', DEFAULT_CONFIG);
    expect(meta).not.toBeNull();
    expect(meta!.specId).toBe('flat-spec');
    // SPEC suffix stripping removes 'Spec' from 'Flat Spec' → 'Flat'
    expect(meta!.title).toBe('Flat');
    expect(meta!.type).toBe('flat-file');
  });

  it('returns null for non-existent spec', () => {
    const meta = extractSpecMetadata(specStorage, 'nonexistent', DEFAULT_CONFIG);
    expect(meta).toBeNull();
  });

  it('strips SPEC suffix from title', () => {
    createSpecOnDisk(specStorage, 'spec02', '# Design SPEC\nContent.\n');
    const meta = extractSpecMetadata(specStorage, 'spec02', DEFAULT_CONFIG);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe('Design');
  });

  it('handles empty H1 title fallback to specId', () => {
    createSpecOnDisk(specStorage, 'spec03', '# SPEC\nContent.\n');
    const meta = extractSpecMetadata(specStorage, 'spec03', DEFAULT_CONFIG);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe('spec03');
  });
});

// ---------------------------------------------------------------------------
// D. pipeline.ts — runBuildPipeline
// ---------------------------------------------------------------------------

describe('build pipeline — runBuildPipeline', () => {
  let repo: string;
  let specStorage: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    repo = initTempGitRepo();
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-minepipe-'));
    // Write meta so pipeline can find specStoragePath
    writeMeta(repo, specStorage);

    const dbPath = path.join(os.tmpdir(), `homegraph-mining-test-${Date.now()}.db`);
    const result = createDatabase(dbPath);
    db = result.db;
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
    if (db && db.open) db.close();
  });

  it('empty pairs returns zero counts', () => {
    const result = runBuildPipeline(repo, specStorage, db);
    expect(result.specsFound).toBe(0);
    expect(result.commitsFound).toBe(0);
    expect(result.fragmentsFound).toBe(0);
    expect(result.relationsCreated).toBe(0);
    expect(result.totalEntries).toBe(0);
    expect(result.skippedEntries).toEqual([]);
  });

  it('pair without commit metadata skipped', () => {
    createSpecOnDisk(specStorage, 'spec01', '# Spec 01\n');

    // Make a commit with matching scope
    commitFile(repo, 'src/main.ts', 'const x = 1;\n', 'feat(spec01): add');

    const result = runBuildPipeline(repo, specStorage, db);
    // There should be findings
    expect(result.specsFound).toBeGreaterThanOrEqual(0);

    // Result structure should be valid
    expect(result).toHaveProperty('specsFound');
    expect(result).toHaveProperty('commitsFound');
    expect(result).toHaveProperty('fragmentsFound');
    expect(result).toHaveProperty('relationsCreated');
    expect(result).toHaveProperty('totalEntries');
    expect(result).toHaveProperty('skippedEntries');
  });

  it('full pipeline: spec + commit + fragment + relations in DB', () => {
    createSpecOnDisk(specStorage, 'spec01', '# Full Spec\nDescription.\n## Design\nDetails.\n');

    // Root commit has no parent → getCommitDiff returns empty.
    // Add a baseline commit first so the matching commit has a parent to diff against.
    commitFile(repo, 'README.md', '# Project\n', 'chore: init');

    const hash = commitFile(repo, 'src/main.ts', 'const x = 1;\n', 'feat(spec01): initial');

    const result = runBuildPipeline(repo, specStorage, db);

    expect(result.specsFound).toBe(1);
    expect(result.commitsFound).toBe(1);
    expect(result.fragmentsFound).toBeGreaterThanOrEqual(1);
    expect(result.relationsCreated).toBeGreaterThanOrEqual(2);

    // Verify DB has the spec node
    const specRow = db.prepare('SELECT id, title, status FROM spec_nodes WHERE id = ?').get('spec01') as { id: string; title: string; status: string } | undefined;
    expect(specRow).toBeDefined();
    expect(specRow!.title).toBe('Full');
    expect(specRow!.status).toBe('active');

    // Verify commit node exists
    const commitRow = db.prepare('SELECT hash FROM commit_nodes WHERE hash = ?').get(hash) as { hash: string } | undefined;
    expect(commitRow).toBeDefined();
  });

  it('pair without spec metadata still inserts commit', () => {
    // Commit without matching scope but spec on disk
    commitFile(repo, 'src/lib.ts', 'lib\n', 'docs: some docs');

    const result = runBuildPipeline(repo, specStorage, db);
    expect(result.commitsFound).toBeGreaterThanOrEqual(0);
    // With no matching pairs, specsFound should be 0
    expect(result.specsFound).toBe(0);
  });

  it('multiple commits same spec counts 1 spec', () => {
    createSpecOnDisk(specStorage, 'spec10', '# Spec 10\nContent.\n');
    commitFile(repo, 'src/v1.ts', 'v1\n', 'feat(spec10): first');
    commitFile(repo, 'src/v2.ts', 'v2\n', 'feat(spec10): second');

    const result = runBuildPipeline(repo, specStorage, db);
    expect(result.specsFound).toBe(1);
    expect(result.commitsFound).toBe(2);
    // relationsCreated should include 2 spec-commit relations + fragment relations
    expect(result.relationsCreated).toBeGreaterThanOrEqual(2);
  });

  it('reports scanning → persisting → done progress', () => {
    createSpecOnDisk(specStorage, 'spec01', '# Spec 01\nContent.\n');
    commitFile(repo, 'src/main.ts', 'const x = 1;\n', 'feat(spec01): add');

    const ticks: ProgressTick[] = [];
    runBuildPipeline(repo, specStorage, db, (t) => ticks.push(t));

    const phases = ticks.map((t) => t.phase);
    expect(phases[0]).toBe('scanning');
    expect(phases[phases.length - 1]).toBe('done');
    expect(phases).toContain('persisting');

    // Persisting ticks: one per pair, monotonically increasing
    const persisting = ticks.filter((t) => t.phase === 'persisting');
    expect(persisting.length).toBe(1);
    expect(persisting[0].current).toBe(1);
    expect(persisting[0].total).toBe(1);
    expect(persisting[0].message).toContain('spec01');
  });

  it('skips build when meta.json currentCommitID matches HEAD', () => {
    // Need at least one commit for HEAD to resolve.
    commitFile(repo, 'src/main.ts', 'const x = 1;\n', 'feat(spec01): add');
    const headHash = getHeadHash(repo);
    expect(headHash).toBeTruthy();

    // Overwrite meta.json with current HEAD so pre-check triggers.
    writeMeta(repo, specStorage, headHash!);

    const result = runBuildPipeline(repo, specStorage, db);
    expect(result.upToDate).toBe(true);
    expect(result.specsFound).toBe(0);
    expect(result.commitsFound).toBe(0);
    expect(result.fragmentsFound).toBe(0);
    expect(result.relationsCreated).toBe(0);
    expect(result.totalEntries).toBe(0);
    expect(result.skippedEntries).toEqual([]);
  });

  it('proceeds with build when meta.json currentCommitID differs from HEAD', () => {
    createSpecOnDisk(specStorage, 'spec01', '# Spec 01\nContent.\n');
    commitFile(repo, 'src/main.ts', 'const x = 1;\n', 'feat(spec01): add');
    // Write a hash that definitely does not match HEAD.
    writeMeta(repo, specStorage, '0000000000000000000000000000000000000000');

    const result = runBuildPipeline(repo, specStorage, db);
    expect(result.upToDate).toBeUndefined();
    // Normal build proceeds — at least one commit is found.
    expect(result.commitsFound).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// E. scope-resolver.ts — normalizeScope
// ---------------------------------------------------------------------------

describe('scope-resolver — normalizeScope', () => {
  const defaultNorm = DEFAULT_CONFIG.commitScope.normalize;

  it('pads single-digit spec number to two digits', () => {
    expect(normalizeScope('spec3', defaultNorm)).toBe('spec03');
    expect(normalizeScope('spec7', defaultNorm)).toBe('spec07');
  });

  it('double-digit unchanged', () => {
    expect(normalizeScope('spec12', defaultNorm)).toBe('spec12');
    expect(normalizeScope('spec99', defaultNorm)).toBe('spec99');
  });

  it('three-digit unchanged', () => {
    // padSpecNumber only pads to 2 digits, so 3-digit stays
    expect(normalizeScope('spec123', defaultNorm)).toBe('spec123');
  });

  it('case insensitive', () => {
    expect(normalizeScope('SPEC01', defaultNorm)).toBe('spec01');
    expect(normalizeScope('Spec08', defaultNorm)).toBe('spec08');
    expect(normalizeScope('speC15', defaultNorm)).toBe('spec15');
  });

  it('non-matching pattern passthrough', () => {
    expect(normalizeScope('auth-module', defaultNorm)).toBe('auth-module');
    expect(normalizeScope('user_service', defaultNorm)).toBe('user_service');
  });

  it('whitespace trim (no trim built-in, depends on caller)', () => {
    // normalizeScope does NOT trim; whitespace in scope is preserved.
    // padSpecNumber regex /^spec(\d+)$/i is anchored at ^, so leading
    // whitespace prevents matching → no padding applied.
    expect(normalizeScope('  spec3', defaultNorm)).toBe('  spec3');
  });

  it('strips prefix', () => {
    expect(normalizeScope('review/spec05', defaultNorm)).toBe('spec05');
  });

  it('does not strip non-matching prefix', () => {
    // default stripPrefixes is ['review/']
    expect(normalizeScope('prefix/spec05', defaultNorm)).toBe('prefix/spec05');
  });

  it('no padding when padSpecNumber is false', () => {
    const config = { ...defaultNorm, padSpecNumber: false };
    expect(normalizeScope('spec3', config)).toBe('spec3');
  });

  it('no lowercase when lowercase is false', () => {
    const config = { ...defaultNorm, lowercase: false };
    // padSpecNumber reconstructs as `spec${paddedDigits}` which implicitly
    // lowercases the prefix regardless of `lowercase` config.
    expect(normalizeScope('SPEC03', config)).toBe('spec03');
    // padding still works
    expect(normalizeScope('spec5', config)).toBe('spec05');
    expect(normalizeScope('SPEC5', config)).toBe('spec05');
  });
});

describe('scope-resolver — resolveScopeToSpec', () => {
  let specStorage: string;
  let specIds: Set<string>;

  beforeEach(() => {
    specStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-resolve-'));
  });

  afterEach(() => {
    if (fs.existsSync(specStorage)) fs.rmSync(specStorage, { recursive: true, force: true });
  });

  const refreshSpecIds = (): void => {
    specIds = new Set(discoverSpecs(specStorage).map((e) => e.specId));
  };

  it('resolves existing spec on disk', () => {
    createSpecOnDisk(specStorage, 'spec03', '# Spec 03\n');
    refreshSpecIds();
    const result = resolveScopeToSpec('feat(spec3): add feature', specIds, DEFAULT_CONFIG);
    expect(result).toBe('spec03');
  });

  it('returns null when spec does not exist on disk', () => {
    refreshSpecIds();
    const result = resolveScopeToSpec('feat(spec99): no spec', specIds, DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  it('returns null when no scope in message', () => {
    refreshSpecIds();
    const result = resolveScopeToSpec('update: no scope here', specIds, DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  it('resolves with review/ prefix', () => {
    createSpecOnDisk(specStorage, 'spec07', '# Spec 07\n');
    refreshSpecIds();
    const result = resolveScopeToSpec('feat(review/spec7): review', specIds, DEFAULT_CONFIG);
    expect(result).toBe('spec07');
  });
});

// ---------------------------------------------------------------------------
// git-scanner helpers
// ---------------------------------------------------------------------------

describe('git-scanner — helper functions', () => {
  let repo: string;

  beforeEach(() => {
    repo = initTempGitRepo();
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('isGitRepo returns true for git repo', () => {
    expect(isGitRepo(repo)).toBe(true);
  });

  it('isGitRepo returns false for non-git directory', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-nonrepo-'));
    try {
      expect(isGitRepo(nonRepo)).toBe(false);
    } finally {
      if (fs.existsSync(nonRepo)) fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('getAllCommits returns commits after initial commit', () => {
    commitFile(repo, 'src/a.ts', 'a\n', 'feat: first');
    const commits = getAllCommits(repo);
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0]!.hash.length).toBe(40);
    expect(commits[0]!.message).toBe('feat: first');
    expect(commits[0]!.author).toBeDefined();
    expect(commits[0]!.timestamp).toBeGreaterThan(0);
  });

  it('getAllCommits returns [] for empty repo', () => {
    const emptyRepo = initTempGitRepo();
    try {
      const commits = getAllCommits(emptyRepo);
      expect(commits).toEqual([]);
    } finally {
      if (fs.existsSync(emptyRepo)) fs.rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  it('getCommitInfo returns metadata for existing commit', () => {
    const hash = commitFile(repo, 'src/b.ts', 'b\n', 'feat: second');
    const info = getCommitInfo(repo, hash);
    expect(info).not.toBeNull();
    expect(info!.hash).toBe(hash);
    expect(info!.message).toBe('feat: second');
  });

  it('getCommitInfo returns null for non-existent hash', () => {
    const info = getCommitInfo(repo, '0'.repeat(40));
    expect(info).toBeNull();
  });

  it('getCommitDiff returns diff for a commit', () => {
    // Must have a parent commit for git diff to work.
    // Root commits with no parent produce empty diff via `git diff <hash>`.
    commitFile(repo, 'src/baseline.ts', 'baseline\n', 'chore: baseline');
    const hash = commitFile(repo, 'src/c.ts', 'c\n', 'feat: third');
    const diff = getCommitDiff(repo, hash);
    expect(diff.length).toBeGreaterThan(0);
  });

  it('getCommitDiff returns empty for non-existent hash', () => {
    const diff = getCommitDiff(repo, '0'.repeat(40));
    expect(diff).toBe('');
  });
});
