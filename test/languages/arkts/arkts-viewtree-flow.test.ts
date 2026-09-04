/**
 * Regression: homegraph_explore Flow must traverse ArkUI ViewTree event bindings
 * (build → .onClick → handler) that extraction already emits as `references` edges.
 * The main Flow BFS historically accepted only `calls`, so the hop surfaced at best
 * in Dynamic-dispatch links and never joined a multi-hop lifecycle→UI chain.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import { ToolHandler } from '../../../src/mcp/tools';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import type { Edge } from '../../../src/types';
import {
  cleanupArktsProjects,
  hasEdgePath,
  makeArktsProject,
  mockArktsQueries,
  nodeByName,
} from './helpers';

const NAMED_HANDLER_FIXTURE = {
  'ParentPage.ets': `
@Entry
@Component
struct ParentPage {
  aboutToAppear(): void {}

  handleClick(): void {
    this.count += 1;
  }

  build() {
    Button('Click')
      .onClick(this.handleClick)
  }
}
`,
};

const LAMBDA_HANDLER_FIXTURE = {
  'ParentPage.ets': `
@Entry
@Component
struct ParentPage {
  handleClick(): void {
    this.count += 1;
  }

  build() {
    Button('Click')
      .onClick(() => {
        this.handleClick()
      })
  }
}
`,
};

function viewTreeEventEdges(edges: Edge[]): Edge[] {
  return edges.filter(
    (e) =>
      e.kind === 'references' &&
      e.metadata?.synthesizedBy === 'viewtree' &&
      e.metadata?.via === 'onClick'
  );
}

function flowEdgeFilter(handler: ToolHandler, edge: Edge): boolean {
  return (handler as unknown as { isExploreFlowEdge(e: Edge): boolean }).isExploreFlowEdge(edge);
}

function synthNote(handler: ToolHandler, edge: Edge): string | undefined {
  return (
    handler as unknown as {
      synthEdgeNote(e: Edge): { compact: string } | null;
    }
  )
    .synthEdgeNote(edge)
    ?.compact;
}

let prevOffloadDisable: string | undefined;
beforeAll(() => {
  prevOffloadDisable = process.env.HOMEGRAPH_OFFLOAD_DISABLE;
  process.env.HOMEGRAPH_OFFLOAD_DISABLE = '1';
});
afterAll(() => {
  if (prevOffloadDisable === undefined) delete process.env.HOMEGRAPH_OFFLOAD_DISABLE;
  else process.env.HOMEGRAPH_OFFLOAD_DISABLE = prevOffloadDisable;
});

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

// ArkTS Scene indexAll is routinely 3–6s on Windows; default 5s testTimeout flakes.
const ARKTS_INDEX_TIMEOUT_MS = 20_000;

describe('languages/arkts viewtree flow', () => {
  let cg: HomeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
  });

  it('indexes build → onClick → lambda handler as a ViewTree references edge', () => {
    const root = makeArktsProject(LAMBDA_HANDLER_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('ParentPage.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const build = nodeByName(result.nodes, 'build', 'method');
    expect(build).toBeDefined();

    const onClickEdges = viewTreeEventEdges(result.edges).filter((e) => e.source === build!.id);
    expect(onClickEdges.length).toBeGreaterThan(0);
    const handlerNode = result.nodes.find((n) => n.id === onClickEdges[0]!.target);
    expect(handlerNode?.kind).toBe('method');
    expect(handlerNode?.name.startsWith('%AM')).toBe(true);
    expect(handlerNode?.qualifiedName).toContain('ParentPage');
  }, ARKTS_INDEX_TIMEOUT_MS);

  it('allows ViewTree onClick references but not structural ViewTree references in Flow BFS', async () => {
    const root = makeArktsProject(LAMBDA_HANDLER_FIXTURE);
    cg = HomeGraph.initSync(root);
    await cg.indexAll();

    const build = nodeByName([...cg.getNodesByKind('method')], 'build', 'method');
    expect(build).toBeDefined();

    const onClickEdge = cg!
      .getOutgoingEdges(build!.id)
      .find((e) => e.metadata?.synthesizedBy === 'viewtree' && e.metadata?.via === 'onClick');
    expect(onClickEdge).toBeDefined();

    const handler = new ToolHandler(cg);
    expect(flowEdgeFilter(handler, onClickEdge!)).toBe(true);
    expect(synthNote(handler, onClickEdge!)).toMatch(/dynamic: ArkUI \.onClick/);

    const structural: Edge = {
      source: 'a',
      target: 'b',
      kind: 'references',
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'viewtree', via: 'child-component' },
    };
    expect(flowEdgeFilter(handler, structural)).toBe(false);
  }, ARKTS_INDEX_TIMEOUT_MS);

  it('connects lifecycle → build → handler in homegraph_explore main Flow', async () => {
    const root = makeArktsProject(NAMED_HANDLER_FIXTURE);
    cg = HomeGraph.initSync(root);
    await cg.indexAll();

    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_explore', {
      query: 'aboutToAppear build handleClick',
    });
    const text = res.content[0]!.text as string;

    expect(text).toContain('**Flow (call path among the symbols you queried)**');
    expect(text).toMatch(/aboutToAppear/);
    expect(text).toMatch(/build/);
    expect(text).toMatch(/handleClick/);
  }, ARKTS_INDEX_TIMEOUT_MS);

  it('labels indexed ViewTree onClick references for Flow output', async () => {
    const root = makeArktsProject(LAMBDA_HANDLER_FIXTURE);
    cg = HomeGraph.initSync(root);
    await cg.indexAll();

    const build = nodeByName([...cg.getNodesByKind('method')], 'build', 'method');
    const onClickEdge = cg!
      .getOutgoingEdges(build!.id)
      .find((e) => e.metadata?.synthesizedBy === 'viewtree' && e.metadata?.via === 'onClick');
    expect(onClickEdge).toBeDefined();

    const handler = new ToolHandler(cg);
    expect(flowEdgeFilter(handler, onClickEdge!)).toBe(true);
    expect(synthNote(handler, onClickEdge!)).toMatch(/dynamic: ArkUI \.onClick/);

    const callback = [...cg!.getNodesByKind('method')].find((n) => n.id === onClickEdge!.target);
    expect(callback?.name.startsWith('%AM')).toBe(true);
    expect(onClickEdge!.metadata?.via).toBe('onClick');
  }, ARKTS_INDEX_TIMEOUT_MS);

  it('does not treat ViewTree child-component references as Flow hops', async () => {
    const root = makeArktsProject({
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
      .width(100)
  }
}
`,
    });
    cg = HomeGraph.initSync(root);
    await cg.indexAll();

    const edges: Edge[] = [];
    for (const n of cg.getNodesByKind('method')) {
      edges.push(...cg.getOutgoingEdges(n.id));
    }
    const byId = new Map([...cg.getNodesByKind('method'), ...cg.getNodesByKind('component')].map((n) => [n.id, n]));

    expect(hasEdgePath(edges, byId, ['build', 'SubComponent'])).toBe(true);

    const childEdge = edges.find((e) => e.metadata?.via === 'child-component');
    expect(childEdge).toBeDefined();

    const handler = new ToolHandler(cg);
    expect(flowEdgeFilter(handler, childEdge!)).toBe(false);

    const res = await handler.execute('homegraph_explore', {
      query: 'CommonTest.build SubComponent',
    });
    const text = res.content[0]!.text as string;

    expect(text).not.toContain('**Flow (call path among the symbols you queried)**');
  }, ARKTS_INDEX_TIMEOUT_MS);
});
