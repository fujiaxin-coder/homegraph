/**
 * ArkTS NAPI cross-language bridge resolver.
 *
 * Closes the ArkTS ↔ C/C++ flow gap in OpenHarmony projects. ArkTS calls native
 * through a `.so` binding (`import x from 'libFoo.so'`) and NAPI-registered
 * export names. This resolver extracts `(jsName → nativeSymbol)` from several
 * registration frontends into one registry, then resolves ArkTS call sites to
 * the matching C/C++ `napi_value` wrapper (optional second hop to a same-file
 * business callee when naming is unambiguous).
 *
 * Frontends (spec 0006):
 *   F1  {"draw", nullptr, PluginManager::NapiDraw, …}  (+ Class_method compat)
 *   F2  napi_define_class / napi_define_sendable_class + property descriptors
 *   F3  DECLARE_NAPI_FUNCTION("foo", NapiFoo) (and METHOD/PROPERTY/GETTER/SETTER)
 *   F4  napi_create_function(env, "run", …, NapiRun, …)
 *
 * Out of scope: full cpp macro expansion, JSBIND codegen without source macros,
 * non-literal export names, linking to .so with no in-repo native source.
 */
import type { Node } from '../../types';
import {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';

const CPP_LANGUAGES = new Set(['cpp', 'c']);

const NAPI_FILE_RE = /\.(?:c|cc|cpp|cxx)$/i;

/** File-level cue that NAPI registration (or OH macros) may be present. */
const NAPI_CUE_RE =
  /\b(?:napi_define_properties|napi_define_(?:sendable_)?class|napi_module_register|napi_create_function|napi_set_named_property|DECLARE_NAPI_(?:FUNCTION|METHOD|PROPERTY|GETTER|SETTER)|NAPI_MODULE)\b/;

/** Photos-style `ClassName_methodName` (compat frontend). */
const CLASS_METHOD_RE = /^[A-Z][A-Za-z0-9_]*_[A-Za-z0-9_]+$/;

/**
 * F1: `{"jsName", nullptr|NULL, NativeSym, …}` descriptor rows.
 * NativeSym may be qualified (`PluginManager::NapiDraw`).
 */
const NAPI_DESC_RE =
  /\{\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*,\s*(?:nullptr|NULL)\s*,\s*([A-Za-z_][A-Za-z0-9_:]*)/g;

/** F3: OpenHarmony DECLARE_NAPI_* macros. */
const NAPI_MACRO_RE =
  /DECLARE_NAPI_(?:FUNCTION|METHOD|PROPERTY|GETTER|SETTER)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * F4: `napi_create_function(env, "run", NAPI_AUTO_LENGTH, NapiRun, …)`.
 * The 4th argument is the native callback (after env, name, length).
 */
const NAPI_CREATE_FN_RE =
  /napi_create_function\s*\(\s*[^,]+,\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*,\s*[^,]+,\s*([A-Za-z_][A-Za-z0-9_:]*)/g;

/** F2: class registration (name used only for kind / docs). */
const NAPI_DEFINE_CLASS_RE =
  /napi_define_(?:sendable_)?class\s*\(\s*[^,]+,\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;

/** Compat: `static napi_value Asset_setCropRect(` when descriptor row is missing. */
const NAPI_CLASS_METHOD_FUNC_RE =
  /(?:static\s+)?napi_value\s+([A-Z][A-Za-z0-9_]*(?:_[A-Za-z0-9_]+)+)\s*\(/g;

export interface NapiExport {
  jsName: string;
  nativeName: string;
  line: number;
  kind: 'flat' | 'class';
  className?: string;
}

function lineOf(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function isNapiFile(filePath: string): boolean {
  return NAPI_FILE_RE.test(filePath);
}

function simpleNativeName(nativeName: string): string {
  const idx = nativeName.lastIndexOf('::');
  return idx >= 0 ? nativeName.slice(idx + 2) : nativeName;
}

function isClassMethodName(name: string): boolean {
  return CLASS_METHOD_RE.test(name);
}

/**
 * Conservative S2: `NapiAddVerticalRuler` → `AddVerticalRuler` when the
 * stripped name appears as a same-file def/call that is not the `Napi*` wrapper.
 */
export function suggestSecondHop(nativeSimpleName: string, source: string): string | null {
  if (!nativeSimpleName.startsWith('Napi') || nativeSimpleName.length <= 4) return null;
  const next = nativeSimpleName.charAt(4);
  if (next < 'A' || next > 'Z') return null;
  const business = nativeSimpleName.slice(4);
  if (!business || business === nativeSimpleName) return null;

  const callRe = new RegExp(`\\b${business}\\s*\\(`);
  for (const line of source.split('\n')) {
    // Skip the NAPI wrapper declaration/definition line.
    if (line.includes(nativeSimpleName)) continue;
    if (callRe.test(line)) return business;
  }
  return null;
}

function collectClassNames(source: string): Set<string> {
  const names = new Set<string>();
  NAPI_DEFINE_CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAPI_DEFINE_CLASS_RE.exec(source)) !== null) {
    names.add(m[1]!);
  }
  return names;
}

function pushExport(
  results: NapiExport[],
  seen: Set<string>,
  jsName: string,
  nativeName: string,
  line: number,
  kind: 'flat' | 'class',
  className?: string
): void {
  if (!jsName || !nativeName) return;
  if (seen.has(jsName)) return;
  seen.add(jsName);
  results.push({
    jsName,
    nativeName: simpleNativeName(nativeName),
    line,
    kind,
    className,
  });
}

/** Parse all supported NAPI registration frontends in one file's source. */
export function parseNapiExports(source: string): NapiExport[] {
  const results: NapiExport[] = [];
  const seen = new Set<string>();
  const classNames = collectClassNames(source);
  const kindFor = (): 'flat' | 'class' => (classNames.size > 0 ? 'class' : 'flat');
  const className = classNames.size === 1 ? [...classNames][0] : undefined;

  NAPI_DESC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAPI_DESC_RE.exec(source)) !== null) {
    pushExport(results, seen, m[1]!, m[2]!, lineOf(source, m.index), kindFor(), className);
  }

  NAPI_MACRO_RE.lastIndex = 0;
  while ((m = NAPI_MACRO_RE.exec(source)) !== null) {
    pushExport(results, seen, m[1]!, m[2]!, lineOf(source, m.index), kindFor(), className);
  }

  NAPI_CREATE_FN_RE.lastIndex = 0;
  while ((m = NAPI_CREATE_FN_RE.exec(source)) !== null) {
    pushExport(results, seen, m[1]!, m[2]!, lineOf(source, m.index), 'flat');
  }

  NAPI_CLASS_METHOD_FUNC_RE.lastIndex = 0;
  while ((m = NAPI_CLASS_METHOD_FUNC_RE.exec(source)) !== null) {
    const name = m[1]!;
    if (!isClassMethodName(name)) continue;
    pushExport(results, seen, name, name, lineOf(source, m.index), 'flat');
  }

  return results;
}

function jsNameFromRef(ref: UnresolvedRef): string {
  return ref.referenceName.includes('.')
    ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
    : ref.referenceName;
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

  // Compat: Class_method-named C/C++ functions are themselves the wrapper.
  for (const node of context.getNodesByKind('function')) {
    if (!CPP_LANGUAGES.has(node.language)) continue;
    if (isClassMethodName(node.name)) add(node.name, node);
  }
  for (const node of context.getNodesByKind('method')) {
    if (!CPP_LANGUAGES.has(node.language)) continue;
    if (isClassMethodName(node.name)) add(node.name, node);
  }

  for (const file of context.getAllFiles()) {
    if (!isNapiFile(file)) continue;
    const source = context.readFile(file);
    if (!source || !NAPI_CUE_RE.test(source)) continue;
    for (const exp of parseNapiExports(source)) {
      const native = exp.nativeName;
      const candidates = [
        ...context.getNodesByName(native),
        // Some extractors store the leaf method name only.
      ].filter((n) => CPP_LANGUAGES.has(n.language) && n.filePath === file);
      const node = candidates[0];
      if (node) add(exp.jsName, node);
    }
  }

  napiBySymbol.set(context, bySymbol);
  return bySymbol;
}

function pickTarget(entries: Node[]): Node | undefined {
  return entries.find((n) => /napi/i.test(n.filePath)) ?? entries[0];
}

export const arktsNapiResolver: FrameworkResolver = {
  name: 'arkts-napi',
  languages: ['arkts', 'typescript', 'cpp', 'c'],

  extract(filePath, source): FrameworkExtractionResult {
    if (!isNapiFile(filePath) || !NAPI_CUE_RE.test(source)) {
      return { nodes: [], references: [] };
    }

    const exports = parseNapiExports(source);
    const now = Date.now();
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const seen = new Set<string>();

    for (const exp of exports) {
      if (seen.has(exp.jsName)) continue;
      seen.add(exp.jsName);
      const id = `arkts-napi:${filePath}:${exp.jsName}`;
      const classDoc = exp.className ? ` (class ${exp.className})` : '';
      nodes.push({
        id,
        kind: 'function',
        name: exp.jsName,
        qualifiedName: exp.className
          ? `${filePath}::${exp.className}.${exp.jsName}`
          : `${filePath}::${exp.jsName}`,
        filePath,
        language: filePath.endsWith('.c') ? 'c' : 'cpp',
        startLine: exp.line,
        endLine: exp.line,
        startColumn: 0,
        endColumn: 0,
        isExported: true,
        docstring: `NAPI export ${exp.jsName}${classDoc} → ${exp.nativeName}`,
        signature: `napi_value ${exp.nativeName}(napi_env, napi_callback_info)`,
        updatedAt: now,
      });

      const second = suggestSecondHop(exp.nativeName, source);
      if (second) {
        references.push({
          fromNodeId: id,
          referenceName: second,
          referenceKind: 'calls',
          line: exp.line,
          column: 0,
          filePath,
          language: filePath.endsWith('.c') ? 'c' : 'cpp',
        });
      }
    }

    return { nodes, references };
  },

  detect(context) {
    for (const file of context.getAllFiles()) {
      if (file.endsWith('.ets') || file.endsWith('.ts')) {
        const src = context.readFile(file);
        if (src && /['"]lib[A-Za-z0-9_]+\.so['"]/.test(src)) return true;
      }
      if (isNapiFile(file)) {
        const src = context.readFile(file);
        if (src && NAPI_CUE_RE.test(src)) return true;
      }
    }
    return false;
  },

  claimsReference(name: string): boolean {
    // Ordinary camelCase exports become knownNames via extract(); Class_method
    // names still need an opt-in so refs reach resolve before/without extract.
    const symbol = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    return isClassMethodName(symbol);
  },

  resolve(ref, context): ResolvedRef | null {
    // S2: export node → same-file business callee
    if (
      ref.referenceKind === 'calls' &&
      ref.fromNodeId.startsWith('arkts-napi:') &&
      (ref.language === 'cpp' || ref.language === 'c')
    ) {
      const candidates = context
        .getNodesByName(ref.referenceName)
        .filter((n) => CPP_LANGUAGES.has(n.language) && n.filePath === ref.filePath);
      const target = candidates[0];
      if (!target) return null;
      return {
        original: ref,
        targetNodeId: target.id,
        confidence: 0.7,
        resolvedBy: 'framework',
      };
    }

    if (
      (ref.language !== 'arkts' && ref.language !== 'typescript') ||
      ref.referenceKind !== 'calls'
    ) {
      return null;
    }

    const symbol = jsNameFromRef(ref);
    if (!symbol) return null;

    const entries = buildNapiMap(context).get(symbol);
    if (!entries || entries.length === 0) return null;

    const target = pickTarget(entries);
    if (!target) return null;

    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.75,
      resolvedBy: 'framework',
    };
  },
};
