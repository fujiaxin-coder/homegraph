/**
 * Build ArkUI migrate snapshot from indexed HomeGraph nodes/edges (spec 0007).
 */

import type { Edge, Node } from '../types';
import {
  AUX_DECORATORS,
  COMPONENT_CONTAINER_DECORATORS,
  KEY_CHANNEL_DECORATORS,
  OBSERVATION_DECORATORS,
  TRACE_DECORATORS,
  channelOfKeyDecorator,
  decodeDecorators,
  mainStateDecorator,
  resolveKeyChannelKey,
  type AppChannel,
  type PassageType,
  type ValueTypeKind,
} from './migrate-semantics';

export const ARKUI_MIGRATE_SCHEMA_VERSION = 1 as const;

export const DEFAULT_DIRECTORY_COMPONENT_LIMIT = 40;

export interface ArkUIMigrateSnapshot {
  schemaVersion: typeof ARKUI_MIGRATE_SCHEMA_VERSION;
  scope: {
    query: string;
    resolved: 'component' | 'file' | 'directory' | 'none';
  };
  components: Array<{
    id: string;
    name: string;
    file: string;
    line: number;
    version?: 'V1' | 'V2';
    containerDecorator?: string;
    isEntry?: boolean;
    isReusable?: boolean;
    stateVars: Array<{
      id: string;
      name: string;
      type?: string;
      decorator: string;
      auxDecorators?: Array<{ kind: string; arg?: string }>;
      decoratorArg?: string;
    }>;
  }>;
  dataPassages: Array<{
    from: string;
    to: string;
    passageType: PassageType | string;
    valueType: ValueTypeKind | string;
    forcesMigration: boolean;
    parentExpression?: string;
    file?: string;
    line?: number;
  }>;
  keyChannels: Array<{
    key: string;
    channel: string;
    participants: string[];
  }>;
  observedClasses: Array<{
    id: string;
    name: string;
    observationDecorator: 'Observed' | 'ObservedV2';
    properties: Array<{
      name: string;
      type?: string;
      hasTrace?: boolean;
      traceDecorator?: string;
    }>;
    referencedBy: string[];
  }>;
  notes?: string[];
}

export interface MigrateSnapshotGraph {
  getNodesByKind(kind: Node['kind']): Node[];
  getNodesByName(name: string): Node[];
  getNodesInFile(filePath: string): Node[];
  getOutgoingEdges(nodeId: string): Edge[];
  getIncomingEdges(nodeId: string): Edge[];
  getNode(id: string): Node | null;
  getAllFiles?(): Array<{ path: string }>;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function isComponentNode(n: Node): boolean {
  if (n.kind === 'component') return true;
  if (n.kind !== 'struct' && n.kind !== 'class') return false;
  const { kinds } = decodeDecorators(n.decorators);
  return kinds.some((k) => COMPONENT_CONTAINER_DECORATORS.has(k));
}

function componentVersion(kinds: string[]): 'V1' | 'V2' | undefined {
  if (kinds.includes('ComponentV2')) return 'V2';
  if (kinds.includes('Component') || kinds.includes('CustomDialog')) return 'V1';
  return undefined;
}

function containerDecorator(kinds: string[]): string | undefined {
  return kinds.find((k) => COMPONENT_CONTAINER_DECORATORS.has(k));
}

function collectStateVarsForComponent(
  graph: MigrateSnapshotGraph,
  component: Node
): ArkUIMigrateSnapshot['components'][0]['stateVars'] {
  const fileNodes = graph.getNodesInFile(component.filePath);
  const structLike = fileNodes.find(
    (n) =>
      n.name === component.name &&
      (n.kind === 'struct' || n.kind === 'class') &&
      n.id !== component.id
  );
  const parentIds = new Set<string>([component.id]);
  if (structLike) parentIds.add(structLike.id);

  const fields: Node[] = [];
  for (const parentId of parentIds) {
    for (const e of graph.getOutgoingEdges(parentId)) {
      if (e.kind !== 'contains') continue;
      const child = graph.getNode(e.target);
      if (!child) continue;
      if (child.kind === 'property' || child.kind === 'field') fields.push(child);
    }
  }

  // Same-file fields that share the component name prefix in qualifiedName
  if (fields.length === 0) {
    for (const n of fileNodes) {
      if (n.kind !== 'property' && n.kind !== 'field') continue;
      if (n.qualifiedName?.includes(`${component.name}.`) || n.qualifiedName?.includes(`${component.name}::`)) {
        fields.push(n);
      }
    }
  }

  const out: ArkUIMigrateSnapshot['components'][0]['stateVars'] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.id)) continue;
    seen.add(field.id);
    const { kinds, argByKind } = decodeDecorators(field.decorators);
    const main = mainStateDecorator(kinds);
    if (!main) continue;
    const auxDecorators = kinds
      .filter((k) => AUX_DECORATORS.has(k))
      .map((kind) => {
        const arg = argByKind.get(kind);
        return arg ? { kind, arg } : { kind };
      });
    const parsedArg = argByKind.get(main);
    const decoratorArg = resolveKeyChannelKey(main, parsedArg, field.name) ?? parsedArg;
    out.push({
      id: field.id,
      name: field.name,
      type: field.signature,
      decorator: main,
      ...(auxDecorators.length > 0 ? { auxDecorators } : {}),
      ...(decoratorArg ? { decoratorArg } : {}),
    });
  }
  return out;
}

