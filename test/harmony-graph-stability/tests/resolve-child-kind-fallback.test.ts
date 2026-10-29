/**
 * P1 — resolveChild name-miss → getNodesByKind full-table fallback.
 * Desired: miss returns null (or O(1) side index); no kind scans per miss.
 * Production fix deferred — this test documents the contract and fails today.
 */
import { describe, expect, it } from 'vitest';
import type { Node } from '../../../src/types';
import type { ResolutionContext } from '../../../src/resolution/types';
import { arkuiChildComponentEdges } from '../../../src/resolution/callback-synthesizer';

function node(partial: Partial<Node> & Pick<Node, 'id' | 'name' | 'kind' | 'filePath'>): Node {
  return {
    qualifiedName: partial.name,
    startLine: 1,
    endLine: 20,
    startColumn: 0,
    endColumn: 0,
    language: 'arkts',
    confidence: 1,
    ...partial,
  };
}

describe('P1 resolveChild kind-scan on name miss', () => {
  it('does not call getNodesByKind when PascalCase framework names miss the name index', async () => {
    const child = node({
      id: 'struct:Child',
      name: 'Child',
      kind: 'struct',
      filePath: 'pages/Host.ets',
      decorators: ['Component'],
      startLine: 1,
      endLine: 30,
    });
    const build = node({
      id: 'method:build',
      name: 'build',
      kind: 'method',
      filePath: 'pages/Host.ets',
      qualifiedName: 'Host::build',
      startLine: 5,
      endLine: 25,
    });
    const host = node({
      id: 'struct:Host',
      name: 'Host',
      kind: 'struct',
      filePath: 'pages/Host.ets',
      decorators: ['Component', 'Entry'],
      startLine: 1,
      endLine: 30,
    });
    const all = [host, child, build];
    const byName = new Map<string, Node[]>([
      ['Child', [child]],
      ['Host', [host]],
      ['build', [build]],
    ]);
    // Column / Button / Text intentionally absent from name index (framework).
    const kindCalls: string[] = [];
    const src = `
@Component
struct Host {
  build() {
    Column() {
      Button('x')
      Text('y')
      Child()
    }
  }
}
`;
    const ctx: ResolutionContext = {
      getNodesInFile: (f) => all.filter((n) => n.filePath === f),
      getNodesByName: (n) => byName.get(n) ?? [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: (k) => {
        kindCalls.push(k);
        return all.filter((n) => n.kind === k);
      },
      fileExists: () => true,
      readFile: () => src,
      getProjectRoot: () => '/tmp',
      getAllFiles: () => ['pages/Host.ets'],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    await arkuiChildComponentEdges(ctx, async () => {});

    const fallbackKinds = kindCalls.filter((k) =>
      k === 'struct' || k === 'component' || k === 'function' || k === 'method'
    );
    // Contract after fix: name-miss must not full-scan kinds (Column/Button/Text).
    expect(fallbackKinds).toEqual([]);
  });
});
