/**
 * Ignore sources and lone-`!` hardening (Spec 0074).
 *
 * Two defects pinned here:
 *
 *  1. `buildDefaultIgnore` only merged the built-in defaults and the root
 *     `.gitignore`. git also honours `.git/info/exclude` and `core.excludesFile`
 *     — both real user configuration — so a directory excluded there was indexed
 *     anyway.
 *  2. A lone `!` line in a `.gitignore` compiled to "negate everything" in the
 *     `ignore` library, silently disabling EVERY rule above it, while git itself
 *     treats it as a no-op. One stray `!` pulled `node_modules/` into the index.
 *
 * The strongest assertions here compare against `git check-ignore` on the same
 * throwaway repo, so the semantics cannot drift from git's own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { buildDefaultIgnore, readGitignorePatterns } from '../src/extraction/default-ignore';
import { removeTempDir } from './helpers/fs';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** True when `git check-ignore` considers `rel` ignored in `cwd`. */
const gitIgnores = (cwd: string, rel: string): boolean => {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('ignore sources (Spec 0074)', () => {
  let dir: string;

  const write = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-ignore-'));
    git(dir, 'init', '-q');
  });

  afterEach(() => {
    if (fs.existsSync(dir)) removeTempDir(dir);
  });

  describe('.git/info/exclude', () => {
    it('is honoured — the file was indexed before this fix', () => {
      write('src/a.ts', 'export function a() { return 1; }\n');
      write('generated/g.ts', 'export function g() { return 2; }\n');
      write('.git/info/exclude', 'generated/\n');

      // git agrees this is ignored; the indexer must agree with git.
      expect(gitIgnores(dir, 'generated/g.ts')).toBe(true);
      expect(buildDefaultIgnore(dir).ignores('generated/g.ts')).toBe(true);
    });

    it('does not affect files it says nothing about', () => {
      write('src/a.ts', 'export function a() { return 1; }\n');
      write('.git/info/exclude', 'generated/\n');

      expect(buildDefaultIgnore(dir).ignores('src/a.ts')).toBe(false);
    });

    it('is overridable by a .gitignore negation, as in git', () => {
      write('src/keep.ts', 'export function k() { return 1; }\n');
      write('.git/info/exclude', 'src/**\n');
      write('.gitignore', '!src/**\n');

      // git lets the .gitignore negation win over info/exclude; so must the
      // matcher, which is why the extras are added AFTER the root .gitignore
      // (later patterns win in the `ignore` library, as in git's own order).
      expect(gitIgnores(dir, 'src/keep.ts')).toBe(false);
      expect(buildDefaultIgnore(dir).ignores('src/keep.ts')).toBe(false);
    });
  });

  describe('core.excludesFile', () => {
    let globalIgnore: string;

    beforeEach(() => {
      globalIgnore = path.join(dir, '..', `homegraph-global-ignore-${path.basename(dir)}`);
      fs.writeFileSync(globalIgnore, 'tmpjunk/\n');
      git(dir, 'config', 'core.excludesFile', globalIgnore);
    });

    afterEach(() => {
      if (globalIgnore && fs.existsSync(globalIgnore)) fs.rmSync(globalIgnore, { force: true });
    });

    it('is honoured', () => {
      write('src/a.ts', 'export function a() { return 1; }\n');
      write('tmpjunk/x.ts', 'export function x() { return 2; }\n');

      expect(gitIgnores(dir, 'tmpjunk/x.ts')).toBe(true);
      expect(buildDefaultIgnore(dir).ignores('tmpjunk/x.ts')).toBe(true);
    });

    it('a missing or unset excludesFile is not an error', () => {
      git(dir, 'config', '--unset', 'core.excludesFile');
      write('src/a.ts', 'export function a() { return 1; }\n');

      // No throw, and normal behaviour is untouched.
      expect(buildDefaultIgnore(dir).ignores('src/a.ts')).toBe(false);
    });
  });

  describe('a lone `!` line', () => {
    it('no longer reverses every rule above it', () => {
      write('node_modules/pkg/index.ts', 'export function dep() { return 1; }\n');
      write('src/a.ts', 'export function a() { return 1; }\n');
      write('.gitignore', 'node_modules/\n!\n');

      // Before the fix this was `false`: the stray `!` negated everything and
      // the whole dependency tree entered the index.
      expect(buildDefaultIgnore(dir).ignores('node_modules/pkg/index.ts')).toBe(true);
      expect(buildDefaultIgnore(dir).ignores('node_modules/')).toBe(true);
    });

    it('a `!` surrounded by whitespace is dropped too', () => {
      write('dist/bundle.js', 'export const x = 1;\n');
      write('.gitignore', 'dist/\n   !   \n');

      expect(buildDefaultIgnore(dir).ignores('dist/bundle.js')).toBe(true);
    });

    it('a REAL negation still works', () => {
      write('gen/lib.ts', 'export function v() { return 1; }\n');
      write('gen/other.ts', 'export function o() { return 2; }\n');
      // `gen/**` rather than `gen/`: the `ignore` library will not descend into
      // an excluded DIRECTORY to re-include a child, so a directory-form
      // exclusion cannot carry a nested negation. That is a pre-existing
      // library property, not something this spec changes — the point here is
      // that the lone-`!` fix did not break negation itself.
      write('.gitignore', 'gen/**\n!gen/lib.ts\n');

      expect(buildDefaultIgnore(dir).ignores('gen/lib.ts')).toBe(false);
      expect(buildDefaultIgnore(dir).ignores('gen/other.ts')).toBe(true);
    });

    it('readGitignorePatterns strips it while keeping the other patterns', () => {
      write('.gitignore', 'a/\n!\nb/\n');
      const out = readGitignorePatterns(path.join(dir, '.gitignore'));

      expect(out.split('\n')).not.toContain('!');
      expect(out).toContain('a/');
      expect(out).toContain('b/');
    });
  });

  describe('agreement with git check-ignore', () => {
    it('matches git across a mixed rule set', () => {
      write('.gitignore', 'dist/\n!dist/keep.ts\nlib/\n');
      write('.git/info/exclude', 'secret/\n');
      write('src/a.ts', 'x\n');
      write('dist/b.js', 'x\n');
      write('dist/keep.ts', 'x\n');
      write('lib/c.ts', 'x\n');
      write('packages/app/lib/d.ts', 'x\n');
      write('secret/e.ts', 'x\n');

      const matcher = buildDefaultIgnore(dir);
      const paths = [
        'src/a.ts',
        'dist/b.js',
        'dist/keep.ts',
        'lib/c.ts',
        'packages/app/lib/d.ts',
        'secret/e.ts',
      ];
      for (const p of paths) {
        expect({ path: p, ignored: matcher.ignores(p) }).toEqual({
          path: p,
          ignored: gitIgnores(dir, p),
        });
      }
    });

    it('an anchored /lib/ only excludes the root one, like git', () => {
      // #2849 territory: a bare `lib/` matches at ANY depth (git semantics), an
      // anchored `/lib/` only at the root. HomeGraph must follow git in both.
      write('.gitignore', '/lib/\n');
      write('lib/a.ts', 'x\n');
      write('packages/app/lib/b.ts', 'x\n');

      const matcher = buildDefaultIgnore(dir);
      for (const p of ['lib/a.ts', 'packages/app/lib/b.ts']) {
        expect({ path: p, ignored: matcher.ignores(p) }).toEqual({
          path: p,
          ignored: gitIgnores(dir, p),
        });
      }
      // Explicit expectations, so a future refactor can't pass by agreeing on
      // the wrong answer.
      expect(matcher.ignores('lib/a.ts')).toBe(true);
      expect(matcher.ignores('packages/app/lib/b.ts')).toBe(false);
    });
  });

  describe('non-git projects', () => {
    it('behaves exactly as before — built-in defaults plus .gitignore', () => {
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-ignore-nogit-'));
      try {
        fs.mkdirSync(path.join(plain, 'src'), { recursive: true });
        fs.writeFileSync(path.join(plain, 'src', 'a.ts'), 'x\n');
        fs.writeFileSync(path.join(plain, '.gitignore'), 'dist/\n');
        fs.mkdirSync(path.join(plain, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(plain, 'dist', 'b.js'), 'x\n');

        const matcher = buildDefaultIgnore(plain);
        expect(matcher.ignores('src/a.ts')).toBe(false);
        expect(matcher.ignores('dist/b.js')).toBe(true);
        expect(matcher.ignores('node_modules/x.js')).toBe(true);
      } finally {
        removeTempDir(plain);
      }
    });

    it('never throws when git is unavailable', () => {
      // A directory that is not a repo at all — resolveGitDir returns null and
      // the core.excludesFile query fails; both must degrade to "nothing extra".
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-ignore-nogit2-'));
      try {
        expect(() => buildDefaultIgnore(plain)).not.toThrow();
      } finally {
        removeTempDir(plain);
      }
    });
  });
});
