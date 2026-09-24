import type { Edge, Node } from '../types';
import { isArkuiScopeEdge } from '../graph/evidence-paths';
import { lexEvidenceSource } from './request-evidence';
import * as path from 'node:path';

export const implementationContextEnabled = (): boolean => process.env.HOMEGRAPH_ARKTS_IMPLEMENTATION_CONTEXT !== '0';
export const controlEvidenceEnabled = (): boolean => process.env.HOMEGRAPH_ARKTS_CONTROL_EVIDENCE !== '0';
export interface ImplementationGraph {
  getNode(id: string): Node | null | undefined;
  getNodesInFile(file: string): Node[];
  getOutgoingEdges(id: string): Edge[];
  getIncomingEdges(id: string): Edge[];
}
export interface ImplementationGroup {
  id: string; label: string; nodes: Node[]; edges: Edge[];
  notes: string[]; missing: string[];
  sdk?: { module: string; version: string; nodes: Node[] };
}
export interface SdkModule { version: string; nodes: Node[] }
const DECLARATIONS = new Set(['class', 'struct', 'component', 'interface', 'function', 'method', 'field', 'property', 'type_alias', 'enum', 'variable', 'constant']);
const TYPES = new Set(['type_of', 'returns', 'instantiates']);
const at = (n: Node) => `${n.filePath}:${n.startLine}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uses = (code: string, name: string) => /^[\w$]+$/.test(name) && new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`).test(code);

/** No fuzzy symbol lookup: only stored edges and the target file of an actual import.
 * Source must be hash-verified by the caller before its relationships are expanded.
 * Limits bound work independently of repository size; gaps survive budget selection.
 */
