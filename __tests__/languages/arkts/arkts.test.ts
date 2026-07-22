import { afterEach, describe, expect, it } from 'vitest';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import {
  ArkTSExtractor,
  isArkTSBatchPersisted,
  resetArkTSBatch,
  scanEtsFiles,
  shouldUseIsolatedArkTSBuild,
} from '../../../src/extraction/languages/arkts';
import { detectLanguage, isArkModuleJson5, isSourceFile } from '../../../src/extraction/grammars';
import { scanDirectory } from '../../../src/extraction';
import { cleanupArktsProjects, makeArktsProject, mockArktsQueries } from './helpers';

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

describe('languages/arkts', () => {
  it('registers .ets and module.json5 as source files', () => {
    expect(isSourceFile('foo.ets')).toBe(true);
    expect(isArkModuleJson5('src/main/module.json5')).toBe(true);
    expect(isSourceFile('src/main/module.json5')).toBe(true);
    expect(detectLanguage('foo.ets')).toBe('arkts');
    expect(detectLanguage('src/main/module.json5')).toBe('yaml');
  });

  it('keeps isolated ArkTS Scene build opt-in (default in-process)', () => {
    const prev = process.env.HOMEGRAPH_ARKTS_ISOLATED;
    try {
      delete process.env.HOMEGRAPH_ARKTS_ISOLATED;
      expect(shouldUseIsolatedArkTSBuild()).toBe(false);
      process.env.HOMEGRAPH_ARKTS_ISOLATED = '0';
      expect(shouldUseIsolatedArkTSBuild()).toBe(false);
      process.env.HOMEGRAPH_ARKTS_ISOLATED = '1';
      expect(shouldUseIsolatedArkTSBuild()).toBe(true);
      process.env.HOMEGRAPH_ARKTS_ISOLATED = 'true';
      expect(shouldUseIsolatedArkTSBuild()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HOMEGRAPH_ARKTS_ISOLATED;
      else process.env.HOMEGRAPH_ARKTS_ISOLATED = prev;
    }
  });

  it('scanEtsFiles skips default-ignored dirs like build/ (same as scanDirectory)', () => {
    const root = makeArktsProject({
      'entry/src/main/ets/pages/Index.ets': 'export struct Index {}',
      'entry/build/default/cache/generated.ets': 'export struct Generated {}',
      'dist/out.ets': 'export struct DistOut {}',
    });

    const scanned = scanEtsFiles(root);
    expect(scanned).toEqual(['entry/src/main/ets/pages/Index.ets']);
    expect(scanned.some((f) => f.includes('/build/') || f.startsWith('dist/'))).toBe(false);

    // Non-git status compares DB vs scanDirectory — ArkTS batch must not invent extras.
    const mainScan = scanDirectory(root).map((f) => f.replace(/\\/g, '/'));
    expect(mainScan).toContain('entry/src/main/ets/pages/Index.ets');
    expect(mainScan.some((f) => f.includes('/build/') || f.startsWith('dist/'))).toBe(false);
  });

  it('builds a Scene, persists batch, and returns symbols + RTA calls', () => {
    const root = makeArktsProject({
      'sample.ets': `
export type UserId = string;

const MAX_SIZE = 100;

export enum Status {
  Active,
  Inactive,
}

export class Greeter {
  greet(name: string): string {
    return this.format(name);
  }
  private format(name: string): string {
    return 'Hello, ' + name;
  }
  label: string = 'x';
}

export function main(): void {
  const g = new Greeter();
  g.greet('world');
}
`,
    });

    bindExtractionContext(root, mockArktsQueries() as never);

    const fileResult = new ArkTSExtractor('sample.ets', '').extract();
    expect(fileResult.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(fileResult.nodes.some((n) => n.name === 'Greeter' && n.kind === 'class')).toBe(true);
    expect(fileResult.nodes.some((n) => n.name === 'greet' && n.kind === 'method')).toBe(true);
    expect(fileResult.nodes.some((n) => n.name === 'main' && n.kind === 'function')).toBe(true);

    const calls = fileResult.edges.filter((e) => e.kind === 'calls');
    expect(calls.length).toBeGreaterThan(0);
    expect(isArkTSBatchPersisted('sample.ets')).toBe(true);
  });

  it('indexes co-located .ts files via Scene batch', () => {
    const root = makeArktsProject({
      'anchor.ets': 'export {}',
      'index.ts': 'export function util() {}',
    });
    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('index.ts', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.nodes.some((n) => n.name === 'util' && n.kind === 'function')).toBe(true);
    expect(isArkTSBatchPersisted('index.ts')).toBe(true);
  });

  it('indexes .d.ts declaration files via Scene batch', () => {
    const root = makeArktsProject({
      'anchor.ets': 'export {}',
      'sdk.d.ts': 'export declare function sdkFn(): void;',
    });
    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('sdk.d.ts', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.nodes.some((n) => n.name === 'sdkFn' && n.kind === 'function')).toBe(true);
    expect(isArkTSBatchPersisted('sdk.d.ts')).toBe(true);
  });

  it('returns empty when the project has no ArkAnalyzer sources', () => {
    const root = makeArktsProject({
      'index.js': 'export function util() {}',
    });
    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('index.js', '').extract();
    expect(result.nodes).toHaveLength(0);
  });

  it('emits unresolved native NAPI call refs from method bodies', () => {
    const root = makeArktsProject({
      'Asset.ets': `
import sdk from './native';

export class Asset {
  setCropRect(left: number, top: number): boolean {
    return sdk.Asset_setCropRect(left, top);
  }
}
`,
    });

    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('Asset.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(
      result.unresolvedReferences.some(
        (r) => r.referenceName === 'Asset_setCropRect' && r.referenceKind === 'calls'
      )
    ).toBe(true);
  });
});