function parseRegisteredAt(registeredAt: unknown): { file?: string; line?: number } {
  if (typeof registeredAt !== 'string') return {};
  const idx = registeredAt.lastIndexOf(':');
  if (idx <= 0) return { file: registeredAt };
  const line = Number(registeredAt.slice(idx + 1));
  return {
    file: registeredAt.slice(0, idx),
    line: Number.isFinite(line) ? line : undefined,
  };
}

function isDataPassageEdge(e: Edge): boolean {
  const m = e.metadata;
  if (!m) return false;
  if (typeof m.passageType === 'string') return true;
  const via = m.via;
  return via === 'Prop' || via === 'Link' || via === 'data-passage' || via === 'builder-param';
}

function collectDataPassages(
  graph: MigrateSnapshotGraph,
  componentIds: Set<string>,
  stateVarIds: Set<string>
): ArkUIMigrateSnapshot['dataPassages'] {
  const out: ArkUIMigrateSnapshot['dataPassages'] = [];
  const seen = new Set<string>();

  const consider = (e: Edge) => {
    if (e.kind !== 'references' || !isDataPassageEdge(e)) return;
    const inScope =
      stateVarIds.has(e.source) ||
      stateVarIds.has(e.target) ||
      componentIds.has(e.source) ||
      componentIds.has(e.target);
    if (!inScope) return;
    const m = e.metadata ?? {};
    const passageType = (m.passageType as string) ??
      (m.via === 'builder-param' ? 'callback' : m.via === 'Link' ? 'state_variable_ref' : 'state_variable_ref');
    const valueType = (m.valueType as string) ?? 'unknown';
    const forcesMigration =
      typeof m.forcesMigration === 'boolean'
        ? m.forcesMigration
        : passageType === 'two_way_binding';
    const key = `${e.source}|${e.target}|${passageType}`;
    if (seen.has(key)) return;
    seen.add(key);
    const loc = parseRegisteredAt(m.registeredAt);
    out.push({
      from: e.source,
      to: e.target,
      passageType,
      valueType,
      forcesMigration,
      ...(typeof m.parentExpression === 'string' ? { parentExpression: m.parentExpression } : {}),
      ...loc,
    });
  };

  for (const id of [...stateVarIds, ...componentIds]) {
    for (const e of graph.getOutgoingEdges(id)) consider(e);
    for (const e of graph.getIncomingEdges(id)) consider(e);
  }
  return out;
}

