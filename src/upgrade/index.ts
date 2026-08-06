/**
 * `homegraph upgrade`
 *
 * Self-update for the CLI, whatever way it was installed:
 *
 *   - **npm** — installed via `npm i -g homegraph`. Upgrading shells out to npm.
 *   - **npx** — ephemeral; nothing to upgrade (next `npx` fetches latest).
 *   - **source** — a git checkout running its own `dist/`; `git pull` + rebuild.
 *   - **bundle** — legacy self-contained runtime+app layout (vendored node +
 *     launcher). Standalone installers are retired; upgrade refuses and points
 *     the user at `npm i -g homegraph` (and `homegraph uninstall` can still
 *     remove leftover bundle artifacts).
 *
 * Detection is structural (see `detectInstallMethod`): a leftover bundle still
 * carries a vendored `node` binary and a `bin/homegraph` launcher next to its
 * `lib/`, so we can recognize it from the running file's path without a marker.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawnSync } from 'child_process';

export const REPO = 'homegraph/homegraph';
export const NPM_PACKAGE = 'homegraph';

// ---------------------------------------------------------------------------
// Install-method detection (pure — fully unit-testable via injected probes)
// ---------------------------------------------------------------------------

export type InstallMethod =
  | { kind: 'bundle'; os: 'unix' | 'windows'; bundleRoot: string; installDir: string | null }
  | { kind: 'npm'; scope: 'global' | 'local' }
  | { kind: 'npx' }
  | { kind: 'source'; root: string }
  | { kind: 'unknown'; reason: string };

export interface DetectInput {
  /** `__filename` of the running CLI module — `<…>/dist/bin/homegraph.js`. */
  filename: string;
  platform: NodeJS.Platform;
  cwd: string;
  /** Injectable existence probe (defaults to fs.existsSync) — for tests. */
  exists?: (p: string) => boolean;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Where the bundle installer keeps its install root, derived from the bundle
 * dir so an upgrade reuses a custom `HOMEGRAPH_INSTALL_DIR`. Returns null when
 * the layout isn't the one the installer creates (then the installer falls
 * back to its own default).
 *
 *   unix:    <installDir>/versions/<vX.Y.Z>   (bundleRoot)  → <installDir>
 *   windows: <installDir>\current             (bundleRoot)  → <installDir>
 */
export function deriveInstallDir(
  bundleRoot: string,
  os: 'unix' | 'windows',
  exists: (p: string) => boolean
): string | null {
  // Use the TARGET platform's path semantics (not the host's), so this is
  // deterministic when reasoning about a Windows layout from a POSIX host (CI)
  // and vice-versa. In production `os` always matches the running platform.
  const P = os === 'windows' ? path.win32 : path.posix;
  if (os === 'windows') {
    if (P.basename(bundleRoot).toLowerCase() === 'current') {
      return P.dirname(bundleRoot);
    }
    return null;
  }
  // unix: bundleRoot is <installDir>/versions/<version>
  const parent = P.dirname(bundleRoot);
  if (P.basename(parent) === 'versions') {
    const installDir = P.dirname(parent);
    return exists(installDir) ? installDir : P.dirname(parent);
  }
  return null;
}

export function detectInstallMethod(input: DetectInput): InstallMethod {
  const exists = input.exists ?? fs.existsSync;
  const isWin = input.platform === 'win32';
  // Path math keyed on the TARGET platform so detection is host-independent
  // (a Windows layout resolves correctly even when unit-tested on macOS/Linux).
  const P = isWin ? path.win32 : path.posix;
  const binDir = P.dirname(input.filename); // <…>/bin

  const norm = toPosix(input.filename);

  // Path-based checks come FIRST. An npm install (or a nested platform
  // package that looks like a vendored bundle) lives under node_modules —
  // that path is authoritative about HOW the user installed, whatever the
  // artifact inside looks like. Otherwise a leftover standalone layout under
  // node_modules would be misread as `kind: 'bundle'`.

  // npx cache: <…>/_npx/<hash>/node_modules/homegraph/…
  // (checked before npm — the npx cache path also contains /node_modules/).
  if (norm.includes('/_npx/')) {
    return { kind: 'npx' };
  }

  // npm install (global or local): lives under a node_modules tree.
  if (norm.includes('/node_modules/')) {
    const underCwd = norm.startsWith(toPosix(P.resolve(input.cwd)) + '/');
    return { kind: 'npm', scope: underCwd ? 'local' : 'global' };
  }

  // Bundle: <root>/lib/dist/bin/homegraph.js → <root> is up 3 from bin/.
  // A bundle has a vendored node + a launcher script as siblings of lib/.
  const bundleRoot = P.resolve(binDir, '..', '..', '..');
  const vendoredNode = P.join(bundleRoot, isWin ? 'node.exe' : 'node');
  const launcher = P.join(bundleRoot, 'bin', isWin ? 'homegraph.cmd' : 'homegraph');
  if (exists(vendoredNode) && exists(launcher)) {
    const os = isWin ? 'windows' : 'unix';
    return { kind: 'bundle', os, bundleRoot, installDir: deriveInstallDir(bundleRoot, os, exists) };
  }

  // Source checkout: running <repo>/dist/bin/homegraph.js with a sibling .git.
  const repoRoot = P.resolve(binDir, '..', '..');
  if (exists(P.join(repoRoot, 'package.json')) && exists(P.join(repoRoot, '.git'))) {
    return { kind: 'source', root: repoRoot };
  }

  return { kind: 'unknown', reason: `unrecognized install layout at ${input.filename}` };
}

