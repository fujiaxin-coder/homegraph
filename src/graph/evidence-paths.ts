import type { Edge, EdgeKind, Node } from '../types';
import type { QueryPlan } from '../search/query-plan';

export type EvidencePathKind = 'calls' | 'events' | 'state' | 'structure';
export type EvidenceDirection = 'outgoing' | 'incoming' | 'either';
export interface EvidencePathGoal {
  kind: EvidencePathKind;
  direction: EvidenceDirection;
  anchorIds: string[];
  ambiguous: string[];
  limited: boolean;
}
export interface EvidencePath {
  id: string; nodeIds: string[]; edges: Edge[]; cost: number;
  /** Search orientation only; nodeIds and edges always retain actual graph direction. */
  orientation: 'outgoing' | 'incoming';
}
export interface EvidencePathSearch {
  goal: EvidencePathGoal;
  paths: EvidencePath[];
  neighbors: Edge[];
  missing: Array<{ from: string; to: string }>;
  stopReason: 'supported' | 'neighbors_only' | 'no_path_in_scope' | 'budget_exhausted' | 'ambiguous_anchors' | 'insufficient_anchors';
  limitsHit: string[];
  stats: { adjacencyReads: number; rowsRead: number; nodesVisited: number; durationMs: number };
}
export interface EvidencePathGraph {
  getNode(id: string): Node | null | undefined;
  getEdges(id: string, direction: 'outgoing' | 'incoming', kinds: EdgeKind[], limit: number, preferred: string[]): Edge[];
}
export const EVIDENCE_PATH_LIMITS = { anchors: 4, hops: 4, reads: 48, perNode: 24, nodes: 128, milliseconds: 60 };
const CONTAINERS = new Set(['class', 'struct', 'component', 'interface', 'enum']);
const STATES = new Set(['state-binding', 'Prop', 'Link', 'observed-ref', 'storage-api', 'data-passage']);
const STRUCTURAL_VIEW = new Set(['child-component', 'builder', 'builder-param', 'states']);

export function isEvidencePathNode(n: Node): boolean {
  return !['file', 'module', 'import', 'export', 'parameter'].includes(n.kind)
    && !n.filePath.startsWith('ohos-sdk:') && !/\.d\.(?:ts|ets)$/.test(n.filePath)
    && !n.filePath.includes('@dummy') && !n.name.startsWith('@dummy')
    && !(n.name === 'constructor' && n.startLine === 1 && n.endLine === 1);
}

/** Exact names may have been removed by generic search stopwords (e.g. Type.start).
 * Resolve through the qualified-name index, never by picking a bare-name overload.
 */
export function completeEvidencePathCandidates(query: string, nodes: Node[],
  lookup: (qualifiedName: string, limit: number) => Node[], plan?: QueryPlan): Node[] {
  const named = [...new Set([...(query.match(/[A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)+/g) ?? []),
    ...(plan?.anchors ?? []).filter(a => /\.|::/.test(a))])].slice(0, EVIDENCE_PATH_LIMITS.anchors);
  const extra: Node[] = [];
  for (const name of named) {
    for (const alias of new Set([name.replace(/::/g, '.'), name.replace(/\./g, '::')])) {
      extra.push(...lookup(alias, 25).filter(isEvidencePathNode));
    }
  }
  return [...new Map([...nodes, ...extra].map(n => [n.id, n])).values()];
}

