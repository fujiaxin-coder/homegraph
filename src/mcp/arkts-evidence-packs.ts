import { parseJson5Minimal } from '../extraction/languages/arkts';
import { implementationContextEnabled, controlEvidenceEnabled, collectImplementationContext, type SdkModule } from './implementation-context';
import * as path from 'node:path';
import { accuracyTargetsEnabled, accuracyCoverageEnabled, type RequestContract } from '../search/request-contract';
import { createRequestEvidenceInspector, renderRequestEvidence, type RequestEvidence, type RequestSource, inspectControlEvidence, renderControlEvidence, type ControlEvidence } from './request-evidence';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import type HomeGraph from '../index';
import type { Edge, Node } from '../types';
import { isConfigLeafNode, validatePathWithinRoot } from '../utils';
import { canonicalSourceDeclarations } from './evidence-rendering';
import { fileFingerprint, mergeRanges } from './explore-dedup';
import type { ExploreEmission, ExploreFileEmission } from './explore-session-state';
import { evidenceEdgeKey, type EvidencePathSearch } from '../graph/evidence-paths';

export type EvidenceGapReason = 'budget' | 'unavailable' | 'stale' | 'invalid_range'
  | 'scope_limit' | 'unindexed_connection' | 'registration_source' | 'ambiguous_anchor';
export interface EvidenceGap { target: string; reason: EvidenceGapReason; nextAnchor: string }
interface SourceUnit {
  id: string; node: Node; start: number; end: number; source: string; fingerprint: string; snapshot?: boolean;
}
interface RelationEvidence {
  source: string; target: string; kind: Edge['kind']; provenance?: Edge['provenance']; via?: string; site?: string;
}
interface EvidencePack {
  id: string; label: string; sources: string[]; priority: number; gaps: EvidenceGap[];
  context?: { label: string; notes: string[]; sdk?: { module: string; version: string; nodes: Node[] } };
  relation?: RelationEvidence;
  path?: { id: string; nodeIds: string[]; relations: RelationEvidence[] };
}
export interface ArktsEvidenceResult {
  text: string;
  emission: ExploreEmission;
  metadata: {
    version: 1 | 2; scope: 'bounded_static_evidence'; status: 'complete' | 'partial' | 'empty';
    requestEvidence?: RequestEvidence;
    controls?: ControlEvidence[];
    implementationContext?: Array<NonNullable<EvidencePack['context']>>;
    selectedPacks: string[]; gaps: EvidenceGap[]; relations: NonNullable<EvidencePack['relation']>[];
    pathSearch?: { goal: EvidencePathSearch['goal']; stopReason: string; limitsHit: string[]; stats: EvidencePathSearch['stats'];
      paths: Array<{ id: string; nodeIds: string[]; cost: number; evidence: 'provided' | 'partial' }> };
  };
}

