import { afterEach, describe, expect, it } from 'vitest';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import type { Edge, Node } from '../../../src/types';
import { cleanupArktsProjects, makeArktsProject, mockArktsQueries, nodeByName } from './helpers';

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

function anonymousMethodNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => (n.kind === 'method' || n.kind === 'function') && n.name.startsWith('%AM'));
}

function isArkAnalyzerAnonymousName(name: string): boolean {
  return /^%AM\d+/.test(name);
}

function hasCallsPath(edges: Edge[], nodes: Node[], fromName: string, toName: string): boolean {
  const startIds = nodes.filter((n) => n.name === fromName).map((n) => n.id);
  const targetIds = new Set(nodes.filter((n) => n.name === toName).map((n) => n.id));
  if (startIds.length === 0 || targetIds.size === 0) return false;

  const callEdges = edges.filter((e) => e.kind === 'calls');
  const visited = new Set<string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (targetIds.has(id)) return true;
    for (const e of callEdges) {
      if (e.source === id && !visited.has(e.target)) queue.push(e.target);
    }
  }
  return false;
}

const RTA_CALLBACK_FIXTURE = {
  'callbacks.ets': `
export function main(): void {
  invoke(() => {
    finalize();
  });
}

function invoke(fn: () => void): void {
  fn();
}

function finalize(): void {
  console.log('done');
}
`,
};

const DEAD_LAMBDA_FIXTURE = {
  'dead.ets': `
export function main(): void {
  invoke(ready);
}

function invoke(fn: () => void): void {
  fn();
}

function ready(): void {}

function neverCalled(): void {
  const unused = () => {
    orphan();
  };
}

function orphan(): void {}
`,
};

describe('languages/arkts anonymous methods', () => {
  it('lazy-indexes anonymous callbacks for RTA calls edges using %AM names', () => {
    const root = makeArktsProject(RTA_CALLBACK_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('callbacks.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const anonNodes = anonymousMethodNodes(result.nodes);
    expect(anonNodes.length).toBeGreaterThan(0);
    expect(isArkAnalyzerAnonymousName(anonNodes[0]!.name)).toBe(true);
    expect(anonNodes[0]!.qualifiedName).toContain('%AM');

    const finalize = nodeByName(result.nodes, 'finalize', 'function');
    expect(finalize).toBeDefined();

    const rtaCalls = result.edges.filter(
      (e) => e.kind === 'calls' && e.metadata?.synthesizedBy === 'arkanalyzer'
    );
    expect(rtaCalls.length).toBeGreaterThan(0);

    const anon = anonNodes[0]!;
    const anonCallsFinalize = rtaCalls.some(
      (e) => e.source === anon.id && e.target === finalize!.id
    );
    expect(anonCallsFinalize).toBe(true);
    expect(hasCallsPath(result.edges, result.nodes, 'main', 'finalize')).toBe(true);
  });

  it('does not index anonymous lambdas that RTA never reaches', () => {
    const root = makeArktsProject(DEAD_LAMBDA_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('dead.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    expect(anonymousMethodNodes(result.nodes)).toHaveLength(0);
    expect(hasCallsPath(result.edges, result.nodes, 'main', 'ready')).toBe(true);
    expect(nodeByName(result.nodes, 'neverCalled', 'function')).toBeDefined();
  });

  it('reuses the same %AM node for ViewTree and RTA paths', () => {
    const root = makeArktsProject({
      'Page.ets': `
@Entry
@Component
struct Page {
  handle(): void {
    console.log('handled');
  }

  build() {
    Button('Go')
      .onClick(() => {
        this.handle();
      })
  }
}
`,
    });
    bindExtractionContext(root, mockArktsQueries() as never);

    const result = new ArkTSExtractor('Page.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const anonNodes = anonymousMethodNodes(result.nodes);
    expect(anonNodes).toHaveLength(1);
    expect(isArkAnalyzerAnonymousName(anonNodes[0]!.name)).toBe(true);
    expect(anonNodes[0]!.qualifiedName).toContain('Page');

    const onClickEdge = result.edges.find(
      (e) =>
        e.kind === 'references' &&
        e.metadata?.synthesizedBy === 'viewtree' &&
        e.metadata?.via === 'onClick'
    );
    expect(onClickEdge?.target).toBe(anonNodes[0]!.id);

    const rtaToHandle = result.edges.some(
      (e) =>
        e.kind === 'calls' &&
        e.metadata?.synthesizedBy === 'arkanalyzer' &&
        e.source === anonNodes[0]!.id
    );
    expect(rtaToHandle).toBe(true);
  });
});
