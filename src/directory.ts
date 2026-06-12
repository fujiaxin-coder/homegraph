/**
 * Directory Management
 *
 * Manages the .homegraph/ directory structure for HomeGraph data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The default per-project data directory name. */
const DEFAULT_HOMEGRAPH_DIR = '.homegraph';

let warnedBadDirName = false;

/**
 * Resolve the per-project data directory name, honoring the `HOMEGRAPH_DIR`
 * environment override (default `.homegraph`). The override is a single path
 * segment that lives in the project root.
 *
 * Why this exists: two environments that share one working tree must NOT share
 * one `.homegraph/` — most concretely Windows-native and WSL (issue #636). The
 * daemon lockfile (`.homegraph/daemon.pid`) records a platform-specific pid and
 * socket path (a Windows named pipe vs a WSL Unix socket), and SQLite file
 * locking across the WSL2 ↔ Windows filesystem boundary is unreliable, so two
 * daemons sharing one index risks corruption. Setting `HOMEGRAPH_DIR=.homegraph-win`
 * on one side gives each environment its own index in the same tree.
 *
 * Read live (not captured at load) so it is both process-accurate and testable.
 * An override that isn't a plain directory name — empty, containing a path
 * separator, `.`, `..`/traversal, or absolute — is ignored (we keep the
 * default) rather than risk writing the index outside the project or into the
 * project root itself; we warn once to stderr so the misconfiguration is seen.
 */
export function homeGraphDirName(): string {
  const raw = process.env.HOMEGRAPH_DIR?.trim();
  if (!raw) return DEFAULT_HOMEGRAPH_DIR;
  const invalid =
    raw === '.' ||
    raw.includes('..') ||
    raw.includes('/') ||
    raw.includes('\\') ||
    path.isAbsolute(raw);
  if (invalid) {
    if (!warnedBadDirName) {
      warnedBadDirName = true;
      // stderr only — stdout is the MCP protocol channel.
      console.warn(
        `[homegraph] Ignoring invalid HOMEGRAPH_DIR="${raw}" — it must be a plain ` +
          `directory name (no path separators, no "..", not absolute). Using "${DEFAULT_HOMEGRAPH_DIR}".`
      );
    }
    return DEFAULT_HOMEGRAPH_DIR;
  }
  return raw;
}

/** Default data directory name (also honors {@link homeGraphDirName} at runtime). */
export const HOMEGRAPH_DIR = DEFAULT_HOMEGRAPH_DIR;

/**
 * Is `name` (a single path segment) a HomeGraph data directory? Matches the
 * default `.homegraph`, the active override, and any `.homegraph-*` sibling.
 */
export function isHomeGraphDataDir(name: string): boolean {
  const active = homeGraphDirName();
  return (
    name === DEFAULT_HOMEGRAPH_DIR ||
    name === active ||
    name.startsWith(DEFAULT_HOMEGRAPH_DIR + '-')
  );
}

/**
 * Get the .homegraph directory path for a project
 */
export function getHomeGraphDir(projectRoot: string): string {
  return path.join(projectRoot, homeGraphDirName());
}

/**
 * Check if a project has been initialized with HomeGraph
 * Requires both .homegraph/ directory AND homegraph.db to exist
 */
export function isInitialized(projectRoot: string): boolean {
  const homegraphDir = getHomeGraphDir(projectRoot);
  if (!fs.existsSync(homegraphDir) || !fs.statSync(homegraphDir).isDirectory()) {
    return false;
  }
  // Must have homegraph.db, not just .homegraph folder
  const dbPath = path.join(homegraphDir, 'homegraph.db');
  return fs.existsSync(dbPath);
}

/**
 * Find the nearest parent directory containing .homegraph/
 *
 * Walks up from the given path to find a HomeGraph-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .homegraph/, or null if not found
 */
