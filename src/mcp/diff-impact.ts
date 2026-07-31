/**
 * Diff → changed-symbol impact helpers for `homegraph_diff_impact`.
 *
 * Parses unified diffs (new-side line ranges), intersects those ranges with
 * indexed symbol spans, and builds a capped evidence pack (callers / impact
 * summary / UI edges). Spec attachment is left to the MCP handler.
 */

import type { Edge, Node, NodeKind } from '../types';

/** Max chars accepted for the `diff` argument (DoS bound; still success-shaped). */
export const DIFF_IMPACT_MAX_DIFF_CHARS = 500_000;

export const DIFF_IMPACT_UI_SYNTHESIZED_BY = new Set([
  'viewtree',
  'arkui-state',
  'arkui-route',
  'arkui-emitter',
]);

/** Kinds that are almost never useful as "what changed" anchors for review. */
const SKIP_NODE_KINDS = new Set<NodeKind>([
  'file',
  'module',
  'parameter',
  'import',
  'export',
]);

export const DIFF_IMPACT_LIMITS = {
  maxSymbols: 80,
  maxCallersPerSymbol: 8,
  maxImpactSamples: 8,
  maxUiEdges: 40,
  maxSpecSymbols: 15,
} as const;

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface FileHunkRanges {
  /** Project-relative forward-slash path (no a/ b/ prefix). */
  path: string;
  ranges: LineRange[];
}

export interface DiffImpactChangedSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface DiffImpactCaller {
  symbol: string;
  callerName: string;
  callerFile: string;
  line: number | null;
}

export interface DiffImpactSummary {
  symbol: string;
  affectedCount: number;
  sampleNames: string[];
}

export interface DiffImpactUiEdge {
  source: string;
  sourceName: string;
  target: string;
  targetName: string;
  kind: string;
  synthesizedBy: string;
  via: string | null;
  line: number | null;
}

export interface DiffImpactPack {
  changedFiles: string[];
  hunks: FileHunkRanges[];
  changedSymbols: DiffImpactChangedSymbol[];
  callers: DiffImpactCaller[];
  impactSummary: DiffImpactSummary[];
  uiEdges: DiffImpactUiEdge[];
  truncated: {
    symbols: boolean;
    callers: boolean;
    impact: boolean;
    uiEdges: boolean;
  };
  notes: string[];
}

/**
 * Strip unified-diff path prefixes (`a/`, `b/`, `./`) and normalize slashes.
 */
export function normalizeDiffFilePath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/');
  if (p === '/dev/null' || p === 'nul' || p === 'NUL') return '';
  // git often emits "b/src/foo.ts\t" or with timestamps after a tab
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  p = p.replace(/^\.\//, '');
  return p;
}

/**
 * Parse unified diff text into per-file **new-side** (post-change) line ranges.
 * Pure deletions (new count 0) contribute no ranges but still list the file.
 */
export function parseUnifiedDiff(diff: string): { hunks: FileHunkRanges[]; notes: string[] } {
  const notes: string[] = [];
  const byFile = new Map<string, LineRange[]>();
  let currentPath = '';

  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const path = normalizeDiffFilePath(line.slice(4));
      currentPath = path;
      if (path && !byFile.has(path)) byFile.set(path, []);
      continue;
    }
    if (line.startsWith('--- ')) {
      // Prefer +++ when present; --- alone (e.g. unusual diffs) seeds the path.
      const path = normalizeDiffFilePath(line.slice(4));
      if (path && !currentPath) {
        currentPath = path;
        if (!byFile.has(path)) byFile.set(path, []);
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      currentPath = '';
      continue;
    }

    const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!m) continue;
    if (!currentPath) {
      notes.push('Skipped a hunk with no preceding +++ file path.');
      continue;
    }
    const newStart = parseInt(m[3]!, 10);
    const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
    if (newCount <= 0) {
      // Pure deletion on the new side — keep file listed, no line ranges.
      if (!byFile.has(currentPath)) byFile.set(currentPath, []);
      continue;
    }
    const ranges = byFile.get(currentPath) ?? [];
    ranges.push({
      startLine: newStart,
      endLine: newStart + newCount - 1,
    });
    byFile.set(currentPath, ranges);
  }

  const hunks: FileHunkRanges[] = [];
  for (const [path, ranges] of byFile) {
    hunks.push({ path, ranges: mergeRanges(ranges) });
  }
  hunks.sort((a, b) => a.path.localeCompare(b.path));
  return { hunks, notes };
}

/** Merge overlapping / adjacent line ranges. */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const out: LineRange[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, cur.endLine);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

export function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

export function nodeOverlapsRanges(node: Pick<Node, 'startLine' | 'endLine'>, ranges: LineRange[]): boolean {
  const span: LineRange = { startLine: node.startLine, endLine: node.endLine };
  return ranges.some((r) => rangesOverlap(span, r));
}

/**
 * Select indexed nodes whose spans intersect any changed line range.
 * Skips container/noise kinds. Prefers tighter (inner) symbols when sorting.
 */