const LIMITS = { nodes: 36, expand: 12, edges: 48, files: 8, fileBytes: 512 * 1024, bytes: 2 * 1024 * 1024 };
const BASE_DECLARATIONS = new Set(['class', 'struct', 'component', 'interface', 'method', 'function', 'property', 'field', 'constant', 'variable', 'enum']);
const CONTAINERS = new Set(['class', 'struct', 'component', 'interface', 'enum']);
const RELATIONS = new Set(['calls', 'references', 'extends', 'implements', 'instantiates']);
const inline = (s: string): string => s.replace(/[`\r\n]/g, ' ');
const location = (n: Node): string => `${n.filePath}:${n.startLine}`;
const label = (n: Node): string => `${n.qualifiedName || n.name} @ ${location(n)}`;
const local = (n: Node): boolean => !n.filePath.startsWith('ohos-sdk:') && !/\.d\.(?:ts|ets)$/i.test(n.filePath) && !isConfigLeafNode(n);
// ArkAnalyzer's virtual entry/implicit constructor has no declaration on disk.
// Explicit constructors with a real range remain available through the normal renderer.
const artifact = (n: Node): boolean => n.filePath.includes('@dummy') || n.name.startsWith('@dummy')
  || /^%AM\d+/i.test(n.name)
  || (n.name === 'constructor' && n.startLine === 1 && n.endLine === 1);

/** Consume already-located nodes. No text search, new planner call or recursive retrieval. */
export function buildArktsEvidencePacks(
  graph: Pick<HomeGraph, 'getNode' | 'getNodesInFile' | 'getFile' | 'getOutgoingEdges' | 'getIncomingEdges'>,
  options: { projectRoot: string; query: string; nodes: Node[]; focusIds: Set<string>; maxChars: number; maxFiles?: number; pathSearch?: EvidencePathSearch; requestContract?: RequestContract; sdkModule?: (module: string) => SdkModule | undefined },
): ArktsEvidenceResult | null {
  const contextEnabled = implementationContextEnabled();
  const DECLARATIONS = contextEnabled ? new Set([...BASE_DECLARATIONS, 'type_alias', 'import', 'export', 'route', 'file']) : BASE_DECLARATIONS;
  if (!options.nodes.some(n => local(n) && /\.ets$/i.test(n.filePath) && DECLARATIONS.has(n.kind))) return null;
  const search = options.pathSearch;
  const targetChecks = accuracyTargetsEnabled(); const behaviorChecks = accuracyCoverageEnabled();
  const inspector = options.requestContract && (targetChecks || behaviorChecks)
    ? createRequestEvidenceInspector(options.requestContract) : undefined;
  const requestSources = new Map<SourceUnit, RequestSource>();
  const requestUnit = (s: SourceUnit): RequestSource => {
    let unit = requestSources.get(s);
    if (!unit) { unit = { filePath: s.node.filePath, start: s.start, source: s.source }; requestSources.set(s, unit); }
    return unit;
  };
  const requiredIds = search ? new Set([...search.goal.anchorIds, ...search.paths.flatMap(p => p.nodeIds)]) : options.focusIds;
  const inputNodes = search && requiredIds.size ? [...requiredIds].flatMap(id => { const n = graph.getNode(id); return n ? [n] : []; }) : options.nodes;
  const all = canonicalSourceDeclarations(inputNodes.filter(n => DECLARATIONS.has(n.kind) && local(n) && !artifact(n)));
  if (!all.length) return null;
  const inputOrder = new Map(all.map((node, index) => [node.id, index]));
  const candidates = all.sort((a, b) => Number(requiredIds.has(b.id)) - Number(requiredIds.has(a.id))
    || (inspector && targetChecks ? inputOrder.get(a.id)! - inputOrder.get(b.id)! : a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)).slice(0, LIMITS.nodes);
  const focus = candidates.filter(n => requiredIds.has(n.id));
  // A named owning type provides scope for its named members, not another
  // callable endpoint. Do not invent a missing Type→method call obligation.
  const relationFocus = focus.filter(n => !CONTAINERS.has(n.kind) || !focus.some(child => child.id !== n.id
    && child.filePath === n.filePath && child.startLine >= n.startLine && child.endLine <= n.endLine
    && !CONTAINERS.has(child.kind)));
  const packs: EvidencePack[] = [];
  const sources = new Map<string, SourceUnit>();
  const nodeSources = new Map<string, { id?: string; gap?: EvidenceGap }>();
  const fileCache = new Map<string, { content?: string; lines?: string[]; fingerprint?: string; reason?: EvidenceGapReason }>();
  const globalGaps: EvidenceGap[] = [];
  let bytesRead = 0;
  const root = realpathSync(options.projectRoot);
  const maxFiles = Math.max(1, Math.min(LIMITS.files, options.maxFiles ?? LIMITS.files));
  const readSource = (node: Node, snapshot = false): { id?: string; gap?: EvidenceGap } => {
    const previous = nodeSources.get(node.id);
    if (previous) return previous;
    if ((!local(node) && !(contextEnabled && (snapshot || node.kind === 'route' || (!node.filePath.startsWith('ohos-sdk:') && /\.d\.(?:ts|ets)$/.test(node.filePath))))) || artifact(node) || !DECLARATIONS.has(node.kind)) {
      const failure = { gap: { target: label(node), reason: 'unavailable' as const, nextAnchor: location(node) } };
      nodeSources.set(node.id, failure);
      return failure;
    }
    let file = fileCache.get(node.filePath);
    if (!file) {
      file = {};
      try {
        const absolute = validatePathWithinRoot(root, node.filePath);
        if (!absolute) {
          file.reason = 'unavailable';
        } else {
          const stat = statSync(absolute);
          const size = stat.size;
          if (!stat.isFile()) file.reason = 'unavailable';
          else if (fileCache.size >= maxFiles || size > LIMITS.fileBytes || bytesRead + size > LIMITS.bytes) file.reason = 'scope_limit';
          else {
            // A file growing after stat must not turn a bounded read into an unbounded one.
            const descriptor = openSync(absolute, 'r');
            const buffer = Buffer.alloc(size + 1);
            let bytes = 0;
            try {
              while (bytes < buffer.length) {
                const read = readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
                if (read === 0) break;
                bytes += read;
              }
            } finally { closeSync(descriptor); }
            bytesRead += bytes;
            const content = buffer.subarray(0, bytes).toString('utf8');
            const indexed = graph.getFile(node.filePath);
            // Hash equality, not mtime: edits can retain timestamps and invalidate ranges.
            if (bytes !== size || (!snapshot && (!indexed || indexed.contentHash !== createHash('sha256').update(content).digest('hex')))) file.reason = 'stale';
            else file = { content, lines: content.split('\n'), fingerprint: fileFingerprint(content) };
          }
        }
      } catch { file.reason = 'unavailable'; }
      fileCache.set(node.filePath, file);
    }
    if ((snapshot || node.kind === 'file') && file.lines) node = { ...node, endLine: file.lines.length };
    if (node.kind === 'import' && file.lines) {
      const head = file.lines.slice(node.startLine - 1, node.startLine + 20).join('\n');
      const importText = head.match(/^\s*import\s+[\s\S]*?\bfrom\s*['"][^'"\r\n]+['"][^\S\r\n]*;?/);
      if (importText) node = { ...node, endLine: node.startLine + importText[0].split('\n').length - 1 };
    }
    const reason = file.reason ?? (!Number.isInteger(node.startLine) || !Number.isInteger(node.endLine)
      || node.startLine < 1 || node.endLine < node.startLine || node.endLine > file.lines!.length
      || !file.lines!.slice(node.startLine - 1, node.endLine).join('\n').trim() ? 'invalid_range' : undefined);
    if (reason) {
      const failure = { gap: { target: label(node), reason, nextAnchor: location(node) } };
      nodeSources.set(node.id, failure);
      return failure;
    }
    // Preserve contiguous ArkTS decorators when the extractor starts at the declaration.
    let start = node.startLine;
    while (start > 1 && /^\s*@\w+(?:\([^\n]*\))?\s*$/.test(file.lines![start - 2]!)) start--;
    const id = `${node.filePath}:${start}-${node.endLine}`;
    if (!sources.has(id)) sources.set(id, { id, node, start, end: node.endLine,
      source: file.lines!.slice(start - 1, node.endLine).join('\n'), fingerprint: file.fingerprint!, ...(snapshot ? { snapshot: true } : {}) });
    const result = { id };
    nodeSources.set(node.id, result);
    return result;
  };
  const dependencies = (nodes: Node[]): { sources: string[]; gaps: EvidenceGap[] } => {
    const resolved = nodes.map(n => readSource(n));
    return { sources: [...new Set(resolved.flatMap(s => s.id ? [s.id] : []))],
      gaps: resolved.flatMap(s => s.gap ? [s.gap] : []) };
  };

  // Read focused declarations before peripheral endpoints spend the file-read allowance.
  for (const n of candidates) packs.push({ id: `source:${n.id}`, label: label(n),
    priority: requiredIds.has(n.id) ? 80 : 20, ...dependencies([n]) });
  if (all.length > candidates.length) globalGaps.push({ target: `${all.length - candidates.length} additional candidates`,
    reason: 'scope_limit', nextAnchor: location(all[candidates.length]!) });

  const configNode = (file: string): Node => ({ id: `context-config:${file}`, kind: 'constant', name: file, qualifiedName: file,
    filePath: file, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0, language: 'yaml' });
  const manifestCache = new Map<string, Node | undefined>();
  const nearestManifest = (file: string): Node | undefined => {
    if (manifestCache.has(file)) return manifestCache.get(file);
    let dir = path.posix.dirname(file.replace(/\\/g, '/')); let found: Node | undefined;
    for (let depth = 0; depth < 12; depth++) {
      const manifest = path.posix.join(dir, 'oh-package.json5');
      const absolute = validatePathWithinRoot(root, manifest);
      try { if (absolute && statSync(absolute).isFile()) { found = configNode(manifest); break; } } catch { /* absent */ }
      if (dir === '.') break; dir = path.posix.dirname(dir);
    }
    manifestCache.set(file, found); return found;
  };
  const configValue = (node: Node): Record<string, unknown> | undefined => {
    const r = readSource(node, true); if (!r.id) return undefined;
    try { const value = parseJson5Minimal(sources.get(r.id)!.source); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
    catch { return undefined; }
  };
  const moduleBinding = (importer: string, module: string) => {
    const manifest = nearestManifest(importer); if (!manifest) return undefined;
    const config = configValue(manifest); const deps = config?.dependencies;
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return undefined;
    const dep = (deps as Record<string, unknown>)[module];
    if (typeof dep !== 'string' || !/^file:\.{1,2}\//.test(dep)) return undefined;
    const depRoot = path.posix.normalize(path.posix.join(path.posix.dirname(manifest.filePath), dep.slice(5)));
    if (depRoot === '..' || depRoot.startsWith('../') || path.posix.isAbsolute(depRoot)) return undefined;
    const targetManifest = configNode(path.posix.join(depRoot, 'oh-package.json5'));
    const target = configValue(targetManifest); if (!target) return undefined;
    const entry = typeof target.main === 'string' ? path.posix.join(depRoot, target.main) : depRoot;
    const relativePath = './' + path.posix.relative(path.posix.dirname(importer), entry);
    return { relativePath, witnesses: [manifest, targetManifest] };
  };
  const contextGroups = contextEnabled ? collectImplementationContext(graph, focus.length ? focus : candidates,
    node => { const r = readSource(node); return r.id ? sources.get(r.id)?.source : undefined; }, options.sdkModule, moduleBinding) : [];
  for (const group of contextGroups) {
    const deps = dependencies(group.nodes);
    packs.push({ id: group.id, label: group.label, priority: 130, ...deps,
      context: { label: group.label, notes: [...group.notes, ...group.missing.map(m => `Unresolved: ${m}`)], ...(group.sdk ? { sdk: group.sdk } : {}) } });
    for (const missing of group.missing) globalGaps.push({ target: missing, reason: 'unindexed_connection', nextAnchor: missing });
  }
  // Only ancestor manifests of the located code; no workspace traversal or credential files.
  const configs = new Set<string>();
  for (const node of contextEnabled && contextGroups.some(g => g.id.startsWith('impl-import:')) ? (focus.length ? focus : candidates).slice(0, 3) : []) {
    let dir = path.posix.dirname(node.filePath.replace(/\\/g, '/'));
    for (let depth = 0; depth < 12; depth++) {
      const manifest = path.posix.join(dir, 'oh-package.json5');
      const absolute = validatePathWithinRoot(root, manifest);
      try {
        if (absolute && statSync(absolute).isFile()) { configs.add(manifest); break; }
      } catch { /* missing ancestor manifest */ }
      if (dir === '.') break;
      dir = path.posix.dirname(dir);
    }
  }
  if (configs.size) configs.add('build-profile.json5');
  for (const config of configs) {
    const node: Node = { id: `context-config:${config}`, kind: 'constant', name: config, qualifiedName: config,
      filePath: config, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: Date.now(), language: 'yaml' };
    const dep = readSource(node, true);
    if (dep.id) packs.push({ id: node.id, label: `module/version configuration ${config}`, priority: 125, sources: [dep.id], gaps: [],
      context: { label: `module/version configuration ${config}`, notes: ['Current configuration snapshot; declared dependencies do not prove installation or export availability.'] } });
    else if (dep.gap && dep.gap.reason !== 'unavailable') globalGaps.push(dep.gap);
  }

  const candidateIds = new Set(candidates.map(n => n.id));
  const edges: Edge[] = [];
  const edgeKeys = new Set<string>();
  let edgesLimited = false;
  for (const n of search ? [] : (relationFocus.length ? relationFocus : candidates).slice(0, LIMITS.expand)) {
    const adjacent = [...graph.getOutgoingEdges(n.id), ...graph.getIncomingEdges(n.id)];
    for (const edge of adjacent) {
      if (!RELATIONS.has(edge.kind)) continue;
      const from = graph.getNode(edge.source); const to = graph.getNode(edge.target);
      if ((from && artifact(from)) || (to && artifact(to))) continue;
      const key = JSON.stringify([edge.source, edge.target, edge.kind, edge.line, edge.metadata?.registeredAt]);
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      if (edges.length >= LIMITS.edges) { edgesLimited = true; continue; }
      edges.push(edge);
    }
  }
  for (const group of contextGroups) for (const edge of group.edges) {
    if (edge.kind === 'imports') continue;
    const key = evidenceEdgeKey(edge);
    if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push(edge); }
  }
  if (search) {
    const fallbackNeighbors = search.missing.length || search.goal.anchorIds.length < 2 ? search.neighbors : [];
    for (const edge of [...search.paths.flatMap(p => p.edges), ...fallbackNeighbors]) {
      const key = evidenceEdgeKey(edge);
      if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push(edge); }
    }
    for (const pair of search.missing) {
      const from = graph.getNode(pair.from); const to = graph.getNode(pair.to);
      globalGaps.push({ target: `${search.goal.kind} path: ${from ? label(from) : pair.from} → ${to ? label(to) : pair.to}`,
        reason: search.stopReason === 'budget_exhausted' ? 'scope_limit' : 'unindexed_connection', nextAnchor: to ? location(to) : pair.to });
    }
    for (const name of search.goal.ambiguous) globalGaps.push({ target: `qualify the symbol with its owning type or file: ${name}`,
      reason: 'ambiguous_anchor', nextAnchor: name });
    if (search.goal.limited || (search.goal.anchorIds.length < 2 && search.stopReason === 'budget_exhausted')) {
      globalGaps.push({ target: `query path search limit: ${search.limitsHit.join(', ')}`, reason: 'scope_limit', nextAnchor: location(candidates[0]!) });
    }
    if (!search.missing.length && !search.goal.ambiguous.length && (search.stopReason === 'no_path_in_scope'
      || (!search.paths.length && !search.neighbors.length))) {
      globalGaps.push({ target: `no ${search.goal.kind} relation in the bounded scope`, reason: 'unindexed_connection', nextAnchor: location(candidates[0]!) });
    }
  }
  if (!search && (edgesLimited || relationFocus.length > LIMITS.expand)) globalGaps.push({ target: 'additional graph neighbors', reason: 'scope_limit',
    nextAnchor: location(relationFocus[0] ?? candidates[0]!) });

  const connected = new Set<string>();
  const relationPacks = new Map<string, EvidencePack>();
  edges.sort((a, b) => Number(candidateIds.has(b.source) && candidateIds.has(b.target))
    - Number(candidateIds.has(a.source) && candidateIds.has(a.target)));
  for (const [i, edge] of edges.entries()) {
    const from = graph.getNode(edge.source);
    const to = graph.getNode(edge.target);
    if (!from || !to || (!local(from) && from.kind !== 'route') || (!local(to) && to.kind !== 'route')) {
      globalGaps.push({ target: `${from ? label(from) : edge.source} ${edge.kind} ${to ? label(to) : edge.target}`,
        reason: 'unavailable', nextAnchor: from ? location(from) : edge.source });
      continue;
    }
    const required = [from, to];
    const gaps: EvidenceGap[] = [];
    const registration = edge.metadata?.registeredAt;
    if (typeof registration === 'string') {
      const match = registration.match(/^(.*):(\d+)$/);
      const line = match ? Number(match[2]) : 0;
      const owner = match ? graph.getNodesInFile(match[1]!).filter(n => DECLARATIONS.has(n.kind)
        && n.startLine <= line && n.endLine >= line).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0] : undefined;
      if (owner) required.push(owner);
      else gaps.push({ target: `registration at ${registration}`, reason: 'registration_source', nextAnchor: registration });
    } else if (edge.line && (edge.line < from.startLine || edge.line > from.endLine)) {
      const owner = graph.getNodesInFile(from.filePath).filter(n => DECLARATIONS.has(n.kind)
        && n.startLine <= edge.line! && n.endLine >= edge.line!).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      if (owner) required.push(owner);
      else gaps.push({ target: `relation site ${from.filePath}:${edge.line}`, reason: 'registration_source', nextAnchor: `${from.filePath}:${edge.line}` });
    }
    const deps = dependencies(required);
    connected.add(from.id); connected.add(to.id);
    const state = edge.metadata?.synthesizedBy === 'viewtree' && edge.metadata?.via === 'Prop'
      ? 'state: @Prop one-way' : edge.metadata?.synthesizedBy === 'viewtree' && edge.metadata?.via === 'Link'
        ? 'state: @Link two-way' : '';
    const via = [edge.metadata?.synthesizedBy, edge.metadata?.via, state].filter(v => typeof v === 'string' && v).join('/');
    const site = typeof registration === 'string' ? registration : edge.line ? `${from.filePath}:${edge.line}` : undefined;
    packs.push({ id: `relation:${i}`, label: `${label(from)} → ${edge.kind} → ${label(to)}`,
      priority: candidateIds.has(from.id) && candidateIds.has(to.id) ? 100 : 60,
      sources: deps.sources, gaps: [...deps.gaps, ...gaps],
      relation: { source: from.id, target: to.id, kind: edge.kind, provenance: edge.provenance, ...(via ? { via } : {}), ...(site ? { site } : {}) } });
    relationPacks.set(evidenceEdgeKey(edge), packs[packs.length - 1]!);
  }
  for (const path of search?.paths ?? []) {
    const members = path.edges.map(e => relationPacks.get(evidenceEdgeKey(e)));
    const missing = members.some(p => !p);
    const target = path.nodeIds.map(id => { const n = graph.getNode(id); return n ? label(n) : id; }).join(' → ');
    packs.push({ id: path.id, label: `directed ${search!.goal.kind} path: ${target}`, priority: 160,
      sources: [...new Set(members.flatMap(p => p?.sources ?? []))],
      gaps: missing ? [{ target, reason: 'unavailable', nextAnchor: target }] : members.flatMap(p => p!.gaps),
      path: { id: path.id, nodeIds: path.nodeIds, relations: members.flatMap(p => p?.relation ? [p.relation] : []) } });
  }
  for (const n of search ? [] : relationFocus) if (!connected.has(n.id)) globalGaps.push({ target: `call/use connection for ${label(n)}`,
    reason: 'unindexed_connection', nextAnchor: location(n) });
  // Individual neighbors do not prove that two requested anchors are connected.
  if (!search && relationFocus.length > 1) {
    const reached = new Set([relationFocus[0]!.id]);
    for (let i = 0; i < edges.length; i++) {
      let changed = false;
      for (const e of edges) if (reached.has(e.source) || reached.has(e.target)) {
        if (!reached.has(e.source) || !reached.has(e.target)) changed = true;
        reached.add(e.source); reached.add(e.target);
      }
      if (!changed) break;
    }
    const disconnected = relationFocus.filter(n => !reached.has(n.id));
    if (disconnected.length) globalGaps.push({ target: `connecting path in the bounded graph slice: ${label(relationFocus[0]!)} → ${label(disconnected[0]!)}`,
      reason: 'unindexed_connection', nextAnchor: location(disconnected[0]!) });
  }

  // Rank already-read, hash-verified declarations by joint targets in the same file.
  // Never discard a dependent helper merely because it has no UI label.
  if (inspector && targetChecks) {
    const byFile = new Map<string, RequestSource[]>();
    for (const unit of sources.values()) {
      const list = byFile.get(unit.node.filePath) ?? [];
      list.push(requestUnit(unit)); byFile.set(unit.node.filePath, list);
    }
    const scores = new Map([...byFile].map(([file, units]) => [file, inspector.score(units)]));
    for (const pack of packs) pack.priority += 30 * Math.max(0, ...pack.sources.map(id => scores.get(sources.get(id)!.node.filePath) ?? 0));
  }
  const selected: EvidencePack[] = [];
  const rejectedGap = (p: EvidencePack): EvidenceGap[] => p.gaps.length ? p.gaps : [{ target: p.label, reason: 'budget',
    nextAnchor: sources.get(p.sources[0] ?? '') ? location(sources.get(p.sources[0]!)!.node) : p.label }];
  const gapsFor = (chosen: EvidencePack[]): EvidenceGap[] => {
    const ids = new Set(chosen.map(p => p.id));
    return [...new Map([...globalGaps, ...packs.filter(p => !ids.has(p.id)).flatMap(rejectedGap)]
      .map(g => [`${g.reason}:${g.target}`, g])).values()];
  };
  const unitsFor = (chosen: EvidencePack[]): SourceUnit[] => {
    const units = [...new Set(chosen.flatMap(p => p.sources))].map(id => sources.get(id)!);
    // A complete enclosing declaration already contains the nested declaration.
    return units.filter(s => !units.some(other => other.id !== s.id && other.node.filePath === s.node.filePath
      && other.start <= s.start && other.end >= s.end)).sort((a, b) => a.node.filePath.localeCompare(b.node.filePath) || a.start - b.start);
  };
  const controlCache = new Map<SourceUnit, ControlEvidence[]>();
  const controlsFor = (chosen: EvidencePack[]): ControlEvidence[] => unitsFor(chosen).flatMap(unit => {
    if (!controlCache.has(unit)) controlCache.set(unit, inspectControlEvidence([requestUnit(unit)]));
    return controlCache.get(unit)!;
  }).slice(0, 8);
  const relationsFor = (chosen: EvidencePack[]): RelationEvidence[] => [...new Map(chosen.flatMap(p => p.path?.relations ?? (p.relation ? [p.relation] : []))
    .map(r => [JSON.stringify(r), r])).values()];
  const stopFor = (chosen: EvidencePack[]): string => search?.stopReason === 'supported'
    && search.paths.some(p => !chosen.some(c => c.path?.id === p.id)) ? 'source_incomplete' : search?.stopReason ?? '';
  const render = (chosen: EvidencePack[]): string => {
    const gaps = gapsFor(chosen);
    const lines = ['**ArkTS evidence packs**', gaps.length ? '> **Partial locator** — explicit gaps below.' : '> Bounded evidence supplied for the selected declarations and static links.',
      'Complete declarations preserve internal branches. Enclosing callers and runtime order/value flow are not proven. Retrieval is not task completion.'];
    if (search) lines.push(`Path goal: ${search.goal.kind}; search direction: ${search.goal.direction}; stop: ${stopFor(chosen)}. Static paths do not prove runtime behavior.`);
    if (inspector) lines.push(...renderRequestEvidence(inspector.inspect(unitsFor(chosen).map(requestUnit)), targetChecks, behaviorChecks));
    if (controlEvidenceEnabled()) lines.push(...renderControlEvidence(controlsFor(chosen)));
    for (const pack of chosen.filter(p => p.context)) {
      lines.push(`**Implementation context: ${inline(pack.context!.label)}**`, ...pack.context!.notes.map(n => `- ${inline(n)}`));
      const sdk = pack.context!.sdk;
      if (sdk) lines.push(`Indexed SDK signatures for ${inline(sdk.module)}; database version ${inline(sdk.version)}. Not source bodies or device validation.`,
        ...sdk.nodes.map(n => `- ${inline(n.filePath)}:${n.startLine} ${inline(n.signature || n.name)}${n.docstring ? ` — ${inline(n.docstring).slice(0, 500)}${n.docstring.length > 500 ? ' [documentation excerpt; remaining constraints not shown]' : ''}` : ''}`));
    }
    const chosenPaths = chosen.filter(p => p.path);
    if (chosenPaths.length) lines.push('**Directed paths (all source dependencies provided)**', ...chosenPaths.map(p => `- ${inline(p.label)}`));
    const relations = relationsFor(chosen);
    if (relations.length) lines.push('**Static relations (with source dependencies)**', ...relations.map(r => {
      const from = graph.getNode(r.source); const to = graph.getNode(r.target);
      return `- ${inline(from ? label(from) : r.source)} → ${r.kind} → ${inline(to ? label(to) : r.target)} [${r.provenance ?? 'indexed'}${r.via ? `; ${inline(r.via)}` : ''}${r.site ? `; site ${inline(r.site)}` : ''}]`;
    }));
    for (const unit of unitsFor(chosen)) {
      // Fence longer than any source backtick run: source-like guidance cannot escape.
      const fence = '`'.repeat(Math.max(3, ...Array.from(unit.source.matchAll(/`+/g), m => m[0].length + 1)));
      lines.push(`### ${inline(unit.node.filePath)}:${unit.start}-${unit.end} — ${unit.snapshot ? 'current configuration snapshot' : unit.node.kind === 'file' ? 'complete indexed file' : 'complete declaration'}; file-fingerprint=${unit.fingerprint}`,
        fence + unit.node.language, unit.source.split('\n').map((line, i) => `${unit.start + i}\t${line}`).join('\n'), fence);
    }
    if (gaps.length) {
      lines.push('**Gaps — inspect only the missing evidence needed for the task**', ...gaps.slice(0, 6).map(g =>
        `- ${g.reason}: ${inline(g.target)}. Next anchor: ${inline(g.nextAnchor)}.`));
      if (gaps.length > 6) lines.push(`- ${gaps.length - 6} further gaps omitted from this bounded display; coverage remains partial.`);
    }
    return lines.join('\n\n');
  };
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  for (const pack of packs.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    if (!pack.gaps.length && render([...selected, pack]).length <= maxChars) selected.push(pack);
  }
  let text = render(selected);
  // Very small shared budgets may not even fit gap locators. Never cut source.
  if (text.length > maxChars) {
    selected.length = 0;
    text = '> Partial locator — evidence pack omitted: shared output budget exhausted.'.slice(0, maxChars);
  }
  const gaps = gapsFor(selected);
  const units = unitsFor(selected);
  const files: ExploreFileEmission[] = [];
  for (const unit of units) {
    let entry = files.find(f => f.path === unit.node.filePath);
    if (!entry) { entry = { path: unit.node.filePath, ranges: [], bytes: 0, fingerprint: unit.fingerprint }; files.push(entry); }
    entry.ranges.push({ start: unit.start, end: unit.end }); entry.bytes += unit.source.length;
  }
  for (const file of files) file.ranges = mergeRanges(file.ranges);
  const locatedNodes = candidates.filter(n => units.some(s => s.node.filePath === n.filePath && s.start <= n.startLine && s.end >= n.endLine))
    .map(n => ({ id: n.id, name: n.name, qualifiedName: n.qualifiedName, filePath: n.filePath, startLine: n.startLine }));
  const status = !units.length ? 'empty' : gaps.length ? 'partial' : 'complete';
  const checkedRequest = inspector?.inspect(units.map(requestUnit));
  const requestEvidence = checkedRequest ? { ...checkedRequest, targets: targetChecks ? checkedRequest.targets : [],
    behaviors: behaviorChecks ? checkedRequest.behaviors : [] } : undefined;
  return { text, emission: { projectRoot: options.projectRoot, query: options.query, files,
    sourceBytes: files.reduce((sum, f) => sum + f.bytes, 0), responseBytes: text.length, locatedNodes,
    evidenceStatus: status, partial: status !== 'complete', coveredObligations: selected.map(p => p.label),
    uncoveredObligations: gaps.map(g => `${g.reason}: ${g.target}`), nextAnchor: gaps[0]?.nextAnchor },
    metadata: { ...(controlEvidenceEnabled() ? { controls: controlsFor(selected) } : {}),
      ...(contextEnabled ? { implementationContext: selected.flatMap(p => p.context ? [{ ...p.context,
        ...(p.context.sdk ? { sdk: { ...p.context.sdk, nodes: p.context.sdk.nodes.map(n => ({
          id: n.id, name: n.name, qualifiedName: n.qualifiedName, kind: n.kind, filePath: n.filePath,
          startLine: n.startLine, endLine: n.endLine, startColumn: n.startColumn, endColumn: n.endColumn,
          language: n.language, updatedAt: n.updatedAt, signature: n.signature,
        })) } } : {}) }] : []) } : {}), ...(requestEvidence ? { requestEvidence } : {}), version: search ? 2 : 1, scope: 'bounded_static_evidence', status, selectedPacks: selected.map(p => p.id), gaps,
      relations: relationsFor(selected), ...(search ? { pathSearch: { goal: search.goal, stopReason: stopFor(selected),
        limitsHit: search.limitsHit, stats: search.stats, paths: search.paths.map(p => ({ id: p.id, nodeIds: p.nodeIds, cost: p.cost,
          evidence: selected.some(c => c.path?.id === p.id) ? 'provided' as const : 'partial' as const })) } } : {}) } };
}
