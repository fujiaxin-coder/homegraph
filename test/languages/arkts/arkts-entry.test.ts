import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import type { Edge, Node } from '../../../src/types';
import {
  cleanupArktsProjects,
  ENTRY_FIXTURE,
  hasEdgePath,
  makeArktsProject,
  mockArktsQueries,
  nodeByName,
} from './helpers';

function allEdges(cg: HomeGraph): Edge[] {
  const edges: Edge[] = [];
  for (const n of cg.getNodesByKind('method')) {
    edges.push(...cg.getOutgoingEdges(n.id));
  }
  for (const n of cg.getNodesByKind('function')) {
    edges.push(...cg.getOutgoingEdges(n.id));
  }
  for (const n of cg.getNodesByKind('class')) {
    edges.push(...cg.getOutgoingEdges(n.id));
  }
  for (const n of cg.getNodesByKind('route')) {
    edges.push(...cg.getOutgoingEdges(n.id));
  }
  return edges;
}

function nodeMap(cg: HomeGraph): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const kind of ['file', 'class', 'component', 'method', 'function', 'route'] as const) {
    for (const n of cg.getNodesByKind(kind)) {
      map.set(n.id, n);
    }
  }
  return map;
}

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

describe('languages/arkts entry tracing', () => {
  it('uses DummyMain RTA to reach Ability and Component lifecycle methods', () => {
    const root = makeArktsProject(ENTRY_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);

    const index = new ArkTSExtractor('src/main/ets/pages/Index.ets', '').extract();
    expect(index.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const calls = index.edges.filter((e) => e.kind === 'calls');
    const aboutToAppear = nodeByName(index.nodes, 'aboutToAppear', 'method');
    expect(aboutToAppear).toBeDefined();
    expect(calls.some((e) => e.target === aboutToAppear!.id)).toBe(true);
  });

  it('extracts module.json5 page routes and links them to the @Entry component', async () => {
    const root = makeArktsProject(ENTRY_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    const pageRoute = routes.find((r) => r.name === 'pages/Index');
    expect(pageRoute).toBeDefined();

    const indexComponent =
      cg.getNodesByKind('component').find((n) => n.name === 'Index') ??
      cg.getNodesByKind('class').find((n) => n.name === 'Index');
    expect(indexComponent).toBeDefined();

    const routeEdges = cg.getOutgoingEdges(pageRoute!.id);
    expect(routeEdges.some((e) => e.target === indexComponent!.id && e.kind === 'references')).toBe(
      true
    );

    cg.close();
  });

  it('traces startup from onWindowStageCreate through first-screen lifecycle to build', async () => {
    const root = makeArktsProject(ENTRY_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();

    const edges = allEdges(cg);
    const byId = nodeMap(cg);

    expect(
      hasEdgePath(edges, byId, ['onCreate', 'onWindowStageCreate'])
    ).toBe(true);

    expect(
      hasEdgePath(edges, byId, ['onWindowStageCreate', 'aboutToAppear'])
    ).toBe(true);

    expect(
      hasEdgePath(edges, byId, ['aboutToAppear', 'build'])
    ).toBe(true);

    cg.close();
  });
});