export function selectChangedSymbols(
  nodesByFile: Map<string, Node[]>,
  hunks: FileHunkRanges[],
  limits: { maxSymbols: number } = { maxSymbols: DIFF_IMPACT_LIMITS.maxSymbols },
): { symbols: DiffImpactChangedSymbol[]; truncated: boolean } {
  const picked: DiffImpactChangedSymbol[] = [];
  for (const hunk of hunks) {
    if (hunk.ranges.length === 0) continue;
    const nodes = nodesByFile.get(hunk.path) ?? [];
    for (const n of nodes) {
      if (SKIP_NODE_KINDS.has(n.kind)) continue;
      if (!nodeOverlapsRanges(n, hunk.ranges)) continue;
      picked.push({
        id: n.id,
        name: n.name,
        kind: n.kind,
        filePath: n.filePath,
        startLine: n.startLine,
        endLine: n.endLine,
      });
    }
  }
  // Prefer smaller spans (inner defs) then earlier lines — review noise control.
  picked.sort(
    (a, b) =>
      (a.endLine - a.startLine) - (b.endLine - b.startLine) ||
      a.startLine - b.startLine ||
      a.name.localeCompare(b.name),
  );
  const truncated = picked.length > limits.maxSymbols;
  return {
    symbols: truncated ? picked.slice(0, limits.maxSymbols) : picked,
    truncated,
  };
}

export function isDiffImpactUiEdge(edge: Edge): boolean {
  if (edge.provenance !== 'heuristic') return false;
  const m = edge.metadata as Record<string, unknown> | undefined;
  const by = m?.synthesizedBy;
  return typeof by === 'string' && DIFF_IMPACT_UI_SYNTHESIZED_BY.has(by);
}

export interface DiffImpactGraph {
  getNodesInFile(filePath: string): Node[];
  getCallers(nodeId: string, maxDepth?: number): Array<{ node: Node; edge: Edge }>;
  getImpactRadius(nodeId: string, maxDepth?: number): { nodes: Map<string, Node> | Iterable<Node> | Node[] };
  getOutgoingEdges(nodeId: string): Edge[];
  getIncomingEdges(nodeId: string): Edge[];
  getNode?(nodeId: string): Node | null | undefined;
}

/**
 * Build the capped evidence pack from hunks + graph. Specs are not included.
 */
export function buildDiffImpactPack(
  graph: DiffImpactGraph,
  hunks: FileHunkRanges[],
  options: {
    depth?: number;
    notes?: string[];
    limits?: Partial<typeof DIFF_IMPACT_LIMITS>;
  } = {},
): DiffImpactPack {
  const limits = { ...DIFF_IMPACT_LIMITS, ...options.limits };
  const depth = Math.max(1, Math.min(options.depth ?? 2, 5));
  const notes = [...(options.notes ?? [])];

  const nodesByFile = new Map<string, Node[]>();
  for (const h of hunks) {
    try {
      nodesByFile.set(h.path, graph.getNodesInFile(h.path));
    } catch {
      nodesByFile.set(h.path, []);
      notes.push(`Could not load nodes for ${h.path}`);
    }
  }

  const { symbols, truncated: symbolsTruncated } = selectChangedSymbols(nodesByFile, hunks, {
    maxSymbols: limits.maxSymbols,
  });

  if (symbols.length === 0) {
    notes.push(
      hunks.some((h) => h.ranges.length > 0)
        ? 'No indexed symbols intersect the changed line ranges (index may be stale relative to the diff, or changes are non-symbol).'
        : 'Diff had no new-side line ranges (pure deletions or empty).',
    );
  }

  const symbolIds = new Set(symbols.map((s) => s.id));
  const nameById = new Map(symbols.map((s) => [s.id, s.name]));

  const callers: DiffImpactCaller[] = [];
  let callersTruncated = false;
  for (const sym of symbols) {
    let list: Array<{ node: Node; edge: Edge }> = [];
    try {
      list = graph.getCallers(sym.id, 1);
    } catch {
      continue;
    }
    if (list.length > limits.maxCallersPerSymbol) {
      callersTruncated = true;
      list = list.slice(0, limits.maxCallersPerSymbol);
    }
    for (const { node, edge } of list) {
      callers.push({
        symbol: sym.name,
        callerName: node.name,
        callerFile: node.filePath,
        line: edge.line ?? null,
      });
    }
  }

  const impactSummary: DiffImpactSummary[] = [];
  let impactTruncated = false;
  for (const sym of symbols) {
    try {
      const impact = graph.getImpactRadius(sym.id, depth);
      const nodes = normalizeImpactNodes(impact.nodes).filter((n) => n.id !== sym.id);
      if (nodes.length > limits.maxImpactSamples) impactTruncated = true;
      impactSummary.push({
        symbol: sym.name,
        affectedCount: nodes.length,
        sampleNames: nodes.slice(0, limits.maxImpactSamples).map((n) => n.name),
      });
    } catch {
      impactSummary.push({ symbol: sym.name, affectedCount: 0, sampleNames: [] });
    }
  }

  const uiEdges: DiffImpactUiEdge[] = [];
  const seenUi = new Set<string>();
  let uiTruncated = false;
  for (const sym of symbols) {
    if (uiEdges.length >= limits.maxUiEdges) {
      uiTruncated = true;
      break;
    }
    let edges: Edge[] = [];
    try {
      edges = [
        ...graph.getOutgoingEdges(sym.id),
        ...graph.getIncomingEdges(sym.id),
      ];
    } catch {
      continue;
    }
    for (const edge of edges) {
      if (!isDiffImpactUiEdge(edge)) continue;
      if (!symbolIds.has(edge.source) && !symbolIds.has(edge.target)) continue;
      const key = `${edge.source}>${edge.target}>${edge.kind}>${String((edge.metadata as Record<string, unknown> | undefined)?.via ?? '')}`;
      if (seenUi.has(key)) continue;
      seenUi.add(key);
      const m = edge.metadata as Record<string, unknown> | undefined;
      const sourceName =
        nameById.get(edge.source) ?? graph.getNode?.(edge.source)?.name ?? edge.source;
      const targetName =
        nameById.get(edge.target) ?? graph.getNode?.(edge.target)?.name ?? edge.target;
      uiEdges.push({
        source: edge.source,
        sourceName,
        target: edge.target,
        targetName,
        kind: edge.kind,
        synthesizedBy: String(m?.synthesizedBy ?? ''),
        via: typeof m?.via === 'string' ? m.via : null,
        line: edge.line ?? null,
      });
      if (uiEdges.length >= limits.maxUiEdges) {
        uiTruncated = true;
        break;
      }
    }
  }

  return {
    changedFiles: hunks.map((h) => h.path),
    hunks,
    changedSymbols: symbols,
    callers,
    impactSummary,
    uiEdges,
    truncated: {
      symbols: symbolsTruncated,
      callers: callersTruncated,
      impact: impactTruncated,
      uiEdges: uiTruncated,
    },
    notes,
  };
}

