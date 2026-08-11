/**
 * ViewTree data-passage classification for ArkUI migrate (spec 0007).
 * Ports migration-graph object-literal + transfer fallbacks with duck typing.
 */

import { ModelUtils, type Scene, type ArkClass, type ArkField, type ArkMethod } from 'arkanalyzer';
import type { ViewTreeNode } from 'arkanalyzer';
import {
  classifyPassageFromText,
  classifyValueType,
  computeForcesMigration,
  type PassageType,
  type ValueTypeKind,
} from './migrate-semantics';

/** ArkAnalyzer ClassCategory.OBJECT */
const CLASS_CATEGORY_OBJECT = 5;

export interface PassageEmit {
  fromField?: ArkField;
  fromIsParentComponent: boolean;
  toField: ArkField;
  passageType: PassageType;
  valueType: ValueTypeKind;
  forcesMigration: boolean;
  parentExpression: string;
  /** Child decorator via for explore labels: Prop | Link | data-passage | builder-param */
  via: string;
}

function hasFn(v: unknown, ...names: string[]): boolean {
  if (!v || typeof v !== 'object') return false;
  return names.every((n) => typeof (v as Record<string, unknown>)[n] === 'function');
}

function backtraceLocalInitValue(value: unknown, depth = 0): unknown {
  if (depth > 8 || !value) return value;
  if (!hasFn(value, 'getDeclaringStmt')) return value;
  try {
    const stmt = (value as { getDeclaringStmt: () => unknown }).getDeclaringStmt();
    if (!stmt || !hasFn(stmt, 'getRightOp')) return value;
    const right = (stmt as { getRightOp: () => unknown }).getRightOp();
    return backtraceLocalInitValue(right, depth + 1);
  } catch {
    return value;
  }
}

function valueText(v: unknown): string {
  try {
    if (v != null && typeof (v as { toString?: () => string }).toString === 'function') {
      return String((v as { toString: () => string }).toString());
    }
  } catch {
    /* ignore */
  }
  return '';
}

function isInstanceFieldRef(v: unknown): v is { getFieldName: () => string } {
  return hasFn(v, 'getFieldName') && hasFn(v, 'getBase');
}

function classifyRightOp(
  rightOp: unknown,
  childDecorator: string,
  parentCls: ArkClass | undefined
): PassageType {
  const text = valueText(rightOp);
  if (text.includes('$$') || text.includes('!!')) return 'two_way_binding';
  if (childDecorator === 'BuilderParam') return 'callback';

  if (isInstanceFieldRef(rightOp)) {
    const name = rightOp.getFieldName();
    if (parentCls && !parentCls.getFieldWithName(name)) return 'callback';
    return 'state_variable_ref';
  }

  if (hasFn(rightOp, 'getClassType') || /^new\s+/.test(text.trim())) {
    if (hasFn(rightOp, 'getArgs') || text.trim().startsWith('new ')) return 'new_instance';
  }
  // Constant-like
  if (hasFn(rightOp, 'getValue') && hasFn(rightOp, 'getType') && !hasFn(rightOp, 'getFieldName')) {
    return 'literal';
  }
  if (hasFn(rightOp, 'getMethodSignature') || hasFn(rightOp, 'getInvokeExpr')) {
    return 'function_call';
  }
  if (hasFn(rightOp, 'getType')) {
    try {
      const t = (rightOp as { getType: () => { toString?: () => string } }).getType();
      const ts = t?.toString?.() ?? '';
      if (/Function|=>/.test(ts)) return 'callback';
    } catch {
      /* ignore */
    }
  }
  return classifyPassageFromText(text, {
    childDecorator,
    parentHasField: parentCls
      ? (n) => !!parentCls.getFieldWithName(n)
      : undefined,
  });
}

/**
 * Resolve anonymous object-literal class from ViewTree `create` attribute
 * (same chain as migration-graph / ViewTreeBuilder).
 */