/** Resolve only actual candidate identities; a bare homonym never selects the first hit. */
export function resolveEvidencePathGoal(query: string, nodes: Node[], focusIds: Set<string>, plan?: QueryPlan): EvidencePathGoal {
  const candidates = [...new Map(nodes.filter(isEvidencePathNode).map(n => [n.id, n])).values()];
  const mentions: Array<{ at: number; length: number; key: string; nodes: Node[] }> = [];
  const aliases = new Map<string, Node[]>();
  const normalize = (s: string) => s.replace(/::/g, '.');
  for (const node of candidates) {
    for (const alias of new Set([node.name, node.qualifiedName, normalize(node.qualifiedName)])) {
      if (!alias) continue;
      aliases.set(alias, [...(aliases.get(alias) ?? []), node]);
    }
  }
  for (const [alias, hits] of aliases) {
    let at = query.indexOf(alias);
    while (at >= 0) {
      const before = query[at - 1] ?? '';
      const after = query[at + alias.length] ?? '';
      if (!/[\w$.]/.test(before) && !/[\w$]/.test(after)) { mentions.push({ at, length: alias.length, key: alias, nodes: hits }); break; }
      at = query.indexOf(alias, at + 1);
    }
  }
  // Qualified Class.member owns the occurrence, not the nested Class/member words.
  const maximal = mentions.filter(m => !mentions.some(other => other !== m && other.at <= m.at
    && other.at + other.length >= m.at + m.length && other.length > m.length)).sort((a, b) => a.at - b.at || b.length - a.length);
  const selected: Node[] = [];
  const ambiguous: string[] = [];
  const bound = candidates.filter(n => plan?.bindings?.some(b => n.id === b.id && n.name === b.name && n.filePath === b.filePath
    && n.startLine === b.startLine && (!b.qualifiedName || n.qualifiedName === b.qualifiedName)));
  const owners = maximal.flatMap(m => m.nodes.length === 1 && CONTAINERS.has(m.nodes[0]!.kind) ? m.nodes : []);
  for (const mention of maximal) {
    let hits = [...new Map(mention.nodes.map(n => [`${n.filePath}:${n.startLine}:${n.name}`, n])).values()];
    if (hits.length > 1) {
      const scoped = hits.filter(n => query.includes(n.filePath) || owners.some(owner => owner.filePath === n.filePath
        && owner.startLine <= n.startLine && owner.endLine >= n.endLine));
      if (scoped.length) hits = scoped;
      const inherited = hits.filter(n => bound.some(b => b.id === n.id));
      if (inherited.length === 1) hits = inherited;
    }
    if (hits.length === 1) selected.push(hits[0]!);
    else ambiguous.push(mention.key);
  }
  // Bindings carry identity from preceding returned source; validate every field.
  for (const node of bound) if (!selected.some(n => n.id === node.id)) selected.push(node);
  const roots = selected.length || ambiguous.length ? selected : candidates.filter(n => focusIds.has(n.id));
  const leaves = [...new Map(roots.filter(n => !CONTAINERS.has(n.kind) || !roots.some(child => child.id !== n.id
    && child.filePath === n.filePath && child.startLine >= n.startLine && child.endLine <= n.endLine
    && !CONTAINERS.has(child.kind))).map(n => [n.id, n])).values()];
  const relation = plan?.relation;
  const direction: EvidenceDirection = relation === 'incoming_references' || relation === 'registration_sites' ? 'incoming'
    : relation === 'outgoing_calls' ? 'outgoing' : 'either';
  const kind: EvidencePathKind = relation === 'outgoing_calls' ? 'calls'
    : relation === 'registration_sites' || plan?.features.queryAsEventDispatchSurvey ? 'events'
      : leaves.some(n => n.kind === 'property' || n.kind === 'field') || plan?.features.queryAsAssignedFlagImpactSurvey ? 'state'
        : leaves.length > 0 && leaves.every(n => CONTAINERS.has(n.kind)) ? 'structure' : 'calls';
  return { kind, direction, anchorIds: leaves.slice(0, EVIDENCE_PATH_LIMITS.anchors).map(n => n.id),
    ambiguous: [...new Set(ambiguous)], limited: leaves.length > EVIDENCE_PATH_LIMITS.anchors };
}

