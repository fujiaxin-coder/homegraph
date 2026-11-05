/**
 * Shared matcher + probes for L1 calls gold (buckets A–E, G).
 * Edge key: file + name [| startLine]; %AM*$name wrappers allowed.
 */
import { expect } from 'vitest';
import type { Edge, Node } from '../../../src/types';
import type { CallEdgeGold } from './calls-gold';

export function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Match gold name to HG node name; allow %AM*$name anonymous wrappers. */
export function nameMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (actual.endsWith('$' + expected)) return true;
  const parts = actual.split('$');
  return parts[parts.length - 1] === expected;
}

export function moduleOf(file: string): string {
  const m = normPath(file).match(/^(mod_[a-z])/);
  return m ? m[1] : '';
}

export function goldLabel(g: CallEdgeGold): string {
  return `[${g.bucket}] ${g.callerFile}:${g.callerName} → ${g.calleeFile}:${g.calleeName}` +
    (g.note ? ` (${g.note})` : '');
}

export type IndexedCall = {
  callerFile: string;
  callerName: string;
  callerStart: number;
  calleeFile: string;
  calleeName: string;
  calleeStart: number;
  dispatch?: string;
  synthesizedBy?: string;
};

function toIndexedCall(e: Edge, s: Node, t: Node): IndexedCall {
  const synth = e.metadata?.synthesizedBy;
  const dispatch =
    e.metadata?.dispatch != null
      ? String(e.metadata.dispatch)
      : e.metadata?.direct === true
        ? 'direct'
        : e.metadata?.direct === false
          ? 'indirect'
          : undefined;
  return {
    callerFile: normPath(s.filePath),
    callerName: s.name,
    callerStart: s.startLine,
    calleeFile: normPath(t.filePath),
    calleeName: t.name,
    calleeStart: t.startLine,
    dispatch,
    synthesizedBy: synth != null ? String(synth) : undefined,
  };
}

export function collectArkCalls(nodes: Node[], edges: Edge[]): IndexedCall[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: IndexedCall[] = [];
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    const synth = e.metadata?.synthesizedBy;
    if (synth != null && synth !== 'arkanalyzer') continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    out.push(toIndexedCall(e, s, t));
  }
  return out;
}

/** HomeGraph heuristic / synthesized calls (non-arkanalyzer). */
export function collectHeuristicCalls(nodes: Node[], edges: Edge[]): IndexedCall[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: IndexedCall[] = [];
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    const synth = e.metadata?.synthesizedBy;
    if (!synth || synth === 'arkanalyzer') continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    out.push(toIndexedCall(e, s, t));
  }
  return out;
}

export function edgeMatchesGold(call: IndexedCall, gold: CallEdgeGold): boolean {
  if (normPath(call.callerFile) !== gold.callerFile) return false;
  if (normPath(call.calleeFile) !== gold.calleeFile) return false;
  if (!nameMatches(call.callerName, gold.callerName)) return false;
  if (!nameMatches(call.calleeName, gold.calleeName)) return false;
  if (gold.callerStart != null && call.callerStart !== gold.callerStart) {
    if (call.callerName === gold.callerName) return false;
  }
  if (gold.calleeStart != null && call.calleeStart !== gold.calleeStart) {
    if (call.calleeName === gold.calleeName) return false;
  }
  if (gold.dispatch != null && call.dispatch != null && call.dispatch !== gold.dispatch) {
    return false;
  }
  if (
    gold.synthesizedBy != null &&
    call.synthesizedBy != null &&
    call.synthesizedBy !== gold.synthesizedBy
  ) {
    return false;
  }
  return true;
}

export function findMatches(calls: IndexedCall[], gold: CallEdgeGold): IndexedCall[] {
  return calls.filter((c) => edgeMatchesGold(c, gold));
}

export function assertMustPresent(calls: IndexedCall[], golds: CallEdgeGold[]): void {
  const missing: string[] = [];
  const multi: string[] = [];
  for (const g of golds) {
    const hits = findMatches(calls, g);
    const label = goldLabel(g);
    if (hits.length === 0) missing.push(label);
    if (
      hits.length > 1 &&
      hits.every((h) => h.callerName === g.callerName && h.calleeName === g.calleeName)
    ) {
      multi.push(`${label} x${hits.length}`);
    }
  }
  expect(missing, `missing must edges:\n${missing.join('\n')}`).toEqual([]);
  expect(multi, `duplicate exact-name must edges:\n${multi.join('\n')}`).toEqual([]);
}

export function assertMustNotAbsent(calls: IndexedCall[], golds: CallEdgeGold[]): void {
  const violations: string[] = [];
  for (const g of golds) {
    if (findMatches(calls, g).length > 0) violations.push(goldLabel(g));
  }
  expect(violations, `must-not violations:\n${violations.join('\n')}`).toEqual([]);
}

/** Find definition-like nodes by file + name (AM wrappers OK). */
export function findNodes(
  nodes: Node[],
  file: string,
  name: string
): Node[] {
  const f = normPath(file);
  return nodes.filter(
    (n) => normPath(n.filePath) === f && nameMatches(n.name, name)
  );
}

export function assertNodeExists(nodes: Node[], file: string, name: string, hint?: string): void {
  const hits = findNodes(nodes, file, name);
  expect(
    hits.length,
    `expected node ${file}:${name}` + (hint ? ` (${hint})` : '')
  ).toBeGreaterThanOrEqual(1);
}

/** Outbound arkanalyzer calls whose caller matches file+name. */
export function outboundFrom(
  calls: IndexedCall[],
  callerFile: string,
  callerName: string
): IndexedCall[] {
  return calls.filter(
    (c) =>
      normPath(c.callerFile) === normPath(callerFile) &&
      nameMatches(c.callerName, callerName)
  );
}

/** Inbound arkanalyzer calls whose callee matches file+name. */
export function inboundTo(
  calls: IndexedCall[],
  calleeFile: string,
  calleeName: string
): IndexedCall[] {
  return calls.filter(
    (c) =>
      normPath(c.calleeFile) === normPath(calleeFile) &&
      nameMatches(c.calleeName, calleeName)
  );
}

export function uniqueCalleeKeys(calls: IndexedCall[]): string[] {
  return [
    ...new Set(calls.map((c) => `${normPath(c.calleeFile)}\0${c.calleeName}`)),
  ].sort();
}
