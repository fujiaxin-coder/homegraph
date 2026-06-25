/**
 * Ingest ArkAnalyzer ViewTree into HomeGraph nodes/edges.
 *
 * Maps declarative UI structure (component tree, event bindings, state usage,
 * prop transfer) to traversable graph edges — no custom runtime heuristics.
 */
import {
  CALLBACK_METHOD_NAME,
  ClassSignature,
  MethodSignature,
  ArkField,
  ArkMethod,
  type ArkClass,
  type Scene,
  type Stmt,
  type ViewTreeNode,
} from 'arkanalyzer';
import type { Edge, ExtractionResult, Language } from '../../types';

const CALLBACK_ATTRS = new Set<string>(CALLBACK_METHOD_NAME);

export interface ViewTreeIndexerContext {
  rootDir: string;
  scene: Scene;
  language: Language;
  methodToId: Map<ArkMethod, string>;
  classToId: Map<ArkClass, string>;
  fieldToId: Map<ArkField, string>;
  nodeIds: Set<string>;
  addEdge(
    result: ExtractionResult,
    source: string,
    target: string,
    kind: Edge['kind'],
    callerFile: string,
    via: string,
    line: number
  ): void;
  ensureMethodNode(
    method: ArkMethod,
    relativePath: string,
    result: ExtractionResult,
    parentId: string
  ): string | null;
  resolveClassNodeId(cls: ArkClass): string | null;
}

function lineFromStmt(stmt: Stmt | undefined): number {
  return stmt?.getOriginFullPosition()?.getFirstLine() ?? 1;
}

function isClassSignature(sig: ClassSignature | MethodSignature): sig is ClassSignature {
  return sig instanceof ClassSignature;
}

function resolveMethodFromSignature(
  ctx: ViewTreeIndexerContext,
  sig: MethodSignature
): ArkMethod | null {
  return ctx.scene.getMethod(sig);
}

function resolveClassFromSignature(
  ctx: ViewTreeIndexerContext,
  sig: ClassSignature
): ArkClass | null {
  return ctx.scene.getClass(sig);
}

function walkViewTree(node: ViewTreeNode, visit: (node: ViewTreeNode) => void): void {
  visit(node);
  for (const child of node.children) {
    walkViewTree(child, visit);
  }
}

function extractMethodSignatures(
  values: (MethodSignature | unknown)[]
): MethodSignature[] {
  const out: MethodSignature[] = [];
  for (const v of values) {
    if (v instanceof MethodSignature) {
      out.push(v);
    }
  }
  return out;
}

export function indexViewTreeForClass(
  ctx: ViewTreeIndexerContext,
  cls: ArkClass,
  result: ExtractionResult,
  relativePath: string
): void {
  if (!cls.hasViewTree()) return;

  const viewTree = cls.getViewTree();
  if (!viewTree) return;
  const root = viewTree.getRoot();
  if (!root) return;

  const classNodeId = ctx.resolveClassNodeId(cls);
  if (!classNodeId) return;

  const buildMethod = cls.getMethods(true).find((m) => m.getName() === 'build');
  if (!buildMethod) return;

  const buildId = ctx.ensureMethodNode(buildMethod, relativePath, result, classNodeId);
  if (!buildId) return;

  const seen = new Set<string>();

  const link = (
    source: string,
    target: string,
    kind: Edge['kind'],
    via: string,
    line: number
  ) => {
    const key = `${source}>${target}>${kind}>${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    ctx.addEdge(result, source, target, kind, relativePath, via, line);
  };

  // Reverse index: state field → build (UI reads this state in the tree).
  for (const [field] of viewTree.getStateValues()) {
    const fieldId = ctx.fieldToId.get(field);
    if (fieldId) {
      const line = field.getOriginFullPosition?.()?.getFirstLine?.() ?? buildMethod.getImplOriginFullPosition()?.getFirstLine() ?? 1;
      link(fieldId, buildId, 'references', 'state-binding', line);
    }
  }

  walkViewTree(root, (node) => {
    // Custom sub-component or @Builder child.
    const sig = node.signature;
    if (sig) {
      if (isClassSignature(sig)) {
        const childCls = resolveClassFromSignature(ctx, sig);
        if (childCls) {
          const childId = ctx.resolveClassNodeId(childCls);
          if (childId) {
            const firstAttr = node.attributes.values().next().value;
            const line = firstAttr ? lineFromStmt(firstAttr[0]) : buildMethod.getImplOriginFullPosition()?.getFirstLine() ?? 1;
            link(buildId, childId, 'references', 'child-component', line);
          }
        }
      } else {
        const builderMethod = resolveMethodFromSignature(ctx, sig);
        if (builderMethod) {
          const builderId = ctx.ensureMethodNode(builderMethod, relativePath, result, classNodeId);
          if (builderId) {
            link(buildId, builderId, 'references', 'builder', builderMethod.getImplOriginFullPosition()?.getFirstLine() ?? 1);
          }
        }
      }
    }

    // Parent → child prop transfer on embedded custom components.
    if (node.stateValuesTransfer) {
      for (const [childField, parentValue] of node.stateValuesTransfer) {
        const childFieldId = ctx.fieldToId.get(childField);
        if (parentValue instanceof ArkField) {
          const parentFieldId = ctx.fieldToId.get(parentValue);
          if (childFieldId && parentFieldId) {
            link(parentFieldId, childFieldId, 'references', 'prop-transfer', childField.getOriginFullPosition()?.getFirstLine() ?? 1);
          }
        } else if (parentValue instanceof ArkMethod) {
          const builderId = ctx.ensureMethodNode(parentValue, relativePath, result, classNodeId);
          if (childFieldId && builderId) {
            link(builderId, childFieldId, 'references', 'builder-param', childField.getOriginFullPosition()?.getFirstLine() ?? 1);
          }
        }
      }
    }

    // Event handler bindings (.onClick, .onTouch, …).
    for (const [attr, [stmt, values]] of node.attributes) {
      if (!CALLBACK_ATTRS.has(attr)) continue;
      const line = lineFromStmt(stmt);
      for (const methodSig of extractMethodSignatures(values)) {
        const handler = resolveMethodFromSignature(ctx, methodSig);
        if (!handler) continue;
        const handlerId = ctx.ensureMethodNode(handler, relativePath, result, classNodeId);
        if (handlerId) {
          link(buildId, handlerId, 'references', attr, line);
        }
      }
    }
  });
}
