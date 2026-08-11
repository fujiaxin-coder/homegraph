/**
 * Spec-Mine Addon Tests
 *
 * Tests for the addon system: registry, paths, validation, loader, scaffold,
 * manager (npm-backed install), supplement rendering, the spec-mine adapter
 * (dedupe / enrich orchestration), and the generateSpecs integration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock openai / OpenAiLlmClient — generator tests pass a plain client object,
// but generateSpecs' module graph may pull the real one at runtime.
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

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

// The production importESM uses `new Function` — works in the CJS CLI, but
// vitest's worker realm has no dynamic-import callback on Function-created
// globals. Mock the boundary with a plain module-scope import() instead.
vi.mock('../src/addons/dynamic-import', () => ({
  importESM: (specifier: string) =>
    import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { silentLogger, setLogger } from '../src/errors';
import { getHomeGraphDir } from '../src/directory';
import {
  readRegistry,
  writeRegistry,
  upsertEntry,
  removeEntry,
  setEntryEnabled,
  registryFilePath,
} from '../src/addons/registry';
import { addonsRootDir, addonPkgDir } from '../src/addons/paths';
import { validateAddonPackage, resolveEntryPoint } from '../src/addons/validate';
import { loadAddons } from '../src/addons/loader';
import { createAddonScaffold } from '../src/addons/init-template';
import {
  installAddon,
  removeAddon,
  listAddons,
  updateAddon,
  resolvePackageName,
  resolvePackageInfo,
  isLocalPathSpec,
  resolveUpdateSpec,
} from '../src/addons/manager';
import { compareSemver } from '../src/addons/semver';
import { renderSupplementSection } from '../src/spec/mine/addon/render';
import {
  dedupeSupplements,
  enrichCluster,
  loadSpecMineAddons,
  SpecMineEnricher,
} from '../src/spec/mine/addon/adapter';
import { generateSpecs } from '../src/spec/mine/generator';
import type { CommitCluster } from '../src/spec/mine/clustering';
import type { LlmClient } from '../src/spec/llm/client';

// Silence logger during tests
setLogger(silentLogger);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix = 'homegraph-addon-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a set of files under `dir` (mkdir -p). */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

/** Minimal valid addon package.json. */
function validPkgJson(name = 'test-addon', extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name,
      version: '1.2.3',
      type: 'module',
      exports: { '.': './index.mjs' },
      homegraph: { addon: true, api: 1 },
      ...extra,
    },
    null,
    2,
  );
}

const VALID_ENRICH = `export async function enrich(input) {
  return [{ key: 'T-1', text: 'requirement from addon' }];
}
`;

function makeEnricher(name: string, enrich: SpecMineEnricher['enrich']): SpecMineEnricher {
  return { addon: { name, version: '1.0.0', module: {} }, enrich };
}

function makeCluster(id: number): CommitCluster {
  const hash = String.fromCharCode(97 + id).repeat(40);
  return {
    id,
    commits: [
      {
        commitHash: hash,
        commitMessage: 'feat: add thing',
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
      },
    ],
    primaryFiles: [`src/module${id}.ts`],
    primarySymbols: ['main'],
    summary: '1 commits',
    timeRange: { start: Date.now(), end: Date.now() },
  };
}

function makeMockClient(chatImpl?: () => Promise<string>): LlmClient {
  return {
    chat: chatImpl ? vi.fn().mockImplementation(chatImpl) : vi.fn().mockResolvedValue('# Spec\n\nBody.'),
    chatJson: vi.fn().mockResolvedValue({}),
  } as unknown as LlmClient;
}

// ===========================================================================
// Registry
// ===========================================================================