// ---------------------------------------------------------------------------
// Version helpers (pure)
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function parseSemver(version: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return null;
  return {
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    pre: m[4] ?? null,
  };
}

/** Returns >0 if a>b, <0 if a<b, 0 if equal. Throws on unparseable input. */
export function compareVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa || !sb) throw new Error(`cannot compare versions: "${a}" vs "${b}"`);
  if (sa.major !== sb.major) return sa.major - sb.major;
  if (sa.minor !== sb.minor) return sa.minor - sb.minor;
  if (sa.patch !== sb.patch) return sa.patch - sb.patch;
  // A prerelease is "less than" its release (1.0.0-rc < 1.0.0).
  if (sa.pre && !sb.pre) return -1;
  if (!sa.pre && sb.pre) return 1;
  if (sa.pre && sb.pre) return sa.pre < sb.pre ? -1 : sa.pre > sb.pre ? 1 : 0;
  return 0;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
  try {
    return compareVersions(latest, current) > 0;
  } catch {
    // If either is unparseable (e.g. a dev "0.0.0-unknown"), treat differing
    // strings as "update available" so the user isn't stuck.
    return normalizeVersion(current) !== normalizeVersion(latest);
  }
}

/** `0.9.9` / `v0.9.9` → `v0.9.9` (release tags are v-prefixed). */
export function normalizeVersion(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t : `v${t}`;
}

/** Strip a leading `v`: `v0.9.9` → `0.9.9`. */
export function stripV(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t.slice(1) : t;
}

/**
 * Parse the release tag out of the `Location` header GitHub returns for
 * `/releases/latest` → `…/releases/tag/v0.9.9`. Pure so it's unit-tested.
 */
export function parseLatestTagFromLocation(location: string | undefined): string | null {
  if (!location) return null;
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location);
  return m ? decodeURIComponent(m[1]!) : null;
}

// ---------------------------------------------------------------------------
// Latest-version resolution (network)
// ---------------------------------------------------------------------------

function httpsGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
  });
}

/**
 * Resolve the latest release tag (e.g. `v0.9.9`).
 *
 * Primary: read the redirect `Location` from `github.com/<repo>/releases/latest`
 * — the unauthenticated GitHub API is rate-limited to 60 req/h/IP and 403s on
 * shared/cloud hosts (issue #325); the redirect has no such limit. Fall back
 * to the API only if the redirect can't be read.
 */
