/**
 * 鸿蒙图稳定性合同（AA 锚定基线）。
 *
 * 数据来源（唯一）：
 *   ../aa-scene-inventory.json
 *   ← node ../aa-scene-inventory.js   （全量 Scene：buildSceneFromProjectDir + inferTypes）
 *   ← 人工审核 JSON 后
 *   ← node ../sync-contract-from-inventory.js
 *
 * 比较语义：
 *   HomeGraph 索引 project/ 的产物必须与下方 fingerprints 精确一致。
 *   真值是 AA Scene IR（经审核），不是「源码理想计数」，也不是「先跑 HG 再回填」。
 *
 * 刷新：改 fixture / 升级 arkanalyzer → 重跑 inventory → 人工审 JSON → sync → 本文件。
 * 禁止：把断言改成 >= 1；禁止写入本机绝对路径。
 */

export type KindCounts = Record<string, number>;

/**
 * 匿名方法指纹（排序后精确比对）。
 * 格式：相对 project 的 posix 路径 + NUL + AA 方法名 + NUL + 起始行
 * 例：mod_a/src/main/ets/PageA.ets\0%AM1$build\018
 */
export type AmKey = string;

export const CONTRACT = {
  meta: {
    /** 采集时 package 中的 arkanalyzer 版本；升级 AA 必须重采。 */
    arkanalyzer: '1.0.94',
    /** 相对本套件目录的 fixture。 */
    fixture: 'project/',
    /** 已审核的 inventory 落盘；合同数字应与其中 contract 段一致。 */
    inventory: '../aa-scene-inventory.json',
    /**
     * 各段是否已写入可测基线。
     * true  → 对应测例必须做精确断言（过不了就 describe.skip 并写明原因，禁止软化）。
     * false → 对应测例保持 skip，且字段为 null。
     */
    filled: {
      etsFiles: true,
      imports: true,
      extends: true,
      implements: true,
      amKeys: true,
      viewtreeByVia: true,
      /**
       * HG 整图 nodes/edges 与 by-kind：不是 AA Scene 直接字段。
       * 待单独从 HomeGraph 落库结果固化后改为 true。
       */
      totals: false,
    },
  },

  // ---------------------------------------------------------------------------
  // L1 / L2 — HomeGraph 整图规模（非 AA Scene 计数；未填）
  // ---------------------------------------------------------------------------
  totals: {
    nodes: null as number | null,
    edges: null as number | null,
  },
  nodesByKind: null as KindCounts | null,
  edgesByKind: null as KindCounts | null,

  // ---------------------------------------------------------------------------
  // L3 — AA 全量 Scene 指纹（已审核；测例精确比对）
  // ---------------------------------------------------------------------------
  fingerprints: {
    /** 工程内 .ets 文件数（排除 @dummyFile）。期望：5 模块 x 5 文件 = 25。 */
    etsFileNodes: 25,

    /** ArkFile.getImportInfos() 条数合计。 */
    imports: 24,

    /**
     * 用户侧 extends（WorkerX → BaseX）。
     * 不含 SDK 超类（Page/Child → CustomComponent）；全量见 scene.extendsAllInScene。
     */
    extends: 5,

    /** BaseX implements IFaceX（每模块 1）。 */
    implements: 5,

    /**
     * 全量 Scene 下全部 %AM* 指纹（已排序，55 条）。
     * 测例必须：expect(amNodeKeys(nodes)).toEqual(CONTRACT.fingerprints.amKeys)
     */
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
      "mod_a/src/main/ets/UtilA.ets\u0000%AM0$helperA\u00002",
      "mod_a/src/main/ets/UtilA.ets\u0000%AM1$mapAllA\u00007",
      "mod_b/src/main/ets/ChildB.ets\u0000%AM0$build\u00008",
      "mod_b/src/main/ets/LibB.ets\u0000%AM0\u000018",
      "mod_b/src/main/ets/LibB.ets\u0000%AM0\u00004",
      "mod_b/src/main/ets/LibB.ets\u0000%AM1\u000013",
      "mod_b/src/main/ets/LibB.ets\u0000%AM1$runLibB\u000020",
      "mod_b/src/main/ets/LibB.ets\u0000%AM2$run\u00006",
      "mod_b/src/main/ets/LibB.ets\u0000%AM3$%AM2$run\u00008",
      "mod_b/src/main/ets/PageB.ets\u0000%AM0$aboutToAppear\u000011",
      "mod_b/src/main/ets/PageB.ets\u0000%AM1$build\u000018",
      "mod_b/src/main/ets/UtilB.ets\u0000%AM0$helperB\u00004",
      "mod_b/src/main/ets/UtilB.ets\u0000%AM1$mapAllB\u00009",
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

    /** 与 amKeys.length 一致。 */
    amKeyCount: 55,
    /** 至少含一条 %AM 的 .ets 文件数。 */
    amFileCount: 20,

    /**
     * ViewTree 关系按 via 分桶（对齐 HG synthesizedBy=viewtree 的 via）。
     * 合计 30：onClick 15 + state-binding 10 + child-component 5。
     */
    viewtreeByVia: {
      onClick: 15,
      'state-binding': 10,
      'child-component': 5,
    } as KindCounts,
  },

  /**
   * AA Scene 自身规模（inventory.summary.scene），供对照，不是 HG DB totals。
   */
  scene: {
    files: 25,
    classes: 65,
    methods: 200,
    /** 含 SDK 超类的 extends 总数（含 CustomComponent）。 */
    extendsAllInScene: 15,
    implementsAllInScene: 5,
  },
} as const;

export type StabilityContract = typeof CONTRACT;

/** 读取已填充合同字段；未填则抛错（防止 skip 去掉后静默用 null）。 */
export function requireFilled<T>(value: T | null | undefined, path: string): T {
  if (value === null || value === undefined) {
    throw new Error(
      `CONTRACT.${path} 未填充 — 先跑 aa-scene-inventory.js 并人工审核（arkanalyzer ${CONTRACT.meta.arkanalyzer}）`
    );
  }
  return value;
}

export function viewtreeEdgeTotal(byVia: KindCounts): number {
  let n = 0;
  for (const v of Object.values(byVia)) n += v;
  return n;
}
