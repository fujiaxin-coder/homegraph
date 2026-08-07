import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../../../src/db';
import { QueryBuilder } from '../../../src/db/queries';
import { resetExtractionContext } from '../../../src/extraction/context';
import {
  OhosSdkInputError,
  findOhosSdkHome,
  hasOpenHarmonyEts,
  indexOhosApiDb,
  isArchivePath,
  listOhosApiEtsRoots,
  ohosApiDbFilename,
  ohosApiDbPackageName,
  parseOhosToolsVersionFromName,
  resetArkTSBatch,
  resolveOhosSdkInput,
  detectOhosCompileSdkVersion,
  discoverLocalOhosSdkCandidates,
  ensureOhosApiDb,
  findLocalOhosSdkForVersion,
  isOhosApiFilePath,
  markOhosApiFilePath,
  normalizeOhosApiVersion,
  parseJson5Minimal,
  readOhosSdkPlatformVersion,
} from '../../../src/extraction/languages/arkts';

const tempDirs: string[] = [];

function makeToolsTree(
  versionLabel: string,
  options?: { includeHms?: boolean; fixtureName?: string }
): { root: string; sdkHome: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ohos-tools-'));
  tempDirs.push(root);
  const sdkHome = path.join(root, 'command-line-tools', 'sdk', 'default');
  const etsApi = path.join(sdkHome, 'openharmony', 'ets', 'api');
  fs.mkdirSync(etsApi, { recursive: true });
  const fixture = options?.fixtureName ?? '@ohos.sample.d.ets';
  const body =
    fixture === '@ohos.fixture.d.ets'
      ? `export declare class FixtureGreeter {
  greet(name: string): string;
}
export declare function fixtureMain(): void;
`
      : 'export declare function sampleFn(): void;\n';
  fs.writeFileSync(path.join(etsApi, fixture), body);
  fs.writeFileSync(path.join(root, `commandline-tools-linux-x64-${versionLabel}.marker`), '');
  if (options?.includeHms) {
    const hmsApi = path.join(sdkHome, 'hms', 'ets', 'api');
    fs.mkdirSync(hmsApi, { recursive: true });
    fs.writeFileSync(path.join(hmsApi, '@hms.sample.d.ets'), 'export declare function hmsFn(): void;\n');
  }
  return { root, sdkHome };
}

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('languages/arkts ohos-sdk-pack', () => {
  it('parses API version from command-line-tools archive names', () => {
    expect(parseOhosToolsVersionFromName('commandline-tools-linux-x64-6.1.1.290.zip')).toBe('6.1.1');
    expect(parseOhosToolsVersionFromName('commandline-tools-linux-x64-6.1.1.290.tar.gz')).toBe('6.1.1');
    expect(parseOhosToolsVersionFromName('6.1.0')).toBe('6.1.0');
  });

  it('detects archive extensions', () => {
    expect(isArchivePath('/tmp/tools.zip')).toBe(true);
    expect(isArchivePath('/tmp/tools.tar.gz')).toBe(true);
    expect(isArchivePath('/tmp/tools.tgz')).toBe(true);
    expect(isArchivePath('/tmp/tools.tar')).toBe(true);
    expect(isArchivePath('/tmp/tools')).toBe(false);
  });

  it('finds sdk/default under an extracted command-line-tools tree', () => {
    const { root, sdkHome } = makeToolsTree('6.1.1.290');
    expect(findOhosSdkHome(root)).toBe(sdkHome);
    expect(hasOpenHarmonyEts(sdkHome)).toBe(true);
  });

  it('lists openharmony and optional hms ets roots', () => {
    const { sdkHome } = makeToolsTree('6.1.1.290', { includeHms: true });
    const roots = listOhosApiEtsRoots(sdkHome);
    expect(roots).toHaveLength(2);
    const norm = (p: string) => p.replace(/\\/g, '/');
    expect(norm(roots[0]!)).toMatch(/openharmony\/ets$/);
    expect(norm(roots[1]!)).toMatch(/hms\/ets$/);
  });

  it('resolves version override ahead of filename parsing', () => {
    const { root, sdkHome } = makeToolsTree('6.1.1.290');
    const resolved = resolveOhosSdkInput({ inputPath: root, versionOverride: '6.1.0' });
    expect(resolved.sdkHome).toBe(sdkHome);
    expect(resolved.version).toBe('6.1.0');
  });

  it('errors when version cannot be determined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ohos-plain-'));
    tempDirs.push(dir);
    const sdkHome = path.join(dir, 'sdk', 'default');
    fs.mkdirSync(path.join(sdkHome, 'openharmony', 'ets', 'api'), { recursive: true });
    fs.writeFileSync(path.join(sdkHome, 'openharmony', 'ets', 'api', '@ohos.sample.d.ets'), 'export {};\n');
    expect(() => resolveOhosSdkInput({ inputPath: dir })).toThrow(OhosSdkInputError);
  });

  it('names versioned API db files', () => {
    expect(ohosApiDbFilename('6.1.1')).toBe('ohos-api-6.1.1.db');
  });

  it('names one npm package per API version', () => {
    expect(ohosApiDbPackageName('6.0.1')).toBe('homegraph-ohos-api-db-6.0.1');
    expect(ohosApiDbPackageName('6.1.1')).toBe('homegraph-ohos-api-db-6.1.1');
  });

  it('normalizes compileSdkVersion strings', () => {
    expect(normalizeOhosApiVersion('6.0.1(21)')).toBe('6.0.1');
    expect(normalizeOhosApiVersion('6.1.1')).toBe('6.1.1');
  });

  it('detects compileSdkVersion from build-profile.json5', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ohos-profile-'));
    tempDirs.push(root);
    fs.writeFileSync(
      path.join(root, 'build-profile.json5'),
      `{
  app: {
    products: [
      { name: "default", compileSdkVersion: "6.0.1(21)" }
    ]
  }
}
`
    );
    expect(detectOhosCompileSdkVersion(root)).toBe('6.0.1');
  });

  it('marks SDK API file paths for explore rendering', () => {
    expect(markOhosApiFilePath('api/@ohos.base.d.ts')).toBe('ohos-sdk:api/@ohos.base.d.ts');
    expect(isOhosApiFilePath('ohos-sdk:api/@ohos.base.d.ts')).toBe(true);
    expect(isOhosApiFilePath('src/main/ets/Index.ets')).toBe(false);
  });

  it('parses minimal json5', () => {
    const parsed = parseJson5Minimal('{ // comment\n"a": 1, }') as { a: number };
    expect(parsed.a).toBe(1);
  });

  it('indexes SDK API declarations into a standalone database', async () => {
    const { sdkHome } = makeToolsTree('6.1.1.290', { fixtureName: '@ohos.fixture.d.ets' });
    const dbPath = path.join(path.dirname(sdkHome), 'ohos-api-test.db');

    const result = await indexOhosApiDb({
      sdkHome,
      version: '6.1.1',
      outputPath: dbPath,
    });

    expect(result.success).toBe(true);
    expect(result.nodesCreated).toBeGreaterThan(0);
    expect(fs.existsSync(dbPath)).toBe(true);

    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());
    expect(queries.getMetadata('ohos_api_version')).toBe('6.1.1');
    expect(queries.getMetadata('ohos_api_db_kind')).toBe('homegraph-ohos-api-db-6.1.1');
    expect(queries.getNodesByName('FixtureGreeter').some((n) => n.kind === 'class')).toBe(true);
    db.close();
  }, 120_000);

  it('reads platformVersion from sdk-pkg.json', () => {
    const { sdkHome } = makeToolsTree('6.1.1.290');
    fs.writeFileSync(
      path.join(sdkHome, 'sdk-pkg.json'),
      JSON.stringify({
        data: {
          apiVersion: '24',
          platformVersion: '6.1.1',
          version: '6.1.1.125',
        },
      })
    );
    expect(readOhosSdkPlatformVersion(sdkHome)).toBe('6.1.1');
  });

  it('discovers local SDK via HOMEGRAPH_OHOS_SDK and builds API db on ensure', async () => {
    const { root, sdkHome } = makeToolsTree('6.0.1.100', { fixtureName: '@ohos.fixture.d.ets' });
    fs.writeFileSync(
      path.join(sdkHome, 'sdk-pkg.json'),
      JSON.stringify({ data: { platformVersion: '6.0.1', version: '6.0.1.100' } })
    );

    const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ohos-api-home-'));
    tempDirs.push(apiDir);
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevSdk = process.env.HOMEGRAPH_OHOS_SDK;
    const prevOhos = process.env.OHOS_SDK_HOME;
    const prevDevEco = process.env.DEVECO_SDK_HOME;
    const prevHos = process.env.HOS_SDK_HOME;
    // Point os.homedir() consumers at a temp home so we don't write into the real ~/.homegraph
    process.env.HOME = apiDir;
    process.env.USERPROFILE = apiDir;
    process.env.HOMEGRAPH_OHOS_SDK = root;
    delete process.env.OHOS_SDK_HOME;
    delete process.env.DEVECO_SDK_HOME;
    delete process.env.HOS_SDK_HOME;

    try {
      const candidates = discoverLocalOhosSdkCandidates();
      expect(candidates.some((c) => c.version === '6.0.1')).toBe(true);
      expect(findLocalOhosSdkForVersion('6.0.1')?.sdkHome).toBe(sdkHome);

      const ensured = await ensureOhosApiDb('6.0.1', { build: true });
      expect('code' in ensured).toBe(false);
      if ('code' in ensured) return;
      expect(ensured.installed).toBe(true);
      expect(fs.existsSync(ensured.dbPath)).toBe(true);
      expect(path.basename(ensured.dbPath)).toBe('ohos-api-6.0.1.db');

      // Second call reuses the on-disk db
      const reused = await ensureOhosApiDb('6.0.1', { build: true });
      expect('code' in reused).toBe(false);
      if ('code' in reused) return;
      expect(reused.installed).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevSdk === undefined) delete process.env.HOMEGRAPH_OHOS_SDK;
      else process.env.HOMEGRAPH_OHOS_SDK = prevSdk;
      if (prevOhos === undefined) delete process.env.OHOS_SDK_HOME;
      else process.env.OHOS_SDK_HOME = prevOhos;
      if (prevDevEco === undefined) delete process.env.DEVECO_SDK_HOME;
      else process.env.DEVECO_SDK_HOME = prevDevEco;
      if (prevHos === undefined) delete process.env.HOS_SDK_HOME;
      else process.env.HOS_SDK_HOME = prevHos;
    }
  }, 120_000);

  it('falls back to an existing 6.1.0 db when the requested version is missing', async () => {
    const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ohos-api-fb-'));
    tempDirs.push(apiDir);
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevSdk = process.env.HOMEGRAPH_OHOS_SDK;
    const prevOhos = process.env.OHOS_SDK_HOME;
    const prevDevEco = process.env.DEVECO_SDK_HOME;
    const prevHos = process.env.HOS_SDK_HOME;
    const prevNoDl = process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD;
    process.env.HOME = apiDir;
    process.env.USERPROFILE = apiDir;
    process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD = '1';
    delete process.env.HOMEGRAPH_OHOS_SDK;
    delete process.env.OHOS_SDK_HOME;
    delete process.env.DEVECO_SDK_HOME;
    delete process.env.HOS_SDK_HOME;

    const apiRoot = path.join(apiDir, '.homegraph', 'api');
    fs.mkdirSync(apiRoot, { recursive: true });
    fs.writeFileSync(path.join(apiRoot, 'ohos-api-6.1.0.db'), 'sqlite-placeholder');

    try {
      const ensured = await ensureOhosApiDb('9.9.9', { build: true });
      expect('code' in ensured).toBe(false);
      if ('code' in ensured) return;
      expect(ensured.version).toBe('6.1.0');
      expect(path.basename(ensured.dbPath)).toBe('ohos-api-6.1.0.db');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevSdk === undefined) delete process.env.HOMEGRAPH_OHOS_SDK;
      else process.env.HOMEGRAPH_OHOS_SDK = prevSdk;
      if (prevOhos === undefined) delete process.env.OHOS_SDK_HOME;
      else process.env.OHOS_SDK_HOME = prevOhos;
      if (prevDevEco === undefined) delete process.env.DEVECO_SDK_HOME;
      else process.env.DEVECO_SDK_HOME = prevDevEco;
      if (prevHos === undefined) delete process.env.HOS_SDK_HOME;
      else process.env.HOS_SDK_HOME = prevHos;
      if (prevNoDl === undefined) delete process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD;
      else process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD = prevNoDl;
    }
  });

  it('returns a warning (not throw) when local SDK is missing and downloads are disabled', async () => {
    const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ohos-api-miss-'));
    tempDirs.push(apiDir);
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevSdk = process.env.HOMEGRAPH_OHOS_SDK;
    const prevOhos = process.env.OHOS_SDK_HOME;
    const prevDevEco = process.env.DEVECO_SDK_HOME;
    const prevHos = process.env.HOS_SDK_HOME;
    const prevNoDl = process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD;
    process.env.HOME = apiDir;
    process.env.USERPROFILE = apiDir;
    process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD = '1';
    delete process.env.HOMEGRAPH_OHOS_SDK;
    delete process.env.OHOS_SDK_HOME;
    delete process.env.DEVECO_SDK_HOME;
    delete process.env.HOS_SDK_HOME;

    try {
      const ensured = await ensureOhosApiDb('9.9.9', { build: true });
      expect('code' in ensured).toBe(true);
      if (!('code' in ensured)) return;
      expect(ensured.code).toBe('ohos_api_sdk_missing');
      expect(ensured.message).toMatch(/unavailable|not found/i);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevSdk === undefined) delete process.env.HOMEGRAPH_OHOS_SDK;
      else process.env.HOMEGRAPH_OHOS_SDK = prevSdk;
      if (prevOhos === undefined) delete process.env.OHOS_SDK_HOME;
      else process.env.OHOS_SDK_HOME = prevOhos;
      if (prevDevEco === undefined) delete process.env.DEVECO_SDK_HOME;
      else process.env.DEVECO_SDK_HOME = prevDevEco;
      if (prevHos === undefined) delete process.env.HOS_SDK_HOME;
      else process.env.HOS_SDK_HOME = prevHos;
      if (prevNoDl === undefined) delete process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD;
      else process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD = prevNoDl;
    }
  });
});
