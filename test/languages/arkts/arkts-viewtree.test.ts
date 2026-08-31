import { afterEach, describe, expect, it } from 'vitest';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import type { Edge, Node } from '../../../src/types';
import { cleanupArktsProjects, makeArktsProject, mockArktsQueries, nodeByName } from './helpers';

const PARENT_CHILD_FIXTURE = {
  'ParentPage.ets': `
@Entry
@Component
struct ParentPage {
  @State countDownStartValue: number = 10
  build() {
    Column() {
      Button() {
        Text('+1')
      }.onClick(() => {
        this.countDownStartValue += 1
      })
      CountDownComponent({ count: this.countDownStartValue, costOfOneAttempt: 2 })
    }
  }
}

@Component
struct CountDownComponent {
  @Prop count: number
  private costOfOneAttempt: number
  build() {
    Column() {
      Text(\`You have \${this.count} Nuggets left\`)
    }
  }
}
`,
};

const NESTED_COMPONENT_FIXTURE = {
  'CommonTest.ets': `
@Component
struct SubComponent {
  build() {
    Column() {
      Text('Inner Text')
    }
  }
}

@Component
struct CommonTest {
  build() {
    SubComponent()
      .id('sub_comp_id')
      .width(100)
      .height(200)
  }
}
`,
};

function viewTreeEdges(edges: Edge[]): Edge[] {
  return edges.filter((e) => e.metadata?.synthesizedBy === 'viewtree');
}

function edgeBetween(
  edges: Edge[],
  fromName: string,
  toName: string,
  nodes: Node[],
  via?: string
): Edge | undefined {
  const fromIds = new Set(nodes.filter((n) => n.name === fromName).map((n) => n.id));
  const toIds = new Set(nodes.filter((n) => n.name === toName).map((n) => n.id));
  return viewTreeEdges(edges).find(
    (e) =>
      fromIds.has(e.source) &&
      toIds.has(e.target) &&
      (via === undefined || e.metadata?.via === via)
  );
}

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

describe('languages/arkts viewtree', () => {
  it('links build to embedded custom components from ViewTree', () => {
    const root = makeArktsProject(NESTED_COMPONENT_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('CommonTest.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const build = nodeByName(result.nodes, 'build', 'method');
    const sub = nodeByName(result.nodes, 'SubComponent', 'component') ??
      nodeByName(result.nodes, 'SubComponent', 'struct');
    expect(build).toBeDefined();
    expect(sub).toBeDefined();

    expect(
      edgeBetween(result.edges, 'build', 'SubComponent', result.nodes, 'child-component')
    ).toBeDefined();
  });

  it('stores ArkUI .id() on the custom component node (Spec 0019)', () => {
    const root = makeArktsProject(NESTED_COMPONENT_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('CommonTest.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const sub = nodeByName(result.nodes, 'SubComponent', 'component');
    expect(sub).toBeDefined();
    expect(sub!.arkuiId).toBe('sub_comp_id');
  });

  it('links build to onClick handlers and state fields to build', () => {
    const root = makeArktsProject(PARENT_CHILD_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('ParentPage.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const build = nodeByName(result.nodes, 'build', 'method');
    expect(build).toBeDefined();

    const onClickEdges = viewTreeEdges(result.edges).filter(
      (e) => e.source === build!.id && e.metadata?.via === 'onClick'
    );
    expect(onClickEdges.length).toBeGreaterThan(0);
    const handlerNode = result.nodes.find((n) => n.id === onClickEdges[0]!.target);
    expect(handlerNode?.kind).toBe('method');

    const stateField =
      nodeByName(result.nodes, 'countDownStartValue', 'property') ??
      nodeByName(result.nodes, 'countDownStartValue', 'field');
    expect(stateField).toBeDefined();
    expect(
      edgeBetween(result.edges, 'countDownStartValue', 'build', result.nodes, 'state-binding')
    ).toBeDefined();
  });

  it('links parent state to child @Prop via ViewTree prop transfer', () => {
    const root = makeArktsProject(PARENT_CHILD_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('ParentPage.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    expect(
      edgeBetween(result.edges, 'countDownStartValue', 'count', result.nodes, 'Prop')
    ).toBeDefined();

    expect(
      edgeBetween(result.edges, 'build', 'CountDownComponent', result.nodes, 'child-component')
    ).toBeDefined();
  });
});
