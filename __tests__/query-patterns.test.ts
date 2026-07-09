import { describe, it, expect } from 'vitest';
import {
  extractFileBasenamesFromQuery,
  extractKitModuleNamesFromQuery,
  extractMemberAccessFromQuery,
  extractImportSearchTerms,
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

describe('fileMatchesQueryBasename', () => {
  it('matches exact basename only', () => {
    expect(
      fileMatchesQueryBasename(
        'feature/foo/LocationController.ets',
        ['LocationController'],
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
