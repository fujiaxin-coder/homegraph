/**
 * P11 — Spec 0070: incremental module reindex must not drop clean-module edges.
 *
 * Dirty-module reindex deletes only edges whose SOURCE lives in the dirty
 * module (via nodes ON DELETE CASCADE during deleteFile re-index); edges the
 * other direction (clean module → dirty module) survive untouched, and clean
 * SIGNATURES-level deps seeded into fileResults must not be force-overwritten.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { HomeGraph } from '../../src';
import {
  closePrecision,
  indexPrecision,
  makePrecisionProject,
  norm,
  twoModuleFiles,
} from './helpers';
import type { Edge, Node } from '../../src/types';

function collectEdges(cg: HomeGraph, nodes: Node[]): Edge[] {
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
  return edges;
}

function arkCallsBetween(
  nodes: Node[],
  edges: Edge[],
  callerFileSuffix: string,
  calleeFileSuffix: string
): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let count = 0;
  for (const e of edges) {
    if (e.kind !== 'calls') continue;
    const synth = e.metadata?.synthesizedBy;
    if (synth != null && synth !== 'arkanalyzer') continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    if (norm(s.filePath).endsWith(callerFileSuffix) && norm(t.filePath).endsWith(calleeFileSuffix)) {
      count++;
    }
  }
  return count;
}

describe('P11 incremental module sync keeps clean-module edges (Spec 0070)', () => {
  it(
    'preserves clean→dirty ark calls and clean file rows across a dirty-module sync',
    async () => {
      const root = makePrecisionProject(
        twoModuleFiles({
          libEts: {
            'Util.ets': `
import { Log } from './Log';

export class Util {
  static compute(): number {
    Log.i('compute');
    return 1;
  }
}
`,
            'Log.ets': `
export class Log {
  static i(msg: string): void {}
}
`,
          },
          appEts: {
            'Caller.ets': `
import { Util } from '@ohos/lib';
import { Log } from './LocalLog';

// clean-module caller → dirty-module callee (cross-module, AA-resolved)
export function appMain(): void {
  Util.compute();
}

function localHelper(): void {
  Log.i('local');
}
`,
            'LocalLog.ets': `
export class Log {
  static i(msg: string): void {}
}
`,
          },
        })
      );

      const first = await indexPrecision(root);
      const { cg } = first;
      try {
        const nodesBefore = first.nodes;
        const edgesBefore = collectEdges(cg, nodesBefore);
        const cleanCallerCount = arkCallsBetween(
          nodesBefore,
          edgesBefore,
          'app/src/main/ets/Caller.ets',
          'lib/src/main/ets/Util.ets'
        );
        // Baseline: the cross-module call must exist before the sync test.
        expect(cleanCallerCount).toBeGreaterThan(0);

        const utilRowBefore = cg
          .getQueryBuilder()
          .getAllNodes()
          .filter((n) => norm(n.filePath).endsWith('lib/src/main/ets/Util.ets'));
        const utilNodeCountBefore = utilRowBefore.length;

        // Touch ONLY the dirty module (lib): body change keeps signature but
        // forces mtime/size drift so sync picks the file up.
        const utilPath = path.join(
          root,
          'lib/src/main/ets/Util.ets'
        );
        const utilBody = fs.readFileSync(utilPath, 'utf-8');
        fs.writeFileSync(
          utilPath,
          utilBody.replace('return 1;', 'return 2;')
        );

        await cg.sync();

        const nodesAfter = cg.getQueryBuilder().getAllNodes();
        const edgesAfter = collectEdges(cg, nodesAfter);

        // 1. Clean module → dirty module: the edge survived the dirty-module
        //    reindex (old code deleted it globally and never re-emitted it).
        const cleanCallerAfter = arkCallsBetween(
          nodesAfter,
          edgesAfter,
          'app/src/main/ets/Caller.ets',
          'lib/src/main/ets/Util.ets'
        );
        expect(cleanCallerAfter).toBe(cleanCallerCount);

        // 2. Dirty module's own re-emitted edge is back (cascade delete then
        //    fresh emit): Util.compute → Log.i within the dirty module.
        const dirtyInternalAfter = arkCallsBetween(
          nodesAfter,
          edgesAfter,
          'lib/src/main/ets/Util.ets',
          'lib/src/main/ets/Log.ets'
        );
        expect(dirtyInternalAfter).toBeGreaterThan(0);

        // 3. Clean seeded dep files were not hollowed by the incremental
        //    force-persist (Spec 0070 prefix gate).
        const utilRowsAfter = nodesAfter.filter((n) =>
          norm(n.filePath).endsWith('lib/src/main/ets/Util.ets')
        );
        expect(utilRowsAfter.length).toBe(utilNodeCountBefore);
      } finally {
        closePrecision(cg);
      }
    },
    { timeout: 180_000 }
  );
});
