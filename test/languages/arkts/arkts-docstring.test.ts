import { afterEach, describe, expect, it } from 'vitest';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import { cleanupArktsProjects, makeArktsProject, mockArktsQueries, nodeByName } from './helpers';

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

describe('languages/arkts docstring (Spec 0020)', () => {
  it('stores JSDoc / leading comments on component, field, and method nodes', () => {
    const root = makeArktsProject({
      'DocsPage.ets': `
/**
 * Entry page that hosts the countdown widget.
 */
@Entry
@Component
struct DocsPage {
  /** Remaining nuggets before the attempt ends. */
  @State count: number = 3

  /**
   * Rebuilds the countdown label after a state change.
   */
  private refreshLabel(): void {
  }

  build() {
    Text(\`\${this.count}\`)
  }
}
`,
    });
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('DocsPage.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const page =
      nodeByName(result.nodes, 'DocsPage', 'component') ??
      nodeByName(result.nodes, 'DocsPage', 'struct');
    expect(page).toBeDefined();
    expect(page!.docstring).toMatch(/Entry page that hosts the countdown widget/i);

    // ArkAnalyzer may also emit a synthetic property named `count` on an anon
    // class that inherits the file/struct leading comment — pick the real field.
    const count = result.nodes.find(
      (n) =>
        n.name === 'count' &&
        (n.kind === 'property' || n.kind === 'field') &&
        /Remaining nuggets/i.test(n.docstring ?? '')
    );
    expect(count).toBeDefined();

    const refresh = nodeByName(result.nodes, 'refreshLabel', 'method');
    expect(refresh).toBeDefined();
    expect(refresh!.docstring).toMatch(/Rebuilds the countdown label/i);
  });

  it('stores // line comments preceding a function', () => {
    const root = makeArktsProject({
      'util.ets': `
// Adds one to the countdown seed.
export function bump(n: number): number {
  return n + 1
}
`,
    });
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('util.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const bump = nodeByName(result.nodes, 'bump', 'function');
    expect(bump).toBeDefined();
    expect(bump!.docstring).toMatch(/Adds one to the countdown seed/i);
  });
});
