/**
 * Sync Module Tests
 *
 * Tests for sync functionality (incremental updates).
 * Note: Git hooks functionality has been removed in favor of homegraph's
 * Claude Code hooks integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import HomeGraph from '../src/index';
import { removeTempDir } from './helpers/fs';

describe('Sync Module', () => {
  describe('Sync Functionality', () => {
    let testDir: string;
    let cg: HomeGraph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-sync-func-'));

      // Create initial source files
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      // Initialize and index
      cg = HomeGraph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        removeTempDir(testDir);
      }
    });

    describe('getChangedFiles()', () => {
      it('should detect added files', () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toContain('src/new.ts');
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect modified files', () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function hello() { return 'modified'; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toContain('src/index.ts');
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect removed files', () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toContain('src/index.ts');
      });
    });

    describe('sync()', () => {
      it('should reindex added files', async () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const result = await cg.sync();

        expect(result.filesAdded).toBe(1);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('newFunc');
        expect(nodes.length).toBeGreaterThan(0);
      });

      it('should reindex modified files', async () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function goodbye() { return 'farewell'; }`
        );

        const result = await cg.sync();

        expect(result.filesModified).toBe(1);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('goodbye');
        expect(nodes.length).toBeGreaterThan(0);

        // Verify old function is gone
        const oldNodes = cg.searchNodes('hello');
        expect(oldNodes.length).toBe(0);
      });

      it('should remove nodes from deleted files', async () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const result = await cg.sync();

        expect(result.filesRemoved).toBe(1);

        // Verify function is gone
        const nodes = cg.searchNodes('hello');
        expect(nodes.length).toBe(0);
      });

      it('should report no changes when nothing changed', async () => {
        const result = await cg.sync();

        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);
        expect(result.filesChecked).toBeGreaterThan(0);
      });
    });
  });

  describe('Git-based sync', () => {
    let testDir: string;
    let cg: HomeGraph;

    function git(...args: string[]) {
      execFileSync('git', args, { cwd: testDir, stdio: 'pipe' });
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-git-sync-'));

      // Initialize a git repo with an initial commit
      git('init');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');

      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      git('add', '-A');
      git('commit', '-m', 'initial');

      // Initialize HomeGraph and index
      cg = HomeGraph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        removeTempDir(testDir);
      }
    });

    it('should detect modified files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'modified'; }`
      );

      const result = await cg.sync();

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toContain('src/index.ts');
    });

    it('should detect new untracked files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(1);
      expect(result.changedFilePaths).toContain('src/new.ts');

      // Verify the function was indexed
      const nodes = cg.searchNodes('newFunc');
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('should stop reporting untracked files once they are indexed (issue #206)', async () => {
      // Untracked files stay `??` in git status even after homegraph indexes
      // them. Change detection must compare them against the DB by hash, not
      // report every untracked file as "added" on every sync/status.
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      // First sync indexes the untracked file.
      const first = await cg.sync();
      expect(first.filesAdded).toBe(1);

      // The file is still untracked in git, but now lives in the DB.
      expect(cg.searchNodes('newFunc').length).toBeGreaterThan(0);

      // status must not keep flagging it as a pending addition...
      const changes = cg.getChangedFiles();
      expect(changes.added).not.toContain('src/new.ts');
      expect(changes.modified).not.toContain('src/new.ts');

      // ...and a second sync must be a no-op for it.
      const second = await cg.sync();
      expect(second.filesAdded).toBe(0);
      expect(second.filesModified).toBe(0);
    });

    it('should re-index an untracked file when its contents change', async () => {
      const filePath = path.join(testDir, 'src', 'new.ts');
      fs.writeFileSync(filePath, `export function newFunc() { return 42; }`);
      await cg.sync();

      // Modify the still-untracked file.
      fs.writeFileSync(filePath, `export function renamedFunc() { return 7; }`);

      const changes = cg.getChangedFiles();
      expect(changes.modified).toContain('src/new.ts');

      const result = await cg.sync();
      expect(result.filesModified).toBe(1);
      expect(cg.searchNodes('renamedFunc').length).toBeGreaterThan(0);
      expect(cg.searchNodes('newFunc').length).toBe(0);
    });

    it('should detect deleted files via git', async () => {
      fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);

      // Verify function is gone
      const nodes = cg.searchNodes('hello');
      expect(nodes.length).toBe(0);
    });

    it('should skip files with unsupported extensions', async () => {
      // A .txt file has no supported grammar, so sync must not index it.
      fs.writeFileSync(
        path.join(testDir, 'src', 'notes.txt'),
        `just some notes`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
    });

    it('should report no changes on clean working tree', async () => {
      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesRemoved).toBe(0);
      expect(result.changedFilePaths).toBeUndefined();
    });
  });

  // Incremental sync's git fast path used to consume `git status` output without
  // the ignore matcher the full index applies — so a committed dependency dir
  // (built-in default exclude) or a tracked file under a .gitignored dir would
  // leak into the index via `sync`, then vanish on the next `index --force`. The
  // git fast path must exclude exactly what the full scan does. (#766)
  describe('Incremental sync honors the ignore matcher (#766)', () => {
    let testDir: string;
    let cg: HomeGraph;

    function git(...args: string[]) {
      execFileSync('git', args, { cwd: testDir, stdio: 'pipe' });
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-766-'));

      git('init');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');

      // Real project source — must keep flowing through sync untouched.
      fs.mkdirSync(path.join(testDir, 'src'));
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      // A COMMITTED vendor/ dir: tracked in git, but a built-in default exclude
      // git knows nothing about. git status happily reports edits to it.
      fs.mkdirSync(path.join(testDir, 'vendor'));
      fs.writeFileSync(
        path.join(testDir, 'vendor', 'lib.ts'),
        `export function vendoredHelper() { return 1; }`
      );

      // A tracked file inside a .gitignored dir: gitignore is a no-op for files
      // already committed, so git status still reports modifications to it.
      fs.writeFileSync(path.join(testDir, '.gitignore'), 'generated/\n');
      fs.mkdirSync(path.join(testDir, 'generated'));
      fs.writeFileSync(
        path.join(testDir, 'generated', 'out.ts'),
        `export function generatedThing() { return 2; }`
      );

      git('add', '-A'); // .gitignore + src/ + vendor/ (generated/ is now ignored)
      git('add', '-f', 'generated/out.ts'); // force the ignored-but-tracked file in
      git('commit', '-m', 'initial');

      cg = HomeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) removeTempDir(testDir);
    });

    it('the full index excludes both (baseline the sync path must match)', () => {
      expect(cg.searchNodes('hello').length).toBeGreaterThan(0);
      expect(cg.searchNodes('vendoredHelper')).toHaveLength(0);
      expect(cg.searchNodes('generatedThing')).toHaveLength(0);
    });

    it('does not re-index a modified tracked file in a built-in excluded dir (vendor/)', () => {
      fs.writeFileSync(
        path.join(testDir, 'vendor', 'lib.ts'),
        `export function vendoredHelper() { return 999; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.modified).not.toContain('vendor/lib.ts');
      expect(changes.added).not.toContain('vendor/lib.ts');
    });

    it('does not re-index a modified tracked file in a .gitignored dir', () => {
      fs.writeFileSync(
        path.join(testDir, 'generated', 'out.ts'),
        `export function generatedThing() { return 999; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.modified).not.toContain('generated/out.ts');
      expect(changes.added).not.toContain('generated/out.ts');
    });

    it('does not index a new untracked file in an excluded dir', () => {
      // vendor/ isn't in .gitignore, so an untracked file there surfaces as `??`
      // in git status — it must still be filtered to match the full index.
      fs.writeFileSync(
        path.join(testDir, 'vendor', 'extra.ts'),
        `export function vendoredExtra() { return 3; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.added).not.toContain('vendor/extra.ts');
    });

    it('status (getChangedFiles) agrees with sync — no phantom pending changes', async () => {
      // The user-visible symptom today: `homegraph status` reads getChangedFiles
      // and reports a vendor edit as a pending change that `sync` (a filesystem
      // reconcile) then never indexes — so the count never clears. Both must now
      // agree that nothing happened.
      fs.writeFileSync(
        path.join(testDir, 'vendor', 'lib.ts'),
        `export function vendoredHelper() { return 999; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);

      const result = await cg.sync();
      expect(result.filesModified).toBe(0);
      expect(result.changedFilePaths ?? []).not.toContain('vendor/lib.ts');
      expect(cg.searchNodes('vendoredHelper')).toHaveLength(0);
    });

    it('still syncs a normal modified source file (no over-filtering)', () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'changed'; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.modified).toContain('src/index.ts');
    });
  });

  // Incremental sync used to scope resolution to the CHANGED files' refs, and
  // a completed pass deleted every ref it failed to resolve — so when a changed
  // file introduced an export/symbol that would satisfy a previously-failed ref
  // in an UNCHANGED file, nothing ever revisited it: the cross-file edge stayed
  // missing (with status reporting a clean index) until a full re-index. Failed
  // refs are now parked as status='failed' and retried when a sync lands files
  // carrying a matching symbol name. (#1240)
  describe('Sync resolves refs satisfied by a new export in another file (#1240)', () => {
    let testDir: string;
    let cg: HomeGraph;

    function write(rel: string, content: string) {
      fs.writeFileSync(path.join(testDir, rel), content);
    }

    function callersOf(fnName: string, kind: string = 'function'): string[] {
      const results = cg.searchNodes(fnName);
      const def = results.map((r) => r.node).find((n) => n.kind === kind && n.name === fnName);
      if (!def) return [];
      return cg.getCallers(def.id).map((c) => c.node.name);
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-1240-'));

      // a.ts references `greet`, which does not exist anywhere yet — the ref
      // fails resolution during the initial index.
      write('a.ts', `import { greet } from './b';\n\nexport function run(): number {\n  return greet();\n}\n`);
      write('b.ts', `export function other(): number {\n  return 1;\n}\n`);

      cg = HomeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) removeTempDir(testDir);
    });

    it('baseline: the unresolvable ref creates no edge and does not report as pending', () => {
      expect(callersOf('greet')).toHaveLength(0);
      // Failed refs are parked, not pending — status must keep reporting a
      // healthy index, or every repo with external-library imports would
      // permanently warn about an "interrupted run".
      expect(cg.getPendingReferenceCount()).toBe(0);
    });

    it('creates the cross-file calls edge from the UNCHANGED file after sync', async () => {
      write('b.ts', `export function greet(): number {\n  return 42;\n}\n`);

      const result = await cg.sync();
      expect(result.filesModified).toBe(1);

      // The ref lives in a.ts, which did NOT change — only the retry of the
      // parked failed ref can create this edge.
      expect(callersOf('greet')).toContain('run');
      expect(cg.getPendingReferenceCount()).toBe(0);
    });

    it('the synced graph matches a full re-index (the issue\'s exact complaint)', async () => {
      write('b.ts', `export function greet(): number {\n  return 42;\n}\n`);
      await cg.sync();
      const synced = cg.getStats();

      await cg.indexAll();
      const reindexed = cg.getStats();

      expect(synced.edgeCount).toBe(reindexed.edgeCount);
      expect(synced.nodeCount).toBe(reindexed.nodeCount);
    });

    it('a second sync is a no-op and does not duplicate edges', async () => {
      write('b.ts', `export function greet(): number {\n  return 42;\n}\n`);
      await cg.sync();
      const afterFirst = cg.getStats();

      const second = await cg.sync();
      expect(second.filesModified).toBe(0);
      expect(cg.getStats().edgeCount).toBe(afterFirst.edgeCount);
      expect(callersOf('greet')).toContain('run');
    });

    it('retries dotted method refs via the name tail when a class gains the method', async () => {
      // `h.greet()` is stored as reference_name 'h.greet'; the retry lookup
      // must match it through name_tail ('greet') when Helper gains greet.
      write('use.ts', `import { Helper } from './helper';\n\nexport function useHelper(): number {\n  const h = new Helper();\n  return h.greet();\n}\n`);
      write('helper.ts', `export class Helper {\n  other(): number {\n    return 1;\n  }\n}\n`);
      await cg.sync();
      expect(callersOf('greet', 'method')).toHaveLength(0);

      write('helper.ts', `export class Helper {\n  other(): number {\n    return 1;\n  }\n  greet(): number {\n    return 42;\n  }\n}\n`);
      const result = await cg.sync();
      expect(result.filesModified).toBe(1);

      expect(callersOf('greet', 'method')).toContain('useHelper');
    });
  });

  // The removal-side counterpart of #1240: when a re-index (or file deletion)
  // drops a symbol other files had resolved edges to, those edges cascade away
  // and the referencing files — which did not change — were never given a
  // chance to re-resolve, so they could not rebind to an alternative
  // definition the way a full re-index would. Resolution edges now carry their
  // originating reference (metadata.refName), and a dropped edge is
  // resurrected as that exact ref: re-resolved in the same sync, or parked as
  // failed until the symbol reappears.
  describe('Sync rebinds or parks refs when a resolved symbol is removed (#1240 removal case)', () => {
    let testDir: string;
    let cg: HomeGraph;

    function write(rel: string, content: string) {
      fs.writeFileSync(path.join(testDir, rel), content);
    }

    function greetDef(): { id: string; filePath: string } | undefined {
      const results = cg.searchNodes('greet');
      const def = results.map((r) => r.node).find((n) => n.kind === 'function' && n.name === 'greet');
      return def ? { id: def.id, filePath: def.filePath } : undefined;
    }

    function greetCallers(): string[] {
      const def = greetDef();
      return def ? cg.getCallers(def.id).map((c) => c.node.name) : [];
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-1240-removal-'));

      // No import — cross-file name matching, so the caller can legitimately
      // rebind to a definition in ANY file, which is what a full re-index does.
      write('a.ts', `export function run(): number {\n  return greet();\n}\n`);
      write('b.ts', `export function greet(): number {\n  return 42;\n}\n`);

      cg = HomeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
      // Baseline: the call resolved into b.ts.
      expect(greetCallers()).toContain('run');
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) removeTempDir(testDir);
    });

    it('rebinds the unchanged caller when the symbol moves to another file', async () => {
      write('b.ts', `export function other(): number {\n  return 1;\n}\n`);
      write('d.ts', `export function greet(): number {\n  return 42;\n}\n`);

      await cg.sync();

      const def = greetDef();
      expect(def?.filePath).toBe('d.ts');
      expect(greetCallers()).toContain('run');
      // Parity with a full re-index — the issue's contract.
      const synced = cg.getStats();
      await cg.indexAll();
      expect(cg.getStats().edgeCount).toBe(synced.edgeCount);
    });

    it('drops the edge on removal and restores it when the symbol returns', async () => {
      write('b.ts', `export function other(): number {\n  return 1;\n}\n`);
      await cg.sync();

      // Removed with no alternative: the edge must be gone (not preserved
      // against a nonexistent symbol) and status must stay clean while the
      // ref waits parked.
      expect(greetDef()).toBeUndefined();
      expect(cg.getPendingReferenceCount()).toBe(0);

      write('b.ts', `export function other(): number {\n  return 1;\n}\nexport function greet(): number {\n  return 42;\n}\n`);
      await cg.sync();

      expect(greetCallers()).toContain('run');
    });

    it('handles whole-file deletion: parks the ref, then rebinds when the symbol reappears elsewhere', async () => {
      fs.unlinkSync(path.join(testDir, 'b.ts'));
      const removal = await cg.sync();
      expect(removal.filesRemoved).toBe(1);
      expect(greetDef()).toBeUndefined();
      expect(cg.getPendingReferenceCount()).toBe(0);

      write('d.ts', `export function greet(): number {\n  return 99;\n}\n`);
      await cg.sync();

      expect(greetDef()?.filePath).toBe('d.ts');
      expect(greetCallers()).toContain('run');
    });
  });

  describe('Cross-file module-attribute caller edges survive callee re-index (#899)', () => {
    let testDir: string;
    let cg: HomeGraph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-899-'));

      // pkg/mod.py — a module with two functions, both called from a separate
      // test file via `mod.<fn>(...)` (module-attribute access). This is the
      // exact shape from the RAGFlow production case in issue #899.
      fs.mkdirSync(path.join(testDir, 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'test'), { recursive: true });
      fs.writeFileSync(
        path.join(testDir, 'pkg', '__init__.py'),
        ``
      );
      fs.writeFileSync(
        path.join(testDir, 'pkg', 'mod.py'),
        [
          `def callee_one(value):`,
          `    """First callee — docstring above the second callee so edits here shift its line."""`,
          `    return value + 1`,
          ``,
          ``,
          `def callee_two(value):`,
          `    """Second callee, called from the test file via mod.callee_two(...)."""`,
          `    return value + 2`,
          ``,
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(testDir, 'test', 'test_callers.py'),
        [
          `from pkg import mod`,
          ``,
          ``,
          `def test_calls_callee_one():`,
          `    assert mod.callee_one(1) == 2`,
          ``,
          ``,
          `def test_calls_callee_two():`,
          `    assert mod.callee_two(1) == 3`,
          ``,
        ].join('\n')
      );

      cg = HomeGraph.initSync(testDir, {
        config: { include: ['**/*.py'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) removeTempDir(testDir);
    });

    function callerCount(fnName: string): number {
      const results = cg.searchNodes(fnName);
      const def = results.map(r => r.node).find(n => n.kind === 'function' && n.name === fnName);
      if (!def) return -1;
      return cg.getCallers(def.id).length;
    }

    it('preserves incoming cross-file calls edges when the callee file is re-indexed', async () => {
      // Baseline: both callees have one cross-file caller each.
      expect(callerCount('callee_one')).toBe(1);
      expect(callerCount('callee_two')).toBe(1);

      // Docstring-only edit to callee_one — adds 1 line, shifting callee_two's
      // line number. A naive ID-based edge restore would drop callee_two's
      // incoming edge (its node id changed); the (kind, name) re-resolve
      // preserves it. A docstring-only edit also confirms zero-AST-change
      // re-indexes don't sever edges.
      fs.writeFileSync(
        path.join(testDir, 'pkg', 'mod.py'),
        [
          `def callee_one(value):`,
          `    """First callee — docstring above the second callee so edits here shift its line."""`,
          `    """Probe: extra docstring line to shift callee_two's start line by 1."""`,
          `    return value + 1`,
          ``,
          ``,
          `def callee_two(value):`,
          `    """Second callee, called from the test file via mod.callee_two(...)."""`,
          `    return value + 2`,
          ``,
        ].join('\n')
      );

      const result = await cg.sync();
      expect(result.filesModified).toBe(1);

      // Both incoming cross-file calls edges must survive the callee re-index.
      expect(callerCount('callee_one')).toBe(1);
      expect(callerCount('callee_two')).toBe(1);
    });

    it('drops incoming edges for a callee that was renamed during re-index', async () => {
      // Baseline.
      expect(callerCount('callee_one')).toBe(1);

      // Rename callee_one -> callee_one_renamed. The old edge's target
      // (kind=function, name=callee_one) no longer matches any re-indexed
      // node, so the edge is correctly dropped (not preserved against a
      // non-existent symbol).
      fs.writeFileSync(
        path.join(testDir, 'pkg', 'mod.py'),
        [
          `def callee_one_renamed(value):`,
          `    """Renamed callee — the old edge targeting callee_one must not be restored."""`,
          `    return value + 1`,
          ``,
          ``,
          `def callee_two(value):`,
          `    """Second callee, called from the test file via mod.callee_two(...)."""`,
          `    return value + 2`,
          ``,
        ].join('\n')
      );

      await cg.sync();

      // The renamed callee has no callers (the test still calls mod.callee_one,
      // which no longer exists). The old callee_one node is gone, so its
      // callerCount is -1 (definition not found); callee_one_renamed exists
      // but has no incoming edges (the test calls the old name).
      expect(callerCount('callee_one')).toBe(-1);
      expect(callerCount('callee_one_renamed')).toBe(0);
      // callee_two is untouched by the rename and its edge survives.
      expect(callerCount('callee_two')).toBe(1);
    });
  });
});

