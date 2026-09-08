import { afterEach, describe, expect, it } from 'vitest';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import { cleanupArktsProjects, makeArktsProject, mockArktsQueries, nodeByName } from './helpers';

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

function anonClassNodes(nodes: { kind: string; name: string }[]) {
  return nodes.filter(
    (n) =>
      n.kind === 'class' &&
      (n.name.includes('$anon') || n.name.startsWith('%AC') || n.name.startsWith('<'))
  );
}

describe('languages/arkts ClassCategory alignment (Spec 0026)', () => {
  it('does not index object literals or type literals as class nodes', () => {
    const root = makeArktsProject({
      'Shapes.ets': `
export type Point = { x: number; y: number }

export class Holder {
  static cfg = { i: 1, label: 'n' }
}
`,
    });
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('Shapes.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    expect(nodeByName(result.nodes, 'Holder', 'class')).toBeDefined();
    expect(nodeByName(result.nodes, 'cfg', 'property')).toBeDefined();
    // type alias may be present; the TYPE_LITERAL shape must not become a class
    expect(anonClassNodes(result.nodes)).toEqual([]);
    expect(result.nodes.filter((n) => n.kind === 'class').map((n) => n.name)).toEqual(['Holder']);
  });

  it('still indexes a real named class beside object-literal initializers', () => {
    const root = makeArktsProject({
      'Anim.ets': `
export class Animator {
  static STANDARD = { opacity: 0.5 }
}
`,
    });
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('Anim.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(nodeByName(result.nodes, 'Animator', 'class')).toBeDefined();
    expect(nodeByName(result.nodes, 'STANDARD', 'property')).toBeDefined();
    expect(anonClassNodes(result.nodes)).toEqual([]);
  });
});
