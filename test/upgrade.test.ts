import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectInstallMethod,
  deriveInstallDir,
  parseSemver,
  compareVersions,
  isUpdateAvailable,
  normalizeVersion,
  stripV,
  parseLatestTagFromLocation,
  reindexAdvisory,
  runUpgrade,
  verifyResolvedVersion,
  NPM_PACKAGE,
  type InstallMethod,
  type UpgradeDeps,
} from '../src/upgrade';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { HomeGraph } from '../src';

// ---------------------------------------------------------------------------
// detectInstallMethod — structural detection from the running file's path
// ---------------------------------------------------------------------------

describe('detectInstallMethod', () => {
  // A bundle exists if a vendored node + launcher sit next to lib/.
  function bundleExists(present: Set<string>) {
    return (p: string) => present.has(p.replace(/\\/g, '/'));
  }

  it('detects a unix bundle and derives the install dir from the versions/ layout', () => {
    const root = '/home/u/.homegraph/versions/v0.9.9';
    const filename = `${root}/lib/dist/bin/homegraph.js`;
    const present = new Set([`${root}/node`, `${root}/bin/homegraph`, '/home/u/.homegraph']);
    const m = detectInstallMethod({
      filename,
      platform: 'linux',
      cwd: '/home/u/project',
      exists: bundleExists(present),
    });
    expect(m).toEqual({
      kind: 'bundle',
      os: 'unix',
      bundleRoot: root,
      installDir: '/home/u/.homegraph',
    });
  });

  it('detects a windows bundle and derives the install dir from current\\', () => {
    const root = 'C:/Users/u/AppData/Local/homegraph/current';
    const filename = `${root}/lib/dist/bin/homegraph.js`;
    const present = new Set([`${root}/node.exe`, `${root}/bin/homegraph.cmd`]);
    const m = detectInstallMethod({
      filename,
      platform: 'win32',
      cwd: 'C:/Users/u/project',
      exists: bundleExists(present),
    }) as Extract<InstallMethod, { kind: 'bundle' }>;
    expect(m.kind).toBe('bundle');
    expect(m.os).toBe('windows');
    // win32 path math emits backslashes; compare separator-independently.
    expect(m.installDir?.replace(/\\/g, '/')).toBe('C:/Users/u/AppData/Local/homegraph');
  });

  it('detects a global npm install', () => {
    const filename = '/usr/local/lib/node_modules/homegraph/dist/bin/homegraph.js';
    const m = detectInstallMethod({
      filename,
      platform: 'linux',
      cwd: '/home/u/project',
      exists: () => false,
    });
    expect(m).toEqual({ kind: 'npm', scope: 'global' });
  });

  it('detects a local (project) npm install as local', () => {
    const cwd = '/home/u/project';
    const filename = `${cwd}/node_modules/homegraph/dist/bin/homegraph.js`;
    const m = detectInstallMethod({ filename, platform: 'linux', cwd, exists: () => false });
    expect(m).toEqual({ kind: 'npm', scope: 'local' });
  });

  it('detects an npx run from the _npx cache', () => {
    const filename = '/home/u/.npm/_npx/abc123/node_modules/homegraph/dist/bin/homegraph.js';
    const m = detectInstallMethod({ filename, platform: 'linux', cwd: '/home/u', exists: () => false });
    expect(m).toEqual({ kind: 'npx' });
  });

  // The npm installer's nested platform package can look like a vendored
  // bundle (node + bin/ launcher) under node_modules. Path under node_modules
  // must win so upgrade stays on the npm path, not legacy bundle detection.
  it('detects the npm thin-installer platform package as npm, not bundle', () => {
    const root = '/usr/local/lib/node_modules/homegraph/node_modules/homegraph-linux-x64';
    const filename = `${root}/lib/dist/bin/homegraph.js`;
    const present = new Set([`${root}/node`, `${root}/bin/homegraph`]);
    const m = detectInstallMethod({
      filename,
      platform: 'linux',
      cwd: '/home/u/project',
      exists: bundleExists(present),
    });
    expect(m).toEqual({ kind: 'npm', scope: 'global' });
  });

  it('detects a project-local thin-installer platform package as npm local', () => {
    const cwd = '/home/u/project';
    const root = `${cwd}/node_modules/homegraph/node_modules/homegraph-darwin-arm64`;
    const filename = `${root}/lib/dist/bin/homegraph.js`;
    const present = new Set([`${root}/node`, `${root}/bin/homegraph`]);
    const m = detectInstallMethod({ filename, platform: 'darwin', cwd, exists: bundleExists(present) });
    expect(m).toEqual({ kind: 'npm', scope: 'local' });
  });

  it('still detects an npx run when the cached platform package has the bundle layout', () => {
    const root = '/home/u/.npm/_npx/abc123/node_modules/homegraph/node_modules/homegraph-linux-x64';
    const filename = `${root}/lib/dist/bin/homegraph.js`;
    const present = new Set([`${root}/node`, `${root}/bin/homegraph`]);
    const m = detectInstallMethod({ filename, platform: 'linux', cwd: '/home/u', exists: bundleExists(present) });
    expect(m).toEqual({ kind: 'npx' });
  });

  it('detects a source checkout via sibling package.json + .git', () => {
    const repo = '/home/u/dev/homegraph';
    const filename = `${repo}/dist/bin/homegraph.js`;
    const present = new Set([`${repo}/package.json`, `${repo}/.git`]);
    const m = detectInstallMethod({
      filename,
      platform: 'darwin',
      cwd: repo,
      exists: bundleExists(present),
    });
    expect(m).toEqual({ kind: 'source', root: repo });
  });

  it('returns unknown for an unrecognized layout', () => {
    const m = detectInstallMethod({
      filename: '/opt/weird/place/homegraph.js',
      platform: 'linux',
      cwd: '/tmp',
      exists: () => false,
    });
    expect(m.kind).toBe('unknown');
  });
});

