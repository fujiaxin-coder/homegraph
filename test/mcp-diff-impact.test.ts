/**
 * Unit tests for unified-diff parsing + changed-symbol selection +
 * homegraph_diff_impact MCP tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import type { Edge, Node } from '../src/types';
import {
  parseUnifiedDiff,
  normalizeDiffFilePath,
  mergeRanges,
  selectChangedSymbols,
  buildDiffImpactPack,
  resolveDiffImpactHunks,
  DIFF_IMPACT_MAX_DIFF_CHARS,
  type DiffImpactGraph,
} from '../src/mcp/diff-impact';

describe('normalizeDiffFilePath', () => {
  it('strips a/ b/ prefixes and tabs', () => {
    expect(normalizeDiffFilePath('b/src/auth.ts')).toBe('src/auth.ts');
    expect(normalizeDiffFilePath('a/src/auth.ts\t2024-01-01')).toBe('src/auth.ts');
    expect(normalizeDiffFilePath('/dev/null')).toBe('');
  });
});

describe('parseUnifiedDiff', () => {
  it('extracts new-side line ranges per file', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -10,3 +10,4 @@',
      ' unchanged',
      '+export function authenticate() {}',
      ' unchanged',
      '@@ -40,2 +41,2 @@',
      '-old',
      '+new',
    ].join('\n');

    const { hunks } = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.path).toBe('src/auth.ts');
    expect(hunks[0]!.ranges).toEqual([
      { startLine: 10, endLine: 13 },
      { startLine: 41, endLine: 42 },
    ]);
  });

  it('merges adjacent ranges', () => {
    expect(
      mergeRanges([
        { startLine: 1, endLine: 3 },
        { startLine: 4, endLine: 5 },
        { startLine: 10, endLine: 11 },
      ]),
    ).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 10, endLine: 11 },
    ]);
  });

  it('lists pure-deletion files with empty ranges', () => {
    const diff2 = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      '--- a/src/gone.ts',
      '+++ b/src/gone.ts',
      '@@ -1,2 +0,0 @@',
      '-line1',
      '-line2',
    ].join('\n');
    const { hunks } = parseUnifiedDiff(diff2);
    expect(hunks[0]!.path).toBe('src/gone.ts');
    expect(hunks[0]!.ranges).toEqual([]);
  });
});

describe('selectChangedSymbols', () => {
  function node(partial: Partial<Node> & Pick<Node, 'id' | 'name' | 'kind' | 'startLine' | 'endLine'>): Node {
    return {
      qualifiedName: partial.name,
      filePath: 'src/a.ts',
      language: 'typescript',
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
      ...partial,
    } as Node;
  }

  it('keeps only symbols intersecting changed lines', () => {
    const nodes = [
      node({ id: '1', name: 'alpha', kind: 'function', startLine: 1, endLine: 5 }),
      node({ id: '2', name: 'beta', kind: 'function', startLine: 20, endLine: 30 }),
      node({ id: '3', name: 'gamma', kind: 'function', startLine: 25, endLine: 28 }),
      node({ id: '4', name: 'imp', kind: 'import', startLine: 22, endLine: 22 }),
    ];
    const { symbols } = selectChangedSymbols(
      new Map([['src/a.ts', nodes]]),
      [{ path: 'src/a.ts', ranges: [{ startLine: 24, endLine: 26 }] }],
    );
    const names = symbols.map((s) => s.name).sort();
    expect(names).toEqual(['beta', 'gamma']);
  });

  it('does not return every symbol in the file', () => {
    const nodes = Array.from({ length: 20 }, (_, i) =>
      node({
        id: String(i),
        name: `fn${i}`,
        kind: 'function',
        startLine: i * 10 + 1,
        endLine: i * 10 + 5,
      }),
    );
    const { symbols } = selectChangedSymbols(
      new Map([['src/a.ts', nodes]]),
      [{ path: 'src/a.ts', ranges: [{ startLine: 51, endLine: 53 }] }],
    );
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('fn5');
  });
});

describe('resolveDiffImpactHunks', () => {
  it('accepts explicit hunks', () => {
    const { hunks, error } = resolveDiffImpactHunks({
      hunks: [{ path: 'src/a.ts', startLine: 10, endLine: 12 }],
    });
    expect(error).toBeUndefined();
    expect(hunks[0]!.ranges[0]).toEqual({ startLine: 10, endLine: 12 });
  });

  it('rejects oversize diff', () => {
    const { error } = resolveDiffImpactHunks({
      diff: 'x'.repeat(DIFF_IMPACT_MAX_DIFF_CHARS + 1),
    });
    expect(error).toMatch(/maximum length/i);
  });

  it('errors when neither diff nor hunks provided', () => {
    const { error } = resolveDiffImpactHunks({});
    expect(error).toMatch(/diff|hunks/i);
  });
});

describe('buildDiffImpactPack', () => {
  it('limits callers/impact to changed symbols only', () => {
    const changed: Node = {
      id: 'fn-changed',
      name: 'changed',
      kind: 'function',
      qualifiedName: 'changed',
      filePath: 'src/a.ts',
      language: 'typescript',
      startLine: 10,
      endLine: 15,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const other: Node = {
      id: 'fn-other',
      name: 'other',
      kind: 'function',
      qualifiedName: 'other',
      filePath: 'src/a.ts',
      language: 'typescript',
      startLine: 100,
      endLine: 110,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const caller: Node = {
      id: 'fn-caller',
      name: 'caller',
      kind: 'function',
      qualifiedName: 'caller',
      filePath: 'src/b.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 5,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };

    const graph: DiffImpactGraph = {
      getNodesInFile: () => [changed, other],
      getCallers: (id) =>
        id === 'fn-changed'
          ? [{ node: caller, edge: { id: 1, source: caller.id, target: id, kind: 'calls', line: 2 } as Edge }]
          : [],
      getImpactRadius: (id) =>
        id === 'fn-changed'
          ? { nodes: new Map([[caller.id, caller], [id, changed]]) }
          : { nodes: new Map() },
      getOutgoingEdges: () => [],
      getIncomingEdges: () => [],
      getNode: (id) => (id === caller.id ? caller : id === changed.id ? changed : null),
    };

    const pack = buildDiffImpactPack(
      graph,
      [{ path: 'src/a.ts', ranges: [{ startLine: 12, endLine: 14 }] }],
      { depth: 2 },
    );

    expect(pack.changedSymbols.map((s) => s.name)).toEqual(['changed']);
    expect(pack.callers).toEqual([
      { symbol: 'changed', callerName: 'caller', callerFile: 'src/b.ts', line: 2 },
    ]);
    expect(pack.impactSummary[0]!.affectedCount).toBe(1);
    expect(pack.impactSummary[0]!.sampleNames).toContain('caller');
  });

  it('includes UI edges touching changed symbols', () => {
    const page: Node = {
      id: 'page',
      name: 'Page',
      kind: 'component',
      qualifiedName: 'Page',
      filePath: 'src/Page.ets',
      language: 'arkts',
      startLine: 1,
      endLine: 40,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const child: Node = {
      id: 'child',
      name: 'Child',
      kind: 'component',
      qualifiedName: 'Child',
      filePath: 'src/Child.ets',
      language: 'arkts',
      startLine: 1,
      endLine: 20,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const uiEdge: Edge = {
      id: 9,
      source: 'page',
      target: 'child',
      kind: 'references',
      provenance: 'heuristic',
      line: 12,
      metadata: { synthesizedBy: 'viewtree', via: 'child-component' },
    };

    const graph: DiffImpactGraph = {
      getNodesInFile: (f) => (f === 'src/Page.ets' ? [page] : []),
      getCallers: () => [],
      getImpactRadius: () => ({ nodes: new Map([[page.id, page]]) }),
      getOutgoingEdges: (id) => (id === 'page' ? [uiEdge] : []),
      getIncomingEdges: () => [],
      getNode: (id) => (id === 'page' ? page : id === 'child' ? child : null),
    };

    const pack = buildDiffImpactPack(
      graph,
      [{ path: 'src/Page.ets', ranges: [{ startLine: 10, endLine: 15 }] }],
    );
    expect(pack.uiEdges).toHaveLength(1);
    expect(pack.uiEdges[0]!.synthesizedBy).toBe('viewtree');
    expect(pack.uiEdges[0]!.via).toBe('child-component');
  });
});

describe('homegraph_diff_impact MCP tool', () => {
  let tempDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-diff-impact-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'math.ts'),
      [
        'export function untouched(): number { return 0; }',
        '',
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export function mul(a: number, b: number): number {',
        '  return a * b;',
        '}',
        '',
        'export function useAdd(): number {',
        '  return add(1, 2);',
        '}',
        '',
      ].join('\n'),
    );
    cg = await HomeGraph.init(tempDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('is registered in the tools list', () => {
    expect(tools.some((t) => t.name === 'homegraph_diff_impact')).toBe(true);
  });

  it('missing diff/hunks is success-shaped guidance', async () => {
    const res = await handler.execute('homegraph_diff_impact', {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/diff|hunks/i);
    expect(res.content[0]!.text).toMatch(/fix the arguments and retry/i);
  });

  it('intersects hunks with symbols — not whole-file dump', async () => {
    const indexed = cg.getNodesInFile('src/math.ts');
    const addNode = indexed.find((n) => n.name === 'add');
    expect(addNode, `nodes=${indexed.map((n) => `${n.name}@${n.startLine}-${n.endLine}`).join(',')}`).toBeTruthy();

    const res = await handler.execute('homegraph_diff_impact', {
      hunks: [{ path: 'src/math.ts', startLine: addNode!.startLine, endLine: addNode!.endLine }],
      depth: 2,
    });
    if (res.isError) {
      throw new Error(`unexpected isError: ${res.content[0]?.text}`);
    }
    const body = JSON.parse(res.content[0]!.text) as {
      changedSymbols: Array<{ name: string }>;
      callers: Array<{ symbol: string; callerName: string }>;
    };
    const names = body.changedSymbols.map((s) => s.name);
    expect(names).toContain('add');
    expect(names).not.toContain('mul');
    expect(names).not.toContain('untouched');
    expect(body.callers.some((c) => c.symbol === 'add' && c.callerName === 'useAdd')).toBe(true);
  });

  it('accepts a unified diff string', async () => {
    const addNode = cg.getNodesInFile('src/math.ts').find((n) => n.name === 'add');
    expect(addNode).toBeTruthy();
    const start = addNode!.startLine;
    const end = addNode!.endLine;
    const count = end - start + 1;
    const diff = [
      'diff --git a/src/math.ts b/src/math.ts',
      '--- a/src/math.ts',
      '+++ b/src/math.ts',
      `@@ -${start},${count} +${start},${count} @@`,
      ' export function add(a: number, b: number): number {',
      '-  return a + b;',
      '+  return a + b + 0;',
      ' }',
    ].join('\n');

    const res = await handler.execute('homegraph_diff_impact', { diff });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0]!.text) as {
      changedFiles: string[];
      changedSymbols: Array<{ name: string }>;
    };
    expect(body.changedFiles).toContain('src/math.ts');
    expect(body.changedSymbols.some((s) => s.name === 'add')).toBe(true);
  });
});
