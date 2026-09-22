import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findSyntheticArkModuleRoot,
  languageForArkAnalyzerPath,
  listOrphanArkAnalyzerSources,
  listSyntheticArkModuleRoots,
  resolveDirtyHarmonyModules,
} from '../../../src/extraction/languages/arkts';
import { cleanupArktsProjects, makeArktsProject } from './helpers';

afterEach(() => cleanupArktsProjects());

describe('languageForArkAnalyzerPath', () => {
  it('tags by extension, not the AA extractor name', () => {
    expect(languageForArkAnalyzerPath('a/b/Foo.ets')).toBe('arkts');
    expect(languageForArkAnalyzerPath('a/b/Bar.ts')).toBe('typescript');
    expect(languageForArkAnalyzerPath('a/b/Baz.d.ts')).toBe('typescript');
    expect(languageForArkAnalyzerPath('a/b/x.js')).toBe('javascript');
  });
});

describe('synthetic Ark modules for orphan TS', () => {
  it('clusters package.json trees outside build-profile modules', () => {
    const root = makeArktsProject({
      'build-profile.json5': JSON.stringify({
        modules: [{ name: 'entry', srcPath: './entry' }],
      }),
      'entry/src/main/ets/Index.ets': 'export struct Index {}',
      'plugin/package.json': JSON.stringify({ name: 'plugin', version: '1.0.0' }),
      'plugin/src/Index.ts': 'export function boot(): void {}',
      'plugin/src/util.ts': 'export const x = 1;',
      'hvigorfile.ts': 'export default {};',
    });

    const modules = [{ name: 'entry', srcPath: 'entry' }];
    const scanned = [
      'entry/src/main/ets/Index.ets',
      'plugin/src/Index.ts',
      'plugin/src/util.ts',
      'hvigorfile.ts',
    ];

    expect(listOrphanArkAnalyzerSources(scanned, modules)).toEqual([
      'hvigorfile.ts',
      'plugin/src/Index.ts',
      'plugin/src/util.ts',
    ]);
    expect(findSyntheticArkModuleRoot(root, 'plugin/src/Index.ts')).toBe('plugin');
    expect(findSyntheticArkModuleRoot(root, 'hvigorfile.ts')).toBeNull();
    expect(listSyntheticArkModuleRoots(root, scanned, modules)).toEqual([
      { name: 'synthetic:plugin', srcPath: 'plugin' },
    ]);
  });

  it('maps dirty orphan plugin files to synthetic module srcPath', () => {
    const root = makeArktsProject({
      'build-profile.json5': JSON.stringify({
        modules: [{ name: 'entry', srcPath: './entry' }],
      }),
      'entry/oh-package.json5': JSON.stringify({ name: '@ohos/entry', version: '1.0.0' }),
      'entry/src/main/ets/Index.ets': 'export struct Index {}',
      'plugin/package.json': JSON.stringify({ name: 'plugin', version: '1.0.0' }),
      'plugin/src/Index.ts': 'export function boot(): void {}',
    });

    const res = resolveDirtyHarmonyModules(root, ['plugin/src/Index.ts']);
    expect(res).toEqual({ mode: 'modules', moduleSrcPaths: ['plugin'] });
  });

  it('does not invent a synthetic root for files already inside a Harmony module', () => {
    const root = makeArktsProject({
      'build-profile.json5': JSON.stringify({
        modules: [{ name: 'lib', srcPath: './lib' }],
      }),
      'lib/package.json': JSON.stringify({ name: 'lib', version: '1.0.0' }),
      'lib/src/Helper.ts': 'export const n = 1;',
    });
    expect(
      listSyntheticArkModuleRoots(root, ['lib/src/Helper.ts'], [{ name: 'lib', srcPath: 'lib' }])
    ).toEqual([]);
    // Touch disk so findSynthetic would otherwise see package.json under lib/
    expect(fs.existsSync(path.join(root, 'lib/package.json'))).toBe(true);
  });

  it('does not register oh-package or packageless orphans as synthetic PROJECT modules', () => {
    // scene_board shape: many feature/* HAP modules + forgotten HARs / loose
    // .ets outside build-profile. Those must NOT become synthetic PROJECT→BODIES
    // (visionglass oh-package pulls launchercommon etc. back into ModuleCache).
    const root = makeArktsProject({
      'build-profile.json5': JSON.stringify({
        modules: [
          { name: 'appcenter', srcPath: './feature/appcenter' },
          { name: 'desktop', srcPath: './feature/desktop/pagedesktop' },
        ],
      }),
      'feature/appcenter/src/main/ets/Index.ets': 'export struct Index {}',
      'feature/desktop/pagedesktop/src/main/ets/Index.ets': 'export struct Index {}',
      'feature/intelligent/src/main/ets/Agent.ets': 'export struct Agent {}',
      'feature/themebase/EditWallpaper.ets': 'export struct EditWallpaper {}',
      'feature/visionglass/oh-package.json5': JSON.stringify({
        name: '@ohos/visionglass',
        version: '1.0.0',
        dependencies: {
          '@ohos/launchercommon': '../../staticcommon/launchercommon',
        },
      }),
      'feature/visionglass/Index.ets': 'export struct Glass {}',
      // Node plugin beside HAPs — still eligible for synthetic.
      'feature/intelligent/tools/package.json': JSON.stringify({ name: 'intel-tools', version: '1.0.0' }),
      'feature/intelligent/tools/index.ts': 'export const tip = 1;',
    });

    const modules = [
      { name: 'appcenter', srcPath: 'feature/appcenter' },
      { name: 'desktop', srcPath: 'feature/desktop/pagedesktop' },
    ];
    const scanned = [
      'feature/appcenter/src/main/ets/Index.ets',
      'feature/desktop/pagedesktop/src/main/ets/Index.ets',
      'feature/intelligent/src/main/ets/Agent.ets',
      'feature/intelligent/tools/index.ts',
      'feature/themebase/EditWallpaper.ets',
      'feature/visionglass/Index.ets',
    ];

    expect(listOrphanArkAnalyzerSources(scanned, modules)).toEqual([
      'feature/intelligent/src/main/ets/Agent.ets',
      'feature/intelligent/tools/index.ts',
      'feature/themebase/EditWallpaper.ets',
      'feature/visionglass/Index.ets',
    ]);
    expect(findSyntheticArkModuleRoot(root, 'feature/intelligent/src/main/ets/Agent.ets', modules)).toBeNull();
    expect(findSyntheticArkModuleRoot(root, 'feature/themebase/EditWallpaper.ets', modules)).toBeNull();
    expect(findSyntheticArkModuleRoot(root, 'feature/visionglass/Index.ets', modules)).toBeNull();
    // Plugin under feature/intelligent must not climb to synthetic:feature/
    expect(findSyntheticArkModuleRoot(root, 'feature/intelligent/tools/index.ts', modules)).toBe(
      'feature/intelligent/tools'
    );
    expect(listSyntheticArkModuleRoots(root, scanned, modules)).toEqual([
      { name: 'synthetic:tools', srcPath: 'feature/intelligent/tools' },
    ]);
  });
});