export function collectImplementationContext(graph: ImplementationGraph, seeds: Node[],
  source: (node: Node) => string | undefined,
  sdkModule?: (module: string) => SdkModule | undefined,
  moduleBinding?: (importer: string, module: string) => { relativePath: string; witnesses: Node[] } | undefined): ImplementationGroup[] {
  const groups: ImplementationGroup[] = [];
  const files = new Map<string, Node[]>();
  const sdkCache = new Map<string, SdkModule | undefined>();
  const inFile = (file: string) => {
    if (!files.has(file)) files.set(file, graph.getNodesInFile(file));
    return files.get(file)!;
  };
  // Import edges may be absent for ArkAnalyzer type-only imports. Resolve the exact
  // relative module path, including barrel exports, without searching other modules.
  let moduleReads = 0;
  const relativeDefinition = (importer: string, module: string, name: string, depth = 0): Node[][] => {
    if (!module.startsWith('.') || depth > 2 || moduleReads >= 12) return [];
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), module));
    if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) return [];
    const paths = /\.(?:ets|ts)$/.test(base) ? [base] : [base + '.ets', base + '.ts', `${base}/Index.ets`, `${base}/index.ets`, `${base}/index.ts`];
    const available = paths.map(file => ({ file, nodes: inFile(file) })).filter(x => x.nodes.length);
    if (available.length !== 1) return [];
    moduleReads++;
    const { file, nodes } = available[0]!;
    const matches = [...new Map(nodes.filter(n => DECLARATIONS.has(n.kind) && n.name === name)
      .map(n => [`${n.filePath}:${n.startLine}:${n.name}`, n])).values()];
    if (matches.length === 1) {
      const body = source(matches[0]!);
      if (body && new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:class|struct|interface|enum|type|function|const|let|var)\\s+${esc(name)}\\b`).test(lexEvidenceSource(body).code)) return [[matches[0]!]];
    }
    const fileNode: Node = { ...nodes[0]!, id: `context-file:${file}`, name: file, qualifiedName: file, kind: 'file', startLine: 1, endLine: 1 };
    const body = source(fileNode); if (!body) return [];
    const out: Node[][] = [];
    const exportCode = lexEvidenceSource(body);
    if (!exportCode.valid) return [];
    for (const m of body.matchAll(/\bexport\s+(\*|\{[^}]+\})\s+from\s*['"]([^'"\r\n]+)['"]/g)) {
      if (!exportCode.code.slice(m.index).startsWith('export')) continue;
      let original = name;
      if (m[1] !== '*') {
        const binding = m[1]!.slice(1, -1).split(',').map(x => x.trim().split(/\s+as\s+/))
          .find(parts => (parts[1] ?? parts[0]) === name);
        if (!binding) continue; original = binding[0]!;
      }
      for (const chain of relativeDefinition(file, m[2]!, original, depth + 1)) out.push([fileNode, ...chain]);
    }
    return out;
  };
  const queue = seeds.slice(0, 6).map(n => ({ node: n, depth: 0 }));
  const visited = new Set<string>(); const seenEdges = new Set<string>(); const seenImports = new Set<string>();
  let reads = 0;
  while (queue.length && visited.size < 24 && reads < 48 && groups.length < 24) {
    const { node, depth } = queue.shift()!;
    if (visited.has(node.id) || node.filePath.startsWith('ohos-sdk:')) continue;
    visited.add(node.id);
    const body = source(node); if (!body) continue;
    const parsed = lexEvidenceSource(body); if (!parsed.valid) continue;
    const own = inFile(node.filePath);
    // Component → build is containment, not an invented runtime call.
    const nested = own.filter(n => n.id !== node.id && n.startLine >= node.startLine && n.endLine <= node.endLine
      && n.kind === 'method' && n.name === 'build').slice(0, 2);
    if (depth < 2) queue.push(...nested.map(n => ({ node: n, depth: depth + 1 })));
    const adjacent = [...graph.getOutgoingEdges(node.id), ...graph.getIncomingEdges(node.id)]; reads += 2;
    for (const edge of adjacent.slice(0, 80)) {
      if (groups.length >= 24) break;
      const scope = isArkuiScopeEdge(edge);
      const outgoing = edge.source === node.id;
      if (!scope && !(outgoing && TYPES.has(edge.kind))) continue;
      const key = JSON.stringify([edge.source, edge.target, edge.kind, edge.metadata]);
      if (seenEdges.has(key)) continue; seenEdges.add(key);
      const other = graph.getNode(outgoing ? edge.target : edge.source);
      if (!other || other.filePath.startsWith('ohos-sdk:')) continue;
      groups.push({ id: `impl-edge:${groups.length}`, label: `${scope ? 'render/navigation scope' : 'type dependency'}: ${node.name} ↔ ${other.name}`,
        nodes: [node, other], edges: [edge], missing: [], notes: scope
          ? ['Static wiring only; enclosing conditions and other shared users remain relevant.'] : [] });
      // Do not fan out from a shared caller into its unrelated siblings.
      if (outgoing && depth < 2) queue.push({ node: other, depth: depth + 1 });
    }
    if (adjacent.length > 80) groups.push({ id: `impl-limit:${node.id}`, label: 'context expansion limit', nodes: [node], edges: [],
      notes: [], missing: [`additional relationships at ${at(node)}`] });

    for (const imp of own.filter(n => n.kind === 'import').slice(0, 40)) {
      if (groups.length >= 24 || seenImports.has(imp.id) || !uses(parsed.code, imp.name)) continue;
      seenImports.add(imp.id);
      const importSource = source(imp); if (!importSource) continue;
      const importCode = lexEvidenceSource(importSource);
      const match = [...importSource.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*['"]([^'"\r\n]+)['"]/g)]
        .find(m => importCode.valid && importCode.code.slice(m.index).startsWith('import'));
      if (!match) continue;
      const clause = match[1]!; const module = match[2]!;
      const aliases = [...clause.matchAll(/([\w$]+)\s+as\s+([\w$]+)/g)];
      const name = aliases.find(a => a[2] === imp.name)?.[1] ?? imp.name;
      const group: ImplementationGroup = { id: `impl-import:${imp.id}`, label: `import ${imp.name} from ${module}`,
        nodes: [node, imp], edges: [], notes: [], missing: [] };
      const links = graph.getOutgoingEdges(imp.id).filter(e => e.kind === 'imports'); reads++;
      for (const link of links.slice(0, 4)) {
        const target = graph.getNode(link.target); if (!target || target.filePath.startsWith('ohos-sdk:')) continue;
        const pool = target.kind === 'file' ? inFile(target.filePath) : [target];
        const matches = pool.filter(n => DECLARATIONS.has(n.kind) && n.name === name);
        const unique = [...new Map(matches.map(n => [`${n.filePath}:${n.startLine}:${n.name}`, n])).values()];
        if (unique.length === 1) { group.nodes.push(unique[0]!); group.edges.push(link); }
        // Export declarations are evidence of the public boundary, never proof that every file-local name is exported.
        const exports = pool.filter(n => n.kind === 'export' && (n.name === name || uses(n.signature ?? '', name))).slice(0, 3);
        group.nodes.push(...exports);
      }
      if (group.nodes.length === 2) {
        const binding = module.startsWith('.') ? undefined : moduleBinding?.(imp.filePath, module);
        const chains = relativeDefinition(imp.filePath, binding?.relativePath ?? module, name);
        if (chains.length === 1) group.nodes.push(...(binding?.witnesses ?? []), ...chains[0]!);
        else if (chains.length > 1) group.missing.push(`ambiguous export ${name} from ${module}`);
      }
      if (group.nodes.length === 2 && /^@(?:kit|ohos|hms)\./.test(module) && sdkModule) {
        if (!sdkCache.has(module)) sdkCache.set(module, sdkModule(module));
        const sdk = sdkCache.get(module);
        if (sdk) {
          const memberNames = new Set([name]);
          for (const m of parsed.code.matchAll(new RegExp(`\\b${esc(imp.name)}\\s*\\.\\s*([\\w$]+)`, 'g'))) memberNames.add(m[1]!);
          const sdkNodes = sdk.nodes.filter(n => n.signature && memberNames.has(n.name));
          // Complete parameter objects are a group: include declared fields of referenced types.
          const signature = sdkNodes.map(n => n.signature).join('\n');
          const types = sdk.nodes.filter(n => ['interface', 'class', 'type_alias', 'enum'].includes(n.kind) && uses(signature, n.name));
          const selected = [...new Map([...sdkNodes, ...types, ...sdk.nodes.filter(n => types.some(t =>
            n.filePath === t.filePath && n.startLine >= t.startLine && n.endLine <= t.endLine))].map(n => [n.id, n])).values()];
          if (selected.length && selected.length <= 32) {
            group.sdk = { module, version: sdk.version, nodes: selected };
            group.notes.push('Bounded SDK signature bundle; inherited/indirect types, API availability and runtime requirements remain unverified.');
          }
          else group.missing.push(`SDK signature/type closure for ${module}.${name}`);
        }
      }
      if (group.nodes.length === 2 && !group.sdk) group.missing.push(`resolved definition/export of ${imp.name} from ${module} (${at(imp)})`);
      group.notes.push('Import/definition evidence does not prove module installation or public export availability.');
      groups.push(group);
    }
  }
  if (queue.length) groups.push({ id: 'impl-limit', label: 'context expansion limit', nodes: [], edges: [], notes: [],
    missing: [at(queue[0]!.node)] });
  return groups;
}