/**
 * Reason a directory is unsafe to use as an index ROOT, or null when it's fine.
 *
 * Indexing your home directory or a filesystem root drags in caches, `Library`,
 * every other project, etc. — a multi-GB index, constant file-watcher churn, and
 * (pre-1.0 on macOS) a file-descriptor blowup that exhausted `kern.maxfiles` and
 * took unrelated apps / the whole machine down (#845). The classic trigger:
 * running the installer or `homegraph init` from `$HOME`, which auto-indexes the
 * current directory. These are never intended project roots, so the installer
 * and `init`/`index` refuse them (overridable with `--force`).
 *
 * Pure-ish (reads only `os.homedir()` + realpath) so it's easy to unit-test.
 * The returned string is a human phrase that slots into "… looks like {reason}".
 */
export function unsafeIndexRootReason(projectRoot: string): string | null {
  const resolve = (p: string): string => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const resolved = resolve(projectRoot);

  // Filesystem root: `/` on POSIX, a drive root like `C:\` on Windows.
  if (path.parse(resolved).root === resolved) {
    return 'the filesystem root';
  }

  const home = resolve(os.homedir());
  // Case-insensitive on macOS/Windows (case-preserving but case-insensitive FS).
  const norm = (p: string): string =>
    process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
  const r = norm(resolved);
  const h = norm(home);

  if (r === h) {
    return 'your home directory';
  }
  // An ancestor of home (e.g. `/Users`, `/home`) — even broader than home.
  if (h.startsWith(r + path.sep)) {
    return 'a parent of your home directory';
  }
  return null;
}

export function findNearestHomeGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/** Heavy/irrelevant directory names the sub-project scan never descends into. */
const SUBPROJECT_SCAN_SKIP = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'vendor', 'bin', 'obj', '.next', '.nuxt', '.svelte-kit', '.cache', 'coverage',
  '.venv', 'venv', '__pycache__', '.turbo', '.idea', '.vscode', 'tmp', 'temp',
]);

/** Manifests that mark a directory as a project/workspace root. The down-scan
 *  is gated on one of these so a non-project cwd (e.g. `$HOME`) is a cheap
 *  no-op instead of a deep filesystem crawl. */
const WORKSPACE_ROOT_MANIFESTS = [
  'package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json',
  'go.work', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'pyproject.toml', 'composer.json', 'Gemfile', 'rush.json',
  'WORKSPACE', 'WORKSPACE.bazel',
];