describe('deriveInstallDir', () => {
  it('unix: returns the dir above versions/', () => {
    expect(deriveInstallDir('/a/b/.homegraph/versions/v1.2.3', 'unix', () => true)).toBe('/a/b/.homegraph');
  });
  it('unix: null when not under versions/', () => {
    expect(deriveInstallDir('/a/b/somewhere', 'unix', () => true)).toBeNull();
  });
  it('windows: returns the parent of current\\', () => {
    expect(deriveInstallDir('C:/x/homegraph/current', 'windows', () => true)?.replace(/\\/g, '/')).toBe('C:/x/homegraph');
  });
  it('windows: null when basename is not current', () => {
    expect(deriveInstallDir('C:/x/homegraph/v1', 'windows', () => true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// version helpers
// ---------------------------------------------------------------------------

describe('version helpers', () => {
  it('parseSemver handles v-prefix and prerelease', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    expect(parseSemver('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: 'rc.1' });
    expect(parseSemver('not-a-version')).toBeNull();
  });

  it('compareVersions orders correctly incl. prerelease < release', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  it('isUpdateAvailable compares, and falls back to string-inequality for unparseable', () => {
    expect(isUpdateAvailable('0.9.8', '0.9.9')).toBe(true);
    expect(isUpdateAvailable('0.9.9', '0.9.9')).toBe(false);
    expect(isUpdateAvailable('0.9.9', '0.9.8')).toBe(false);
    // dev sentinel can't parse → any difference means "update available"
    expect(isUpdateAvailable('0.0.0-unknown', '0.9.9')).toBe(true);
  });

  it('normalizeVersion / stripV round-trip', () => {
    expect(normalizeVersion('0.9.9')).toBe('v0.9.9');
    expect(normalizeVersion('v0.9.9')).toBe('v0.9.9');
    expect(stripV('v0.9.9')).toBe('0.9.9');
    expect(stripV('0.9.9')).toBe('0.9.9');
  });

  it('parseLatestTagFromLocation extracts the tag from a releases redirect', () => {
    expect(parseLatestTagFromLocation('https://github.com/homegraph/homegraph/releases/tag/v0.9.9')).toBe('v0.9.9');
    expect(parseLatestTagFromLocation('https://github.com/o/r/releases/tag/v1.2.3?foo=bar')).toBe('v1.2.3');
    expect(parseLatestTagFromLocation(undefined)).toBeNull();
    expect(parseLatestTagFromLocation('https://github.com/o/r/releases')).toBeNull();
  });

  it('reindexAdvisory mentions the refresh commands', () => {
    const a = reindexAdvisory();
    expect(a).toContain('homegraph sync');
    expect(a).toContain('homegraph index -f');
  });
});

// ---------------------------------------------------------------------------
// runUpgrade orchestration — mocked side-effects
// ---------------------------------------------------------------------------

interface Calls {
  runs: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }>;
  captures: Array<{ cmd: string; args: string[] }>;
  logs: string[];
  errors: string[];
}

function makeDeps(
  overrides: Partial<UpgradeDeps> & { method: InstallMethod; currentVersion: string },
  runExit = 0
): { deps: UpgradeDeps; calls: Calls } {
  const calls: Calls = { runs: [], captures: [], logs: [], errors: [] };
  const deps: UpgradeDeps = {
    currentVersion: overrides.currentVersion,
    method: overrides.method,
    resolveLatest: overrides.resolveLatest ?? (async () => 'v0.9.9'),
    run: (cmd, args, env) => {
      calls.runs.push({ cmd, args, env });
      return runExit;
    },
    // Default probe: spawn fails → 'inconclusive'. Tests that exercise the
    // post-upgrade version check override this.
    capture: (cmd, args) => {
      calls.captures.push({ cmd, args });
      return overrides.capture ? overrides.capture(cmd, args) : null;
    },
    hasCommand: overrides.hasCommand ?? ((c) => c === 'curl'),
    log: (m) => calls.logs.push(m),
    warn: (m) => calls.logs.push(m),
    error: (m) => calls.errors.push(m),
    platform: overrides.platform ?? 'linux',
  };
  return { deps, calls };
}

describe('runUpgrade', () => {
  it('does nothing when already up to date', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.9' });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/up to date/i);
  });

  it('--check reports an available update without running anything', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({ check: true }, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/update is available/i);
  });

  it('legacy bundle: refuses upgrade and points at npm', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'bundle', os: 'unix', bundleRoot: '/h/.homegraph/versions/v0.9.8', installDir: '/h/.homegraph' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.runs).toHaveLength(0);
    expect(calls.errors.join('\n')).toMatch(/retired standalone bundle/i);
    expect(calls.logs.join('\n')).toMatch(/npm i -g/);
  });

  it('legacy windows bundle: also refuses and points at npm', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'bundle', os: 'windows', bundleRoot: 'C:/x/homegraph/current', installDir: 'C:/x/homegraph' },
      currentVersion: '0.9.8',
      platform: 'win32',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.runs).toHaveLength(0);
    expect(calls.errors.join('\n')).toMatch(/retired standalone bundle/i);
  });

  it('npm global: shells out to npm install -g @pkg@latest', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs[0].cmd).toBe('npm');
    expect(calls.runs[0].args).toEqual(['install', '-g', `${NPM_PACKAGE}@latest`]);
  });

  it('npm on win32 routes through cmd.exe (a direct npm.cmd spawn EINVALs on modern Node)', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      platform: 'win32',
    });
    await runUpgrade({}, deps);
    expect(calls.runs[0].cmd).toBe('cmd.exe');
    expect(calls.runs[0].args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(calls.runs[0].args[3]).toBe(`npm install -g ${NPM_PACKAGE}@latest`);
  });

  it('npm: a pinned version is passed through as @<version>', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.9',
    });
    await runUpgrade({ version: '0.9.8' }, deps);
    // npm spec carries no leading "v".
    expect(calls.runs[0].args).toEqual(['install', '-g', `${NPM_PACKAGE}@0.9.8`]);
  });

  it('npm: surfaces a non-zero exit as failure', async () => {
    const { deps, calls } = makeDeps(
      { method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' },
      1
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.errors.join('\n')).toMatch(/npm exited/i);
  });

  it('npx: nothing to upgrade', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npx' }, currentVersion: '0.9.8' });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/nothing to upgrade/i);
  });

  it('source: tells the user to git pull, runs nothing', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'source', root: '/dev/homegraph' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/git pull/);
  });
});

