/**
 * ArkTS entry / module manifest resolver.
 *
 * Parses HarmonyOS `module.json5` page routes and links startup paths:
 * module pages → @Entry components, loadContent(url) → first-screen lifecycle.
 */
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

function findArktsComponentByName(context: ResolutionContext, name: string): Node | null {
  for (const kind of ['component', 'struct', 'class'] as const) {
    for (const n of context.getNodesByKind(kind)) {
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
    for (const n of context.getNodesByKind(kind)) {
      if (n.language !== 'arkts' || n.name !== stem) continue;
      const fp = n.filePath.replace(/\\/g, '/');
      if (fp.includes(suffix) || fp.endsWith(`${stem}.ets`)) return n;
    }
  }
  return null;
}

function findArktsMethodInComponent(
  context: ResolutionContext,
  component: Node,
  methodName: string
): Node | null {
  const owner =
    context.getNodesByKind('struct').find(
      (c) => c.language === 'arkts' && c.filePath === component.filePath && c.name === component.name
    ) ??
    context.getNodesByKind('class').find(
      (c) => c.language === 'arkts' && c.filePath === component.filePath && c.name === component.name
    ) ??
    component;

  for (const n of context.getNodesInFile(owner.filePath)) {
    if (n.kind === 'method' && n.name === methodName && n.startLine >= owner.startLine) {
      return n;
    }
  }
  return null;
}

export const arktsEntryResolver: FrameworkResolver = {
  name: 'arkts-entry',
  languages: ['arkts', 'yaml'],

  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (file.endsWith('module.json5')) return true;
      if (!file.endsWith('.ets')) continue;
      const src = context.readFile(file);
      if (src && (/\bUIAbility\b/.test(src) || /\bloadContent\s*\(/.test(src))) return true;
    }
    return false;
  },

  claimsReference(name: string): boolean {
    return name.startsWith('pages/') || /^[A-Z][A-Za-z0-9]*$/.test(name);
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    if (filePath.endsWith('module.json5')) {
      const pages = parseModuleJson5Pages(content);
      for (const page of pages) {
        const line =
          content.split('\n').findIndex((l) => l.includes(page)) + 1 || 1;
        const routeId = `arkts-route:${filePath}:${page}`;
        nodes.push({
          id: routeId,
          kind: 'route',
          name: page,
          qualifiedName: `${filePath}::${page}`,
          filePath,
          language: 'yaml',
          startLine: line > 0 ? line : 1,
          endLine: line > 0 ? line : 1,
          startColumn: 0,
          endColumn: 0,
          isExported: false,
          updatedAt: now,
        });
        references.push({
          fromNodeId: routeId,
          referenceName: pageStem(page),
          referenceKind: 'references',
          line: line > 0 ? line : 1,
          column: 0,
          filePath,
          language: 'yaml',
        });
      }

      for (const ability of parseModuleAbilities(content)) {
        const line =
          content.split('\n').findIndex((l) => l.includes(ability.name)) + 1 || 1;
        const abilityId = `arkts-ability:${filePath}:${ability.name}`;
        nodes.push({
          id: abilityId,
          kind: 'route',
          name: `ability:${ability.name}`,
          qualifiedName: `${filePath}::ability::${ability.name}`,
          filePath,
          language: 'yaml',
          startLine: line > 0 ? line : 1,
          endLine: line > 0 ? line : 1,
          startColumn: 0,
          endColumn: 0,
          isExported: false,
          signature: ability.srcEntry,
          updatedAt: now,
        });
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

    if (ref.referenceName.startsWith('pages/')) {
      const routes = context.getNodesByKind('route').filter(
        (n) => n.name === ref.referenceName && n.filePath.endsWith('module.json5')
      );
      const route = routes[0];
      if (route) {
        return {
          original: ref,
          targetNodeId: route.id,
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
