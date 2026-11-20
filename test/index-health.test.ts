/**
 * Index health — files whose content is current but whose symbols are missing
 * (Spec 0073).
 *
 * The bug this pins: `status` judged an index only by whether it had caught up
 * with the disk (`getChangedFiles`, the `indexed_at_commit` stamp). A file that
 * was indexed, hashed correctly, and yielded ZERO symbols passed every one of
 * those checks — so `homegraph status` printed `[OK] Index is up to date` and
 * `index.state = complete` while that file's code was invisible to every query.
 *
 * `getIndexHealth()` splits such files by what the user should do: re-read the
 * file (`needsReindex`) or fix it / its grammar (`parseErrors`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { removeTempDir } from './helpers/fs';

describe('Index health (Spec 0073)', () => {
  let testDir: string;
  let cg: HomeGraph;

  const write = (rel: string, content: string): void => {
    const full = path.join(testDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-health-'));
    fs.mkdirSync(path.join(testDir, 'src'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) removeTempDir(testDir);
  });

  describe('a healthy index', () => {
    it('reports nothing when every file yields symbols', async () => {
      write('src/a.ts', 'export function alpha() { return 1; }\n');
      write('src/b.ts', 'export function beta() { return 2; }\n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const health = cg.getIndexHealth();
      expect(health.needsReindex).toHaveLength(0);
      expect(health.parseErrors).toHaveLength(0);
    });
  });

  describe('a file that yields no symbols', () => {
    it('is reported as needing a re-read, not left as "up to date"', async () => {
      write('src/good.ts', 'export function good() { return 1; }\n');
      // Not TypeScript: tree-sitter recovers into an error tree with no
      // declarations, so the file is indexed and hashed but contributes
      // nothing beyond its own `file` node.
      write('src/broken.ts', 'this is not valid typescript @@@ {{{ \n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const health = cg.getIndexHealth();
      const flagged = [...health.needsReindex, ...health.parseErrors];
      expect(flagged).toContain('src/broken.ts');
      // The healthy file must never be blamed.
      expect(flagged).not.toContain('src/good.ts');
    });

    it('the flag survives a content-hash comparison — the bug this pins', async () => {
      write('src/broken.ts', 'this is not valid typescript @@@ {{{ \n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      // The bytes are unchanged: change detection sees nothing to do. This is
      // exactly why the old status called the index current.
      const changes = cg.getChangedFiles();
      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.removed).toHaveLength(0);

      // …and the health check is what surfaces the damage.
      expect(cg.getIndexHealth().needsReindex).toContain('src/broken.ts');
    });

    it('names every offending file, not just the first', async () => {
      write('src/bad1.ts', '@@@ {{{ \n');
      write('src/bad2.ts', '%%% }}} \n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const flagged = [...cg.getIndexHealth().needsReindex, ...cg.getIndexHealth().parseErrors];
      expect(flagged).toContain('src/bad1.ts');
      expect(flagged).toContain('src/bad2.ts');
    });
  });

  describe('file-level-only languages', () => {
    it('does not blame a language whose unit of meaning is the file', async () => {
      // `yaml` produces no symbol nodes by design — an empty node list is the
      // correct result there, and reporting it would be a permanent false alarm.
      write('src/a.ts', 'export function alpha() { return 1; }\n');
      write('config.yaml', 'name: demo\nversion: 1\n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*'], exclude: [] } });
      await cg.indexAll();

      const health = cg.getIndexHealth();
      const flagged = [...health.needsReindex, ...health.parseErrors];
      expect(flagged).not.toContain('config.yaml');
    });
  });

  describe('files that are legitimately symbol-free', () => {
    it('does not blame a re-export barrel', async () => {
      // A barrel's whole job is forwarding names declared elsewhere — flagging
      // every `index.ts` would make the report noise nobody reads.
      write('src/real.ts', 'export function real() { return 1; }\n');
      write('src/barrel.ts', "export * from './real';\nexport { real as alias } from './real';\n");
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const flagged = [...cg.getIndexHealth().needsReindex, ...cg.getIndexHealth().parseErrors];
      expect(flagged).not.toContain('src/barrel.ts');
    });

    it('does not blame a multi-line export block or `export type {}`', async () => {
      write('src/real.ts', 'export function real() { return 1; }\nexport type T = number;\n');
      write('src/barrel.ts', [
        "export type { T } from './real';",
        'export {',
        '  real,',
        "} from './real';",
        '',
      ].join('\n'));
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const flagged = [...cg.getIndexHealth().needsReindex, ...cg.getIndexHealth().parseErrors];
      expect(flagged).not.toContain('src/barrel.ts');
    });

    it('does not blame a minified single-line data payload', async () => {
      // A bundled JSON blob is not code; there is nothing for the user to fix.
      write('src/real.ts', 'export function real() { return 1; }\n');
      write('src/data.js', `window.DATA = {${'a:1,'.repeat(2000)}z:0};\n`);
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*'], exclude: [] } });
      await cg.indexAll();

      const flagged = [...cg.getIndexHealth().needsReindex, ...cg.getIndexHealth().parseErrors];
      expect(flagged).not.toContain('src/data.js');
    });

    it('still flags a file that DECLARES something but yielded no symbols', async () => {
      // The barrel exemption must not swallow a real defect: a file with an
      // actual declaration that produced nothing is exactly what to report.
      write('src/declares.ts', 'export function decl() { return 1; }\n');
      write('src/junk.ts', 'export function broken( { [[[ \n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const flagged = [...cg.getIndexHealth().needsReindex, ...cg.getIndexHealth().parseErrors];
      expect(flagged).toContain('src/junk.ts');
    });
  });

  describe('classification', () => {
    it('the two lists never overlap', async () => {
      write('src/bad.ts', '@@@ {{{ \n');
      write('src/ok.ts', 'export function ok() { return 1; }\n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const { needsReindex, parseErrors } = cg.getIndexHealth();
      const overlap = needsReindex.filter((p) => parseErrors.includes(p));
      expect(overlap).toHaveLength(0);
    });

    it('paths are repository-relative, not absolute', async () => {
      write('src/bad.ts', '@@@ {{{ \n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const flagged = [...cg.getIndexHealth().needsReindex, ...cg.getIndexHealth().parseErrors];
      for (const p of flagged) {
        expect(path.isAbsolute(p)).toBe(false);
        expect(p).toContain('src/bad.ts');
      }
    });
  });

  describe('after the file is repaired', () => {
    it('a fixed file drops off the list', async () => {
      write('src/bad.ts', '@@@ {{{ \n');
      cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();
      expect(cg.getIndexHealth().needsReindex).toContain('src/bad.ts');

      write('src/bad.ts', 'export function repaired() { return 42; }\n');
      await cg.sync();

      const health = cg.getIndexHealth();
      expect(health.needsReindex).not.toContain('src/bad.ts');
      expect(health.parseErrors).not.toContain('src/bad.ts');
    });
  });
});

/**
 * End-to-end through the built CLI: the health report must actually reach the
 * user, and `--strict` must turn it into an exit code a script can gate on.
 *
 * Skipped when `dist/` has not been built, so `vitest run` on a fresh checkout
 * does not fail for a reason that has nothing to do with this spec.
 */