export async function resolveLatestVersion(repo = REPO, timeoutMs = 12000): Promise<string> {
  try {
    const res = await httpsGet(
      `https://github.com/${repo}/releases/latest`,
      { 'User-Agent': 'homegraph-upgrade' },
      timeoutMs
    );
    const loc = res.headers.location;
    const tag = parseLatestTagFromLocation(Array.isArray(loc) ? loc[0] : loc);
    if (tag) return normalizeVersion(tag);
  } catch {
    /* fall through to API */
  }
  try {
    const res = await httpsGet(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { 'User-Agent': 'homegraph-upgrade', Accept: 'application/vnd.github+json' },
      timeoutMs
    );
    const tag = JSON.parse(res.body)?.tag_name;
    if (typeof tag === 'string' && tag) return normalizeVersion(tag);
  } catch {
    /* fall through to error */
  }
  throw new Error(
    'could not resolve the latest version from GitHub. Check your network, or pin a version: `homegraph upgrade <version>`.'
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  /** Pin a specific version (positional arg or HOMEGRAPH_VERSION). */
  version?: string;
  /** Report current vs latest, don't change anything. */
  check?: boolean;
  /** Reinstall even if already on the resolved version. */
  force?: boolean;
}

/** Injectable side-effects so the orchestrator stays unit-testable. */
export interface UpgradeDeps {
  currentVersion: string;
  method: InstallMethod;
  resolveLatest: (pin?: string) => Promise<string>;
  /** Run a command inheriting stdio; returns its exit code (-1 = spawn failed). */
  run: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => number;
  /** Run a command capturing stdout (nothing reaches the terminal); null = spawn failed. */
  capture: (cmd: string, args: string[]) => { code: number; stdout: string } | null;
  hasCommand: (cmd: string) => boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  platform: NodeJS.Platform;
}

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** The honest, additive re-index reminder shown after a successful upgrade. */
export function reindexAdvisory(): string {
  return [
    c.dim('Your existing project indexes keep working, but were built by the previous version.'),
    c.dim('To pick up this version’s extraction improvements, refresh each project:'),
    `  ${c.cyan('homegraph sync')}        ${c.dim('# incremental, fast')}`,
    `  ${c.cyan('homegraph index -f')}    ${c.dim('# full rebuild')}`,
    c.dim('(`homegraph status` flags any index that predates the engine you’re running.)'),
  ].join('\n');
}

/**
 * Returns the process exit code (0 = success / nothing to do, 1 = failure).
 */
export async function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<number> {
  const { currentVersion, method } = deps;

  // Resolve the target version (pinned or latest).
  let latest: string;
  try {
    latest = normalizeVersion(opts.version || (await deps.resolveLatest()));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const currentDisplay = normalizeVersion(currentVersion);
  deps.log(`${c.bold('HomeGraph')}  current ${c.cyan(currentDisplay)}  ${opts.version ? 'target' : 'latest'} ${c.cyan(latest)}`);

  const updateAvailable = isUpdateAvailable(currentVersion, latest);

  if (opts.check) {
    if (updateAvailable) {
      deps.log(c.yellow(`An update is available: ${currentDisplay} → ${latest}`));
      deps.log(c.dim('Run `homegraph upgrade` to install it.'));
    } else {
      deps.log(c.green(`You’re on the latest version (${currentDisplay}).`));
    }
    return 0;
  }

  if (!updateAvailable && !opts.force && !opts.version) {
    deps.log(c.green(`Already up to date (${currentDisplay}).`));
    deps.log(c.dim('Use `--force` to reinstall, or `homegraph upgrade <version>` to change versions.'));
    return 0;
  }

  // Dispatch by install method. npm performs a real binary update, so after
  // it succeeds we self-heal the front-load hook (below); npx/source/bundle/
  // unknown don't update anything here, so they return directly.
  let code: number;
  switch (method.kind) {
    case 'bundle':
      deps.error('This HomeGraph was installed with the retired standalone bundle installer.');
      deps.log(c.dim('Standalone installers are no longer published. Switch to npm:'));
      deps.log(`  ${c.cyan(`npm i -g ${NPM_PACKAGE}@latest`)}`);
      deps.log(c.dim('Then remove the leftover bundle with `homegraph uninstall` if you still have one on PATH.'));
      return 1;
    case 'npm':
      // npm version specs have no leading "v" (`@0.9.8`, not `@v0.9.8` — the
      // latter resolves as a nonexistent dist-tag).
      code = await upgradeNpm(method, opts.version ? stripV(latest) : 'latest', deps);
      break;
    case 'npx':
      deps.log(c.green('npx always runs the latest version on demand — nothing to upgrade.'));
      deps.log(c.dim(`Force a fresh fetch with: npx ${NPM_PACKAGE}@latest`));
      return 0;
    case 'source':
      deps.warn(`Running from a source checkout at ${method.root}.`);
      deps.log(c.dim('Upgrade it with: git pull && npm run build'));
      return 0;
    default:
      deps.error(`Couldn’t determine how HomeGraph was installed (${method.reason}).`);
      deps.log(c.dim(`Reinstall with: npm i -g ${NPM_PACKAGE}`));
      return 1;
  }

  // After a successful update, ensure the front-load prompt hook is wired for an
  // already-configured global Claude install — so existing users pick it up on
  // upgrade, not only on a fresh `install` (the hook config is version-agnostic,
  // so the still-running old binary can write it safely). Idempotent + gated on
  // an existing Claude config, and skipped entirely by the kill-switch. Never
  // fatal to the upgrade.
  if (code === 0) {
    let probe: VersionProbe = 'inconclusive';
    try {
      probe = reportResolvedVersion(latest, deps);
    } catch {
      /* an inconclusive probe must not fail the upgrade */
    }
    try {
      await selfHealPromptHook(deps);
    } catch {
      /* a hook-wiring hiccup must not fail the upgrade */
    }
    // The refresh executes whatever `homegraph` PATH resolves. If the probe
    // just proved that's a stale shadowed install, spawning it would rewrite
    // the agent surfaces with the very templates the refresh exists to heal —
    // skip, and point at the manual command for after the PATH is fixed.
    if (probe !== 'mismatch') {
      try {
        selfHealInstalledSurfaces(deps);
      } catch {
        /* a refresh hiccup must not fail the upgrade */
      }
    } else {
      deps.log(c.dim('Skipped refreshing agent instructions/config — run `homegraph install --refresh` once the PATH is fixed.'));
    }
  }
  return code;
}

type VersionProbe = 'match' | 'mismatch' | 'inconclusive';

/**
 * Prove the upgrade actually took: spawn the `homegraph` this terminal's PATH
 * resolves and compare its reported version to the target. Catches the silent
 * failure mode where ANOTHER install shadows the one we just upgraded (issue
 * #1071 — e.g. a stale global copy earlier on PATH): the upgrade "succeeds"
 * but `homegraph -v` — in this terminal and every future one — keeps serving
 * the old version. Exported for unit tests.
 */
export function verifyResolvedVersion(latest: string, deps: UpgradeDeps): VersionProbe {
  if (!deps.hasCommand('homegraph')) return 'inconclusive';
  // Windows installs expose homegraph through a .cmd launcher; Node can't
  // spawn .cmd files without a shell, so route through cmd.exe there.
  const probe = deps.platform === 'win32'
    ? deps.capture('cmd.exe', ['/d', '/s', '/c', 'homegraph --version'])
    : deps.capture('homegraph', ['--version']);
  if (!probe || probe.code !== 0) return 'inconclusive';
  // `homegraph --version` prints the bare version; take the last non-empty
  // line so a stray runtime warning above it can't spoil the parse.
  const reported = probe.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
  if (!parseSemver(reported)) return 'inconclusive';
  return compareVersions(reported, latest) === 0 ? 'match' : 'mismatch';
}

/**
 * Log the outcome of the post-upgrade version probe. On a match the user
 * knows the current terminal is already serving the new version; on a
 * mismatch they get told exactly which stale install is hijacking their PATH
 * instead of discovering it via a mysteriously unchanged `homegraph -v`.
 * Inconclusive probes fall back to the old soft hint — never a scare on
 * setups we can't inspect (no `homegraph` on PATH yet, exotic wrappers).
 * Returns the probe result so the caller can gate the post-upgrade refresh
 * (which spawns the PATH-resolved binary) on it.
 */
function reportResolvedVersion(latest: string, deps: UpgradeDeps): VersionProbe {
  const { method } = deps;
  // A project-local npm install isn't served by PATH's `homegraph` (that
  // would be some other install) — a probe could only false-alarm.
  if (method.kind === 'npm' && method.scope === 'local') return 'inconclusive';
  const probe = verifyResolvedVersion(latest, deps);
  switch (probe) {
    case 'match':
      deps.log(c.green(`✓ \`homegraph\` on your PATH now reports ${latest} — this terminal is already using it.`));
      break;
    case 'mismatch':
      deps.warn(`Installed ${latest}, but the \`homegraph\` this terminal resolves still reports an older version.`);
      deps.log(c.dim('Another HomeGraph install earlier on your PATH is shadowing the one just upgraded.'));
      deps.log(c.dim('Find every copy with `which -a homegraph` (Windows: `where homegraph`) and remove or upgrade the stale one.'));
      break;
    case 'inconclusive':
      deps.log(c.dim('Open a new terminal if `homegraph --version` looks unchanged (PATH cache).'));
      break;
  }
  return probe;
}

/**
 * Refresh the agent surfaces previous installs wrote — the marker-fenced
 * instructions sections (CLAUDE.md / AGENTS.md / GEMINI.md), MCP entries,
 * legacy-hook cleanups — so they match the version that will serve them.
 * Unlike the prompt hook above, this content is NOT version-agnostic: the
 * templates are baked into the binary, so the still-running old process
 * would only rewrite its own stale copy — the exact staleness this heals.
 * We therefore spawn the freshly-installed binary (`homegraph install
 * --refresh`), which is refresh-only: agents never configured stay
 * untouched, and permission / prompt-hook choices are preserved. Gated on
 * `homegraph` being resolvable on PATH (an npm-local install isn't) and on
 * the kill-switch; never fatal to the upgrade.
 */
function selfHealInstalledSurfaces(deps: UpgradeDeps): void {
  if (process.env.HOMEGRAPH_NO_INSTALL_REFRESH === '1') return;
  if (!deps.hasCommand('homegraph')) return;
  deps.log(c.dim('Refreshing agent instruction sections and config written by previous versions…'));
  // Windows installs expose homegraph through a .cmd launcher. Node cannot
  // spawn .cmd files directly without a shell, so route the constant command
  // through cmd.exe there (the same launcher a terminal would resolve).
  const code = deps.platform === 'win32'
    ? deps.run('cmd.exe', ['/d', '/s', '/c', 'homegraph install --refresh'])
    : deps.run('homegraph', ['install', '--refresh']);
  if (code !== 0) {
    deps.warn('Could not refresh the installed agent surfaces — run `homegraph install --refresh` manually.');
  }
}

/**
 * Wire the Claude `UserPromptSubmit` front-load hook on upgrade for an
 * already-configured global Claude install. No-op when Claude isn't configured,
 * when the hook is already present, or when the kill-switch is set.
 */
async function selfHealPromptHook(deps: UpgradeDeps): Promise<void> {
  if (process.env.HOMEGRAPH_NO_PROMPT_HOOK === '1' || process.env.HOMEGRAPH_PROMPT_HOOK === '0') return;
  const { claudeTarget, writePromptHookEntry } = await import('../installer/targets/claude');
  if (!claudeTarget.detect('global').alreadyConfigured) return;
  const res = writePromptHookEntry('global');
  if (res.action === 'created' || res.action === 'updated') {
    deps.log(
      c.dim('Enabled the HomeGraph front-load hook for Claude Code (structural prompts). Disable any time: HOMEGRAPH_NO_PROMPT_HOOK=1'),
    );
  }
}

/**
 * How to invoke npm. On Windows npm is a .cmd batch file, which Node refuses
 * to spawn without a shell (EINVAL since the CVE-2024-27980 hardening) — a
 * direct `npm.cmd` spawn fails on every current Node, so route it through
 * cmd.exe, the same way the surface-refresh step invokes the .cmd launcher.
 * (Verified live on the Windows VM: `spawnSync('npm.cmd')` → EINVAL;
 * `cmd.exe /d /s /c npm …` → works.)
 */
export function npmInvocation(platform: NodeJS.Platform, npmArgs: string[]): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...npmArgs].join(' ')] };
  }
  return { cmd: 'npm', args: npmArgs };
}