function looksLikeProjectRoot(dir: string): boolean {
  return WORKSPACE_ROOT_MANIFESTS.some((m) => fs.existsSync(path.join(dir, m)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Indexed sub-project roots beneath `root` (bounded breadth-first scan). For
 * the monorepo case behind #964: the index lives in a CHILD
 * (`packages/x/.homegraph/`), not at the workspace root the agent's cwd points
 * at. Descent stops at the first indexed directory on a branch (a project's
 * own sub-dirs aren't separate projects) and is bounded by depth + count so it
 * never turns into a full-tree crawl on a large repo.
 */
export function findIndexedSubprojectRoots(
  root: string,
  opts: { maxDepth?: number; max?: number } = {},
): string[] {
  const maxDepth = opts.maxDepth ?? 4;
  const max = opts.max ?? 64;
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= max || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SUBPROJECT_SCAN_SKIP.has(e.name)) continue;
      const child = path.join(dir, e.name);
      if (isInitialized(child)) { out.push(child); continue; } // don't descend into an indexed project
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/**
 * What the front-load hook should do for a prompt issued from a directory.
 */
export interface FrontloadPlan {
  /** Open + explore this project and inject its source as context. `null` when
   *  there's no single project to front-load (none indexed, or several indexed
   *  sub-projects with no clear match — see {@link nudgeProjects}). */
  exploreRoot: string | null;
  /** Indexed sub-projects to surface in a "pass `projectPath`" nudge: the rest
   *  of a monorepo's indexed projects alongside `exploreRoot`, or — when no one
   *  project clearly matches — the full list (with `exploreRoot` null). */
  nudgeProjects: string[];
  /** True when the plan came from scanning DOWN into sub-projects (cwd itself
   *  is not under any index) — the monorepo case, where a follow-up
   *  `homegraph_explore` needs an explicit `projectPath`. */
  viaSubScan: boolean;
}

/**
 * Decide what the front-load hook injects for a `prompt` issued from `cwd`,
 * shaped by where the `.homegraph/` index(es) actually are:
 *   1. **cwd (or an ancestor) is indexed** → front-load that project. The
 *      normal single-project / nested-file case.
 *   2. **cwd isn't indexed but looks like a workspace root** → the indexes live
 *      in sub-projects (the monorepo case behind #964). One indexed
 *      sub-project → front-load it; several → front-load the one the prompt
 *      names (by relative path like `packages/api`, or package directory name)
 *      and nudge about the rest; several with no match → nudge the full list so
 *      the agent passes `projectPath`, rather than guessing wrong.
 *   3. **nothing indexed reachable** → do nothing (the agent's own tools apply).
 */
export function planFrontload(cwd: string, prompt: string): FrontloadPlan {
  const none: FrontloadPlan = { exploreRoot: null, nudgeProjects: [], viaSubScan: false };

  // 1. up-walk — nearest indexed ancestor (incl. cwd). Cheap; covers the common
  //    single-project case without a down-scan.
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i++) {
    if (isInitialized(dir)) return { exploreRoot: dir, nudgeProjects: [], viaSubScan: false };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 2. down-scan — only from something that looks like a workspace root, so a
  //    non-project cwd (e.g. $HOME) is a cheap no-op, not a deep crawl.
  const base = path.resolve(cwd);
  if (!looksLikeProjectRoot(base)) return none;
  const subs = findIndexedSubprojectRoots(base);
  if (subs.length === 0) return none;
  if (subs.length === 1) return { exploreRoot: subs[0]!, nudgeProjects: [], viaSubScan: true };

  // Several indexed sub-projects — pick the one the prompt points at, if any.
  const p = prompt.toLowerCase();
  let best: { root: string; score: number; relLen: number } | null = null;
  for (const s of subs) {
    const rel = path.relative(base, s);
    const relLc = rel.split(path.sep).join('/').toLowerCase();
    const name = path.basename(s).toLowerCase();
    let score = 0;
    if (relLc && p.includes(relLc)) score = 10;                         // "packages/api"
    else if (name.length >= 3 && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(p)) score = 5; // "api"
    if (score > 0 && (!best || score > best.score || (score === best.score && rel.length < best.relLen))) {
      best = { root: s, score, relLen: rel.length };
    }
  }
  if (best) {
    return { exploreRoot: best.root, nudgeProjects: subs.filter((s) => s !== best!.root), viaSubScan: true };
  }
  // No clear match — nudge the full list rather than front-load a guess.
  return { exploreRoot: null, nudgeProjects: subs, viaSubScan: true };
}

/**
 * Contents of `.homegraph/.gitignore`. A single wildcard ignore keeps every
 * transient file in the index dir — the database, `daemon.pid`, the socket,
 * logs, cache, and anything future versions add — out of git, without having
 * to enumerate each name (issues #788, #492, #484). Older versions wrote an
 * explicit allowlist that never listed `daemon.pid` or the socket, so those
 * runtime files were silently committed.
 */
const GITIGNORE_CONTENT = `# HomeGraph data files — local to each machine, not for committing.
# Ignore everything in .homegraph/ except this file itself, so transient
# files (the database, daemon.pid, sockets, logs) never show up in git.
*
!.gitignore
`;

/** Header line that prefixes every .gitignore HomeGraph has auto-generated. */
const GITIGNORE_MARKER = '# HomeGraph data files';

/**
 * Is `content` a stale HomeGraph-generated `.gitignore` that should be
 * regenerated in place? True when it carries our header but predates the
 * wildcard ignore (it has no bare `*` line) — i.e. one of the old explicit
 * allowlists (`*.db`, `cache/`, `.dirty`, …) that never ignored `daemon.pid`
 * or the socket (issue #788). A file WITHOUT our header is user-authored and
 * is left untouched; one that already has the wildcard is current. Matching
 * on the header (not a byte-exact list of past defaults) heals every old
 * variant — v0.7.x through 0.9.9 — and is idempotent once upgraded.
 */
function isStaleDefaultGitignore(content: string): boolean {
  if (!content.trimStart().startsWith(GITIGNORE_MARKER)) return false;
  return !content.split('\n').some((line) => line.trim() === '*');
}

/**
 * Write `.homegraph/.gitignore` if it's absent, or upgrade a stale
 * HomeGraph-generated default in place; a user-customized file is left alone.
 * Best-effort — returns `false` only if a needed write failed.
 */
function ensureGitignore(gitignorePath: string): boolean {
  let existing: string | null;
  try {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    existing = null; // absent (ENOENT) or unreadable — (re)create below
  }
  // Current default or a user-authored file: nothing to do.
  if (existing !== null && !isStaleDefaultGitignore(existing)) return true;
  try {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the .homegraph directory structure
 * Note: Only throws if homegraph.db already exists, not just if .homegraph/ exists.
 */
export function createDirectory(projectRoot: string): void {
  const homegraphDir = getHomeGraphDir(projectRoot);
  const dbPath = path.join(homegraphDir, 'homegraph.db');

  // Only throw if HomeGraph is actually initialized (db exists)
  // .homegraph/ folder alone is fine
  if (fs.existsSync(dbPath)) {
    throw new Error(`HomeGraph already initialized in ${projectRoot}`);
  }

  // Create main directory (if it doesn't exist)
  fs.mkdirSync(homegraphDir, { recursive: true });

  // Write .gitignore inside .homegraph (create if absent, upgrade a stale
  // pre-wildcard default left by an older version — issue #788).
  ensureGitignore(path.join(homegraphDir, '.gitignore'));
}

/**
 * Remove the .homegraph directory
 */
export function removeDirectory(projectRoot: string): void {
  const homegraphDir = getHomeGraphDir(projectRoot);

  if (!fs.existsSync(homegraphDir)) {
    return;
  }

  // Verify .homegraph is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(homegraphDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(homegraphDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(homegraphDir);
    return;
  }

  // Recursively remove directory
  fs.rmSync(homegraphDir, { recursive: true, force: true });
}

/**
 * Get all files in the .homegraph directory
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const homegraphDir = getHomeGraphDir(projectRoot);

  if (!fs.existsSync(homegraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .homegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(homegraphDir);
  return files;
}

/**
 * Get the total size of the .homegraph directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const homegraphDir = getHomeGraphDir(projectRoot);

  if (!fs.existsSync(homegraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .homegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(homegraphDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .homegraph
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getHomeGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .homegraph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const homegraphDir = getHomeGraphDir(projectRoot);

  if (!fs.existsSync(homegraphDir)) {
    errors.push('HomeGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(homegraphDir).isDirectory()) {
    errors.push('.homegraph exists but is not a directory');
    return { valid: false, errors };
  }

  // Auto-repair / upgrade .gitignore (non-critical file). A missing one is
  // recreated; a stale pre-wildcard default that never ignored daemon.pid is
  // regenerated in place (issue #788); a user-authored file is left alone.
  const gitignorePath = path.join(homegraphDir, '.gitignore');
  const existedBefore = fs.existsSync(gitignorePath);
  if (!ensureGitignore(gitignorePath) && !existedBefore) {
    // Only a missing-and-uncreatable file is surfaced; a failed in-place
    // upgrade of an existing file is non-fatal — the index still works.
    errors.push('.gitignore missing in .homegraph directory and could not be created');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
