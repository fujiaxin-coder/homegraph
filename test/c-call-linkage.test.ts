/**
 * Spec 0056 — a C call does not bind another file's static, and a definition
 * compiled only when an unset flag is on yields to the definition the default
 * build compiles.
 */
import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import { matchByExactName } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

function fn(partial: Pick<Node, 'id' | 'name' | 'filePath' | 'startLine'>): Node {
  return {
    ...partial,
    kind: 'function',
    language: 'c',
    qualifiedName: partial.name,
    endLine: partial.startLine,
    startColumn: 0,
    endColumn: 1,
  } as Node;
}

function context(files: Record<string, string>, nodes: Node[]): ResolutionContext {
  return {
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: () => [],
    readFile: (f: string) => files[f] ?? null,
    getFileLines: (f: string) => files[f]?.split('\n') ?? null,
    fileExists: (f: string) => f in files,
    getAllFiles: () => Object.keys(files),
    getProjectRoot: () => '',
    getNodesByKind: () => [],
    getNodesInFile: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  } as unknown as ResolutionContext;
}

const call = (filePath: string, line: number): UnresolvedRef => ({
  fromNodeId: 'caller',
  referenceName: 'mstime',
  referenceKind: 'calls',
  line,
  column: 1,
  filePath,
  language: 'c',
});

describe('Spec 0056 C call linkage', () => {
  it('reaches the non-static definition past another file\'s static copy', () => {
    const files = {
      'server.c': 'void serve(void) { mstime(); }\n',
      'util.c': 'static int mstime(void) { return 1; }\n',
      'time.c': 'int mstime(void) { return 2; }\n',
    };
    const nodes = [
      fn({ id: 'static', name: 'mstime', filePath: 'util.c', startLine: 1 }),
      fn({ id: 'extern', name: 'mstime', filePath: 'time.c', startLine: 1 }),
    ];
    const resolved = matchByExactName(call('server.c', 1), context(files, nodes));
    expect(resolved?.targetNodeId).toBe('extern');
  });

  it('keeps a static definition in the call\'s own file', () => {
    const files = {
      'quicklist.c': '#ifdef REDIS_TEST\nstatic int mstime(void) { return 1; }\nint test(void) { return mstime(); }\n#endif\n',
      'time.c': 'int mstime(void) { return 2; }\n',
    };
    const nodes = [
      fn({ id: 'own', name: 'mstime', filePath: 'quicklist.c', startLine: 2 }),
      fn({ id: 'extern', name: 'mstime', filePath: 'time.c', startLine: 1 }),
    ];
    const resolved = matchByExactName(call('quicklist.c', 3), context(files, nodes));
    expect(resolved?.targetNodeId).toBe('own');
  });

  it('lets an ifdef nobody sets yield to the compiled source file', () => {
    const files = {
      'fpconv.h': '#ifdef USE_INTERNAL_FPCONV\nvoid fpconv_init(void) {}\n#endif\n',
      'fpconv.c': 'void fpconv_init(void) {}\n',
      'lua_cjson.c': 'void init(void) { fpconv_init(); }\n',
    };
    const nodes = [
      fn({ id: 'header', name: 'fpconv_init', filePath: 'fpconv.h', startLine: 2 }),
      fn({ id: 'source', name: 'fpconv_init', filePath: 'fpconv.c', startLine: 1 }),
    ].map((n) => ({ ...n, name: 'fpconv_init', qualifiedName: 'fpconv_init' }));
    const resolved = matchByExactName(
      { ...call('lua_cjson.c', 1), referenceName: 'fpconv_init' },
      context(files, nodes),
    );
    expect(resolved?.targetNodeId).toBe('source');
  });

  it('does not apply the C linkage rule to ArkTS', () => {
    const files = { 'a.ets': 'function mstime() {}\n', 'b.ets': 'function mstime() {}\n' };
    const nodes = [
      { ...fn({ id: 'a', name: 'mstime', filePath: 'a.ets', startLine: 1 }), language: 'arkts' as const },
      { ...fn({ id: 'b', name: 'mstime', filePath: 'b.ets', startLine: 1 }), language: 'arkts' as const },
    ];
    const resolved = matchByExactName(
      { ...call('c.ets', 1), language: 'arkts' },
      context(files, nodes),
    );
    expect(resolved?.targetNodeId).toBeDefined();
    expect(['a', 'b']).toContain(resolved?.targetNodeId);
  });
});
