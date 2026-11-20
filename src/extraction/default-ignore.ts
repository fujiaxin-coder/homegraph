/**
 * Built-in directory / path ignore rules shared by `scanDirectory` and
 * language-specific walks (e.g. ArkTS `scanEtsFiles`) so every enumerator
 * agrees on what is project source vs build/vendor noise.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import ignore, { Ignore } from 'ignore';
import { logWarn } from '../errors';

/**
 * Directory names that are dependency, build, cache, or tooling output across the
 * languages/frameworks HomeGraph supports — curated from the canonical
 * github/gitignore templates. Excluded by default so the graph reflects your code,
 * not third-party noise, without requiring a `.gitignore` (issue #407). The
 * exclusion applies uniformly (git or not, tracked or not); the only opt-in is an
 * explicit `.gitignore` negation (e.g. `!vendor/`). First-party-prone or generic
 * names (`packages`, `lib`, `app`, `bin`, `src`, `deps`, `env`, `tmp`, `storage`,
 * `Library`) are deliberately NOT listed, to avoid ever hiding real source.
 *
 * Only dirs that actually contain *indexable source* (or are enormous) earn a slot
 * — IDE/state dirs like `.idea`/`.vs` are omitted because HomeGraph indexes only
 * recognized source extensions, so they produce no symbols regardless.
 */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // JS / TS — dependency directories
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store',
  // JS / TS — framework & bundler build / cache / deploy output
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.docusaurus', 'storybook-static', '.vinxi', '.nitro', 'out-tsc',
  '.vercel', '.netlify', '.wrangler',
  // Build output (common across ecosystems)
  'dist', 'build', 'out', '.output',
  // Test / coverage
  'coverage', '.nyc_output',
  // Python
  '__pycache__', '__pypackages__', '.venv', 'venv', '.pixi', '.pdm-build',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  '.ipynb_checkpoints', '.eggs',
  // Rust / JVM (Maven, Gradle, Scala)
  'target', '.gradle',
  // .NET
  'obj',
  // Vendored deps (Go, PHP/Composer, Ruby/Bundler)
  'vendor',
  // Swift / iOS
  '.build', 'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  // Dart / Flutter
  '.dart_tool', '.pub-cache',
  // Native (Android NDK, C/C++ deps)
  '.cxx', '.externalNativeBuild', 'vcpkg_installed',
  // Scala tooling
  '.bloop', '.metals',
  // Lua / Luau (LuaRocks)
  'lua_modules', '.luarocks',
  // Delphi / RAD Studio IDE backups (duplicate .pas source — would double-count)
  '__history', '__recovery',
  // Generic cache
  '.cache',
]);

/**
 * Android resource directory types. A `res/` tree holds ONLY non-code resources —
 * layouts, drawables, value bags (strings/colors/styles), menus, navigation
 * graphs — split into one typed subdirectory per kind, optionally density/locale/
 * version-qualified (`values-es`, `drawable-hdpi`, `layout-v21`, …). None of it
 * yields an extractable code symbol, yet on an Android app it DOMINATES the tree
 * (one report: 26k XML files = 97% of the project, 0 symbols), bloating the DB,
 * slowing indexing, and skewing both the file count and `codegraph_explore`
 * results (#1047). So these are excluded by default. The structure is
 * self-identifying — a non-Android project has no `res/layout/` etc., so it's
 * untouched — and the only XML that DOES produce symbols (MyBatis mappers) lives
 * under `src/main/resources/`, never `res/`, so nothing useful is dropped.
 * `res/raw/` is deliberately NOT here: it holds arbitrary bundled assets that can
 * be code-ish (a `.sql` schema, a `.js`), so we leave it indexed. Override any of
 * these with a `.gitignore` negation (e.g. `!res/values/`).
 */
const ANDROID_RES_TYPES: readonly string[] = [
  'anim', 'animator', 'color', 'drawable', 'font', 'layout',
  'menu', 'mipmap', 'navigation', 'transition', 'values', 'xml',
];

/** Gitignore-style patterns for the `ignore` matcher: the dirs above plus a few globs. */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `${d}/`),
  '*.egg-info/',     // Python packaging metadata
  'cmake-build-*/',  // CLion / CMake build trees
  'bazel-*/',        // Bazel output symlink trees
  // Android resource dirs at any depth, with their qualifier variants (#1047).
  ...ANDROID_RES_TYPES.map((t) => `**/res/${t}*/`),
];

/** True if `buf` decodes as strict UTF-8 (no invalid byte sequences). */
function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop patterns that name nothing.
 *
 * A lone `!` (or `!` followed only by whitespace) is the dangerous case: git
 * treats it as a no-op — there is no pattern after the negation prefix to
 * re-include — but the `ignore` library compiles it into "negate everything",
 * which silently disables EVERY rule above it. One stray `!` therefore pulls
 * `node_modules/`, `dist/` and the rest of the tree back into the index, which
 * on a large JS project means hundreds of thousands of files (Spec 0074).
 *
 * Applies to every source that funnels through `readGitignorePatterns` — the
 * project `.gitignore`, `.git/info/exclude` and `core.excludesFile` — because
 * git's own parser treats a lone `!` the same way in all three.
 */
function dropEmptyPatterns(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '!')
    .join('\n');
}