// ---------------------------------------------------------------------------
// Post-upgrade self-heal of installed agent surfaces
// ---------------------------------------------------------------------------

describe('post-upgrade refresh of installed agent surfaces', () => {
  it('runs `homegraph install --refresh` via the NEW binary after a successful npm upgrade', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      hasCommand: (cmd) => cmd === 'homegraph',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    // The refresh is spawned AFTER the binary swap, so the fresh install
    // (with the current templates) does the writing — not this process.
    const last = calls.runs[calls.runs.length - 1];
    expect(last?.cmd).toBe('homegraph');
    expect(last?.args).toEqual(['install', '--refresh']);
  });

  it('runs the Windows .cmd launcher through cmd.exe', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      platform: 'win32',
      hasCommand: (cmd) => cmd === 'homegraph',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    const last = calls.runs[calls.runs.length - 1];
    expect(last?.cmd).toBe('cmd.exe');
    expect(last?.args).toEqual(['/d', '/s', '/c', 'homegraph install --refresh']);
  });

  it('skips the refresh when `homegraph` is not resolvable on PATH', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      // default hasCommand resolves only curl
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs.filter((r) => r.cmd === 'homegraph')).toHaveLength(0);
  });

  it('a failing refresh warns but does not fail the upgrade', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      hasCommand: (cmd) => cmd === 'homegraph',
    });
    deps.run = (cmd, args, env) => {
      calls.runs.push({ cmd, args, env });
      return cmd === 'homegraph' ? 1 : 0;
    };
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.logs.join('\n')).toMatch(/install --refresh/);
  });

  it('does not run after a failed upgrade', async () => {
    const { deps, calls } = makeDeps(
      {
        method: { kind: 'npm', scope: 'global' },
        currentVersion: '0.9.8',
        hasCommand: (cmd) => cmd === 'homegraph',
      },
      1
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.runs.filter((r) => r.cmd === 'homegraph')).toHaveLength(0);
  });

  it('respects the HOMEGRAPH_NO_INSTALL_REFRESH kill-switch', async () => {
    process.env.HOMEGRAPH_NO_INSTALL_REFRESH = '1';
    try {
      const { deps, calls } = makeDeps({
        method: { kind: 'npm', scope: 'global' },
        currentVersion: '0.9.8',
        hasCommand: (cmd) => cmd === 'homegraph',
      });
      const code = await runUpgrade({}, deps);
      expect(code).toBe(0);
      expect(calls.runs.filter((r) => r.cmd === 'homegraph')).toHaveLength(0);
    } finally {
      delete process.env.HOMEGRAPH_NO_INSTALL_REFRESH;
    }
  });

  it('skips the refresh when the version probe says a stale install shadows the new one', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      hasCommand: (cmd) => cmd === 'homegraph',
      capture: () => ({ code: 0, stdout: '0.9.8\n' }), // PATH still serves the OLD version
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    // Spawning `homegraph install --refresh` would execute the shadowed stale
    // binary — the exact staleness the refresh exists to heal.
    expect(calls.runs.filter((r) => r.cmd === 'homegraph')).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/run `homegraph install --refresh` once the PATH is fixed/);
  });
});

