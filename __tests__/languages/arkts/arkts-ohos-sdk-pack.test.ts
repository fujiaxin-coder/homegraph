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
    expect(roots[0]!.endsWith('openharmony/ets')).toBe(true);
    expect(roots[1]!.endsWith('hms/ets')).toBe(true);
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
});
