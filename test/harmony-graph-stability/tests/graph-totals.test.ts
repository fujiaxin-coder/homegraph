import { describe, expect, it } from 'vitest';
import { CONTRACT, viewtreeEdgeTotal } from './contract';
import {
  amNodeKeys,
  countByKind,
  countEdgesByKind,
  etsFileNodes,
  indexStabilityProject,
  synthBy,
} from './helpers';

/**
 * AA 合同可锚定面 + contains/calls 期望规模。
 * 对不上时：查 HG 落库 或 AA/映射口径（禁止用 HG 改合同糊弄）。
 */
describe('harmony-graph-stability / AA-anchored persist surface', () => {
  it(
    'HG matches AA fingerprints (ets/imports/heritage/viewtree/am)',
    async () => {
      const { cg, nodes, edges } = await indexStabilityProject();
      try {
        const fp = CONTRACT.fingerprints;
        const byKind = countEdgesByKind(edges);

        expect(etsFileNodes(nodes).length).toBe(fp.etsFileNodes);
        expect(byKind.imports ?? 0).toBe(fp.imports);
        expect(byKind.extends ?? 0).toBe(fp.extends);
        expect(byKind.implements ?? 0).toBe(fp.implements);

        const vt = synthBy(edges, 'viewtree');
        const byVia: Record<string, number> = {};
        for (const e of vt) {
          const via = String(e.metadata?.via ?? '');
          byVia[via] = (byVia[via] ?? 0) + 1;
        }
        expect(byVia).toEqual(fp.viewtreeByVia);
        expect(vt.length).toBe(viewtreeEdgeTotal(fp.viewtreeByVia));

        const am = amNodeKeys(nodes);
        expect(am.length).toBe(fp.amKeyCount);
        expect(new Set(am.map((k) => k.split('\0')[0])).size).toBe(fp.amFileCount);
        for (const key of am) {
          expect(key.split('\0')[1] ?? '').toMatch(/^%AM\d+/);
        }
      } finally {
        cg.close();
      }
    },
    180_000
  );

  it(
    'HG contains + calls edge counts match CONTRACT.expected (AA structural / RTA)',
    async () => {
      const { cg, edges } = await indexStabilityProject();
      try {
        const byKind = countEdgesByKind(edges);
        const exp = CONTRACT.expected.edgesByKind;
        expect(byKind.contains ?? 0).toBe(exp.contains);
        expect(byKind.calls ?? 0).toBe(exp.calls);
        expect(byKind.imports ?? 0).toBe(exp.imports);
        expect(byKind.extends ?? 0).toBe(exp.extends);
        expect(byKind.implements ?? 0).toBe(exp.implements);
        expect(synthBy(edges, 'viewtree').length).toBe(exp.references_viewtree);
      } finally {
        cg.close();
      }
    },
    180_000
  );

  it(
    'HG node-kind histogram matches CONTRACT.expected.nodesByKind where kinds overlap',
    async () => {
      const { cg, nodes } = await indexStabilityProject();
      try {
        const got = countByKind(nodes);
        const exp = CONTRACT.expected.nodesByKind;
        // AA anonymous_method 在 HG 里落在 method/function；分别对照可映射项。
        // file/class：工程口径在 nodesByKind；HG 持久化 DummyMain → *WithDummyMain。
        expect(got.file ?? 0).toBe(CONTRACT.expected.fileNodesWithDummyMain);
        expect(got.import ?? 0).toBe(exp.import);
        expect(got.interface ?? 0).toBe(exp.interface);
        expect(got.component ?? 0).toBe(exp.component);
        expect(got.class ?? 0).toBe(CONTRACT.expected.classNodesWithDummyMain);
        expect(got.struct ?? 0).toBe(exp.struct);
        expect(got.property ?? 0).toBe(exp.property);
        // method+function（含 %AM）+ DummyMain 等 HG 额外 callable
        const hgCallable = (got.method ?? 0) + (got.function ?? 0);
        expect(hgCallable).toBe(CONTRACT.expected.callableNodesWithDummyMain);
      } finally {
        cg.close();
      }
    },
    180_000
  );
});
