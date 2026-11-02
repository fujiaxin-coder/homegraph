/**
 * Shared helpers for harmony-graph-stability suite.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach } from 'vitest';
import { HomeGraph } from '../../../src';
import { resetExtractionContext } from '../../../src/extraction/context';
import { resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import type { Edge, Node } from '../../../src/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_FIXTURE = path.resolve(HERE, '..', 'project');

const tempRoots: string[] = [];

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  for (const dir of tempRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore Windows lock races
    }
  }
});

/** Copy the checked-in fixture into a fresh temp dir (keeps repo clean of .homegraph). */
export function cloneStabilityProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-stability-'));
  tempRoots.push(dir);
  fs.cpSync(PROJECT_FIXTURE, dir, { recursive: true });
  return dir;
}

export type StabilityIndex = {
  root: string;
  cg: HomeGraph;
  nodes: Node[];
  edges: Edge[];
  counts: { nodes: number; edges: number };
  /** Close DB + delete temp project (for beforeAll/afterAll suites). */
  dispose: () => void;
};

function collectGraph(cg: HomeGraph): Omit<StabilityIndex, 'root' | 'cg' | 'dispose'> {
  const qb = cg.getQueryBuilder();
  const nodes = qb.getAllNodes();
  const edges: Edge[] = [];
  for (const n of nodes) {
    edges.push(...cg.getOutgoingEdges(n.id));
  }
  const seen = new Set<string>();
  const uniq: Edge[] = [];
  for (const e of edges) {
    const k = `${e.source}\0${e.target}\0${e.kind}\0${JSON.stringify(e.metadata ?? null)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
  }
  return { nodes, edges: uniq, counts: qb.getNodeAndEdgeCount() };
}

/**
 * Index fixture; temp dir is tracked by afterEach (single-`it` style).
 */
export async function indexStabilityProject(): Promise<StabilityIndex> {
  const root = cloneStabilityProject();
  const cg = HomeGraph.initSync(root);
  try {
    await cg.indexAll();
    const graph = collectGraph(cg);
    return {
      root,
      cg,
      ...graph,
      dispose: () => {
        try {
          cg.close();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    cg.close();
    throw e;
  }
}

/**
 * Index once for a multi-`it` describe. Temp dir is NOT in afterEach list —
 * caller must `dispose()` in afterAll (closes DB + rmSync).
 */
export async function openStabilityIndex(): Promise<StabilityIndex> {
  resetArkTSBatch();
  resetExtractionContext();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-stability-suite-'));
  fs.cpSync(PROJECT_FIXTURE, root, { recursive: true });
  const cg = HomeGraph.initSync(root);
  try {
    await cg.indexAll();
    const graph = collectGraph(cg);
    return {
      root,
      cg,
      ...graph,
      dispose: () => {
        try {
          cg.close();
        } catch {
          /* ignore */
        }
        try {
          fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          /* ignore */
        }
        resetArkTSBatch();
        resetExtractionContext();
      },
    };
  } catch (e) {
    try {
      cg.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function countByKind(nodes: Node[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of nodes) {
    out[n.kind] = (out[n.kind] ?? 0) + 1;
  }
  return out;
}

export function countEdgesByKind(edges: Edge[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) {
    out[e.kind] = (out[e.kind] ?? 0) + 1;
  }
  return out;
}

export function amNodeKeys(nodes: Node[]): string[] {
  return nodes
    .filter((n) => /^%AM\d+/.test(n.name))
    .map((n) => `${n.filePath.replace(/\\/g, '/')}\0${n.name}\0${n.startLine}`)
    .sort();
}

export function synthBy(edges: Edge[], name: string): Edge[] {
  return edges.filter((e) => e.metadata?.synthesizedBy === name);
}

export function etsFileNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => {
    if (n.kind !== 'file') return false;
    const p = n.filePath.replace(/\\/g, '/');
    if (p.includes('@dummy')) return false;
    return /\.ets$/i.test(p);
  });
}
