/**
 * ArkTS entry / module manifest + Harmony route profile resolver (Spec 0039).
 *
 * Parses:
 * - `module.json5` pages → @Entry components, loadContent(url) → lifecycle
 * - `route_map.json` / `router_map.json` routerMap[] → page / buildFunction
 * - `main_pages.json` src[] → @Entry (same as module pages)
 */
import { isHarmonyRouteProfileJson } from '../../extraction/grammars';
import type { Node } from '../../types';
import {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
  FrameworkExtractionResult,
} from '../types';

const LOAD_CONTENT_PAGE_RE = /loadContent\s*\(\s*['"]([^'"]+)['"]/g;

function pageStem(pagePath: string): string {
  const normalized = pagePath.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  return base.replace(/\.ets$/i, '');
}

function lineOfNeedle(content: string, needle: string): number {
  const idx = content.indexOf(needle);
  if (idx < 0) return 1;
  return content.slice(0, idx).split('\n').length;
}

/** Module root = path prefix before `/src/main/` (Harmony HAP/HAR layout). */
export function harmonyModuleRootFromProfile(profileRel: string): string {
  const n = profileRel.replace(/\\/g, '/');
  const marker = '/src/main/';
  const i = n.indexOf(marker);
  if (i < 0) return '';
  return n.slice(0, i);
}

/** Resolve `pageSourceFile` (module-relative) against the profile's module root. */
export function resolveHarmonyPageSourcePath(
  profileRel: string,
  pageSourceFile: string
): string {
  const modRoot = harmonyModuleRootFromProfile(profileRel);
  const page = pageSourceFile.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!modRoot) return page;
  return `${modRoot}/${page}`.replace(/\/+/g, '/');
}

function parseModuleJson5Pages(content: string): string[] {
  const pages: string[] = [];
  const seen = new Set<string>();

  const add = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed || trimmed.includes('$') || seen.has(trimmed)) return;
    seen.add(trimmed);
    pages.push(trimmed);
  };

  const pagesString = content.match(/"pages"\s*:\s*"([^"]+)"/);
  if (pagesString) add(pagesString[1]!);

  const pagesArray = content.match(/"pages"\s*:\s*\[([\s\S]*?)\]/);
  if (pagesArray) {
    for (const m of pagesArray[1]!.matchAll(/"([^"]+)"/g)) {
      add(m[1]!);
    }
  }

  return pages;
}

function parseModuleAbilities(content: string): Array<{ name: string; srcEntry: string }> {
  const abilities: Array<{ name: string; srcEntry: string }> = [];
  for (const block of content.matchAll(
    /\{\s*"name"\s*:\s*"([^"]+)"[\s\S]*?"srcEntry"\s*:\s*"([^"]+)"[\s\S]*?\}/g
  )) {
    abilities.push({ name: block[1]!, srcEntry: block[2]! });
  }
  return abilities;
}

interface RouterMapEntry {
  name: string;
  pageSourceFile: string;
  buildFunction?: string;
}

/** Parse standard Harmony `routerMap` JSON (route_map / router_map). */
export function parseHarmonyRouterMap(content: string): RouterMapEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const arr = (data as { routerMap?: unknown }).routerMap;
  if (!Array.isArray(arr)) return [];
  const out: RouterMapEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const pageSourceFile =
      typeof rec.pageSourceFile === 'string' ? rec.pageSourceFile.trim() : '';
    if (!name || !pageSourceFile) continue;
    const buildFunction =
      typeof rec.buildFunction === 'string' && rec.buildFunction.trim()
        ? rec.buildFunction.trim()
        : undefined;
    out.push({ name, pageSourceFile, buildFunction });
  }
  return out;
}