function collectKeyChannels(
  graph: MigrateSnapshotGraph,
  stateVars: Array<{ id: string; name: string; decorator: string; decoratorArg?: string }>,
  componentIds: Set<string>
): ArkUIMigrateSnapshot['keyChannels'] {
  const groups = new Map<string, { key: string; channel: AppChannel | string; participants: Set<string> }>();

  for (const sv of stateVars) {
    if (!KEY_CHANNEL_DECORATORS.has(sv.decorator)) continue;
    // stateVars already carry implicit Provide/Consume name as decoratorArg (spec 0014);
    // resolve again so callers that pass raw fields stay correct.
    const key = resolveKeyChannelKey(sv.decorator, sv.decoratorArg, sv.name);
    if (!key) continue;
    const channel = channelOfKeyDecorator(sv.decorator);
    const gkey = `${channel}:${key}`;
    const g = groups.get(gkey) ?? {
      key,
      channel,
      participants: new Set<string>(),
    };
    g.participants.add(sv.id);
    groups.set(gkey, g);
  }

  // Storage API edges (index-time)
  for (const id of componentIds) {
    for (const e of graph.getOutgoingEdges(id)) {
      const m = e.metadata;
      if (!m || m.synthesizedBy !== 'arkui-migrate' || m.via !== 'storage-api') continue;
      const key = String(m.key ?? '');
      const channel = String(m.channel ?? '');
      if (!key || !channel) continue;
      const gkey = `${channel}:${key}`;
      const g = groups.get(gkey) ?? { key, channel, participants: new Set<string>() };
      g.participants.add(id);
      if (typeof e.target === 'string' && e.target !== id) g.participants.add(e.target);
      groups.set(gkey, g);
    }
  }

  return [...groups.values()].map((g) => ({
    key: g.key,
    channel: g.channel,
    participants: [...g.participants],
  }));
}

function isObservedClassOrStruct(n: Node): boolean {
  if (n.kind !== 'class' && n.kind !== 'struct') return false;
  const { kinds } = decodeDecorators(n.decorators);
  return kinds.some((k) => OBSERVATION_DECORATORS.has(k));
}

function isObservedRefEdge(e: Edge): boolean {
  return e.kind === 'references' && e.metadata?.via === 'observed-ref';
}

function observedClassProperties(
  graph: MigrateSnapshotGraph,
  clsId: string
): ArkUIMigrateSnapshot['observedClasses'][0]['properties'] {
  const properties: ArkUIMigrateSnapshot['observedClasses'][0]['properties'] = [];
  for (const e of graph.getOutgoingEdges(clsId)) {
    if (e.kind !== 'contains') continue;
    const field = graph.getNode(e.target);
    if (!field || (field.kind !== 'property' && field.kind !== 'field')) continue;
    const { kinds: fk } = decodeDecorators(field.decorators);
    const traceDecorator = fk.find((k) => TRACE_DECORATORS.has(k));
    properties.push({
      name: field.name,
      type: field.signature,
      hasTrace: !!traceDecorator,
      ...(traceDecorator ? { traceDecorator } : {}),
    });
  }
  return properties;
}

/**
 * Collect @Observed/@ObservedV2 classes for a migrate scope without scanning
 * the whole graph (spec 0013): reverse from stateVar observed-ref edges, plus
 * Observed types that live in scoped component files.
 */
function collectObserved(
  graph: MigrateSnapshotGraph,
  scopeNodes: Node[],
  stateVarIds: Set<string>
): ArkUIMigrateSnapshot['observedClasses'] {
  const fileSet = new Set(scopeNodes.map((n) => normalizePath(n.filePath)));
  const referencedByMap = new Map<string, Set<string>>();
  const classes = new Map<string, Node>();

  for (const stateVarId of stateVarIds) {
    for (const e of graph.getOutgoingEdges(stateVarId)) {
      if (!isObservedRefEdge(e)) continue;
      const cls = graph.getNode(e.target);
      if (!cls || !isObservedClassOrStruct(cls)) continue;
      classes.set(cls.id, cls);
      const refs = referencedByMap.get(cls.id) ?? new Set<string>();
      refs.add(stateVarId);
      referencedByMap.set(cls.id, refs);
    }
  }

  for (const filePath of fileSet) {
    for (const n of graph.getNodesInFile(filePath)) {
      if (!isObservedClassOrStruct(n)) continue;
      classes.set(n.id, n);
    }
  }

  const out: ArkUIMigrateSnapshot['observedClasses'] = [];
  for (const cls of classes.values()) {
    const { kinds } = decodeDecorators(cls.decorators);
    const observationDecorator = kinds.includes('ObservedV2') ? 'ObservedV2' : 'Observed';
    out.push({
      id: cls.id,
      name: cls.name,
      observationDecorator,
      properties: observedClassProperties(graph, cls.id),
      referencedBy: [...(referencedByMap.get(cls.id) ?? [])],
    });
  }
  return out;
}

