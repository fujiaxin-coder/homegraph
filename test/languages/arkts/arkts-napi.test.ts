import { describe, it, expect } from 'vitest';
import type { Node, Language } from '../../../src/types';
import type { ResolutionContext, UnresolvedRef } from '../../../src/resolution/types';
import {
  arktsNapiResolver,
  parseNapiExports,
  suggestSecondHop,
} from '../../../src/resolution/frameworks/arkts-napi';

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

function fn(name: string, filePath: string, startLine = 10, language: Language = 'cpp'): Node {
  return {
    id: `cpp:${filePath}:${name}:${startLine}`,
    kind: 'function',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language,
    startLine,
    endLine: startLine + 8,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  } as Node;
}

function ref(name: string, filePath: string, language: Language = 'arkts'): UnresolvedRef {
  return {
    fromNodeId: `arkts:${filePath}:caller:20`,
    referenceName: name,
    referenceKind: 'calls',
    line: 21,
    column: 0,
    filePath,
    language,
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

const FLAT_CAMEL = `napi_value PluginManager::NapiDraw(napi_env env, napi_callback_info info);
static napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor desc[] = {
        {"draw", nullptr, PluginManager::NapiDraw, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"finishDraw", nullptr, PluginManager::NapiFinishDraw, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setDirection", nullptr, PluginManager::NapiSetDirection, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}
`;

const DEFINE_CLASS = `void LayoutRotatePacking::AddVerticalRuler(int x) { (void)x; }
napi_value LayoutRotatePacking::NapiAddVerticalRuler(napi_env env, napi_callback_info info)
{
    LayoutRotatePacking *obj = nullptr;
    obj->AddVerticalRuler(0);
    return nullptr;
}
napi_value LayoutRotatePacking::NapiInit(napi_env env, napi_value exports)
{
    napi_property_descriptor properties[] = {
        {"addVerticalRuler", nullptr, LayoutRotatePacking::NapiAddVerticalRuler, nullptr, nullptr, nullptr,
         napi_default, nullptr},
    };
    napi_value cons;
    napi_define_class(env, "LayoutRotatePacking", NAPI_AUTO_LENGTH, LayoutRotatePacking::NapiConstructor, nullptr,
                      sizeof(properties) / sizeof(properties[0]), properties, &cons);
    return exports;
}
`;

const SENDABLE_CLASS = `static napi_value NapiPing(napi_env env, napi_callback_info info) { return nullptr; }
void InitSendable(napi_env env, napi_value exports)
{
    napi_property_descriptor props[] = {
        {"ping", nullptr, NapiPing, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_value cons;
    napi_define_sendable_class(env, "Pingable", NAPI_AUTO_LENGTH, NapiCtor, nullptr,
                               sizeof(props) / sizeof(props[0]), props, &cons);
}
`;

const DECLARE_MACROS = `static napi_value NapiFoo(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value NapiBar(napi_env env, napi_callback_info info) { return nullptr; }
static napi_property_descriptor props[] = {
    DECLARE_NAPI_FUNCTION("foo", NapiFoo),
    DECLARE_NAPI_METHOD("bar", NapiBar),
};
napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
`;

const CREATE_FUNCTION = `static napi_value NapiRun(napi_env env, napi_callback_info info) { return nullptr; }
static napi_value Init(napi_env env, napi_value exports)
{
    napi_value fn;
    napi_create_function(env, "run", NAPI_AUTO_LENGTH, NapiRun, nullptr, &fn);
    napi_set_named_property(env, exports, "run", fn);
    return exports;
}
`;

const MULTIMODAL_C = `napi_value getTidByName(napi_env env, napi_callback_info info) { return NULL; }
napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor desc = {"getTidByName", NULL, getTidByName, NULL, NULL, NULL, napi_default, NULL};
    napi_define_properties(env, exports, 1, &desc);
    return exports;
}
NAPI_MODULE(multimodalinput, Init)
`;

describe('parseNapiExports', () => {
  it('parses Class_method descriptor rows (photos compat)', () => {
    const exps = parseNapiExports(NAPI_ADAPTER);
    expect(exps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jsName: 'Asset_setCropRect', nativeName: 'Asset_setCropRect' }),
      ])
    );
  });

  it('parses camelCase flat descriptors with qualified native symbols', () => {
    const exps = parseNapiExports(FLAT_CAMEL);
    expect(exps.map((e) => e.jsName).sort()).toEqual(['draw', 'finishDraw', 'setDirection']);
    expect(exps.find((e) => e.jsName === 'draw')?.nativeName).toBe('NapiDraw');
  });

  it('parses napi_define_class property rows', () => {
    const exps = parseNapiExports(DEFINE_CLASS);
    expect(exps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jsName: 'addVerticalRuler',
          nativeName: 'NapiAddVerticalRuler',
          kind: 'class',
          className: 'LayoutRotatePacking',
        }),
      ])
    );
  });

  it('parses napi_define_sendable_class the same way', () => {
    const exps = parseNapiExports(SENDABLE_CLASS);
    expect(exps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jsName: 'ping', nativeName: 'NapiPing', kind: 'class' }),
      ])
    );
  });

  it('parses DECLARE_NAPI_FUNCTION / METHOD macros', () => {
    const exps = parseNapiExports(DECLARE_MACROS);
    expect(exps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jsName: 'foo', nativeName: 'NapiFoo' }),
        expect.objectContaining({ jsName: 'bar', nativeName: 'NapiBar' }),
      ])
    );
  });

  it('parses napi_create_function dynamic mounts', () => {
    const exps = parseNapiExports(CREATE_FUNCTION);
    expect(exps).toEqual([expect.objectContaining({ jsName: 'run', nativeName: 'NapiRun', kind: 'flat' })]);
  });

  it('parses NULL (C) descriptor rows', () => {
    const exps = parseNapiExports(MULTIMODAL_C);
    expect(exps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jsName: 'getTidByName', nativeName: 'getTidByName' }),
      ])
    );
  });
});