/** Semantic admissibility is distinct from the non-probabilistic search cost. */
function edgeSemantics(edge: Edge): { state: boolean; event: boolean } {
  const via = typeof edge.metadata?.via === 'string' ? edge.metadata.via : '';
  const by = edge.metadata?.synthesizedBy;
  const state = by === 'arkui-state' || ((by === 'viewtree' || by === 'arkui-migrate')
    && (STATES.has(via) || typeof edge.metadata?.passageType === 'string'));
  const event = (by === 'viewtree' && !!via && !state && !STRUCTURAL_VIEW.has(via))
    || ['callback', 'event-emitter', 'closure-collection', 'fn-pointer-dispatch', 'arkui-emitter', 'arkui-common-event', 'arkui-taskpool'].includes(String(by));
  return { state, event };
}

export function evidenceEdgeCost(edge: Edge, goal: EvidencePathGoal): number | null {
  const { state, event } = edgeSemantics(edge);
  let relevanceCost: number;
  if (goal.kind === 'structure') {
    if (!['extends', 'implements', 'overrides', 'instantiates'].includes(edge.kind)) return null;
    relevanceCost = 0;
  } else if (goal.kind === 'state' && state && (edge.kind === 'references' || edge.kind === 'calls')) relevanceCost = 0;
  else if (edge.kind === 'calls' && !state) relevanceCost = goal.kind === 'events' ? 0.4 : goal.kind === 'state' ? 0.5 : 0;
  else if (edge.kind === 'references' && event) relevanceCost = goal.kind === 'events' ? 0 : 0.3;
  else return null;
  const reliabilityCost = edge.provenance === 'heuristic' ? 0.75
    : edge.provenance === 'tree-sitter' || edge.provenance === 'scip' ? 0 : 1;
  return 1 + relevanceCost + reliabilityCost;
}

export function evidenceEdgeKey(edge: Edge): string {
  return JSON.stringify([edge.source, edge.target, edge.kind, edge.line, edge.metadata?.synthesizedBy, edge.metadata?.via, edge.metadata?.registeredAt]);
}