function resolveScope(
  graph: MigrateSnapshotGraph,
  scope: string
): { resolved: ArkUIMigrateSnapshot['scope']['resolved']; components: Node[]; notes: string[] } {
  const query = scope.trim();
  const notes: string[] = [];
  if (!query) {
    return { resolved: 'none', components: [], notes: ['Empty scope'] };
  }

  const byName = graph
    .getNodesByName(query)
    .filter(isComponentNode);
  // Prefer kind=component when present
  const namedComponents =
    byName.filter((n) => n.kind === 'component').length > 0
      ? byName.filter((n) => n.kind === 'component')
      : byName;
  if (namedComponents.length > 0) {
    return { resolved: 'component', components: namedComponents, notes };
  }

  const norm = normalizePath(query).replace(/^\.\//, '');
  const allComponents = [
    ...graph.getNodesByKind('component'),
    ...graph.getNodesByKind('struct').filter(isComponentNode),
  ];
  // Dedupe by id
  const uniq = new Map<string, Node>();
  for (const c of allComponents) uniq.set(c.id, c);
  const components = [...uniq.values()];

  const fileHits = components.filter((c) => normalizePath(c.filePath) === norm);
  if (fileHits.length > 0) {
    return { resolved: 'file', components: fileHits, notes };
  }

  // Directory prefix
  const dirPrefix = norm.endsWith('/') ? norm : `${norm}/`;
  const dirHits = components.filter((c) => {
    const fp = normalizePath(c.filePath);
    return fp.startsWith(dirPrefix) || fp.startsWith(norm);
  });
  // Avoid treating a random string as directory when zero path-like hits and no slash
  if (dirHits.length > 0 && (norm.includes('/') || norm.includes('\\') || dirHits.length < components.length)) {
    if (dirHits.length > DEFAULT_DIRECTORY_COMPONENT_LIMIT) {
      notes.push(
        `Directory scope matched ${dirHits.length} components; returning first ${DEFAULT_DIRECTORY_COMPONENT_LIMIT}. Narrow scope.`
      );
      return {
        resolved: 'directory',
        components: dirHits.slice(0, DEFAULT_DIRECTORY_COMPONENT_LIMIT),
        notes,
      };
    }
    return { resolved: 'directory', components: dirHits, notes };
  }

  // Basename file match
  const baseHits = components.filter(
    (c) => normalizePath(c.filePath).endsWith(`/${norm}`) || normalizePath(c.filePath) === norm
  );
  if (baseHits.length > 0) {
    return { resolved: 'file', components: baseHits, notes };
  }

  notes.push(`No ArkUI component matched scope "${query}"`);
  return { resolved: 'none', components: [], notes };
}

/**
 * Assemble a migrate snapshot for a scope (component name, file path, or directory prefix).
 */
export function buildArkUIMigrateSnapshot(
  graph: MigrateSnapshotGraph,
  scope: string
): ArkUIMigrateSnapshot {
  const { resolved, components, notes } = resolveScope(graph, scope);
  const componentIds = new Set(components.map((c) => c.id));

  const componentViews: ArkUIMigrateSnapshot['components'] = components.map((c) => {
    const { kinds } = decodeDecorators(c.decorators);
    // Also merge struct-side decorators if component node lacks them
    const struct = graph
      .getNodesInFile(c.filePath)
      .find((n) => n.name === c.name && (n.kind === 'struct' || n.kind === 'class') && n.id !== c.id);
    const structKinds = struct ? decodeDecorators(struct.decorators).kinds : [];
    const allKinds = [...new Set([...kinds, ...structKinds])];
    return {
      id: c.id,
      name: c.name,
      file: c.filePath,
      line: c.startLine,
      version: componentVersion(allKinds),
      containerDecorator: containerDecorator(allKinds),
      isEntry: allKinds.includes('Entry') || undefined,
      isReusable: allKinds.includes('Reusable') || undefined,
      stateVars: collectStateVarsForComponent(graph, c),
    };
  });

  const stateVarsFlat = componentViews.flatMap((c) =>
    c.stateVars.map((sv) => ({
      id: sv.id,
      name: sv.name,
      decorator: sv.decorator,
      decoratorArg: sv.decoratorArg,
    }))
  );
  const stateVarIds = new Set(stateVarsFlat.map((s) => s.id));

  const dataPassages = collectDataPassages(graph, componentIds, stateVarIds);
  const keyChannels = collectKeyChannels(graph, stateVarsFlat, componentIds);
  const observedClasses = collectObserved(graph, components, stateVarIds);

  return {
    schemaVersion: ARKUI_MIGRATE_SCHEMA_VERSION,
    scope: { query: scope.trim(), resolved },
    components: componentViews,
    dataPassages,
    keyChannels,
    observedClasses,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
