import { describe, it, expect } from 'vitest';
import {
  extractFileBasenamesFromQuery,
  extractKitModuleNamesFromQuery,
  extractMemberAccessFromQuery,
  extractImportSearchTerms,
  extractDependencySymbolsFromQuery,
  queryNamesConfigFile,
  shouldCompactImportListing,
  shouldOmitSourceBodies,
  queryNamesMultipleExploreAnchors,
  shouldBuildCallerInventory,
  shouldBuildMemberSurvey,
  shouldBuildConfigSection,
  fileMatchesQueryBasename,
} from '../src/search/query-utils';

describe('extractFileBasenamesFromQuery', () => {
  it('extracts standalone file basenames', () => {
    expect(extractFileBasenamesFromQuery('LocationController.ets中 locationManager.on')).toEqual([
      'LocationController',
    ]);
  });

  it('extracts basenames from path-style references (backslash or slash)', () => {
    expect(extractFileBasenamesFromQuery('项目common\\constants.ets中使用到了哪些错误码')).toEqual([
      'constants',
    ]);
    expect(extractFileBasenamesFromQuery('see product/foo/oh-package.json5 deps')).toEqual([
      'oh-package',
    ]);
  });
});

describe('extractKitModuleNamesFromQuery', () => {
  it('extracts @kit literal and PascalCase *Kit tokens', () => {
    expect(extractKitModuleNamesFromQuery("import from @kit.ArkTS and ServiceCollaborationKit")).toEqual(
      expect.arrayContaining(['ArkTS', 'ServiceCollaborationKit']),
    );
  });
});

describe('extractMemberAccessFromQuery', () => {
  it('extracts receiver.method and leading-dot members', () => {
    const accesses = extractMemberAccessFromQuery(
      'pointer.setPointerStyle 和 .drawModifier 以及 locationManager.on()',
    );
    const dotted = accesses.map((a) => a.dotted);
    expect(dotted).toContain('pointer.setPointerStyle');
    expect(dotted).toContain('.drawModifier');
    expect(dotted).toContain('locationManager.on');
  });
});

describe('extractImportSearchTerms', () => {
  it('includes both bare kit name and @kit path', () => {
    expect(extractImportSearchTerms('ServiceCollaborationKit dependency')).toEqual(
      expect.arrayContaining(['ServiceCollaborationKit', '@kit.ServiceCollaborationKit']),
    );
  });
});

describe('extractDependencySymbolsFromQuery', () => {
  it('extracts camelCase API symbols but not kit module names', () => {
    expect(extractDependencySymbolsFromQuery('files importing taskpool from @kit.ArkTS')).toContain(
      'taskpool',
    );
    expect(extractDependencySymbolsFromQuery('files importing taskpool from @kit.ArkTS')).not.toContain(
      'ArkTS',
    );
  });
});

describe('queryNamesConfigFile', () => {
  it('detects config files by extension in query text', () => {
    expect(queryNamesConfigFile('show build-profile.json5 strictMode value')).toBe(true);
    expect(queryNamesConfigFile('what calls BadgeManager')).toBe(false);
  });
});

describe('shouldCompactImportListing', () => {
  it('compacts when symbol filter matches multiple sites', () => {
    expect(shouldCompactImportListing(5, true)).toBe(true);
    expect(shouldCompactImportListing(1, true)).toBe(false);
    expect(shouldCompactImportListing(5, false)).toBe(false);
  });
});

describe('shouldOmitSourceBodies', () => {
  it('omits source for import inventory when graph has no flow path', () => {
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 4,
        hasFilteredImports: true,
        callerBulletCount: 0,
        memberFileCount: 0,
        configRendered: false,
      }, false, false),
    ).toBe(true);
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 4,
        hasFilteredImports: true,
        callerBulletCount: 0,
        memberFileCount: 0,
        configRendered: false,
      }, true, false),
    ).toBe(false);
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 4,
        hasFilteredImports: true,
        callerBulletCount: 5,
        memberFileCount: 0,
        configRendered: false,
      }, false, true),
    ).toBe(false);
  });
});

describe('shouldBuildCallerInventory', () => {
  it('builds when a type name is named in the query', () => {
    expect(shouldBuildCallerInventory('external callers of BadgeManager')).toBe(true);
    expect(shouldBuildCallerInventory('how BadgeManager notifies listeners')).toBe(true);
  });
});

describe('shouldBuildMemberSurvey', () => {
  it('builds only when member-access syntax is present', () => {
    expect(shouldBuildMemberSurvey('files using .drawModifier')).toBe(true);
    expect(shouldBuildMemberSurvey('list all UI components')).toBe(false);
  });
});

describe('shouldBuildConfigSection', () => {
  it('builds when query names a config file by extension', () => {
    expect(shouldBuildConfigSection('read app.json5 dependencies')).toBe(true);
    expect(shouldBuildConfigSection('how routing works')).toBe(false);
  });
});

describe('fileMatchesQueryBasename', () => {
  it('matches exact basename for any source extension', () => {
    expect(
      fileMatchesQueryBasename(
        'feature/foo/LocationController.ets',
        ['LocationController'],
      ),
    ).toBe(true);
    expect(
      fileMatchesQueryBasename(
        'src/auth/UserService.ts',
        ['UserService'],
      ),
    ).toBe(true);
    expect(
      fileMatchesQueryBasename(
        'product/pcbase/control.ets',
        ['LocationController'],
      ),
    ).toBe(false);
  });
});