/** One bounded search per request. Each orientation follows directed edges throughout. */
export function searchEvidencePaths(graph: EvidencePathGraph, goal: EvidencePathGoal,
  options: { now?: () => number; limits?: Partial<typeof EVIDENCE_PATH_LIMITS> } = {}): EvidencePathSearch {
  const limits = { ...EVIDENCE_PATH_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const started = now();
  const hits = new Set<string>();
  const stats = { adjacencyReads: 0, rowsRead: 0, nodesVisited: 0, durationMs: 0 };
  const nodeCache = new Map<string, Node | null>();
  const adjacency = new Map<string, Edge[]>();
  const neighbors = new Map<string, Edge>();
  const paths: EvidencePath[] = [];
  const missing: EvidencePathSearch['missing'] = [];
  const kinds: EdgeKind[] = goal.kind === 'structure' ? ['extends', 'implements', 'overrides', 'instantiates'] : ['calls', 'references'];
  const alive = () => {
    if (now() - started >= limits.milliseconds) { hits.add('time'); return false; }
    return true;
  };
  const node = (id: string): Node | null => {
    if (nodeCache.has(id)) return nodeCache.get(id)!;
    if (nodeCache.size >= limits.nodes) { hits.add('nodes'); return null; }
    const value = graph.getNode(id);
    const kept = value && isEvidencePathNode(value) ? value : null;
    nodeCache.set(id, kept); stats.nodesVisited = nodeCache.size;
    return kept;
  };
  const read = (id: string, direction: 'outgoing' | 'incoming'): Edge[] => {
    const key = `${direction}:${id}`;
    if (adjacency.has(key)) return adjacency.get(key)!;
    if (!alive()) return [];
    if (stats.adjacencyReads >= limits.reads) { hits.add('reads'); return []; }
    const rows = graph.getEdges(id, direction, kinds, limits.perNode + 1, goal.anchorIds);
    stats.adjacencyReads++; stats.rowsRead += rows.length;
    if (rows.length > limits.perNode) hits.add('neighbors');
    const valid = rows.slice(0, limits.perNode).filter(e => evidenceEdgeCost(e, goal) !== null
      && node(e.source) && node(e.target)).sort((a, b) => evidenceEdgeCost(a, goal)! - evidenceEdgeCost(b, goal)!
        || evidenceEdgeKey(a).localeCompare(evidenceEdgeKey(b)));
    adjacency.set(key, valid);
    return valid;
  };
  const directions: Array<'outgoing' | 'incoming'> = goal.direction === 'either' ? ['outgoing', 'incoming'] : [goal.direction];
  // Scoped one-hop evidence doubles as the direct-link fast path and bounded fallback.
  for (const id of goal.anchorIds) for (const direction of directions) {
    for (const edge of read(id, direction).slice(0, 8)) neighbors.set(evidenceEdgeKey(edge), edge);
  }
  type State = { id: string; ids: string[]; edges: Edge[]; cost: number; direction: 'outgoing' | 'incoming'; semantic: boolean };
  for (let pair = 1; pair < goal.anchorIds.length; pair++) {
    const from = goal.anchorIds[pair - 1]!; const to = goal.anchorIds[pair]!;
    const queue: State[] = directions.map(direction => ({ id: from, ids: [from], edges: [], cost: 0, direction,
      semantic: goal.kind === 'calls' || goal.kind === 'structure' }));
    const best = new Map<string, number>();
    let found: EvidencePath | undefined;
    while (queue.length && alive()) {
      queue.sort((a, b) => a.cost - b.cost || a.edges.length - b.edges.length || a.ids.join('/').localeCompare(b.ids.join('/')));
      const current = queue.shift()!;
      if (current.id === to && current.semantic) {
        found = { id: `path:${pair}`, nodeIds: current.direction === 'outgoing' ? current.ids : [...current.ids].reverse(),
          edges: current.direction === 'outgoing' ? current.edges : [...current.edges].reverse(), cost: current.cost, orientation: current.direction };
        break;
      }
      if (current.edges.length >= limits.hops) { hits.add('hops'); continue; }
      for (const edge of read(current.id, current.direction)) {
        const next = current.direction === 'outgoing' ? edge.target : edge.source;
        if (current.ids.includes(next)) continue;
        const cost = current.cost + evidenceEdgeCost(edge, goal)!;
        const semantics = edgeSemantics(edge);
        const semantic = current.semantic || (goal.kind === 'state' ? semantics.state : semantics.event);
        const key = `${current.direction}:${next}:${current.edges.length + 1}:${semantic}`;
        if (cost >= (best.get(key) ?? Infinity)) continue;
        best.set(key, cost);
        queue.push({ id: next, ids: [...current.ids, next], edges: [...current.edges, edge], cost, direction: current.direction, semantic });
      }
    }
    if (found) paths.push(found); else missing.push({ from, to });
  }
  if (goal.limited) hits.add('anchors');
  stats.durationMs = Math.max(0, now() - started);
  const hasGoalNeighbor = [...neighbors.values()].some(edge => goal.kind === 'state' ? edgeSemantics(edge).state
    : goal.kind === 'events' ? edgeSemantics(edge).event : true);
  const stopReason = goal.ambiguous.length ? 'ambiguous_anchors'
    : !goal.anchorIds.length ? 'insufficient_anchors'
      : missing.length ? hits.size ? 'budget_exhausted' : 'no_path_in_scope'
        : goal.limited || (goal.anchorIds.length === 1 && hits.size) ? 'budget_exhausted'
          : goal.anchorIds.length === 1 ? hasGoalNeighbor ? 'neighbors_only' : 'no_path_in_scope' : 'supported';
  return { goal, paths, neighbors: [...neighbors.values()], missing, stopReason, limitsHit: [...hits], stats };
}