describe('homegraph status reports index health (Spec 0073, CLI)', () => {
  const BIN = path.resolve(__dirname, '../dist/bin/homegraph.js');
  const built = fs.existsSync(BIN);

  let dir: string;

  const write = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-health-cli-'));
    fs.mkdirSync(path.join(dir, 'src'));
    write('src/good.ts', 'export function good() { return 1; }\n');
    write('src/broken.ts', 'this is not valid typescript @@@ {{{ \n');
  });

  afterEach(() => {
    if (fs.existsSync(dir)) removeTempDir(dir);
  });

  const run = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [BIN, ...args], {
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, HOMEGRAPH_NO_DAEMON: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  it.skipIf(!built)('names the file and does not claim a plain "up to date"', async () => {
    const cg = HomeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.destroy();

    const { out } = run(['status']);
    expect(out).toContain('Index Health');
    expect(out).toContain('src/broken.ts');
    // The misleading bare verdict must be gone.
    expect(out).not.toMatch(/\[OK\] Index is up to date\b(?!,)/);
    expect(out).toContain('yielded no symbols');
  });

  it.skipIf(!built)('--strict exits non-zero when a file lost its symbols', async () => {
    const cg = HomeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.destroy();

    expect(run(['status', '--strict']).code).toBe(1);
  });

  it.skipIf(!built)('--strict exits zero on a fully healthy index', async () => {
    // Drop the broken file, re-index, and the gate opens.
    fs.unlinkSync(path.join(dir, 'src/broken.ts'));
    const cg = HomeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.destroy();

    expect(run(['status', '--strict']).code).toBe(0);
  });

  it.skipIf(!built)('--json carries indexHealth', async () => {
    const cg = HomeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.destroy();

    const { out } = run(['status', '--json']);
    const parsed = JSON.parse(out.trim().split('\n').pop() as string) as {
      indexHealth: { needsReindex: string[]; parseErrors: string[] };
    };
    const flagged = [...parsed.indexHealth.needsReindex, ...parsed.indexHealth.parseErrors];
    expect(flagged).toContain('src/broken.ts');
  });
});
