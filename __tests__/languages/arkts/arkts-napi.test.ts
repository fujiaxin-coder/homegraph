import { describe, it, expect } from 'vitest';
import type { Node, Language } from '../../../src/types';
import type { ResolutionContext, UnresolvedRef } from '../../../src/resolution/types';
import { arktsNapiResolver } from '../../../src/resolution/frameworks/arkts-napi';

function makeContext(nodes: Node[], fileContents: Record<string, string> = {}): ResolutionContext {
  const byName = new Map<string, Node[]>();
  for (const n of nodes) {
    const arr = byName.get(n.name);
    if (arr) arr.push(n);
    else byName.set(n.name, [n]);
  }
  const allFiles = new Set<string>([...nodes.map((n) => n.filePath), ...Object.keys(fileContents)]);
  return {
    getNodesInFile: (fp) => nodes.filter((n) => n.filePath === fp),
    getNodesByName: (name) => byName.get(name) ?? [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    getNodesByLowerName: () => [],
    fileExists: (fp) => allFiles.has(fp),
    readFile: (fp) => fileContents[fp] ?? null,
    getProjectRoot: () => '/test',
    getAllFiles: () => Array.from(allFiles),
    getImportMappings: () => [],
  };
}

function fn(name: string, filePath: string, startLine = 10): Node {
  return {
    id: `cpp:${filePath}:${name}:${startLine}`,
    kind: 'function',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'cpp',
    startLine,
    endLine: startLine + 8,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  } as Node;
}

function ref(name: string, filePath: string): UnresolvedRef {
  return {
    fromNodeId: `arkts:${filePath}:setCropRect:20`,
    referenceName: name,
    referenceKind: 'calls',
    line: 21,
    column: 0,
    filePath,
    language: 'arkts',
  };
}

const NAPI_ADAPTER = `static napi_value Asset_setCropRect(napi_env env, napi_callback_info info)
{
    JSArguments args(env, info);
    return JSValue(env);
}
static const napi_property_descriptor desc[] = {
    {"Asset_setCropRect", nullptr, Asset_setCropRect, nullptr, nullptr, nullptr, napi_default, nullptr},
};
napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
`;

describe('arktsNapiResolver', () => {
  describe('detect()', () => {
    it('returns true when an .ets file imports a .so library', () => {
      const ctx = makeContext([], {
        'native.ts': `import nativeSo from 'libImageEditor.so';\nexport default nativeSo;`,
      });
      expect(arktsNapiResolver.detect(ctx)).toBe(true);
    });

    it('returns true when a .cpp file registers NAPI properties', () => {
      const ctx = makeContext([], { 'napi_adapter.cpp': NAPI_ADAPTER });
      expect(arktsNapiResolver.detect(ctx)).toBe(true);
    });

    it('returns false for unrelated projects', () => {
      const ctx = makeContext([], { 'index.ts': 'export function main() {}' });
      expect(arktsNapiResolver.detect(ctx)).toBe(false);
    });
  });

  describe('claimsReference()', () => {
    it('claims NAPI symbol names', () => {
      expect(arktsNapiResolver.claimsReference?.('Asset_setCropRect')).toBe(true);
      expect(arktsNapiResolver.claimsReference?.('sdk.Asset_setCropRect')).toBe(true);
    });

    it('does not claim ordinary identifiers', () => {
      expect(arktsNapiResolver.claimsReference?.('setCropRect')).toBe(false);
      expect(arktsNapiResolver.claimsReference?.('greet')).toBe(false);
    });
  });

  describe('extract()', () => {
    it('emits function nodes for NAPI exports', () => {
      const { nodes } = arktsNapiResolver.extract!('napi_adapter.cpp', NAPI_ADAPTER);
      expect(nodes.some((n) => n.name === 'Asset_setCropRect' && n.kind === 'function')).toBe(true);
    });
  });

  describe('resolve()', () => {
    it('bridges ArkTS call refs to the C++ NAPI wrapper', () => {
      const cppNode = fn('Asset_setCropRect', 'napi_adapter.cpp', 522);
      const ctx = makeContext([cppNode], { 'napi_adapter.cpp': NAPI_ADAPTER });
      const result = arktsNapiResolver.resolve(
        ref('Asset_setCropRect', 'service/Asset.ets'),
        ctx
      );
      expect(result?.targetNodeId).toBe(cppNode.id);
      expect(result?.resolvedBy).toBe('framework');
    });

    it('strips a qualified ArkTS receiver before lookup', () => {
      const cppNode = fn('Asset_setCropRect', 'napi_adapter.cpp', 522);
      const ctx = makeContext([cppNode], { 'napi_adapter.cpp': NAPI_ADAPTER });
      const result = arktsNapiResolver.resolve(
        ref('sdk.Asset_setCropRect', 'service/Asset.ets'),
        ctx
      );
      expect(result?.targetNodeId).toBe(cppNode.id);
    });

    it('ignores non-ArkTS callers', () => {
      const cppNode = fn('Asset_setCropRect', 'napi_adapter.cpp');
      const ctx = makeContext([cppNode]);
      const result = arktsNapiResolver.resolve(
        {
          ...ref('Asset_setCropRect', 'napi_adapter.cpp'),
          language: 'cpp' as Language,
        },
        ctx
      );
      expect(result).toBeNull();
    });
  });
});