describe('addon registry', () => {
  let repo: string;

  beforeEach(() => {
    repo = tmpDir();
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('missing registry file reads as empty', () => {
    expect(readRegistry(repo)).toEqual({ addons: [] });
  });

  it('write then read round-trips entries', () => {
    writeRegistry(repo, {
      addons: [{ name: '@scope/foo', version: '1.0.0', enabled: true, source: 'registry' }],
    });
    expect(readRegistry(repo)).toEqual({
      addons: [{ name: '@scope/foo', version: '1.0.0', enabled: true, source: 'registry' }],
    });
  });

  it('registry file lives at .homegraph/addons.json', () => {
    expect(registryFilePath(repo)).toBe(path.join(getHomeGraphDir(repo), 'addons.json'));
  });

  it('upsertEntry inserts a new entry and creates the file', () => {
    upsertEntry(repo, { name: 'a', version: '0.1.0', enabled: true, source: 'registry' });
    expect(fs.existsSync(registryFilePath(repo))).toBe(true);
    expect(readRegistry(repo).addons).toEqual([
      { name: 'a', version: '0.1.0', enabled: true, source: 'registry' },
    ]);
  });

  it('upsertEntry replaces an existing entry preserving position', () => {
    upsertEntry(repo, { name: 'a', version: '0.1.0', enabled: true, source: 'registry' });
    upsertEntry(repo, { name: 'b', version: '0.2.0', enabled: false, source: 'local' });
    upsertEntry(repo, { name: 'a', version: '0.1.1', enabled: false, source: 'registry' });
    expect(readRegistry(repo).addons.map((e) => e.name)).toEqual(['a', 'b']);
    expect(readRegistry(repo).addons[0]!.version).toBe('0.1.1');
  });

  it('removeEntry returns false for unknown names', () => {
    expect(removeEntry(repo, 'nope')).toBe(false);
  });

  it('removeEntry removes only the matching entry', () => {
    upsertEntry(repo, { name: 'a', version: '0.1.0', enabled: true, source: 'registry' });
    upsertEntry(repo, { name: 'b', version: '0.2.0', enabled: true, source: 'registry' });
    expect(removeEntry(repo, 'a')).toBe(true);
    expect(readRegistry(repo).addons.map((e) => e.name)).toEqual(['b']);
  });

  it('setEntryEnabled toggles the flag', () => {
    upsertEntry(repo, { name: 'a', version: '0.1.0', enabled: true, source: 'registry' });
    expect(setEntryEnabled(repo, 'a', false)).toBe(true);
    expect(readRegistry(repo).addons[0]!.enabled).toBe(false);
    expect(setEntryEnabled(repo, 'missing', true)).toBe(false);
  });

  it('corrupt registry file is ignored and treated as empty', () => {
    writeFiles(path.dirname(registryFilePath(repo)), { 'addons.json': 'not json{' });
    expect(readRegistry(repo)).toEqual({ addons: [] });
  });

  it('malformed entries are filtered out', () => {
    writeFiles(path.dirname(registryFilePath(repo)), {
      'addons.json': JSON.stringify({
        addons: [
          { name: 'ok', version: '1.0.0', enabled: true, source: 'registry' },
          { name: 42, version: '1.0.0', enabled: true, source: 'registry' },
          { name: 'no-version' },
          { name: 'legacy', version: '1.0.0', enabled: true }, // pre-`source` format — dropped, no compatibility path
        ],
      }),
    });
    expect(readRegistry(repo).addons).toEqual([
      { name: 'ok', version: '1.0.0', enabled: true, source: 'registry' },
    ]);
  });
});

// ===========================================================================
// Paths
// ===========================================================================

describe('addon paths', () => {
  it('lays out addons under .homegraph/addons', () => {
    const repo = tmpDir();
    try {
      expect(addonsRootDir(repo)).toBe(path.join(getHomeGraphDir(repo), 'addons'));
      expect(addonPkgDir(repo, '@scope/foo')).toBe(
        path.join(addonsRootDir(repo), 'node_modules', '@scope', 'foo'),
      );
      expect(addonPkgDir(repo, 'plain')).toBe(
        path.join(addonsRootDir(repo), 'node_modules', 'plain'),
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe('addon validation', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir('homegraph-addon-pkg-');
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a valid addon with enrich', async () => {
    writeFiles(dir, { 'package.json': validPkgJson(), 'index.mjs': VALID_ENRICH });
    const result = await validateAddonPackage(dir);
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(result.entryPoint).toBe('./index.mjs');
    expect(typeof result.module!.enrich).toBe('function');
  });

  it('accepts a default-export-only addon (merged into the namespace)', async () => {
    writeFiles(dir, {
      'package.json': validPkgJson(),
      'index.mjs': `export default { enrich: async () => [] };\n`,
    });
    const result = await validateAddonPackage(dir);
    expect(result.ok).toBe(true);
    expect(typeof result.module!.enrich).toBe('function');
  });

  it('rejects a package without the homegraph marker', async () => {
    writeFiles(dir, {
      'package.json': JSON.stringify({ name: 'x', version: '1.0.0', main: 'index.mjs' }),
      'index.mjs': VALID_ENRICH,
    });
    const result = await validateAddonPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('homegraph');
  });

  it('rejects an incompatible api version', async () => {
    writeFiles(dir, {
      'package.json': JSON.stringify({
        name: 'x',
        version: '1.0.0',
        main: 'index.mjs',
        homegraph: { addon: true, api: 2 },
      }),
      'index.mjs': VALID_ENRICH,
    });
    const result = await validateAddonPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/api/i);
  });

  it('rejects an addon exporting neither enrich nor buildPrompt', async () => {
    writeFiles(dir, {
      'package.json': validPkgJson(),
      'index.mjs': 'export const name = "x";\n',
    });
    const result = await validateAddonPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('neither enrich nor buildPrompt');
  });

  it('rejects missing package.json', async () => {
    const result = await validateAddonPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('package.json not found');
  });

  it('rejects an entry point that does not exist', async () => {
    writeFiles(dir, {
      'package.json': validPkgJson('x', { exports: { '.': './missing.mjs' } }),
    });
    const result = await validateAddonPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('entry point not found');
  });

  it('rejects a module that fails to load', async () => {
    writeFiles(dir, {
      'package.json': validPkgJson(),
      'index.mjs': 'export const broken = ;\n',
    });
    const result = await validateAddonPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('failed to load');
  });

  it('resolveEntryPoint prefers exports over main over index.js', () => {
    expect(resolveEntryPoint({ exports: './lib.mjs' })).toBe('./lib.mjs');
    expect(resolveEntryPoint({ exports: { '.': './nested.mjs' } })).toBe('./nested.mjs');
    expect(resolveEntryPoint({ exports: { '.': { import: './imp.mjs', default: './def.mjs' } } })).toBe(
      './imp.mjs',
    );
    expect(resolveEntryPoint({ main: './main.js' })).toBe('./main.js');
    expect(resolveEntryPoint({})).toBe('index.js');
  });
});

// ===========================================================================
// Loader
// ===========================================================================

describe('addon loader', () => {
  let repo: string;

  beforeEach(() => {
    repo = tmpDir('homegraph-addon-load-');
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  /** Simulate an installed addon: registry entry + files in the install dir. */
  function installFixture(name: string, { enabled = true, marker = true } = {}): void {
    const pkgDir = addonPkgDir(repo, name);
    writeFiles(pkgDir, {
      'package.json': marker
        ? validPkgJson(name)
        : JSON.stringify({ name, version: '1.0.0', main: 'index.mjs' }),
      'index.mjs': VALID_ENRICH,
    });
    upsertEntry(repo, { name, version: '1.0.0', enabled, source: 'registry' });
  }

  it('loads enabled registered addons in registry order', async () => {
    installFixture('a');
    installFixture('b');
    const loaded = await loadAddons(repo);
    expect(loaded.map((a) => a.name)).toEqual(['a', 'b']);
    expect(typeof loaded[0]!.module.enrich).toBe('function');
  });

  it('skips disabled addons', async () => {
    installFixture('a', { enabled: false });
    expect(await loadAddons(repo)).toEqual([]);
  });

  it('skips registered-but-not-installed addons', async () => {
    upsertEntry(repo, { name: 'ghost', version: '1.0.0', enabled: true, source: 'registry' });
    expect(await loadAddons(repo)).toEqual([]);
  });

  it('skips installed addons that fail validation', async () => {
    installFixture('bad', { marker: false });
    expect(await loadAddons(repo)).toEqual([]);
  });

  it('never loads unregistered installed packages (no directory scan)', async () => {
    writeFiles(addonPkgDir(repo, 'lurker'), {
      'package.json': validPkgJson('lurker'),
      'index.mjs': VALID_ENRICH,
    });
    expect(await loadAddons(repo)).toEqual([]);
  });

  it('loadSpecMineAddons filters by export shape', async () => {
    installFixture('enricher');
    const set = await loadSpecMineAddons(repo);
    expect(set.enrichers.length).toBe(1);
    expect(set.buildPrompt).toBeUndefined();
  });

  it('loadSpecMineAddons picks the first buildPrompt addon (registry order)', async () => {
    // Only the second fixture exports buildPrompt → it wins by elimination.
    writeFiles(addonPkgDir(repo, 'enricher-only'), {
      'package.json': validPkgJson('enricher-only'),
      'index.mjs': VALID_ENRICH,
    });
    upsertEntry(repo, { name: 'enricher-only', version: '1.0.0', enabled: true, source: 'registry' });
    writeFiles(addonPkgDir(repo, 'taker'), {
      'package.json': validPkgJson('taker'),
      'index.mjs': `${VALID_ENRICH}\nexport async function buildPrompt(ctx) { return 'T'; }\n`,
    });
    upsertEntry(repo, { name: 'taker', version: '1.0.0', enabled: true, source: 'registry' });

    const set = await loadSpecMineAddons(repo);
    expect(set.enrichers.length).toBe(2);
    expect(set.buildPrompt?.addon.name).toBe('taker');
  });
});

// ===========================================================================
// Scaffold (homegraph addon init)
// ===========================================================================

describe('addon init scaffold', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir('homegraph-addon-scaffold-');
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a js addon package with the marker and an enrich stub', () => {
    const created = createAddonScaffold('my-addon', dir, 'js');
    expect(created.length).toBeGreaterThanOrEqual(3);

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'my-addon', 'package.json'), 'utf-8'));
    expect(pkg.homegraph).toEqual({ addon: true, api: 1 });
    expect(pkg.type).toBe('module');

    const index = fs.readFileSync(path.join(dir, 'my-addon', 'index.mjs'), 'utf-8');
    expect(index).toContain('export async function enrich');
  });

  it('ts variant produces index.ts + tsconfig.json', () => {
    createAddonScaffold('my-addon', dir, 'ts');
    expect(fs.existsSync(path.join(dir, 'my-addon', 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'my-addon', 'tsconfig.json'))).toBe(true);
  });

  it('ts variant exports a single, fully-typed enrich (regression: duplicate + implicit any)', () => {
    createAddonScaffold('my-addon', dir, 'ts');
    const index = fs.readFileSync(path.join(dir, 'my-addon', 'index.ts'), 'utf-8');
    // Regression guard: the old scaffold emitted the untyped JS template and
    // then a typed duplicate — two `export async function enrich` declarations
    // (TS2323) plus implicit-any params (TS7006).
    expect(index.match(/export async function enrich/g)).toHaveLength(1);
    expect(index).toContain('export async function enrich(input: EnrichInput): Promise<Supplement[]>');
    expect(index).not.toContain(': any');
    expect(index).toContain("import type { EnrichInput, Supplement } from 'homegraph'");
    // The devDependency makes `import type { … } from 'homegraph'` resolvable.
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'my-addon', 'package.json'), 'utf-8'));
    expect(pkg.devDependencies).toEqual({ homegraph: 'latest' });
  });

  it('js variant keeps the jsdoc type hints and a single enrich', () => {
    createAddonScaffold('my-addon', dir, 'js');
    const index = fs.readFileSync(path.join(dir, 'my-addon', 'index.mjs'), 'utf-8');
    expect(index.match(/export async function enrich/g)).toHaveLength(1);
    expect(index).toContain("@param {import('homegraph').EnrichInput} input");
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'my-addon', 'package.json'), 'utf-8'));
    expect(pkg.devDependencies).toBeUndefined();
  });

  it('throws when the target directory already exists', () => {
    fs.mkdirSync(path.join(dir, 'existing'), { recursive: true });
    expect(() => createAddonScaffold('existing', dir, 'js')).toThrow(/already exists/);
  });
});

