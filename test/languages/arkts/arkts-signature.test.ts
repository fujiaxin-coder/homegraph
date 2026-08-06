import { afterEach, describe, expect, it } from 'vitest';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import {
  ArkTSExtractor,
  buildArkMethodSignatureFields,
  normalizeArktsReturnType,
  resetArkTSBatch,
} from '../../../src/extraction/languages/arkts';
import { buildSceneConfigFromProject, Scene } from 'arkanalyzer';
import { cleanupArktsProjects, makeArktsProject, mockArktsQueries, nodeByName } from './helpers';

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

function extractNodes(source: string) {
  const root = makeArktsProject({ 'Sig.ets': source });
  bindExtractionContext(root, mockArktsQueries() as never);
  const result = new ArkTSExtractor('Sig.ets', '').extract();
  expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
  return result.nodes;
}

function methodFromScene(root: string, className: string, methodName: string) {
  const scene = new Scene();
  scene.buildSceneFromProjectDir(
    buildSceneConfigFromProject(root, process.env.OHOS_SDK_HOME, {
      supportFileExts: ['.ets'],
      enableMethodBodyBuild: true,
    })
  );
  scene.inferTypes();
  for (const f of scene.getFiles()) {
    for (const c of f.getClasses()) {
      if (c.getName() !== className) continue;
      const m = c.getMethodWithName(methodName);
      if (m) return m;
    }
    const m = f.getDefaultClass().getMethodWithName(methodName);
    if (m && methodName !== '%dflt') return m;
  }
  throw new Error(`method not found: ${className}.${methodName}`);
}

describe('languages/arkts signatures', () => {
  it('normalizeArktsReturnType keeps class names and drops primitives', () => {
    expect(normalizeArktsReturnType('void')).toBeUndefined();
    expect(normalizeArktsReturnType('string')).toBeUndefined();
    expect(normalizeArktsReturnType('Greeter')).toBe('Greeter');
    expect(normalizeArktsReturnType('Promise<UserProfile>')).toBe('UserProfile');
    expect(normalizeArktsReturnType('ohos.app.Ability')).toBe('Ability');
  });

  it('stores named params, return type, and no return_type for void methods', () => {
    const nodes = extractNodes(`
export class Greeter {
  greet(name: string): string {
    return name;
  }
}
`);
    const greet = nodeByName(nodes, 'greet', 'method');
    expect(greet?.signature).toBe('greet(name: string): string');
    expect(greet?.returnType).toBeUndefined();
    expect(greet?.signature).not.toContain('@');
  });

  it('stores return_type for class-returning methods', () => {
    const nodes = extractNodes(`
export class Widget {}
export class Factory {
  build(): Widget {
    return new Widget();
  }
}
`);
    const build = nodeByName(nodes, 'build', 'method');
    expect(build?.signature).toBe('build(): Widget');
    expect(build?.returnType).toBe('Widget');
  });

  it('joins interface overloads with newline (canonical first)', () => {
    const nodes = extractNodes(`
export interface Handler {
  onClick(event: ClickEvent): void;
  onClick(id: string, event: ClickEvent): void;
}
`);
    const onClick = nodeByName(nodes, 'onClick', 'method');
    expect(onClick?.signature?.split('\n')).toEqual([
      'onClick(ClickEvent): void',
      'onClick(string, ClickEvent): void',
    ]);
    expect(onClick?.returnType).toBeUndefined();
  });

  it('joins declare-function overloads with newline', () => {
    const nodes = extractNodes(`
export declare function sdkFn(x: number): void;
export declare function sdkFn(x: string): void;
`);
    const sdkFn = nodeByName(nodes, 'sdkFn', 'function');
    expect(sdkFn?.signature?.split('\n')).toEqual([
      'sdkFn(number): void',
      'sdkFn(string): void',
    ]);
  });

  it('buildArkMethodSignatureFields matches indexed nodes for overload fixture', () => {
    const source = `
export interface Handler {
  onClick(event: ClickEvent): void;
  onClick(id: string, event: ClickEvent): void;
}
export class Greeter {
  greet(name: string): string { return name; }
}
`;
    const root = makeArktsProject({ 'Sig.ets': source });
    bindExtractionContext(root, mockArktsQueries() as never);
    const nodes = new ArkTSExtractor('Sig.ets', '').extract().nodes;
    const onClick = nodeByName(nodes, 'onClick', 'method')!;
    const greet = nodeByName(nodes, 'greet', 'method')!;

    const onClickFields = buildArkMethodSignatureFields(
      methodFromScene(root, 'Handler', 'onClick')
    );
    const greetFields = buildArkMethodSignatureFields(
      methodFromScene(root, 'Greeter', 'greet')
    );

    expect(onClickFields.signature).toBe(onClick.signature);
    expect(greetFields.signature).toBe(greet.signature);
    expect(greetFields.returnType).toBe(greet.returnType);
  });
});