/**
 * Read a `.gitignore` and return patterns safe to hand to the `ignore` matcher —
 * never throwing, even when the file isn't real gitignore text. Two failure
 * modes, both seen in the wild (issue #682):
 *
 *  - The file isn't valid UTF-8 — e.g. transparently encrypted in place by
 *    corporate DLP / endpoint-security software, leaving a UTF-16 header plus
 *    ciphertext. None of it is meaningful patterns, so the whole file is skipped.
 *  - The file is text but a single line can't be compiled to a regex by the
 *    `ignore` library — `\\[` and friends throw "Unterminated character class".
 *    Crucially the throw is LAZY (at match time, not `.add()`), so it would
 *    otherwise escape mid-scan. That one pattern is dropped; the rest are kept.
 *
 * Either way a warning that NAMES the file is logged (the reporter couldn't tell
 * which `.gitignore` was at fault) and indexing continues instead of aborting.
 * Returns '' when there's nothing usable.
 */
export function readGitignorePatterns(giPath: string): string {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(giPath);
  } catch {
    return ''; // unreadable (permissions / race) — treat as absent
  }
  // A NUL byte never appears in real gitignore text, and a fatal UTF-8 decode
  // catches the rest. Such a file isn't ignore patterns at all.
  if (buf.includes(0) || !isValidUtf8(buf)) {
    logWarn(
      'Ignoring a .gitignore that is not valid UTF-8 text — it may have been encrypted ' +
        'in place by endpoint-security software. Indexing continues without it.',
      { file: giPath },
    );
    return '';
  }
  const content = buf.toString('utf-8');
  // Fast path: one `.ignores()` call forces the library to compile EVERY rule,
  // so if it doesn't throw, the whole file is safe to use verbatim.
  try {
    ignore().add(content).ignores('.homegraph-probe');
    return dropEmptyPatterns(content);
  } catch {
    // Fall through: a line is uncompilable — keep the good ones, drop the bad.
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const line of content.split(/\r?\n/)) {
    // A lone `!` compiles fine but reverses every rule above it, so it must be
    // dropped here too — the compile check would never catch it.
    if (line.trim() === '!') continue;
    try {
      ignore().add(line).ignores('.homegraph-probe');
      kept.push(line);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    logWarn(
      `Skipped ${dropped} unparseable pattern(s) in a .gitignore; the rest are applied.`,
      { file: giPath },
    );
  }
  return kept.join('\n');
}

/**
 * The repository's `.git` directory, or null outside a repo.
 *
 * Uses `rev-parse --absolute-git-dir` rather than joining `rootDir/.git`, so a
 * worktree (where `.git` is a file pointing elsewhere) and a submodule resolve
 * to the real directory that holds `info/exclude`.
 */
function resolveGitDir(rootDir: string): string | null {
  try {
    const out = execFileSync('git', ['-C', rootDir, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null; // not a repo, git absent, or timed out
  }
}

/** Expand a leading `~` the way git does for `core.excludesFile`. */
function expandUserPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * git's exclude sources beyond the project `.gitignore`: `.git/info/exclude` and
 * whichever file `core.excludesFile` names.
 *
 * Both are real ignore configuration — same format, same "default ignore"
 * semantics, and overridable by a `.gitignore` negation — but neither is a
 * `.gitignore`, so before this the indexer never saw them: a file the user
 * explicitly excluded landed in the graph, and a private or secret-bearing
 * directory got read into SQLite (Spec 0074).
 *
 * Best-effort throughout: outside a repo, without git, or if a file is
 * unreadable, the contribution is simply empty. Never throws.
 */
function readGitExcludeExtraPatterns(rootDir: string): string {
  const chunks: string[] = [];

  const gitDir = resolveGitDir(rootDir);
  if (gitDir) {
    const excludePath = path.join(gitDir, 'info', 'exclude');
    if (fs.existsSync(excludePath)) {
      const patterns = readGitignorePatterns(excludePath);
      if (patterns) chunks.push(patterns);
    }
  }

  try {
    const configured = execFileSync('git', ['-C', rootDir, 'config', '--get', 'core.excludesFile'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    if (configured) {
      const abs = expandUserPath(configured);
      if (fs.existsSync(abs)) {
        const patterns = readGitignorePatterns(abs);
        if (patterns) chunks.push(patterns);
      }
    }
  } catch {
    // No git, unset, or timeout — leave extras empty.
  }

  return chunks.join('\n');
}

/**
 * An `ignore` matcher seeded with the built-in defaults, merged with the project's
 * root .gitignore so a negation there (e.g. `!vendor/`) overrides a default. Shared
 * by both enumeration paths so behavior is identical with or without git — and so
 * the defaults apply to tracked files too (committing a dependency dir doesn't make
 * it project code; the explicit `.gitignore` negation is the only opt-in).
 *
 * git's other exclude sources (`.git/info/exclude`, `core.excludesFile`) are
 * added BEFORE the root `.gitignore`, because a later pattern wins in the
 * `ignore` library — and git gives `.gitignore` the highest precedence, so its
 * negation must be able to override them (Spec 0074).
 */
export function buildDefaultIgnore(rootDir: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
  // Lower precedence first: git's non-.gitignore exclude sources.
  const extra = readGitExcludeExtraPatterns(rootDir);
  if (extra) ig.add(extra);
  // Highest precedence last: the project .gitignore, so its `!` overrides both
  // a built-in default and anything the exclude sources said.
  const rootGitignore = path.join(rootDir, '.gitignore');
  if (fs.existsSync(rootGitignore)) ig.add(readGitignorePatterns(rootGitignore));
  return ig;
}

/**
 * Defaults-only ignore matcher (no root `.gitignore` merged). Used wherever the
 * parent repo's own ignore rules must NOT apply — inside embedded child repos,
 * whose gitignore semantics their own `git ls-files` already enforced (#514).
 */
export function defaultsOnlyIgnore(): Ignore {
  return ignore().add(DEFAULT_IGNORE_PATTERNS);
}