// ===========================================================================
// Manager (npm-backed install / remove / list)
// ===========================================================================

describe('addon manager', () => {
  let repo: string;
  let fixtureDir: string;

  beforeEach(() => {
    repo = tmpDir('homegraph-addon-mgr-');
    fixtureDir = tmpDir('homegraph-addon-fixture-');
  });

  afterEach(() => {
    for (const dir of [repo, fixtureDir]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolvePackageName reads a local package.json', () => {
    writeFiles(fixtureDir, { 'package.json': validPkgJson('local-addon') });
    expect(resolvePackageName(fixtureDir)).toBe('local-addon');
    expect(resolvePackageName(`./${path.basename(fixtureDir)}`)).toBeNull(); // relative to cwd, not the fixture
  });

  it('installAddon installs, validates, and registers a local package', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });

    const result = await installAddon(repo, fixtureDir, { enable: true });
    expect(result.name).toBe('local-addon');
    expect(result.version).toBe('1.2.3');

    const registry = readRegistry(repo);
    expect(registry.addons).toEqual([
      { name: 'local-addon', version: '1.2.3', enabled: true, source: 'local' },
    ]);
    expect(fs.existsSync(path.join(addonPkgDir(repo, 'local-addon'), 'index.mjs'))).toBe(true);
  });

  it('installAddon with enable=false registers disabled', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: false });
    expect(readRegistry(repo).addons[0]!.enabled).toBe(false);
  });

  it('installAddon rolls back (unregisters + removes files) on invalid packages', async () => {
    writeFiles(fixtureDir, {
      'package.json': JSON.stringify({ name: 'not-an-addon', version: '1.0.0', main: 'index.mjs' }),
      'index.mjs': VALID_ENRICH,
    });

    await expect(installAddon(repo, fixtureDir, { enable: true })).rejects.toThrow(
      /not a valid HomeGraph addon/,
    );
    expect(readRegistry(repo).addons).toEqual([]);
    expect(fs.existsSync(addonPkgDir(repo, 'not-an-addon'))).toBe(false);
  });

  it('removeAddon returns false for unregistered names', () => {
    expect(removeAddon(repo, 'ghost', { purge: true })).toBe(false);
  });

  it('removeAddon without purge unregisters but keeps files', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });
    const installedDir = addonPkgDir(repo, 'local-addon');

    expect(removeAddon(repo, 'local-addon', { purge: false })).toBe(true);
    expect(readRegistry(repo).addons).toEqual([]);
    expect(fs.existsSync(installedDir)).toBe(true);
  });

  it('removeAddon with purge deletes the installed files', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });

    expect(removeAddon(repo, 'local-addon', { purge: true })).toBe(true);
    expect(fs.existsSync(addonPkgDir(repo, 'local-addon'))).toBe(false);
  });

  it('listAddons reports installed vs missing status', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('present-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });
    upsertEntry(repo, { name: 'ghost-addon', version: '2.0.0', enabled: true, source: 'registry' });

    const list = listAddons(repo);
    expect(list).toEqual([
      { name: 'present-addon', version: '1.2.3', enabled: true, source: 'local', installed: true },
      { name: 'ghost-addon', version: '2.0.0', enabled: true, source: 'registry', installed: false },
    ]);
  });

  it('updateAddon is a no-op for an empty registry and throws for unknown names', async () => {
    expect(await updateAddon(repo)).toEqual([]);
    await expect(updateAddon(repo, 'nope')).rejects.toThrow(/not registered/);
  });

  it('isLocalPathSpec detects local path specs', () => {
    expect(isLocalPathSpec('./x')).toBe(true);
    expect(isLocalPathSpec('../x')).toBe(true);
    expect(isLocalPathSpec('/abs/x')).toBe(true);
    expect(isLocalPathSpec('file:../x')).toBe(true);
    expect(isLocalPathSpec('foo')).toBe(false);
    expect(isLocalPathSpec('@scope/foo')).toBe(false);
    expect(isLocalPathSpec('foo@1.2.3')).toBe(false);
  });

  it('resolvePackageInfo tags local path specs as local source', () => {
    writeFiles(fixtureDir, { 'package.json': validPkgJson('local-addon') });
    expect(resolvePackageInfo(fixtureDir)).toEqual({ name: 'local-addon', source: 'local' });
  });

  it('resolveUpdateSpec follows the recorded range or forces @latest', () => {
    expect(resolveUpdateSpec('foo', false)).toBe('foo');
    expect(resolveUpdateSpec('foo', true)).toBe('foo@latest');
  });

  it('installAddon refuses to downgrade an installed addon', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });

    // Same source, lower version → rejected before npm touches the store.
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon', { version: '1.0.0' }),
      'index.mjs': VALID_ENRICH,
    });
    await expect(installAddon(repo, fixtureDir, { enable: true })).rejects.toThrow(
      /older than the installed/,
    );
    expect(readRegistry(repo).addons).toEqual([
      { name: 'local-addon', version: '1.2.3', enabled: true, source: 'local' },
    ]);
  });

  it('installAddon upgrades to a newer version and records it', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });

    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon', { version: '2.0.0' }),
      'index.mjs': VALID_ENRICH,
    });
    const result = await installAddon(repo, fixtureDir, { enable: true });
    expect(result.version).toBe('2.0.0');
    expect(readRegistry(repo).addons[0]!.version).toBe('2.0.0');
    expect(readRegistry(repo).addons[0]!.source).toBe('local');
  });

  it('installAddon restores the previous version when an upgrade fails validation', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });

    // The upgrade target is no longer a valid addon (no homegraph marker).
    writeFiles(fixtureDir, {
      'package.json': JSON.stringify({ name: 'local-addon', version: '3.0.0', main: 'index.mjs' }),
      'index.mjs': VALID_ENRICH,
    });
    await expect(installAddon(repo, fixtureDir, { enable: true })).rejects.toThrow(
      /not a valid HomeGraph addon/,
    );

    // Registry untouched and the store entry still resolves (link restored).
    expect(readRegistry(repo).addons).toEqual([
      { name: 'local-addon', version: '1.2.3', enabled: true, source: 'local' },
    ]);
    expect(fs.existsSync(path.join(addonPkgDir(repo, 'local-addon'), 'package.json'))).toBe(true);
    // No rollback backups linger after the failed attempt.
    expect(fs.readdirSync(addonsRootDir(repo)).some((f) => f.startsWith('.rollback-'))).toBe(false);
  });

  it('keeps source local when the name is pre-resolved (CLI path)', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    // The CLI resolves the name up front and passes it via options.name.
    await installAddon(repo, fixtureDir, { enable: true, name: 'local-addon' });
    expect(readRegistry(repo).addons[0]!.source).toBe('local');
  });

  it('refuses a versionless local package against an installed version', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });

    // No version → resolves to '0.0.0' (the same fallback validation uses) →
    // a genuine downgrade against 1.2.3 → refused before npm runs.
    writeFiles(fixtureDir, {
      'package.json': JSON.stringify({
        name: 'local-addon',
        type: 'module',
        exports: { '.': './index.mjs' },
        homegraph: { addon: true, api: 1 },
      }),
      'index.mjs': VALID_ENRICH,
    });
    await expect(installAddon(repo, fixtureDir, { enable: true })).rejects.toThrow(
      /older than the installed/,
    );
    expect(readRegistry(repo).addons[0]!.version).toBe('1.2.3');
  });

  it('re-installing the same version is an idempotent no-op', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });
    await installAddon(repo, fixtureDir, { enable: true });
    expect(readRegistry(repo).addons).toEqual([
      { name: 'local-addon', version: '1.2.3', enabled: true, source: 'local' },
    ]);
  });

  it('updateAddon rejects --latest for local-path addons', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });
    await expect(updateAddon(repo, 'local-addon', { latest: true })).rejects.toThrow(
      /local path.*registry packages only/,
    );
  });

  it('updateAddon returns from/to for a local addon re-link (no change)', async () => {
    writeFiles(fixtureDir, {
      'package.json': validPkgJson('local-addon'),
      'index.mjs': VALID_ENRICH,
    });
    await installAddon(repo, fixtureDir, { enable: true });
    const results = await updateAddon(repo, 'local-addon');
    expect(results).toEqual([{ name: 'local-addon', from: '1.2.3', to: '1.2.3' }]);
  });
});

