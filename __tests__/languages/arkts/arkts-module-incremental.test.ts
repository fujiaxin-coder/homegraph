/**
 * Harmony multi-module ArkTS incremental sync: dirty-file → module mapping and
 * module-scoped reindex (analyseByModule target subset).
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import { resetExtractionContext } from '../../../src/extraction/context';
import {
  isArkTSBatchPersisted,
  listHarmonyProjectModules,
  normalizeHarmonyModuleSrcPath,
  resetArkTSBatch,
  resolveDirtyHarmonyModules,
} from '../../../src/extraction/languages/arkts';
import { cleanupArktsProjects, makeArktsProject } from './helpers';

/** Minimal 2-module Harmony fixture (entry depends on library). */
function makeTwoModuleProject(extraFiles: Record<string, string> = {}): string {
  return makeArktsProject({
    'build-profile.json5': JSON.stringify({
      modules: [
        { name: 'entry', srcPath: './entry' },
        { name: 'library', srcPath: './library' },
      ],
    }),
    'entry/oh-package.json5': JSON.stringify({
      name: '@ohos/entry',
      version: '1.0.0',
      dependencies: { library: '../library' },
    }),
    'library/oh-package.json5': JSON.stringify({
      name: '@ohos/library',
      version: '1.0.0',
    }),
    'library/src/main/ets/Util.ets': `
export function helper(): string {
  return 'v1';
}
`,
    'entry/src/main/ets/Index.ets': `
export function main(): string {
  return 'entry';
}
`,
    ...extraFiles,
  });
}

function bumpFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
  const st = fs.statSync(filePath);
  fs.utimesSync(filePath, st.atime, new Date(st.mtimeMs + 2000));
}

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

describe('languages/arkts module incremental — mapping', () => {
  it('normalizes build-profile srcPath forms', () => {
    expect(normalizeHarmonyModuleSrcPath('./entry')).toBe('entry');
    expect(normalizeHarmonyModuleSrcPath('entry/')).toBe('entry');
    expect(normalizeHarmonyModuleSrcPath('products\\phone')).toBe('products/phone');
  });

  it('lists PROJECT modules from build-profile.json5', () => {
    const root = makeTwoModuleProject();
    expect(listHarmonyProjectModules(root)).toEqual([
      { name: 'entry', srcPath: 'entry' },
      { name: 'library', srcPath: 'library' },
    ]);
  });

  it('maps dirty .ets files to their Harmony modules', () => {
    const root = makeTwoModuleProject();
    const res = resolveDirtyHarmonyModules(root, [
      'entry/src/main/ets/Index.ets',
      'library/src/main/ets/Util.ets',
    ]);
    expect(res).toEqual({
      mode: 'modules',
      moduleSrcPaths: ['entry', 'library'],
    });
  });

  it('maps a single dirty file to one module', () => {
    const root = makeTwoModuleProject();
    expect(
      resolveDirtyHarmonyModules(root, ['library/src/main/ets/Util.ets'])
    ).toEqual({ mode: 'modules', moduleSrcPaths: ['library'] });
  });

  it('forces full rebuild when build-profile.json5 changes', () => {
    const root = makeTwoModuleProject();
    const res = resolveDirtyHarmonyModules(root, ['build-profile.json5']);
    expect(res.mode).toBe('full');
    if (res.mode === 'full') {
      expect(res.reason).toMatch(/build-profile/);
    }
  });

  it('forces full rebuild for ArkTS sources outside every module', () => {
    const root = makeTwoModuleProject({ 'orphan.ets': 'export function x() {}' });
    const res = resolveDirtyHarmonyModules(root, ['orphan.ets']);
    expect(res.mode).toBe('full');
    if (res.mode === 'full') {
      expect(res.reason).toMatch(/outside modules/);
    }
  });

  it('returns none when changed files are unrelated', () => {
    const root = makeTwoModuleProject();
    expect(resolveDirtyHarmonyModules(root, ['README.md'])).toEqual({ mode: 'none' });
  });

  it('ignores virtual @dummyFile artifacts when resolving dirty modules', () => {
    const root = makeTwoModuleProject();
    expect(
      resolveDirtyHarmonyModules(root, ['@dummyFile.ets', 'library/src/main/ets/Util.ets'])
    ).toEqual({ mode: 'modules', moduleSrcPaths: ['library'] });
  });
});

describe('languages/arkts module incremental — sync', () => {
  it('reindexes a dirty library module without dropping entry symbols', async () => {
    const root = makeTwoModuleProject();
    const cg = HomeGraph.initSync(root);
    try {
      await cg.indexAll();

      expect(
        cg.getNodesByKind('function').some(
          (n) => n.name === 'main' && n.filePath.replace(/\\/g, '/').includes('entry/')
        )
      ).toBe(true);
      expect(
        cg.getNodesByKind('function').some(
          (n) => n.name === 'helper' && n.filePath.replace(/\\/g, '/').includes('library/')
        )
      ).toBe(true);

      bumpFile(
        path.join(root, 'library/src/main/ets/Util.ets'),
        `
export function helper(): string {
  return 'v2';
}
export function helperExtra(): string {
  return 'extra';
}
`
      );

      resetArkTSBatch();
      const syncResult = await cg.sync();
      expect(syncResult.filesModified).toBeGreaterThan(0);

      expect(
        cg.getNodesByKind('function').some(
          (n) =>
            n.name === 'helperExtra' && n.filePath.replace(/\\/g, '/').includes('library/')
        )
      ).toBe(true);
      expect(
        cg.getNodesByKind('function').some(
          (n) => n.name === 'main' && n.filePath.replace(/\\/g, '/').includes('entry/')
        )
      ).toBe(true);

      // Incremental path should have marked the dirty module file as batch-persisted.
      expect(isArkTSBatchPersisted('library/src/main/ets/Util.ets')).toBe(true);
      // Clean module must not be rewritten in this batch (proves module subset, not full).
      expect(isArkTSBatchPersisted('entry/src/main/ets/Index.ets')).toBe(false);
    } finally {
      cg.close();
    }
  }, 120_000);

  it('maps module.json5 edits to the owning module', () => {
    const root = makeTwoModuleProject({
      'entry/src/main/module.json5': `{
  "module": { "name": "entry", "type": "entry", "pages": "pages/Index" }
}`,
    });
    expect(
      resolveDirtyHarmonyModules(root, ['entry/src/main/module.json5'])
    ).toEqual({ mode: 'modules', moduleSrcPaths: ['entry'] });
  });
});
