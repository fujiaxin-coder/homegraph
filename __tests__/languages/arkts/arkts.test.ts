import { afterEach, describe, expect, it } from 'vitest';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import { detectLanguage, isArkModuleJson5, isSourceFile } from '../../../src/extraction/grammars';
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
  });

  it('returns empty when the project has no .ets files', () => {
    const root = makeArktsProject({
      'index.ts': 'export function util() {}',
    });
    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('index.ts', '').extract();
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