// ===========================================================================
// Supplement section rendering
// ===========================================================================

describe('supplement section rendering', () => {
  it('returns empty string for no supplements', () => {
    expect(renderSupplementSection([], 2000, 48000)).toBe('');
  });

  it('renders entries with key and short commit hash', () => {
    const section = renderSupplementSection(
      [{ key: 'JIRA-123', text: 'Detailed requirement.', commitHash: 'a'.repeat(40) }],
      2000,
      48000,
    );
    expect(section).toContain('## Supplement');
    expect(section).toContain('**[JIRA-123]**');
    expect(section).toContain('Detailed requirement.');
    expect(section).toContain('(commit aaaaaaa)');
  });

  it('truncates per-entry text beyond the per-entry cap', () => {
    const long = 'x'.repeat(500);
    const section = renderSupplementSection([{ text: long }], 100, 48000);
    expect(section).toContain('(truncated)');
    expect(section.length).toBeLessThan(long.length);
  });

  it('drops later entries when the section exceeds the total budget', () => {
    const s1 = { key: 'K1', text: 'A' };
    const s2 = { key: 'K2', text: 'B' };
    // Exactly the header + first entry: the second entry (same length) no longer fits.
    const budgetForFirst = renderSupplementSection([s1], 2000, 100_000).length;
    const section = renderSupplementSection([s1, s2], 2000, budgetForFirst);
    expect(section).toContain('K1');
    expect(section).not.toContain('K2');
  });

  it('returns empty when not even the header fits', () => {
    expect(renderSupplementSection([{ text: 'A' }], 2000, 10)).toBe('');
  });
});