describe('suggestSecondHop', () => {
  it('strips Napi prefix when a same-file business def exists', () => {
    expect(suggestSecondHop('NapiAddVerticalRuler', DEFINE_CLASS)).toBe('AddVerticalRuler');
  });

  it('returns null when no business def is present', () => {
    expect(suggestSecondHop('NapiDraw', FLAT_CAMEL)).toBeNull();
  });
});

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

    it('returns true for .c NAPI_MODULE registrations', () => {
      const ctx = makeContext([], { 'napi_init.c': MULTIMODAL_C });
      expect(arktsNapiResolver.detect(ctx)).toBe(true);
    });

    it('returns true for create_function-only files', () => {
      const ctx = makeContext([], { 'init.cpp': CREATE_FUNCTION });
      expect(arktsNapiResolver.detect(ctx)).toBe(true);
    });

    it('returns false for unrelated projects', () => {
      const ctx = makeContext([], { 'index.ts': 'export function main() {}' });
      expect(arktsNapiResolver.detect(ctx)).toBe(false);
    });
  });

  describe('claimsReference()', () => {
    it('claims NAPI Class_method symbol names', () => {
      expect(arktsNapiResolver.claimsReference?.('Asset_setCropRect')).toBe(true);
      expect(arktsNapiResolver.claimsReference?.('sdk.Asset_setCropRect')).toBe(true);
    });

    it('does not claim ordinary identifiers (pre-filter via extract nodes)', () => {
      expect(arktsNapiResolver.claimsReference?.('setCropRect')).toBe(false);
      expect(arktsNapiResolver.claimsReference?.('greet')).toBe(false);
      expect(arktsNapiResolver.claimsReference?.('draw')).toBe(false);
    });
  });

  describe('extract()', () => {
    it('emits function nodes for Class_method NAPI exports', () => {
      const { nodes } = arktsNapiResolver.extract!('napi_adapter.cpp', NAPI_ADAPTER);
      expect(nodes.some((n) => n.name === 'Asset_setCropRect' && n.kind === 'function')).toBe(true);
    });

    it('emits jsName nodes for camelCase flat exports', () => {
      const { nodes } = arktsNapiResolver.extract!('napi_init.cpp', FLAT_CAMEL);
      expect(nodes.map((n) => n.name).sort()).toEqual(['draw', 'finishDraw', 'setDirection']);
    });

    it('emits S2 calls refs when Napi* → business naming is safe', () => {
      const { references } = arktsNapiResolver.extract!('layout_rotate_packing.cpp', DEFINE_CLASS);
      expect(references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromNodeId: 'arkts-napi:layout_rotate_packing.cpp:addVerticalRuler',
            referenceName: 'AddVerticalRuler',
            referenceKind: 'calls',
          }),
        ])
      );
    });

    it('extracts from .c files', () => {
      const { nodes } = arktsNapiResolver.extract!('napi_init.c', MULTIMODAL_C);
      expect(nodes.some((n) => n.name === 'getTidByName')).toBe(true);
    });
  });

  describe('resolve()', () => {
    it('bridges ArkTS Class_method refs to the C++ NAPI wrapper', () => {
      const cppNode = fn('Asset_setCropRect', 'napi_adapter.cpp', 522);
      const ctx = makeContext([cppNode], { 'napi_adapter.cpp': NAPI_ADAPTER });
      const result = arktsNapiResolver.resolve(ref('Asset_setCropRect', 'service/Asset.ets'), ctx);
      expect(result?.targetNodeId).toBe(cppNode.id);
      expect(result?.resolvedBy).toBe('framework');
    });

    it('strips a qualified ArkTS receiver before lookup', () => {
      const cppNode = fn('Asset_setCropRect', 'napi_adapter.cpp', 522);
      const ctx = makeContext([cppNode], { 'napi_adapter.cpp': NAPI_ADAPTER });
      const result = arktsNapiResolver.resolve(ref('sdk.Asset_setCropRect', 'service/Asset.ets'), ctx);
      expect(result?.targetNodeId).toBe(cppNode.id);
    });

    it('bridges camelCase flat exports (mattes.draw → NapiDraw)', () => {
      const cppNode = fn('NapiDraw', 'napi_init.cpp', 85);
      const ctx = makeContext([cppNode], { 'napi_init.cpp': FLAT_CAMEL });
      const result = arktsNapiResolver.resolve(ref('mattes.draw', 'pages/ScreenEffectPage.ets'), ctx);
      expect(result?.targetNodeId).toBe(cppNode.id);
    });

    it('bridges define_class instance methods', () => {
      const cppNode = fn('NapiAddVerticalRuler', 'layout_rotate_packing.cpp', 143);
      const ctx = makeContext([cppNode], { 'layout_rotate_packing.cpp': DEFINE_CLASS });
      const result = arktsNapiResolver.resolve(
        ref('addVerticalRuler', 'LayoutRotatePackingProxy.ets'),
        ctx
      );
      expect(result?.targetNodeId).toBe(cppNode.id);
    });

    it('bridges DECLARE_NAPI_FUNCTION macros', () => {
      const cppNode = fn('NapiFoo', 'napi_macros.cpp', 1);
      const ctx = makeContext([cppNode], { 'napi_macros.cpp': DECLARE_MACROS });
      const result = arktsNapiResolver.resolve(ref('foo', 'caller.ets'), ctx);
      expect(result?.targetNodeId).toBe(cppNode.id);
    });

    it('bridges napi_create_function mounts', () => {
      const cppNode = fn('NapiRun', 'init.cpp', 1);
      const ctx = makeContext([cppNode], { 'init.cpp': CREATE_FUNCTION });
      const result = arktsNapiResolver.resolve(ref('run', 'app.ets'), ctx);
      expect(result?.targetNodeId).toBe(cppNode.id);
    });

    it('bridges .c NULL descriptors (getTidByName)', () => {
      const cNode = fn('getTidByName', 'napi_init.c', 79, 'c');
      const ctx = makeContext([cNode], { 'napi_init.c': MULTIMODAL_C });
      const result = arktsNapiResolver.resolve(ref('multimodalinput.getTidByName', 'MultiModalInputUtil.ets'), ctx);
      expect(result?.targetNodeId).toBe(cNode.id);
    });

    it('resolves S2 hop from NAPI export node to business callee', () => {
      const business = fn('AddVerticalRuler', 'layout_rotate_packing.cpp', 50);
      const ctx = makeContext([business], { 'layout_rotate_packing.cpp': DEFINE_CLASS });
      const result = arktsNapiResolver.resolve(
        {
          fromNodeId: 'arkts-napi:layout_rotate_packing.cpp:addVerticalRuler',
          referenceName: 'AddVerticalRuler',
          referenceKind: 'calls',
          line: 117,
          column: 0,
          filePath: 'layout_rotate_packing.cpp',
          language: 'cpp',
        },
        ctx
      );
      expect(result?.targetNodeId).toBe(business.id);
      expect(result?.confidence).toBe(0.7);
    });

    it('allows typescript callers that import lib*.so', () => {
      const cppNode = fn('NapiDraw', 'napi_init.cpp', 85);
      const ctx = makeContext([cppNode], { 'napi_init.cpp': FLAT_CAMEL });
      const result = arktsNapiResolver.resolve(ref('draw', 'cache/LauncherLayoutCacheUtil.ts', 'typescript'), ctx);
      expect(result?.targetNodeId).toBe(cppNode.id);
    });

    it('ignores non-ArkTS/TS callers for the primary bridge', () => {
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