function normalizeImpactNodes(
  nodes: Map<string, Node> | Iterable<Node> | Node[],
): Node[] {
  if (Array.isArray(nodes)) return nodes;
  if (nodes instanceof Map) return Array.from(nodes.values());
  return Array.from(nodes);
}

/**
 * Accept either a unified `diff` string or explicit `hunks` from the agent.
 */
export function resolveDiffImpactHunks(args: {
  diff?: unknown;
  hunks?: unknown;
}): { hunks: FileHunkRanges[]; notes: string[]; error?: string } {
  if (typeof args.diff === 'string' && args.diff.length > 0) {
    if (args.diff.length > DIFF_IMPACT_MAX_DIFF_CHARS) {
      return {
        hunks: [],
        notes: [],
        error:
          `\`diff\` exceeds maximum length of ${DIFF_IMPACT_MAX_DIFF_CHARS} characters ` +
          `(got ${args.diff.length}). Pass a smaller unified diff (e.g. one PR file at a time).`,
      };
    }
    return parseUnifiedDiff(args.diff);
  }

  if (Array.isArray(args.hunks)) {
    const hunks: FileHunkRanges[] = [];
    const notes: string[] = [];
    for (const raw of args.hunks) {
      if (!raw || typeof raw !== 'object') {
        notes.push('Ignored a non-object hunk entry.');
        continue;
      }
      const rec = raw as Record<string, unknown>;
      const path =
        typeof rec.path === 'string'
          ? normalizeDiffFilePath(rec.path)
          : typeof rec.file === 'string'
            ? normalizeDiffFilePath(rec.file)
            : '';
      if (!path) {
        notes.push('Ignored a hunk with no path.');
        continue;
      }
      const startLine = Number(rec.startLine ?? rec.start);
      const endLine = Number(rec.endLine ?? rec.end ?? startLine);
      if (!Number.isFinite(startLine) || startLine < 1) {
        notes.push(`Ignored hunk for ${path}: invalid startLine.`);
        continue;
      }
      const end = Number.isFinite(endLine) && endLine >= startLine ? endLine : startLine;
      hunks.push({ path, ranges: [{ startLine, endLine: end }] });
    }
    // Merge by path
    const byPath = new Map<string, LineRange[]>();
    for (const h of hunks) {
      const list = byPath.get(h.path) ?? [];
      list.push(...h.ranges);
      byPath.set(h.path, list);
    }
    const merged: FileHunkRanges[] = [...byPath.entries()].map(([p, ranges]) => ({
      path: p,
      ranges: mergeRanges(ranges),
    }));
    merged.sort((a, b) => a.path.localeCompare(b.path));
    return { hunks: merged, notes };
  }

  return {
    hunks: [],
    notes: [],
    error:
      'Provide either `diff` (unified diff text) or `hunks` (array of { path, startLine, endLine }).',
  };
}