// ===========================================================================
// Adapter — dedupe + enrich orchestration
// ===========================================================================

describe('spec-mine addon adapter', () => {
  it('dedupes by opaque key (first occurrence wins)', () => {
    const result = dedupeSupplements([
      { key: 'JIRA-1', text: 'v1' },
      { key: 'JIRA-1', text: 'v2' },
      { text: 'plain' },
    ]);
    expect(result).toEqual([{ key: 'JIRA-1', text: 'v1' }, { text: 'plain' }]);
  });

  it('dedupes keyless supplements by exact text', () => {
    const result = dedupeSupplements([{ text: 'same' }, { text: 'same' }, { text: 'other' }]);
    expect(result).toEqual([{ text: 'same' }, { text: 'other' }]);
  });

  it('keyed and keyless entries do not collide', () => {
    const result = dedupeSupplements([{ key: 'K', text: 'x' }, { text: 'x' }]);
    expect(result.length).toBe(2);
  });

  it('enrichCluster runs enrichers in parallel with the EnrichInput shape', async () => {
    const cluster = makeCluster(0);
    const enrich = vi.fn().mockResolvedValue([{ key: 'T-1', text: 'req' }]);
    const supplements = await enrichCluster([makeEnricher('a', enrich)], cluster);

    expect(enrich).toHaveBeenCalledTimes(1);
    const input = enrich.mock.calls[0]![0];
    expect(input.clusterId).toBe(cluster.id);
    expect(input.commits[0]).toMatchObject({
      commitHash: cluster.commits[0]!.commitHash,
      commitMessage: cluster.commits[0]!.commitMessage,
      author: cluster.commits[0]!.author,
      timestamp: cluster.commits[0]!.timestamp,
    });
    expect(supplements).toEqual([{ key: 'T-1', text: 'req' }]);
  });

  it('enrichCluster merges and dedupes across addons', async () => {
    const a = makeEnricher('a', async () => [{ key: 'K', text: 'from a' }]);
    const b = makeEnricher('b', async () => [{ key: 'K', text: 'from b' }]);
    const supplements = await enrichCluster([a, b], makeCluster(0));
    expect(supplements).toEqual([{ key: 'K', text: 'from a' }]);
  });

  it('a failing enricher is skipped without blocking others', async () => {
    const a = makeEnricher('bad', async () => {
      throw new Error('boom');
    });
    const b = makeEnricher('good', async () => [{ text: 'kept' }]);
    const supplements = await enrichCluster([a, b], makeCluster(0));
    expect(supplements).toEqual([{ text: 'kept' }]);
  });

  it('a non-array enrich result is ignored', async () => {
    const a = makeEnricher('weird', async () => 'not-an-array' as never);
    const supplements = await enrichCluster([a], makeCluster(0));
    expect(supplements).toEqual([]);
  });

  it('a hanging enricher times out and is skipped', async () => {
    vi.useFakeTimers();
    try {
      const hanging = makeEnricher('slow', () => new Promise(() => {}));
      const pending = enrichCluster([hanging], makeCluster(0));
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await pending).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('empty enricher list short-circuits', async () => {
    expect(await enrichCluster([], makeCluster(0))).toEqual([]);
  });
});

// ===========================================================================
// Integration — generateSpecs with addonSet
// ===========================================================================

describe('generateSpecs with addon set', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = tmpDir('homegraph-addon-gen-');
  });

  afterEach(() => {
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('renders enricher supplements into the cluster prompt', async () => {
    const client = makeMockClient();
    const enrich = vi.fn().mockResolvedValue([{ key: 'JIRA-9', text: 'Requirement details.' }]);
    const addonSet = {
      enrichers: [makeEnricher('jira', enrich)],
    };

    const result = await generateSpecs([makeCluster(0)], client, outputDir, undefined, undefined, addonSet);
    expect(result.specs.length).toBe(1);
    expect(result.errors).toBe(0);

    const userPrompt = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(userPrompt).toContain('## Supplement');
    expect(userPrompt).toContain('**[JIRA-9]**');
    expect(userPrompt).toContain('Requirement details.');
    expect(userPrompt).toContain('## Cluster Context');
    // Supplement renders BEFORE the cluster context
    expect(userPrompt.indexOf('## Supplement')).toBeLessThan(userPrompt.indexOf('## Cluster Context'));
  });

  it('buildPrompt addon takes over prompt assembly entirely', async () => {
    const client = makeMockClient();
    const buildPrompt = vi.fn().mockResolvedValue('CUSTOM PROMPT');
    const addonSet = {
      enrichers: [],
      buildPrompt: { addon: { name: 'taker', version: '1.0.0', module: {} }, fn: buildPrompt },
    };

    const result = await generateSpecs([makeCluster(0)], client, outputDir, undefined, undefined, addonSet);
    expect(result.specs.length).toBe(1);

    const userPrompt = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(userPrompt).toBe('CUSTOM PROMPT');

    const ctx = buildPrompt.mock.calls[0]![0];
    expect(ctx.cluster.id).toBe(0);
    expect(ctx.cluster.commits[0].commitHash).toHaveLength(40);
    expect(ctx.supplements).toEqual([]);
    expect(ctx.limits.maxContextChars).toBeGreaterThan(0);
    expect(ctx.template.length).toBeGreaterThan(0);
  });

  it('falls back to default assembly when buildPrompt throws', async () => {
    const client = makeMockClient();
    const buildPrompt = vi.fn().mockRejectedValue(new Error('boom'));
    const addonSet = {
      enrichers: [],
      buildPrompt: { addon: { name: 'taker', version: '1.0.0', module: {} }, fn: buildPrompt },
    };

    const result = await generateSpecs([makeCluster(0)], client, outputDir, undefined, undefined, addonSet);
    expect(result.specs.length).toBe(1);

    const userPrompt = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(userPrompt).toContain('## Cluster Context');
  });

  it('a throwing enricher never blocks spec generation', async () => {
    const client = makeMockClient();
    const addonSet = {
      enrichers: [
        makeEnricher('bad', async () => {
          throw new Error('boom');
        }),
      ],
    };

    const result = await generateSpecs([makeCluster(0)], client, outputDir, undefined, undefined, addonSet);
    expect(result.specs.length).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('without an addon set the prompt has no supplement section', async () => {
    const client = makeMockClient();
    const result = await generateSpecs([makeCluster(0)], client, outputDir);
    expect(result.specs.length).toBe(1);
    const userPrompt = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(userPrompt).not.toContain('## Supplement');
  });
});

// ===========================================================================
// Semver (install version gate)
// ===========================================================================

describe('addon semver', () => {
  it('compares core versions numerically', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('ignores a leading v and build metadata', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3+build.5', '1.2.3')).toBe(0);
  });

  it('orders prereleases below their release', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    // Numeric prerelease identifiers compare numerically.
    expect(compareSemver('1.0.0-2', '1.0.0-10')).toBeLessThan(0);
    // A shorter prerelease list sorts first.
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
  });

  it('treats unparseable versions as equal (conservative gate)', () => {
    expect(compareSemver('garbage', '1.0.0')).toBe(0);
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
  });
});