// ---------------------------------------------------------------------------
// Post-upgrade version probe — does the PATH-resolved `homegraph` serve the
// version we just installed, in THIS terminal?
// ---------------------------------------------------------------------------

describe('post-upgrade version probe', () => {
  const npmGlobal = { method: { kind: 'npm', scope: 'global' } as InstallMethod, currentVersion: '0.9.8' };

  it('match: confirms the same terminal already serves the new version', async () => {
    const { deps, calls } = makeDeps({
      ...npmGlobal,
      hasCommand: (c) => c === 'homegraph',
      capture: () => ({ code: 0, stdout: '0.9.9\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.captures).toEqual([{ cmd: 'homegraph', args: ['--version'] }]);
    const out = calls.logs.join('\n');
    expect(out).toMatch(/now reports v0\.9\.9/);
    expect(out).not.toMatch(/Open a new terminal/);
  });

  it('mismatch: warns that a shadowing install is still serving the old version', async () => {
    const { deps, calls } = makeDeps({
      ...npmGlobal,
      hasCommand: (c) => c === 'homegraph',
      capture: () => ({ code: 0, stdout: '0.9.8\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0); // the upgrade itself succeeded — warn, don't fail
    const out = calls.logs.join('\n');
    expect(out).toMatch(/still reports an older version/);
    expect(out).toMatch(/shadowing/);
    expect(out).toMatch(/which -a homegraph/);
  });

  it('inconclusive: falls back to the soft new-terminal hint when homegraph is not on PATH', async () => {
    const { deps, calls } = makeDeps(npmGlobal); // hasCommand resolves only curl
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.captures).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/Open a new terminal/);
  });

  it('inconclusive: a failing or unparsable probe never warns about shadowing', async () => {
    const { deps, calls } = makeDeps({
      ...npmGlobal,
      hasCommand: (c) => c === 'homegraph',
      capture: () => ({ code: 0, stdout: 'something went wrong\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    const out = calls.logs.join('\n');
    expect(out).not.toMatch(/shadowing/);
    expect(out).toMatch(/Open a new terminal/);
  });

  it('parses the last non-empty line, so a runtime warning above the version is harmless', () => {
    const { deps } = makeDeps({
      ...npmGlobal,
      hasCommand: (c) => c === 'homegraph',
      capture: () => ({ code: 0, stdout: '(node:1) ExperimentalWarning: blah\nv0.9.9\n\n' }),
    });
    expect(verifyResolvedVersion('v0.9.9', deps)).toBe('match');
  });

  it('routes the probe through cmd.exe on Windows (.cmd launcher)', async () => {
    const { deps, calls } = makeDeps({
      ...npmGlobal,
      platform: 'win32',
      hasCommand: (c) => c === 'homegraph' || c === 'npm.cmd',
      capture: () => ({ code: 0, stdout: '0.9.9\r\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.captures).toEqual([{ cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'homegraph --version'] }]);
    expect(calls.logs.join('\n')).toMatch(/now reports v0\.9\.9/);
  });

  it('skips the probe for npm-local installs — PATH serves a different copy', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'local' },
      currentVersion: '0.9.8',
      hasCommand: (c) => c === 'homegraph',
      capture: () => ({ code: 0, stdout: '0.9.7\n' }),
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.captures).toHaveLength(0);
    expect(calls.logs.join('\n')).not.toMatch(/shadowing/);
  });

  it('does not probe after a failed upgrade', async () => {
    const { deps, calls } = makeDeps(
      { ...npmGlobal, hasCommand: (c) => c === 'homegraph', capture: () => ({ code: 0, stdout: '0.9.9\n' }) },
      1
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.captures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Re-index staleness — real index, real metadata stamp
// ---------------------------------------------------------------------------

describe('index extraction-version stamp / isIndexStale', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-upgrade-stamp-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the current extraction version on full index and is not stale', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    const cg = await HomeGraph.init(dir, { index: false });
    // No index yet → not stale (nothing to refresh).
    expect(cg.isIndexStale()).toBe(false);

    await cg.indexAll();
    const info = cg.getIndexBuildInfo();
    expect(info.extractionVersion).toBe(EXTRACTION_VERSION);
    expect(typeof info.version).toBe('string');
    expect(cg.isIndexStale()).toBe(false);
    cg.destroy();
  });

  it('flags an index stamped by an older extraction version as stale', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    const cg = await HomeGraph.init(dir, { index: false });
    await cg.indexAll();

    // Simulate an index built by an older engine.
    (cg as unknown as { queries: { setMetadata(k: string, v: string): void } }).queries.setMetadata(
      'indexed_with_extraction_version',
      String(EXTRACTION_VERSION - 1)
    );
    expect(cg.isIndexStale()).toBe(true);
    cg.destroy();
  });
});