export function resolveObjectLiteralClass(
  node: ViewTreeNode,
  scene: Scene
): ArkClass | null {
  const createEntry = node.attributes?.get('create');
  if (!createEntry) return null;
  const stmt = createEntry[0];
  let expr: unknown;
  try {
    if (hasFn(stmt, 'getRightOp')) {
      expr = (stmt as unknown as { getRightOp: () => unknown }).getRightOp();
    } else if (hasFn(stmt, 'getInvokeExpr')) {
      expr = (stmt as unknown as { getInvokeExpr: () => unknown }).getInvokeExpr();
    }
  } catch {
    return null;
  }
  if (!hasFn(expr, 'getArg')) return null;
  let temp: unknown;
  try {
    temp = (expr as { getArg: (i: number) => unknown }).getArg(0);
  } catch {
    return null;
  }
  if (!hasFn(temp, 'getUsedStmts')) return null;

  let arg: unknown;
  try {
    for (const usedStmt of (temp as { getUsedStmts: () => Iterable<unknown> }).getUsedStmts()) {
      if (!hasFn(usedStmt, 'getRightOp')) continue;
      const rightOp = (usedStmt as { getRightOp: () => unknown }).getRightOp();
      if (!hasFn(rightOp, 'getMethodSignature') || !hasFn(rightOp, 'getArg')) continue;
      try {
        const ms = (rightOp as { getMethodSignature: () => { getMethodSubSignature: () => { getMethodName: () => string } } }).getMethodSignature();
        if (ms.getMethodSubSignature().getMethodName() !== 'constructor') continue;
        arg = (rightOp as { getArg: (i: number) => unknown }).getArg(0);
        break;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  if (!arg || !hasFn(arg, 'getType')) return null;

  try {
    const argType = (arg as { getType: () => unknown }).getType();
    const objectCls = ModelUtils.getArkClassInBuild(scene, argType as never);
    if (!objectCls || objectCls.getCategory() !== CLASS_CATEGORY_OBJECT) return null;
    return objectCls;
  } catch {
    return null;
  }
}

function childDecoratorKind(field: ArkField): string {
  try {
    const decs = field.getStateDecorators?.();
    if (decs) {
      for (const d of decs) {
        const k = d.getKind();
        if (k) return k;
      }
    }
  } catch {
    /* ignore */
  }
  try {
    for (const d of field.getDecorators?.() ?? []) {
      const k = d.getKind();
      if (k === 'Prop' || k === 'Link' || k === 'Param' || k === 'ObjectLink' || k === 'BuilderParam') {
        return k;
      }
    }
  } catch {
    /* ignore */
  }
  return '';
}

function viaForChildDecorator(kind: string): string {
  if (kind === 'Prop' || kind === 'Link') return kind;
  if (kind === 'BuilderParam') return 'builder-param';
  return 'data-passage';
}

function valueTypeOfField(field: ArkField): ValueTypeKind {
  try {
    return classifyValueType(field.getType()?.toString());
  } catch {
    return 'unknown';
  }
}

/**
 * Emit passage records for a custom-component ViewTree node.
 */
export function collectPassagesForViewTreeNode(
  node: ViewTreeNode,
  scene: Scene,
  parentCls: ArkClass
): PassageEmit[] {
  const out: PassageEmit[] = [];
  const seen = new Set<string>();
  const objectCls = resolveObjectLiteralClass(node, scene);

  if (objectCls) {
    for (const field of objectCls.getFields()) {
      const childName = field.getName();
      // Map object-literal field → child component field by name
      const childField = (() => {
        // Prefer signature's declaring class fields via stateValuesTransfer keys
        if (node.stateValuesTransfer) {
          for (const [cf] of node.stateValuesTransfer) {
            if (cf.getName() === childName) return cf;
          }
        }
        return null;
      })();
      // If transfer map missing this name, still try to use literal field as stand-in
      // only when we can resolve real child field from transfer.
      if (!childField) continue;

      const initializers = field.getInitializer?.() ?? [];
      if (initializers.length === 0) continue;
      const assign = initializers[initializers.length - 1];
      if (!hasFn(assign, 'getRightOp')) continue;
      const rightOp = backtraceLocalInitValue(
        (assign as unknown as { getRightOp: () => unknown }).getRightOp()
      );
      const childDec = childDecoratorKind(childField);
      const passageType = classifyRightOp(rightOp, childDec, parentCls);
      const valueType = valueTypeOfField(childField);
      const forcesMigration = computeForcesMigration(passageType, valueType);
      const parentExpression = valueText(rightOp);

      let fromField: ArkField | undefined;
      let fromIsParentComponent = true;
      if (
        (passageType === 'state_variable_ref' || passageType === 'two_way_binding') &&
        isInstanceFieldRef(rightOp)
      ) {
        const pf = parentCls.getFieldWithName(rightOp.getFieldName());
        if (pf) {
          fromField = pf;
          fromIsParentComponent = false;
        }
      }

      const key = `${fromField?.getName() ?? 'comp'}|${childField.getName()}|${passageType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        fromField,
        fromIsParentComponent,
        toField: childField,
        passageType,
        valueType,
        forcesMigration,
        parentExpression,
        via: viaForChildDecorator(childDec),
      });
    }
    if (out.length > 0) return out;
  }

  // Fallback: stateValuesTransfer
  if (!node.stateValuesTransfer) return out;
  for (const [childField, value] of node.stateValuesTransfer) {
    const childDec = childDecoratorKind(childField);
    const valueType = valueTypeOfField(childField);
    let passageType: PassageType;
    let fromField: ArkField | undefined;
    let fromIsParentComponent = true;
    let parentExpression: string;
    let via: string;

    if (value && typeof (value as ArkField).getName === 'function' && hasFn(value, 'getDeclaringArkClass')) {
      // ArkField
      passageType = 'state_variable_ref';
      fromField = value as ArkField;
      fromIsParentComponent = false;
      parentExpression = `this.${fromField.getName()}`;
      via = viaForChildDecorator(childDec) || 'Prop';
    } else if (value && hasFn(value, 'getSignature')) {
      // ArkMethod builder
      passageType = 'callback';
      parentExpression = `<builder:${(value as ArkMethod).getName?.() ?? 'builder'}>`;
      via = 'builder-param';
    } else {
      continue;
    }

    const forcesMigration = computeForcesMigration(passageType, valueType);
    const key = `${fromField?.getName() ?? 'comp'}|${childField.getName()}|${passageType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      fromField,
      fromIsParentComponent,
      toField: childField,
      passageType,
      valueType,
      forcesMigration,
      parentExpression,
      via,
    });
  }
  return out;
}