function upgradeNpm(
  method: Extract<InstallMethod, { kind: 'npm' }>,
  versionSpec: string,
  deps: UpgradeDeps
): number {
  const args = method.scope === 'global'
    ? ['install', '-g', `${NPM_PACKAGE}@${versionSpec}`]
    : ['install', `${NPM_PACKAGE}@${versionSpec}`];
  deps.log(c.dim(`Running: npm ${args.join(' ')}`));
  const inv = npmInvocation(deps.platform, args);
  const code = deps.run(inv.cmd, inv.args, process.env);
  if (code !== 0) {
    deps.error(`npm exited with code ${code}.`);
    if (method.scope === 'global') {
      deps.log(c.dim('If this is a permissions error (EACCES), your global prefix needs sudo, or use a'));
      deps.log(c.dim('Node version manager (nvm/fnm) so global installs don’t require root.'));
    }
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.'));
  deps.log(reindexAdvisory());
  return 0;
}

// ---------------------------------------------------------------------------
// Production deps wiring (used by the CLI)
// ---------------------------------------------------------------------------

/**
 * True if `cmd` resolves to an executable on PATH. A pure-Node PATH scan — NOT
 * a spawned `command -v`/`which`: `command` is a shell builtin (no standalone
 * binary on Debian, though macOS ships one), and `which` isn't guaranteed
 * present on minimal images, so spawning either is unreliable. Scanning PATH
 * ourselves behaves identically on every platform.
 */
export function hasCommand(cmd: string): boolean {
  const isWin = process.platform === 'win32';
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (isWin) return true;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        /* not here / not executable — keep scanning */
      }
    }
  }
  return false;
}

export function defaultRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: env ?? process.env, windowsHide: true });
  if (r.error) return -1;
  return r.status ?? -1;
}

export function defaultCapture(cmd: string, args: string[]): { code: number; stdout: string } | null {
  // stdio is piped (the default with `encoding`), so nothing the probed
  // command prints reaches the user's terminal. The timeout keeps a wedged
  // probe from hanging the upgrade's last step.
  const r = spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, timeout: 30_000 });
  if (r.error) return null;
  return { code: r.status ?? -1, stdout: r.stdout ?? '' };
}
