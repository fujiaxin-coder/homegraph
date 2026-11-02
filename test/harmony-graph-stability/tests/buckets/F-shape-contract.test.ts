/**
 * 桶 F — import / heritage / 图形状合同
 * 测什么：AA 审核合同上的 imports、extends、implements、viewtree、%AM、规模指纹防回归
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT, viewtreeEdgeTotal } from '../contract';
import {
  amNodeKeys,
  countByKind,
  countEdgesByKind,
  etsFileNodes,
  openStabilityIndex,
  synthBy,
  type StabilityIndex,
} from '../helpers';

describe('桶 F · 形状 / import / heritage 合同', () => {
  let idx: StabilityIndex;

  beforeAll(async () => {
    idx = await openStabilityIndex();
  }, 180_000);

  afterAll(() => idx?.dispose());

  describe('fingerprints — 结构面', () => {
    it('ets 文件节点数', () => {
      expect(etsFileNodes(idx.nodes).length).toBe(CONTRACT.fingerprints.etsFileNodes);
    });

    it('imports 边数', () => {
      expect(countEdgesByKind(idx.edges).imports ?? 0).toBe(CONTRACT.fingerprints.imports);
    });

    it('extends / implements（用户 heritage，已滤 SDK）', () => {
      const byKind = countEdgesByKind(idx.edges);
      expect(byKind.extends ?? 0).toBe(CONTRACT.fingerprints.extends);
      expect(byKind.implements ?? 0).toBe(CONTRACT.fingerprints.implements);
    });

    it('viewtree by via 分桶精确相等', () => {
      const vt = synthBy(idx.edges, 'viewtree');
      const byVia: Record<string, number> = {};
      for (const e of vt) {
        const via = String(e.metadata?.via ?? '');
        byVia[via] = (byVia[via] ?? 0) + 1;
      }
      expect(byVia).toEqual(CONTRACT.fingerprints.viewtreeByVia);
      expect(vt.length).toBe(viewtreeEdgeTotal(CONTRACT.fingerprints.viewtreeByVia));
    });

    it('%AM 匿名方法：数量 + 文件数 + 名形', () => {
      const am = amNodeKeys(idx.nodes);
      const fp = CONTRACT.fingerprints;
      expect(am.length).toBe(fp.amKeyCount);
      expect(new Set(am.map((k) => k.split('\0')[0])).size).toBe(fp.amFileCount);
      for (const key of am) {
        expect(key.split('\0')[1] ?? '').toMatch(/^%AM\d+/);
      }
      expect(fp.amKeys.length).toBe(fp.amKeyCount);
    });
  });

  describe('expected.edgesByKind — 落库规模', () => {
    it('contains / calls / imports / heritage / viewtree', () => {
      const byKind = countEdgesByKind(idx.edges);
      const exp = CONTRACT.expected.edgesByKind;
      expect(byKind.contains ?? 0).toBe(exp.contains);
      expect(byKind.calls ?? 0).toBe(exp.calls);
      expect(byKind.imports ?? 0).toBe(exp.imports);
      expect(byKind.extends ?? 0).toBe(exp.extends);
      expect(byKind.implements ?? 0).toBe(exp.implements);
      expect(synthBy(idx.edges, 'viewtree').length).toBe(exp.references_viewtree);
    });
  });

  describe('expected.nodesByKind — DummyMain 偏移', () => {
    it('file / class / callable 含 DummyMain', () => {
      const got = countByKind(idx.nodes);
      const exp = CONTRACT.expected.nodesByKind;
      expect(got.file ?? 0).toBe(CONTRACT.expected.fileNodesWithDummyMain);
      expect(got.import ?? 0).toBe(exp.import);
      expect(got.interface ?? 0).toBe(exp.interface);
      expect(got.component ?? 0).toBe(exp.component);
      expect(got.class ?? 0).toBe(CONTRACT.expected.classNodesWithDummyMain);
      expect(got.struct ?? 0).toBe(exp.struct);
      expect(got.property ?? 0).toBe(exp.property);
      const hgCallable = (got.method ?? 0) + (got.function ?? 0);
      expect(hgCallable).toBe(CONTRACT.expected.callableNodesWithDummyMain);
    });
  });

  describe('跨模块 import 锚点（合同计数之外的抽查）', () => {
    it('存在 UtilB→UtilA / UtilC→UtilB 方向的 import 节点或边痕迹', () => {
      const imports = idx.edges.filter((e) => e.kind === 'imports');
      expect(imports.length).toBe(CONTRACT.fingerprints.imports);

      // 至少有指向 helperA / helperB 名的 import 节点
      const importNodes = idx.nodes.filter((n) => n.kind === 'import');
      const names = new Set(importNodes.map((n) => n.name));
      expect(names.has('helperA') || names.has('BaseA')).toBe(true);
      expect(names.has('helperB') || names.has('BaseB')).toBe(true);
    });

    it('Worker* extends Base*：extends 边数与合同一致且 > 0', () => {
      expect(CONTRACT.fingerprints.extends).toBeGreaterThan(0);
      expect(countEdgesByKind(idx.edges).extends ?? 0).toBe(CONTRACT.fingerprints.extends);
    });
  });
});
