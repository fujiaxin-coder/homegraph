/**
 * 鸿蒙图稳定性合同（AA 锚定基线）。
 *
 * 刷新：node ../aa-scene-inventory.js → 审 JSON → node ../sync-contract-from-inventory.js
 * 真值只来自 AA 全量 Scene + 审核。禁止 HG 回填。
 */

export type KindCounts = Record<string, number>;

/** AA 全量 Scene %AM 清单（审计用）。HG 测例只核数量 + 名为 %AM*。 */
export type AmKey = string;

export const CONTRACT = {
  meta: {
    arkanalyzer: "1.0.94",
    fixture: 'project/',
    inventory: '../aa-scene-inventory.json',
    filled: {
      scene: true,
      fingerprints: true,
      expected: true,
    },
  },

  scene: {
    files: 27,
    classes: 70,
    methods: 214,
    extendsAllInScene: 15,
    implementsAllInScene: 5,
  },

  fingerprints: {
    etsFileNodes: 27,
    imports: 25,
    extends: 5,
    implements: 5,
    amKeys: [
      "mod_a/src/main/ets/ChildA.ets\u0000%AM0$build\u00008",
      "mod_a/src/main/ets/LibA.ets\u0000%AM0\u000018",
      "mod_a/src/main/ets/LibA.ets\u0000%AM0\u00004",
      "mod_a/src/main/ets/LibA.ets\u0000%AM1\u000013",
      "mod_a/src/main/ets/LibA.ets\u0000%AM1$runLibA\u000020",
      "mod_a/src/main/ets/LibA.ets\u0000%AM2$run\u00006",
      "mod_a/src/main/ets/LibA.ets\u0000%AM3$%AM2$run\u00008",
      "mod_a/src/main/ets/PageA.ets\u0000%AM0$aboutToAppear\u000011",
      "mod_a/src/main/ets/PageA.ets\u0000%AM1$build\u000018",
      "mod_a/src/main/ets/UtilA.ets\u0000%AM0$helperA\u00007",
      "mod_a/src/main/ets/UtilA.ets\u0000%AM1$mapAllA\u000012",
      "mod_b/src/main/ets/ChildB.ets\u0000%AM0$build\u00008",
      "mod_b/src/main/ets/LibB.ets\u0000%AM0\u000018",
      "mod_b/src/main/ets/LibB.ets\u0000%AM0\u00004",
      "mod_b/src/main/ets/LibB.ets\u0000%AM1\u000013",
      "mod_b/src/main/ets/LibB.ets\u0000%AM1$runLibB\u000020",
      "mod_b/src/main/ets/LibB.ets\u0000%AM2$run\u00006",
      "mod_b/src/main/ets/LibB.ets\u0000%AM3$%AM2$run\u00008",
      "mod_b/src/main/ets/PageB.ets\u0000%AM0$aboutToAppear\u000011",
      "mod_b/src/main/ets/PageB.ets\u0000%AM1$build\u000018",
      "mod_b/src/main/ets/UtilB.ets\u0000%AM0$helperB\u00005",
      "mod_b/src/main/ets/UtilB.ets\u0000%AM1$mapAllB\u000012",
      "mod_c/src/main/ets/ChildC.ets\u0000%AM0$build\u00008",
      "mod_c/src/main/ets/LibC.ets\u0000%AM0\u000018",
      "mod_c/src/main/ets/LibC.ets\u0000%AM0\u00004",
      "mod_c/src/main/ets/LibC.ets\u0000%AM1\u000013",
      "mod_c/src/main/ets/LibC.ets\u0000%AM1$runLibC\u000020",
      "mod_c/src/main/ets/LibC.ets\u0000%AM2$run\u00006",
      "mod_c/src/main/ets/LibC.ets\u0000%AM3$%AM2$run\u00008",
      "mod_c/src/main/ets/PageC.ets\u0000%AM0$aboutToAppear\u000011",
      "mod_c/src/main/ets/PageC.ets\u0000%AM1$build\u000018",
      "mod_c/src/main/ets/UtilC.ets\u0000%AM0$helperC\u00004",
      "mod_c/src/main/ets/UtilC.ets\u0000%AM1$mapAllC\u00009",
      "mod_d/src/main/ets/ChildD.ets\u0000%AM0$build\u00008",
      "mod_d/src/main/ets/LibD.ets\u0000%AM0\u000018",
      "mod_d/src/main/ets/LibD.ets\u0000%AM0\u00004",
      "mod_d/src/main/ets/LibD.ets\u0000%AM1\u000013",
      "mod_d/src/main/ets/LibD.ets\u0000%AM1$runLibD\u000020",
      "mod_d/src/main/ets/LibD.ets\u0000%AM2$run\u00006",
      "mod_d/src/main/ets/LibD.ets\u0000%AM3$%AM2$run\u00008",
      "mod_d/src/main/ets/PageD.ets\u0000%AM0$aboutToAppear\u000011",
      "mod_d/src/main/ets/PageD.ets\u0000%AM1$build\u000018",
      "mod_d/src/main/ets/UtilD.ets\u0000%AM0$helperD\u00004",
      "mod_d/src/main/ets/UtilD.ets\u0000%AM1$mapAllD\u00009",
      "mod_e/src/main/ets/ChildE.ets\u0000%AM0$build\u00008",
      "mod_e/src/main/ets/LibE.ets\u0000%AM0\u000018",
      "mod_e/src/main/ets/LibE.ets\u0000%AM0\u00004",
      "mod_e/src/main/ets/LibE.ets\u0000%AM1\u000013",
      "mod_e/src/main/ets/LibE.ets\u0000%AM1$runLibE\u000020",
      "mod_e/src/main/ets/LibE.ets\u0000%AM2$run\u00006",
      "mod_e/src/main/ets/LibE.ets\u0000%AM3$%AM2$run\u00008",
      "mod_e/src/main/ets/PageE.ets\u0000%AM0$aboutToAppear\u000011",
      "mod_e/src/main/ets/PageE.ets\u0000%AM1$build\u000018",
      "mod_e/src/main/ets/UtilE.ets\u0000%AM0$helperE\u00004",
      "mod_e/src/main/ets/UtilE.ets\u0000%AM1$mapAllE\u00009",
    ] as AmKey[],
    amKeyCount: 55,
    amFileCount: 20,
    viewtreeByVia: {
      "onClick": 15,
      "state-binding": 10,
      "child-component": 5
    } as KindCounts,
  },

  /** HG persist expected：去 %AC + DummyMain/callable 偏移 + RTA−无节点 SDK。 */
  expected: {
    nodesByKind: {
      "file": 27,
      "import": 25,
      "class": 12,
      "struct": 10,
      "interface": 5,
      "enum": 0,
      "method": 63,
      "function": 16,
      "property": 10,
      "component": 10,
      "anonymous_method": 55
    } as KindCounts,
    edgesByKind: {
      "imports": 25,
      "extends": 5,
      "implements": 5,
      "contains": 217,
      "calls": 93,
      "references_viewtree": 30
    } as KindCounts,
    containsTotal: 217,
    callEdgeCount: 93,
    callEdgeCountAll: 71,
    viewtreeEdgeTotal: 30,
    types: 27,
    methods: 134,
    fields: 10,
    components: 10,
    fileNodesWithDummyMain: 28,
    classNodesWithDummyMain: 13,
    callableNodesWithDummyMain: 144,
  },
} as const;

export type StabilityContract = typeof CONTRACT;

export function viewtreeEdgeTotal(byVia: KindCounts): number {
  let n = 0;
  for (const v of Object.values(byVia)) n += v;
  return n;
}