/** Parse `main_pages.json` `{ "src": ["pages/Index", ...] }`. */
export function parseHarmonyMainPages(content: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const src = (data as { src?: unknown }).src;
  if (!Array.isArray(src)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of src) {
    if (typeof p !== 'string') continue;
    const t = p.trim();
    if (!t || t.includes('$') || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function findArktsComponentByName(context: ResolutionContext, name: string): Node | null {
  for (const kind of ['component', 'struct', 'class'] as const) {
    const iter = context.iterateNodesByKind?.(kind) ?? context.getNodesByKind(kind);
    for (const n of iter) {
      if (n.language !== 'arkts' || n.name !== name) continue;
      if (n.filePath.endsWith('.ets')) return n;
    }
  }
  return null;
}

function findArktsPageComponent(context: ResolutionContext, pagePath: string): Node | null {
  const stem = pageStem(pagePath);
  const direct = findArktsComponentByName(context, stem);
  if (direct) return direct;

  const suffix = pagePath.replace(/\\/g, '/');
  for (const kind of ['component', 'struct', 'class'] as const) {
    const iter = context.iterateNodesByKind?.(kind) ?? context.getNodesByKind(kind);
    for (const n of iter) {
      if (n.language !== 'arkts' || n.name !== stem) continue;
      const fp = n.filePath.replace(/\\/g, '/');
      if (fp.includes(suffix) || fp.endsWith(`${stem}.ets`)) return n;
    }
  }
  return null;
}

function findArktsSymbolInFile(
  context: ResolutionContext,
  fileRel: string,
  name: string
): Node | null {
  const norm = fileRel.replace(/\\/g, '/');
  const nodes = context.getNodesInFile(norm);
  for (const n of nodes) {
    if (n.name !== name) continue;
    if (
      n.kind === 'component' ||
      n.kind === 'struct' ||
      n.kind === 'class' ||
      n.kind === 'function' ||
      n.kind === 'method'
    ) {
      return n;
    }
  }
  return null;
}

function findArktsBuilderByName(context: ResolutionContext, name: string): Node | null {
  for (const kind of ['function', 'method'] as const) {
    const iter = context.iterateNodesByKind?.(kind) ?? context.getNodesByKind(kind);
    for (const n of iter) {
      if (n.language !== 'arkts' || n.name !== name) continue;
      return n;
    }
  }
  return null;
}

function findArktsMethodInComponent(
  context: ResolutionContext,
  component: Node,
  methodName: string
): Node | null {
  let owner: Node = component;
  if (component.kind === 'component') {
    for (const c of context.getNodesInFile(component.filePath)) {
      if (
        (c.kind === 'struct' || c.kind === 'class') &&
        c.language === 'arkts' &&
        c.name === component.name
      ) {
        owner = c;
        break;
      }
    }
  }

  for (const n of context.getNodesInFile(owner.filePath)) {
    if (n.kind === 'method' && n.name === methodName && n.startLine >= owner.startLine) {
      return n;
    }
  }
  return null;
}

function pushPageRoute(
  nodes: Node[],
  references: UnresolvedRef[],
  filePath: string,
  content: string,
  page: string,
  now: number
): void {
  const line = lineOfNeedle(content, page);
  const routeId = `arkts-route:${filePath}:${page}`;
  nodes.push({
    id: routeId,
    kind: 'route',
    name: page,
    qualifiedName: `${filePath}::${page}`,
    filePath,
    language: 'yaml',
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    updatedAt: now,
  });
  references.push({
    fromNodeId: routeId,
    referenceName: pageStem(page),
    referenceKind: 'references',
    line,
    column: 0,
    filePath,
    language: 'yaml',
  });
}

function extractRouterMapProfile(
  filePath: string,
  content: string,
  now: number
): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  for (const entry of parseHarmonyRouterMap(content)) {
    const line = lineOfNeedle(content, `"name": "${entry.name}"`) || lineOfNeedle(content, entry.name);
    const pageRel = resolveHarmonyPageSourcePath(filePath, entry.pageSourceFile);
    const routeId = `arkts-route:${filePath}:${entry.name}`;
    const sigParts = [`pageSourceFile=${entry.pageSourceFile}`];
    if (entry.buildFunction) sigParts.push(`buildFunction=${entry.buildFunction}`);
    nodes.push({
      id: routeId,
      kind: 'route',
      name: entry.name,
      qualifiedName: `${filePath}::${entry.name}`,
      filePath,
      language: 'yaml',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      signature: sigParts.join('; '),
      updatedAt: now,
    });
    references.push({
      fromNodeId: routeId,
      referenceName: pageStem(entry.pageSourceFile),
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'yaml',
      candidates: [pageRel],
    });
    if (entry.buildFunction) {
      references.push({
        fromNodeId: routeId,
        referenceName: entry.buildFunction,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'yaml',
        candidates: [pageRel],
      });
    }
  }
  return { nodes, references };
}

export const arktsEntryResolver: FrameworkResolver = {
  name: 'arkts-entry',
  languages: ['arkts', 'yaml'],

  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (file.endsWith('module.json5') || isHarmonyRouteProfileJson(file)) return true;
      if (!file.endsWith('.ets')) continue;
      const src = context.readFile(file);
      if (src && (/\bUIAbility\b/.test(src) || /\bloadContent\s*\(/.test(src))) return true;
    }
    return false;
  },

  claimsReference(name: string): boolean {
    return (
      name.startsWith('pages/') ||
      /^[A-Z][A-Za-z0-9]*$/.test(name) ||
      /Builder$/.test(name)
    );
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const base = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';

    if (filePath.endsWith('module.json5')) {
      const pages = parseModuleJson5Pages(content);
      for (const page of pages) {
        pushPageRoute(nodes, references, filePath, content, page, now);
      }

      for (const ability of parseModuleAbilities(content)) {
        const line = lineOfNeedle(content, ability.name);
        const abilityId = `arkts-ability:${filePath}:${ability.name}`;
        nodes.push({
          id: abilityId,
          kind: 'route',
          name: `ability:${ability.name}`,
          qualifiedName: `${filePath}::ability::${ability.name}`,
          filePath,
          language: 'yaml',
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: 0,
          isExported: false,
          signature: ability.srcEntry,
          updatedAt: now,
        });
      }
      return { nodes, references };
    }

    if (base === 'route_map.json' || base === 'router_map.json') {
      return extractRouterMapProfile(filePath, content, now);
    }

    if (base === 'main_pages.json') {
      for (const page of parseHarmonyMainPages(content)) {
        pushPageRoute(nodes, references, filePath, content, page, now);
      }
      return { nodes, references };
    }

    if (!filePath.endsWith('.ets')) {
      return { nodes, references };
    }

    LOAD_CONTENT_PAGE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOAD_CONTENT_PAGE_RE.exec(content)) !== null) {
      const page = m[1]!;
      const line = content.slice(0, m.index).split('\n').length;
      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: page,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'arkts',
      });
    }

    return { nodes, references };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'references') return null;

    const preferredFile = ref.candidates?.[0]?.replace(/\\/g, '/');

    if (preferredFile) {
      const inFile = findArktsSymbolInFile(context, preferredFile, ref.referenceName);
      if (inFile) {
        return {
          original: ref,
          targetNodeId: inFile.id,
          confidence: 0.92,
          resolvedBy: 'framework',
        };
      }
    }

    if (ref.referenceName.startsWith('pages/')) {
      const routesIter = context.iterateNodesByKind?.('route') ?? context.getNodesByKind('route');
      for (const n of routesIter) {
        if (n.name !== ref.referenceName || !n.filePath.endsWith('module.json5')) continue;
        return {
          original: ref,
          targetNodeId: n.id,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }

      const pageComponent = findArktsPageComponent(context, ref.referenceName);
      if (pageComponent) {
        return {
          original: ref,
          targetNodeId: pageComponent.id,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
      return null;
    }

    if (/Builder$/.test(ref.referenceName)) {
      const builder = findArktsBuilderByName(context, ref.referenceName);
      if (builder) {
        return {
          original: ref,
          targetNodeId: builder.id,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    const component = findArktsComponentByName(context, ref.referenceName);
    if (component) {
      return {
        original: ref,
        targetNodeId: component.id,
        confidence: 0.85,
        resolvedBy: 'framework',
      };
    }

    return null;
  },
};

export function findArktsEntryPageComponent(
  context: ResolutionContext,
  pagePath: string
): Node | null {
  return findArktsPageComponent(context, pagePath);
}

export function findArktsLifecycleMethod(
  context: ResolutionContext,
  component: Node,
  methodName: string
): Node | null {
  return findArktsMethodInComponent(context, component, methodName);
}
