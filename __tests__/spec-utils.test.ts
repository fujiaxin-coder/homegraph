/**
 * Spec Utility Tests
 *
 * Comprehensive tests for spec utility functions from:
 *   - src/spec/utils.ts (file I/O, commit-info parsing, meta r/w, db path,
 *     budget profile, truncation, spec discovery)
 *   - src/spec/config.ts (config loading)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Mocks — hoisted by Vitest so they run before any imports
// ---------------------------------------------------------------------------

vi.mock('../src/errors', () => ({
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import {
  readFileContent,
  writeFileContent,
  parseCommitInfoMd,
  readMeta,
  writeMeta,
  resolveDbPath,
  computeBudgetProfile,
  truncateText,
  truncateCodeDiff,
  truncateSubtitles,
  discoverSpecs,
  SPEC_DATA_DIR,
} from '../src/spec/utils';
import type { SpecMeta, SpecEntry, BudgetProfile } from '../src/spec/utils';
import { loadSpecConfig } from '../src/spec/config';
import type { SpecConfig } from '../src/spec/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// readFileContent
// ---------------------------------------------------------------------------

describe('readFileContent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should read a UTF-8 file', () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(filePath, 'Hello, world!', 'utf-8');
    expect(readFileContent(filePath)).toBe('Hello, world!');
  });

  it('should read a file with Unicode content', () => {
    const filePath = path.join(tmpDir, 'unicode.txt');
    fs.writeFileSync(filePath, 'こんにちは世界 🌍', 'utf-8');
    expect(readFileContent(filePath)).toBe('こんにちは世界 🌍');
  });

  it('should return null for ENOENT (file not found)', () => {
    const filePath = path.join(tmpDir, 'nonexistent.txt');
    expect(readFileContent(filePath)).toBeNull();
  });

  it('should return null for EISDIR (path is a directory)', () => {
    const dirPath = path.join(tmpDir, 'mydir');
    fs.mkdirSync(dirPath);
    expect(readFileContent(dirPath)).toBeNull();
  });

  it('should return null for EACCES (permission denied)', () => {
    const filePath = path.join(tmpDir, 'noperm.txt');
    fs.writeFileSync(filePath, 'secret', 'utf-8');
    fs.chmodSync(filePath, 0o000); // remove all permissions
    try {
      expect(readFileContent(filePath)).toBeNull();
    } finally {
      // Restore permissions so cleanup works
      fs.chmodSync(filePath, 0o644);
    }
  });
});

// ---------------------------------------------------------------------------
// writeFileContent
// ---------------------------------------------------------------------------

describe('writeFileContent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should write content to a file', () => {
    const filePath = path.join(tmpDir, 'output.txt');
    writeFileContent(filePath, 'Hello, world!');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Hello, world!');
  });

  it('should create parent directories if they do not exist', () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt');
    writeFileContent(filePath, 'nested content');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('nested content');
  });

  it('should overwrite an existing file', () => {
    const filePath = path.join(tmpDir, 'overwrite.txt');
    fs.writeFileSync(filePath, 'original', 'utf-8');
    writeFileContent(filePath, 'updated');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated');
  });

  it('should write Unicode content', () => {
    const filePath = path.join(tmpDir, 'unicode.txt');
    writeFileContent(filePath, 'こんにちは 🌍');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('こんにちは 🌍');
  });

  it('should write an empty string', () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    writeFileContent(filePath, '');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseCommitInfoMd
// ---------------------------------------------------------------------------

describe('parseCommitInfoMd', () => {
  it('should parse "commit: <hash>" format', () => {
    expect(parseCommitInfoMd('commit: abc1234')).toBe('abc1234');
  });

  it('should parse "commit-id: <hash>" format', () => {
    expect(parseCommitInfoMd('commit-id: abc1234')).toBe('abc1234');
  });

  it('should parse "commit_id: <hash>" format', () => {
    expect(parseCommitInfoMd('commit_id: abc1234')).toBe('abc1234');
  });

  it('should parse "commit = <hash>" format', () => {
    expect(parseCommitInfoMd('commit = abc1234')).toBe('abc1234');
  });

  it('should parse a bare 40-char hex hash on its own line', () => {
    const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    expect(parseCommitInfoMd(hash)).toBe(hash);
  });

  it('should parse a short 7-char hash', () => {
    expect(parseCommitInfoMd('commit: abc1234')).toBe('abc1234');
  });

  it('should parse case-insensitively and lowercase the result', () => {
    // The implementation calls .toLowerCase() on the matched hash.
    expect(parseCommitInfoMd('Commit: ABC1234')).toBe('abc1234');
  });

  it('should handle whitespace around delimiters', () => {
    // Multiple spaces after the delimiter are consumed by \s*
    expect(parseCommitInfoMd('commit:   abc1234')).toBe('abc1234');
    // Leading/trailing whitespace on the line is trimmed
    expect(parseCommitInfoMd('  commit: abc1234  ')).toBe('abc1234');
  });

  it('should not match when spaces appear before the delimiter', () => {
    // The regex requires the delimiter (:, =, or space) to immediately
    // follow the optional "id" suffix; extra spaces before ":" break it.
    expect(parseCommitInfoMd('commit   :   abc1234')).toBeNull();
  });

  it('should skip blank lines', () => {
    const content = '\n\ncommit: abc1234\n\n';
    expect(parseCommitInfoMd(content)).toBe('abc1234');
  });

  it('should ignore irrelevant lines', () => {
    const content = 'Some description\nAuthor: someone\ncommit: abc1234\nDate: today';
    expect(parseCommitInfoMd(content)).toBe('abc1234');
  });

  it('should return null for empty string', () => {
    expect(parseCommitInfoMd('')).toBeNull();
  });

  it('should return null for whitespace-only string', () => {
    expect(parseCommitInfoMd('   \n  \n  ')).toBeNull();
  });

  it('should return null when no hash is present', () => {
    expect(parseCommitInfoMd('Some random text\nwithout any hash')).toBeNull();
  });

  it('should return the first hash when multiple are present', () => {
    const content = 'commit: abc1234\ncommit: def5678';
    expect(parseCommitInfoMd(content)).toBe('abc1234');
  });

  it('should not match a hash shorter than 7 characters', () => {
    expect(parseCommitInfoMd('commit: abc12')).toBeNull();
  });

  it('should not match a hash longer than 40 characters', () => {
    const hash = 'a'.repeat(41);
    expect(parseCommitInfoMd(`commit: ${hash}`)).toBeNull();
  });

  it('should parse "commit:<hash>" (no space after colon)', () => {
    // `[:= ]` matches colon, then `\s*` matches zero spaces, then hash.
    expect(parseCommitInfoMd('commit:abc1234')).toBe('abc1234');
  });
});

// ---------------------------------------------------------------------------
// readMeta
// ---------------------------------------------------------------------------

describe('readMeta', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should read a valid meta.json and return SpecMeta', () => {
    const metaDir = path.join(tmpDir, SPEC_DATA_DIR);
    fs.mkdirSync(metaDir, { recursive: true });
    const meta: SpecMeta = {
      repoPath: '/some/repo',
      specStoragePath: '/some/repo/specs',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(metaDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
    const result = readMeta(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe('/some/repo');
    expect(result!.specStoragePath).toBe('/some/repo/specs');
    expect(result!.createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result!.updatedAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('should return null when meta.json does not exist', () => {
    expect(readMeta(tmpDir)).toBeNull();
  });

  it(`should return null when ${SPEC_DATA_DIR} directory does not exist`, () => {
    expect(readMeta(path.join(tmpDir, 'nonexistent'))).toBeNull();
  });

  it('should return createdAt as undefined when it is missing', () => {
    const metaDir = path.join(tmpDir, SPEC_DATA_DIR);
    fs.mkdirSync(metaDir, { recursive: true });
    const meta = {
      repoPath: '/some/repo',
      specStoragePath: '/some/repo/specs',
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(metaDir, 'meta.json'),
      JSON.stringify(meta),
      'utf-8',
    );
    const result = readMeta(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.createdAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeMeta
// ---------------------------------------------------------------------------

describe('writeMeta', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it(`should write meta.json and create the ${SPEC_DATA_DIR} directory`, () => {
    const result = writeMeta(tmpDir, '/some/repo/specs');
    const metaPath = path.join(tmpDir, SPEC_DATA_DIR, 'meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);
    expect(result.repoPath).toBe(tmpDir);
    expect(result.specStoragePath).toBe('/some/repo/specs');
    expect(result.updatedAt).toBeTruthy();
    expect(typeof result.updatedAt).toBe('string');
  });

  it('should set both createdAt and updatedAt on first write', () => {
    // On first write there is no existing meta.json, so createdAt is
    // assigned the current timestamp (same as updatedAt).
    const result = writeMeta(tmpDir, '/some/repo/specs');
    expect(result.createdAt).toBeTruthy();
    expect(typeof result.createdAt).toBe('string');
    expect(result.updatedAt).toBeTruthy();
    expect(typeof result.updatedAt).toBe('string');
  });

  it('should preserve existing createdAt on subsequent writes', () => {
    const first = writeMeta(tmpDir, '/some/repo/specs');
    // Small delay to ensure updatedAt is different
    // (timestamps are ISO with millisecond precision)
    const second = writeMeta(tmpDir, '/some/repo/specs2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.specStoragePath).toBe('/some/repo/specs2');
  });

  it('should return the full SpecMeta that was written', () => {
    const result = writeMeta(tmpDir, '/some/repo/specs');
    expect(result.repoPath).toBe(tmpDir);
    expect(result.specStoragePath).toBe('/some/repo/specs');
    expect(result.updatedAt).toBeDefined();

    // Read back and verify
    const read = readMeta(tmpDir);
    expect(read).not.toBeNull();
    expect(read!.repoPath).toBe(result.repoPath);
    expect(read!.specStoragePath).toBe(result.specStoragePath);
    expect(read!.createdAt).toBe(result.createdAt);
    expect(read!.updatedAt).toBe(result.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// resolveDbPath
// ---------------------------------------------------------------------------

describe('resolveDbPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should return explicitDbPath as-is when given', () => {
    const result = resolveDbPath('/some/repo', '/custom/path/db.sqlite');
    expect(result).toBe('/custom/path/db.sqlite');
  });

  it('should prioritize explicitDbPath over repoPath', () => {
    const result = resolveDbPath('/some/repo', '/explicit/db.sqlite');
    expect(result).toBe('/explicit/db.sqlite');
  });

  it(`should return <repoPath>/${SPEC_DATA_DIR}/commit4spec.db when repoPath given`, () => {
    const result = resolveDbPath(tmpDir);
    expect(result).toBe(path.join(tmpDir, SPEC_DATA_DIR, 'commit4spec.db'));
    // Verify the directory was created
    expect(fs.existsSync(path.join(tmpDir, SPEC_DATA_DIR))).toBe(true);
  });

  it(`should create ${SPEC_DATA_DIR}/.gitignore with "*" content`, () => {
    resolveDbPath(tmpDir);
    const gitignorePath = path.join(tmpDir, SPEC_DATA_DIR, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe('*\n');
  });

  it('should be idempotent — .gitignore not overwritten on second call', () => {
    resolveDbPath(tmpDir);
    const gitignorePath = path.join(tmpDir, SPEC_DATA_DIR, '.gitignore');
    // Modify the .gitignore
    fs.writeFileSync(gitignorePath, 'custom content\n', 'utf-8');
    // Second call should not overwrite
    resolveDbPath(tmpDir);
    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe('custom content\n');
  });

  it('should return ./commit4spec.db when neither repoPath nor explicitDbPath given', () => {
    const result = resolveDbPath();
    expect(result).toBe('./commit4spec.db');
  });

  it('should return ./commit4spec.db when repoPath is undefined and explicitDbPath is undefined', () => {
    const result = resolveDbPath(undefined, undefined);
    expect(result).toBe('./commit4spec.db');
  });
});

// ---------------------------------------------------------------------------
// computeBudgetProfile
// ---------------------------------------------------------------------------

describe('computeBudgetProfile', () => {
  it('should return tiny tier for specCount = 0', () => {
    const profile = computeBudgetProfile(0);
    expect(profile.tier).toBe('tiny');
  });

  it('should return tiny tier for specCount = 1', () => {
    const profile = computeBudgetProfile(1);
    expect(profile.tier).toBe('tiny');
    expect(profile.maxFragments).toBe(12);
    expect(profile.maxContents).toBe(16);
    expect(profile.contentBudget).toBe(48000);
  });

  it('should return tiny tier for specCount = 3 (boundary)', () => {
    const profile = computeBudgetProfile(3);
    expect(profile.tier).toBe('tiny');
  });

  it('should return small tier for specCount = 4', () => {
    const profile = computeBudgetProfile(4);
    expect(profile.tier).toBe('small');
    expect(profile.maxFragments).toBe(10);
    expect(profile.maxContents).toBe(14);
    expect(profile.contentBudget).toBe(40000);
  });

  it('should return small tier for specCount = 8 (boundary)', () => {
    const profile = computeBudgetProfile(8);
    expect(profile.tier).toBe('small');
  });

  it('should return medium tier for specCount = 9', () => {
    const profile = computeBudgetProfile(9);
    expect(profile.tier).toBe('medium');
    expect(profile.maxFragments).toBe(8);
    expect(profile.maxContents).toBe(12);
    expect(profile.contentBudget).toBe(32000);
  });

  it('should return medium tier for specCount = 15 (boundary)', () => {
    const profile = computeBudgetProfile(15);
    expect(profile.tier).toBe('medium');
  });

  it('should return large tier for specCount = 16', () => {
    const profile = computeBudgetProfile(16);
    expect(profile.tier).toBe('large');
    expect(profile.maxFragments).toBe(6);
    expect(profile.maxContents).toBe(10);
    expect(profile.contentBudget).toBe(24000);
  });

  it('should return large tier for specCount = 30 (boundary)', () => {
    const profile = computeBudgetProfile(30);
    expect(profile.tier).toBe('large');
  });

  it('should return vlarge tier for specCount = 31', () => {
    const profile = computeBudgetProfile(31);
    expect(profile.tier).toBe('vlarge');
    expect(profile.maxFragments).toBe(0);
    expect(profile.maxContents).toBe(0);
    expect(profile.contentBudget).toBe(16000);
  });

  it('should return vlarge tier for a very large specCount', () => {
    const profile = computeBudgetProfile(100);
    expect(profile.tier).toBe('vlarge');
  });

  it('should return vlarge tier for specCount = 1000', () => {
    const profile = computeBudgetProfile(1000);
    expect(profile.tier).toBe('vlarge');
  });
});

// ---------------------------------------------------------------------------
// truncateText
// ---------------------------------------------------------------------------

describe('truncateText', () => {
  it('should return short text unchanged', () => {
    const text = 'Hello, world!';
    expect(truncateText(text, 100)).toBe(text);
  });

  it('should return text exactly at maxLen unchanged', () => {
    const text = 'Hello, world!'; // 13 chars
    expect(truncateText(text, text.length)).toBe(text);
  });

  it('should return empty string unchanged', () => {
    expect(truncateText('', 10)).toBe('');
  });

  it('should truncate long text at a newline boundary', () => {
    // Text with a newline before the truncation point.
    // "Line one\nLine two is much longer..." — newline at index 8.
    // With maxLen=30, effectiveMax=16, so the newline is found.
    const text = 'Line one\nLine two is much longer and should be cut off';
    const result = truncateText(text, 30);
    expect(result).toContain('Line one');
    expect(result).toContain('…(truncated)');
    expect(result).not.toContain('Line two');
  });

  it('should append the truncation suffix', () => {
    const text = 'A'.repeat(1000);
    const maxLen = 100;
    const result = truncateText(text, maxLen);
    expect(result).toContain('…(truncated)');
    // Result should be shorter than or equal to maxLen
    expect(result.length).toBeLessThanOrEqual(maxLen);
  });

  it('should hard-cut when no newline is found in budget', () => {
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // 26 chars, no newlines
    const maxLen = 20;
    const result = truncateText(text, maxLen);
    expect(result.length).toBeLessThanOrEqual(maxLen);
    expect(result).toContain('…(truncated)');
  });
});

// ---------------------------------------------------------------------------
// truncateCodeDiff
// ---------------------------------------------------------------------------

describe('truncateCodeDiff', () => {
  it('should return short diff unchanged', () => {
    const diff = '@@ -1,3 +1,3 @@\n unchanged\n line\n';
    expect(truncateCodeDiff(diff, 1000)).toBe(diff);
  });

  it('should return empty string unchanged', () => {
    expect(truncateCodeDiff('', 100)).toBe('');
  });

  it('should return diff at or under maxChars unchanged (default maxChars)', () => {
    const diff = '@@ -1,1 +1,1 @@\n short\n';
    expect(truncateCodeDiff(diff)).toBe(diff);
  });

  it('should truncate a long diff and append suffix', () => {
    // Build a diff with many lines and hunk headers
    let longDiff = '';
    for (let i = 0; i < 100; i++) {
      longDiff += `@@ -${i},1 +${i},1 @@\n some content line ${i}\n`;
    }
    const maxChars = 500;
    const result = truncateCodeDiff(longDiff, maxChars);
    expect(result.length).toBeLessThanOrEqual(maxChars);
    expect(result).toContain('…(truncated)');
    // Should have preserved at least one hunk header
    expect(result).toContain('@@');
  });

  it('should truncate at a hunk header boundary when possible', () => {
    // The hunk header must fall in the trailing 50% of the diff for step 2
    // of the algorithm to find it.  Layout:
    //   [300 A's] \n @@ -10,1 +10,1 @@ \n [100 B's]
    // Total ~421 chars, halfPoint ~210, hunk at ~301 (in trailing 50%).
    const prefix = 'A'.repeat(300);
    const hunkHeader = '@@ -10,1 +10,1 @@\n';
    const suffix = 'B'.repeat(100);
    const diff = prefix + '\n' + hunkHeader + suffix;
    const result = truncateCodeDiff(diff, 350);
    // Should cut right before the hunk header, keeping only the prefix + newline
    expect(result).toContain('…(truncated)');
    expect(result).toContain(prefix);
    expect(result).not.toContain('@@');
  });

  it('should handle a diff where maxChars is very small', () => {
    const diff = 'A'.repeat(1000);
    const result = truncateCodeDiff(diff, 20);
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// truncateSubtitles
// ---------------------------------------------------------------------------

describe('truncateSubtitles', () => {
  it('should keep entries within both limits unchanged', () => {
    const subtitles = ['short', 'also short'];
    const result = truncateSubtitles(subtitles, 100, 10);
    expect(result).toEqual(['short', 'also short']);
  });

  it('should cap the number of entries', () => {
    const subtitles = ['a', 'b', 'c', 'd', 'e'];
    const result = truncateSubtitles(subtitles, 100, 3);
    expect(result).toHaveLength(3);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('should truncate individual entries that are too long', () => {
    const subtitles = ['short', 'A'.repeat(500)];
    const result = truncateSubtitles(subtitles, 60, 10);
    expect(result[0]).toBe('short');
    expect(result[1]!.length).toBeLessThanOrEqual(60);
    expect(result[1]).toContain('…(truncated)');
  });

  it('should return a new array (not mutate the original)', () => {
    const subtitles = ['a', 'b', 'c'];
    const result = truncateSubtitles(subtitles, 100, 10);
    expect(result).not.toBe(subtitles);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('should handle an empty array', () => {
    const result = truncateSubtitles([], 100, 10);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discoverSpecs
// ---------------------------------------------------------------------------

describe('discoverSpecs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('should discover directory-type spec entries', () => {
    const specDir = path.join(tmpDir, 'spec-storage');
    fs.mkdirSync(specDir, { recursive: true });
    fs.mkdirSync(path.join(specDir, 'spec01'));
    fs.mkdirSync(path.join(specDir, 'spec02'));
    fs.writeFileSync(path.join(specDir, 'spec01', 'README.md'), '# Spec 01', 'utf-8');

    const result = discoverSpecs(specDir);
    const dirEntries = result.filter((e) => e.entryType === 'directory');
    expect(dirEntries).toHaveLength(2);
    expect(dirEntries.map((e) => e.specId).sort()).toEqual(['spec01', 'spec02']);
    expect(dirEntries[0]!.path).toContain(specDir);
  });

  it('should discover file-type spec entries (.md files)', () => {
    const specDir = path.join(tmpDir, 'spec-storage');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'architecture.md'), '# Architecture', 'utf-8');
    fs.writeFileSync(path.join(specDir, 'design.md'), '# Design', 'utf-8');

    const result = discoverSpecs(specDir);
    const fileEntries = result.filter((e) => e.entryType === 'file');
    expect(fileEntries).toHaveLength(2);
    expect(fileEntries.map((e) => e.specId).sort()).toEqual(['architecture', 'design']);
  });

  it('should strip .md extension for file-type specId', () => {
    const specDir = path.join(tmpDir, 'spec-storage');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'my-spec.md'), '# My Spec', 'utf-8');

    const result = discoverSpecs(specDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.specId).toBe('my-spec');
  });

  it('should return empty array for an empty directory', () => {
    const specDir = path.join(tmpDir, 'spec-storage');
    fs.mkdirSync(specDir, { recursive: true });
    const result = discoverSpecs(specDir);
    expect(result).toEqual([]);
  });

  it('should return empty array for a nonexistent path', () => {
    const result = discoverSpecs(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('should skip non-.md files', () => {
    const specDir = path.join(tmpDir, 'spec-storage');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'notes.txt'), 'plain text', 'utf-8');
    fs.writeFileSync(path.join(specDir, 'config.json'), '{}', 'utf-8');

    const result = discoverSpecs(specDir);
    expect(result).toEqual([]);
  });

  it('should handle mixed directory and file specs', () => {
    const specDir = path.join(tmpDir, 'spec-storage');
    fs.mkdirSync(specDir, { recursive: true });
    fs.mkdirSync(path.join(specDir, 'spec01'));
    fs.writeFileSync(path.join(specDir, 'standalone.md'), '# Standalone', 'utf-8');

    const result = discoverSpecs(specDir);
    const dirs = result.filter((e) => e.entryType === 'directory');
    const files = result.filter((e) => e.entryType === 'file');
    expect(dirs).toHaveLength(1);
    expect(files).toHaveLength(1);
    expect(dirs[0]!.specId).toBe('spec01');
    expect(files[0]!.specId).toBe('standalone');
  });
});

// ---------------------------------------------------------------------------
// loadSpecConfig
// ---------------------------------------------------------------------------

describe('loadSpecConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    // Delete any env var that might interfere with tests
    delete process.env.TEST_SPEC_API_KEY;
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    delete process.env.TEST_SPEC_API_KEY;
  });

  // --- config file missing or invalid → llm is null (no defaults) ---

  it('should return null for llm when config file is missing', () => {
    const config = loadSpecConfig(tmpDir);
    expect(config).toBeDefined();
    expect(config.discovery).toBeDefined();
    expect(config.discovery.primaryDocCandidates).toBeInstanceOf(Array);
    expect(config.llm).toBeNull();
  });

  it('should return null for llm when config file contains invalid JSON', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, 'not valid json {{{', 'utf-8');

    const config = loadSpecConfig(tmpDir);
    expect(config.llm).toBeNull();
  });

  it('should return null for llm when top-level value is not an object', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, '"just a string"', 'utf-8');

    const config = loadSpecConfig(tmpDir);
    expect(config.llm).toBeNull();
  });

  it('should return null for llm when top-level value is an array', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, '[1, 2, 3]', 'utf-8');

    const config = loadSpecConfig(tmpDir);
    expect(config.llm).toBeNull();
    expect(config.discovery.primaryDocCandidates).toBeInstanceOf(Array);
  });

  it('should return null for llm when config file has no llm section', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({ discovery: { primaryDocCandidates: ['custom.md'] } }),
      'utf-8',
    );

    const config = loadSpecConfig(tmpDir);
    expect(config.discovery.primaryDocCandidates).toEqual(['custom.md']);
    expect(config.llm).toBeNull();
  });

  // --- valid llm config ---

  it('should deep merge valid config over defaults', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const userConfig = {
      llm: {
        provider: 'openai',
        apiKey: 'sk-test-deep-merge',
        model: 'gpt-3.5-turbo',
        temperature: 0.5,
      },
      discovery: {
        primaryDocCandidates: ['custom.md'],
      },
    };
    fs.writeFileSync(
      configFile,
      JSON.stringify(userConfig),
      'utf-8',
    );

    const config = loadSpecConfig(tmpDir);
    // Merged user values
    expect(config.llm!.provider).toBe('openai');
    expect(config.llm!.model).toBe('gpt-3.5-turbo');
    expect(config.llm!.temperature).toBe(0.5);
    expect(config.discovery.primaryDocCandidates).toEqual(['custom.md']);
    // Default values still present for keys not overridden
    expect(config.llm!.maxTokens).toBe(4096);
    expect(config.discovery.supplementaryGlobs).toBeInstanceOf(Array);
  });

  it('should resolve apiKey from process.env when apiKeyEnv is set', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const userConfig = {
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        apiKeyEnv: 'TEST_SPEC_API_KEY',
      },
    };
    fs.writeFileSync(
      configFile,
      JSON.stringify(userConfig),
      'utf-8',
    );

    process.env.TEST_SPEC_API_KEY = 'sk-env-resolved-key';
    const config = loadSpecConfig(tmpDir);
    expect(config.llm!.apiKey).toBe('sk-env-resolved-key');
  });

  it('should leave apiKey empty when apiKeyEnv points to unset env var', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const userConfig = {
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        apiKeyEnv: 'NONEXISTENT_ENV_VAR_XYZ',
      },
    };
    fs.writeFileSync(
      configFile,
      JSON.stringify(userConfig),
      'utf-8',
    );

    const config = loadSpecConfig(tmpDir);
    expect(config.llm!.apiKey).toBe('');
  });

  it('should preserve apiKey from config file when apiKeyEnv is not set', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const userConfig = {
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-direct-key',
      },
    };
    fs.writeFileSync(
      configFile,
      JSON.stringify(userConfig),
      'utf-8',
    );

    const config = loadSpecConfig(tmpDir);
    expect(config.llm!.apiKey).toBe('sk-direct-key');
  });

  it('should normalize baseUrl when provided', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const userConfig = {
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
        baseUrl: 'https://custom.api.example.com/v1',
      },
    };
    fs.writeFileSync(
      configFile,
      JSON.stringify(userConfig),
      'utf-8',
    );

    const config = loadSpecConfig(tmpDir);
    expect(config.llm!.baseUrl).toBe('https://custom.api.example.com/v1');
  });

  it('should normalize maxTokens as integer', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const userConfig = {
      llm: {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
        maxTokens: 8192,
      },
    };
    fs.writeFileSync(
      configFile,
      JSON.stringify(userConfig),
      'utf-8',
    );

    const config = loadSpecConfig(tmpDir);
    expect(config.llm!.maxTokens).toBe(8192);
  });

  it('should use default temperature when not provided', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({ llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' } }),
      'utf-8',
    );

    const config = loadSpecConfig(tmpDir);
    expect(config.llm!.temperature).toBe(0.2);
  });

  // --- llm validation errors ---

  it('should throw when llm.provider is invalid', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({ llm: { provider: 'invalid', model: 'gpt-4o', apiKey: 'sk-test' } }),
      'utf-8',
    );

    expect(() => loadSpecConfig(tmpDir)).toThrow('llm.provider');
  });

  it('should throw when llm.model is missing', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({ llm: { provider: 'openai', apiKey: 'sk-test' } }),
      'utf-8',
    );

    expect(() => loadSpecConfig(tmpDir)).toThrow('llm.model');
  });

  it('should throw when llm.apiKey and apiKeyEnv are both missing', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({ llm: { provider: 'openai', model: 'gpt-4o' } }),
      'utf-8',
    );

    expect(() => loadSpecConfig(tmpDir)).toThrow('llm.apiKey');
  });

  it('should support anthropic provider', () => {
    const configFile = path.join(tmpDir, SPEC_DATA_DIR, 'configs.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        llm: { provider: 'anthropic', model: 'claude-3-opus', apiKey: 'sk-ant' },
      }),
      'utf-8',
    );

    const config = loadSpecConfig(tmpDir);
    expect(config.llm!.provider).toBe('anthropic');
    expect(config.llm!.model).toBe('claude-3-opus');
  });
});
