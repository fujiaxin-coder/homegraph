/**
 * ArkTS NAPI cross-language bridge resolver.
 *
 * Closes the ArkTS ↔ C++ flow gap in OpenHarmony projects. ArkTS calls native
 * through a `.so` binding (`import sdk from './native'` → `libImageEditor.so`)
 * using NAPI-registered symbol names like `sdk.Asset_setCropRect(...)`.
 * ArkAnalyzer RTA stops at the `.so` boundary; this resolver links those call
 * sites to the matching `static napi_value Asset_setCropRect(...)` wrapper (and
 * its downstream `Asset::SetCropRect` callee) in C++.
 *
 * Registration shape (napi_adapter.cpp):
 *   static napi_value Asset_setCropRect(napi_env env, napi_callback_info info) { … }
 *   {"Asset_setCropRect", nullptr, Asset_setCropRect, …}
 *   napi_define_properties(env, exports, …, mydesc);
 */
import type { Node } from '../../types';
import {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';

/** JS-visible NAPI export: `ClassName_methodName`. */
const NAPI_SYMBOL_RE = /^[A-Z][A-Za-z0-9_]*_[A-Za-z0-9_]+$/;

/** `{"Asset_setCropRect", nullptr, Asset_setCropRect, …}` descriptor rows. */
const NAPI_DESC_RE =
  /\{\s*["']([A-Z][A-Za-z0-9_]*(?:_[A-Za-z0-9_]+)+)["']\s*,\s*nullptr\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/g;

/** `static napi_value Asset_setCropRect(` callback definitions. */
const NAPI_FUNC_RE =
  /(?:static\s+)?napi_value\s+([A-Z][A-Za-z0-9_]*(?:_[A-Za-z0-9_]+)+)\s*\(/g;

const CPP_LANGUAGES = new Set(['cpp', 'c']);

interface NapiExport {
  jsName: string;
  nativeName: string;
  line: number;
}

function isNapiSymbol(name: string): boolean {
  return NAPI_SYMBOL_RE.test(name);
}

function lineOf(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function parseNapiExports(source: string): NapiExport[] {
  const results: NapiExport[] = [];
  const seen = new Set<string>();

  NAPI_DESC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAPI_DESC_RE.exec(source)) !== null) {
    const jsName = m[1]!;
    const nativeName = m[2]!;
    if (!isNapiSymbol(jsName)) continue;
    if (seen.has(jsName)) continue;
    seen.add(jsName);
    results.push({ jsName, nativeName, line: lineOf(source, m.index) });
  }

  NAPI_FUNC_RE.lastIndex = 0;
  while ((m = NAPI_FUNC_RE.exec(source)) !== null) {
    const name = m[1]!;
    if (!isNapiSymbol(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    results.push({ jsName: name, nativeName: name, line: lineOf(source, m.index) });
  }

  return results;
}

const napiBySymbol: WeakMap<ResolutionContext, Map<string, Node[]>> = new WeakMap();

function buildNapiMap(context: ResolutionContext): Map<string, Node[]> {
  const cached = napiBySymbol.get(context);
  if (cached) return cached;

  const bySymbol = new Map<string, Node[]>();
  const add = (symbol: string, node: Node): void => {
    const arr = bySymbol.get(symbol);
    if (arr) arr.push(node);
    else bySymbol.set(symbol, [node]);
  };

  for (const node of context.getNodesByKind('function')) {
    if (!CPP_LANGUAGES.has(node.language)) continue;
    if (isNapiSymbol(node.name)) add(node.name, node);
  }

  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.cpp') && !file.endsWith('.cc') && !file.endsWith('.cxx')) continue;
    const source = context.readFile(file);
    if (!source || !/\bnapi_(define_properties|module_register)\b/.test(source)) continue;
    for (const exp of parseNapiExports(source)) {
      const candidates = context.getNodesByName(exp.nativeName).filter(
        (n) => CPP_LANGUAGES.has(n.language) && n.filePath === file
      );
      const node = candidates[0];
      if (node) add(exp.jsName, node);
    }
  }

  napiBySymbol.set(context, bySymbol);
  return bySymbol;
}

function napiSymbolFromRef(ref: UnresolvedRef): string | null {
  const name = ref.referenceName.includes('.')
    ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
    : ref.referenceName;
  return isNapiSymbol(name) ? name : null;
}

export const arktsNapiResolver: FrameworkResolver = {
  name: 'arkts-napi',
  languages: ['arkts', 'cpp', 'c'],

  extract(filePath, source) {
    if (!filePath.endsWith('.cpp') && !filePath.endsWith('.cc') && !filePath.endsWith('.cxx')) {
      return { nodes: [], references: [] };
    }
    if (!/\bnapi_(define_properties|module_register)\b/.test(source)) {
      return { nodes: [], references: [] };
    }

    const exports = parseNapiExports(source);
    const now = Date.now();
    const nodes: Node[] = [];
    const seen = new Set<string>();

    for (const exp of exports) {
      if (seen.has(exp.jsName)) continue;
      seen.add(exp.jsName);
      nodes.push({
        id: `arkts-napi:${filePath}:${exp.jsName}`,
        kind: 'function',
        name: exp.jsName,
        qualifiedName: `${filePath}::${exp.jsName}`,
        filePath,
        language: 'cpp',
        startLine: exp.line,
        endLine: exp.line,
        startColumn: 0,
        endColumn: 0,
        isExported: true,
        docstring: `NAPI export ${exp.jsName}`,
        signature: `napi_value ${exp.nativeName}(napi_env, napi_callback_info)`,
        updatedAt: now,
      });
    }

    return { nodes, references: [] };
  },

  detect(context) {
    for (const file of context.getAllFiles()) {
      if (file.endsWith('.ets') || file.endsWith('.ts')) {
        const src = context.readFile(file);
        if (src && /['"]lib[A-Za-z0-9_]+\.so['"]/.test(src)) return true;
      }
      if (file.endsWith('.cpp') || file.endsWith('.cc') || file.endsWith('.cxx')) {
        const src = context.readFile(file);
        if (src && /\bnapi_(define_properties|module_register)\b/.test(src)) return true;
      }
    }
    return false;
  },

  claimsReference(name: string): boolean {
    const symbol = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    return isNapiSymbol(symbol);
  },

  resolve(ref, context): ResolvedRef | null {
    if (ref.language !== 'arkts' || ref.referenceKind !== 'calls') return null;

    const symbol = napiSymbolFromRef(ref);
    if (!symbol) return null;

    const entries = buildNapiMap(context).get(symbol);
    if (!entries || entries.length === 0) return null;

    const target = entries.find((n) => n.filePath.includes('napi')) ?? entries[0];
    if (!target) return null;

    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.75,
      resolvedBy: 'framework',
    };
  },
};
