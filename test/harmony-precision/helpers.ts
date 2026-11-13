/**
 * Shared helpers for harmony-precision — thin wrappers over ArkTS test helpers.
 */
import { afterEach } from 'vitest';
import { HomeGraph } from '../../src';
import { resetExtractionContext } from '../../src/extraction/context';
import { resetArkTSBatch } from '../../src/extraction/languages/arkts';
import {
  cleanupArktsProjects,
  makeArktsProject,
} from '../languages/arkts/helpers';
import type { Edge, Node } from '../../src/types';

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

/** Minimal Harmony modular layout (one or more modules under build-profile). */
export function makePrecisionProject(files: Record<string, string>): string {
  return makeArktsProject(files);
}

export async function indexPrecision(root: string): Promise<{
  cg: HomeGraph;
  nodes: Node[];
  edges: Edge[];
}> {
  process.env.HOMEGRAPH_OFFLOAD_DISABLE = '1';
  const cg = HomeGraph.initSync(root);
  try {
    await cg.indexAll();
    const nodes = cg.getQueryBuilder().getAllNodes();
    const edges: Edge[] = [];
    const seen = new Set<string>();
    for (const n of nodes) {
      for (const e of cg.getOutgoingEdges(n.id)) {
        const k = `${e.source}\0${e.target}\0${e.kind}\0${JSON.stringify(e.metadata ?? null)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push(e);
      }
    }
    return { cg, nodes, edges };
  } catch (e) {
    cg.close();
    throw e;
  }
}

export function closePrecision(cg: HomeGraph): void {
  try {
    cg.close();
  } catch {
    /* ignore */
  }
}

export function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

export function nameMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (actual.endsWith('$' + expected)) return true;
  const parts = actual.split('$');
  return parts[parts.length - 1] === expected;
}

/** ArkAnalyzer (or missing synth) calls between file+name endpoints. */
export function hasArkCall(
  nodes: Node[],
  edges: Edge[],
  callerFileSuffix: string,
  callerName: string,
  calleeFileSuffix: string,
  calleeName: string
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    const synth = e.metadata?.synthesizedBy;
    if (synth != null && synth !== 'arkanalyzer') continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    if (!norm(s.filePath).endsWith(callerFileSuffix)) continue;
    if (!norm(t.filePath).endsWith(calleeFileSuffix)) continue;
    if (!nameMatches(s.name, callerName)) continue;
    if (!nameMatches(t.name, calleeName)) continue;
    return true;
  }
  return false;
}

export function hasHeuristicCall(
  nodes: Node[],
  edges: Edge[],
  callerName: string,
  calleeName: string,
  synthesizedBy: string
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    if (e.metadata?.synthesizedBy !== synthesizedBy) continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    if (!nameMatches(s.name, callerName)) continue;
    if (!nameMatches(t.name, calleeName)) continue;
    return true;
  }
  return false;
}

/** Single-module modular project skeleton. */
export function singleModuleFiles(
  etsFiles: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {
    'build-profile.json5': JSON.stringify({
      modules: [{ name: 'entry', srcPath: './entry' }],
    }),
    'entry/oh-package.json5': JSON.stringify({
      name: '@ohos/entry',
      version: '1.0.0',
    }),
    'entry/src/main/module.json5': JSON.stringify({
      module: { name: 'entry', type: 'entry', deviceTypes: ['phone'] },
    }),
  };
  for (const [rel, body] of Object.entries(etsFiles)) {
    out[`entry/src/main/ets/${rel}`] = body;
  }
  return out;
}

/** Two-module modular project (lib + app). */
export function twoModuleFiles(opts: {
  libEts: Record<string, string>;
  appEts: Record<string, string>;
}): Record<string, string> {
  const out: Record<string, string> = {
    'build-profile.json5': JSON.stringify({
      modules: [
        { name: 'lib', srcPath: './lib' },
        { name: 'app', srcPath: './app' },
      ],
    }),
    'oh-package.json5': JSON.stringify({ name: 'precision-root', version: '1.0.0' }),
    'lib/oh-package.json5': JSON.stringify({ name: '@ohos/lib', version: '1.0.0' }),
    'app/oh-package.json5': JSON.stringify({
      name: '@ohos/app',
      version: '1.0.0',
      dependencies: { '@ohos/lib': '1.0.0' },
    }),
    'lib/src/main/module.json5': JSON.stringify({
      module: { name: 'lib', type: 'har', deviceTypes: ['phone'] },
    }),
    'app/src/main/module.json5': JSON.stringify({
      module: { name: 'app', type: 'entry', deviceTypes: ['phone'] },
    }),
  };
  for (const [rel, body] of Object.entries(opts.libEts)) {
    out[`lib/src/main/ets/${rel}`] = body;
  }
  for (const [rel, body] of Object.entries(opts.appEts)) {
    out[`app/src/main/ets/${rel}`] = body;
  }
  return out;
}