describe('Scoped sync parity (#watcher-scoped)', () => {
  let testDir: string;
  let cg: HomeGraph;

  const snapshot = (g: HomeGraph): string => {
    const nodes = g
      .searchNodes('', { limit: 100000 })
      .map((r) => r.node)
      .map((n) => `${n.kind}|${n.qualifiedName}|${n.filePath}|${n.startLine}`)
      .sort()
      .join('\n');
    return nodes;
  };

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-sync-scoped-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'a.ts'), `export function alpha() { return beta(); }`);
    fs.writeFileSync(path.join(srcDir, 'b.ts'), `export function beta() { return 1; }`);
    cg = HomeGraph.initSync(testDir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('a scoped modify lands the same graph as a full sync of the same edit', async () => {
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function beta() { return 2; }\nexport function gamma() { return 3; }`);
    const scoped = await cg.sync({ paths: ['src/b.ts'] });
    expect(scoped.filesModified).toBe(1);
    const scopedSnap = snapshot(cg);

    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function beta() { return 1; }`);
    await cg.sync();
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function beta() { return 2; }\nexport function gamma() { return 3; }`);
    const full = await cg.sync();
    expect(full.filesModified).toBe(1);
    expect(snapshot(cg)).toBe(scopedSnap);
  });

  it('a scoped delete removes the file and resurrects cross-file refs like a full sync', async () => {
    fs.rmSync(path.join(testDir, 'src', 'b.ts'));
    const scoped = await cg.sync({ paths: ['src/b.ts'] });
    expect(scoped.filesRemoved).toBe(1);
    expect(scoped.filesChecked).toBe(1);
    const gone = cg.searchNodes('beta');
    expect(gone.filter((r) => r.node.filePath === 'src/b.ts').length).toBe(0);
  });

  it('a scoped add indexes the new file', async () => {
    fs.writeFileSync(path.join(testDir, 'src', 'c.ts'), `export function delta() { return 4; }`);
    const scoped = await cg.sync({ paths: ['src/c.ts'] });
    expect(scoped.filesAdded).toBe(1);
    expect(cg.searchNodes('delta').length).toBeGreaterThan(0);
  });

  it('scoped sync ignores paths outside the change without touching them', async () => {
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function alpha() { return beta() + 1; }`);
    const scoped = await cg.sync({ paths: ['src/a.ts'] });
    expect(scoped.filesModified).toBe(1);
    expect(scoped.filesRemoved).toBe(0);
    expect(cg.searchNodes('beta').length).toBeGreaterThan(0);
  });
});

  // ---------------------------------------------------------------------------
  // Spec 0071 — status must see COMMITTED changes, not just working-tree edits.
  //
  // Before this, `getChangedFiles()` fed only `git status --porcelain` into the
  // candidate set. Committing (or merging, fast-forward included) makes the
  // working tree clean, so `homegraph status` reported `Index is up to date`
  // while the index still held the OLD content hash — a silent lie. The fix
  // stamps the commit the index was last brought up to date at
  // (`indexed_at_commit`) and adds `git diff <stamp> HEAD` to the candidate set.
  // ---------------------------------------------------------------------------
  describe('status detects committed changes (Spec 0071)', () => {
    let repoDir: string;
    let repo: HomeGraph;

    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repoDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });

    const commitAll = (message: string): void => {
      execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' });
      execFileSync(
        'git',
        ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', message],
        { cwd: repoDir, stdio: 'pipe' }
      );
    };

    const pendingCount = (): number => {
      const c = repo.getChangedFiles();
      return c.added.length + c.modified.length + c.removed.length;
    };

    beforeEach(async () => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-spec0071-'));
      fs.mkdirSync(path.join(repoDir, 'src'));
      fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), `export function hello() { return 'world'; }\n`);
      fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');

      git('init', '-q');
      commitAll('initial');

      repo = HomeGraph.initSync(repoDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await repo.indexAll();
    });

    afterEach(() => {
      if (repo) repo.destroy();
      if (fs.existsSync(repoDir)) removeTempDir(repoDir);
    });

    it('a fresh index of a committed tree reports no pending changes', () => {
      expect(pendingCount()).toBe(0);
    });

    it('a committed edit is reported as pending (was a false "up to date")', () => {
      fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), `export function hello() { return 'committed'; }\n`);
      commitAll('edit hello');

      // Working tree is clean — `git status` says nothing. The old code stopped
      // here and reported the index as up to date.
      expect(git('status', '--porcelain').trim()).toBe('');

      const changes = repo.getChangedFiles();
      expect(changes.modified).toContain('src/index.ts');
    });

    it('a committed NEW file is reported as pending', () => {
      fs.writeFileSync(path.join(repoDir, 'src', 'added.ts'), `export function fresh() { return 1; }\n`);
      commitAll('add fresh');

      expect(git('status', '--porcelain').trim()).toBe('');
      expect(repo.getChangedFiles().added).toContain('src/added.ts');
    });

    it('a committed DELETION is reported as pending', () => {
      const victim = path.join(repoDir, 'src', 'index.ts');
      fs.unlinkSync(victim);
      commitAll('drop index');

      expect(git('status', '--porcelain').trim()).toBe('');
      expect(repo.getChangedFiles().removed).toContain('src/index.ts');
    });

    it('a fast-forward merge of another branch is reported as pending', () => {
      const baseBranch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();

      // Branch off, commit, return, ff-merge — no merge commit, only the pointer moves.
      git('checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(repoDir, 'src', 'feature.ts'), `export function fromFeature() { return 2; }\n`);
      commitAll('feature work');
      git('checkout', '-q', baseBranch);
      git('merge', '-q', '--ff-only', 'feature');

      // ff merge leaves a clean tree; HEAD moved but the index never saw the file.
      expect(git('status', '--porcelain').trim()).toBe('');
      const changes = repo.getChangedFiles();
      expect(changes.added).toContain('src/feature.ts');
    });

    it('a --no-ff merge is reported as pending', () => {
      const baseBranch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();

      git('checkout', '-q', '-b', 'feature2');
      fs.writeFileSync(path.join(repoDir, 'src', 'merged.ts'), `export function mergedIn() { return 3; }\n`);
      commitAll('merge work');
      git('checkout', '-q', baseBranch);
      git('merge', '-q', '--no-ff', 'feature2', '-m', 'merge feature2');

      expect(git('status', '--porcelain').trim()).toBe('');
      expect(repo.getChangedFiles().added).toContain('src/merged.ts');
    });

    it('sync after a commit clears the pending change for good', async () => {
      fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), `export function hello() { return 'after-sync'; }\n`);
      commitAll('edit again');

      expect(pendingCount()).toBeGreaterThan(0);

      await repo.sync();

      // Sync indexed the committed content. HEAD is still ahead of the stamp
      // (only a full index advances it), but the candidates re-hash to the same
      // content, so nothing reads as pending.
      expect(pendingCount()).toBe(0);
    });

    it('an uncommitted edit after a fresh index is still reported as pending', () => {
      fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), `export function hello() { return 'dirty'; }\n`);
      expect(repo.getChangedFiles().modified).toContain('src/index.ts');
    });

    it('an index stamped with an unknown commit falls back to a full scan', () => {
      // Simulate a rebase/force-push: the stamp names a commit the repo no
      // longer has. `canTrustGitFastPath` must decline, and the full scan must
      // still answer correctly from disk.
      const queries = (repo as unknown as { queries: { setMetadata(k: string, v: string): void } }).queries;
      queries.setMetadata('indexed_at_commit', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

      fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), `export function hello() { return 'orphan-stamp'; }\n`);
      commitAll('after fake stamp');

      // Even with a clean tree and an unusable stamp, the disk-vs-DB scan sees
      // the committed edit.
      const changes = repo.getChangedFiles();
      expect(changes.modified).toContain('src/index.ts');
    });

    it('a torn dirty-paths pair (commit mismatch) is rejected, not trusted', () => {
      const queries = (repo as unknown as {
        queries: { setMetadata(k: string, v: string): void };
      }).queries;
      // Write a dirty set whose embedded commit doesn't match the stamp.
      queries.setMetadata('indexed_dirty_paths', JSON.stringify({ commit: 'mismatch', paths: ['src/index.ts'] }));

      // indexedDirtyPaths() returns null on a mismatch, so the fast path is
      // declined and the full scan answers — no phantom pending from the torn pair.
      expect(pendingCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Spec 0072 — sync must not report progress past its own total.
  //
  // Regression: reconcile used ONE counter shared by the removals loop (which
  // walks the DB's previous file set) and the adds/mods loop (which walks the
  // disk). `current` was therefore the cumulative work of both while `total`
  // was only the disk count. On a repo with ~1059 files the sync emitted
  // `{current: 2000, total: 1059}`; the CLI's progress bar turned that into a
  // 189% bar, computed `empty = 25 - 47 = -22`, and `String.repeat(-22)` threw
  // `RangeError: Invalid count value` from a UI timer — killing the process.
  //
  // The invariant below is the contract the bar relies on. It only trips once a
  // count crosses SYNC_RECONCILE_YIELD_INTERVAL (1000), so the fixture is large
  // on purpose.
  // ---------------------------------------------------------------------------
  describe('sync progress never exceeds its total (Spec 0072)', () => {
    let bigDir: string;
    let bigRepo: HomeGraph;

    const FILE_COUNT = 1100; // past the 1000 yield interval

    beforeEach(async () => {
      bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-spec0072-'));
      fs.mkdirSync(path.join(bigDir, 'src'));
      for (let i = 0; i < FILE_COUNT; i++) {
        fs.writeFileSync(
          path.join(bigDir, 'src', `mod${i}.ts`),
          `export function fn${i}() { return ${i}; }\n`
        );
      }
      bigRepo = HomeGraph.initSync(bigDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await bigRepo.indexAll();
    });

    afterEach(() => {
      if (bigRepo) bigRepo.destroy();
      if (fs.existsSync(bigDir)) removeTempDir(bigDir);
    });

    it('every scanning progress event satisfies current <= total', async () => {
      const events: Array<{ phase: string; current: number; total: number }> = [];

      // Delete a slice so the removals loop runs a meaningful number of times
      // AND the adds/mods loop still walks the full disk set — the exact shape
      // that used to make the shared counter overshoot.
      for (let i = 0; i < 60; i++) fs.unlinkSync(path.join(bigDir, 'src', `mod${i}.ts`));

      await bigRepo.sync({
        onProgress: (p) => {
          if (p && p.phase === 'scanning' && p.total > 0) {
            events.push({ phase: p.phase, current: p.current, total: p.total });
          }
        },
      });

      // The yield interval fired at least once, else the assertion is vacuous.
      expect(events.length).toBeGreaterThan(0);

      for (const e of events) {
        expect(e.current).toBeLessThanOrEqual(e.total);
        expect(e.current).toBeGreaterThan(0);
        // The bar computes percent from this ratio; 100 is the hard ceiling.
        expect(Math.round((e.current / e.total) * 100)).toBeLessThanOrEqual(100);
      }
    });

    it('a sync over the yield threshold completes without throwing', async () => {
      // The user-visible symptom was a crash, so assert the whole call settles.
      await expect(bigRepo.sync()).resolves.toBeDefined();
    });
  });
