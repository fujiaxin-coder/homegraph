/**
 * L1 calls gold — source-proven must / must-not edges, organized by scenario bucket.
 *
 * Edge key is stable to source positions (file + name [| startLine]), NOT %AM ids
 * or MethodSignature strings. Matcher allows %AM*$name wrappers for the same body.
 *
 * Hand-maintained (not overwritten by sync-contract-from-inventory.js).
 *
 * Buckets:
 *   A 跨模块 static direct — exact 名漂了还能召回
 *   B 非 RTA entry helper — 未 export helper，CFG 护栏补边
 *   C 扇出负例 — getInstance/error 不洪水
 *   D 同模块清晰 — this.foo()，不应靠 CFG 灌满
 *   E DummyMain/export lifecycle — Component → 子调用
 *   F import/heritage — 见 buckets/F-shape-contract.test.ts（形状合同，非 calls 边）
 *   G HG heuristic calls — 仅 pin 本 fixture 索引里真实存在且源码可证的合成边
 */

export type CallBucket = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/** Stable call-edge gold key. Prefer startLine when known; name+file is required. */
export type CallEdgeGold = {
  bucket: CallBucket;
  note?: string;
  callerFile: string;
  callerName: string;
  callerStart?: number;
  calleeFile: string;
  calleeName: string;
  calleeStart?: number;
  dispatch?: string;
  /** Expected metadata.synthesizedBy when bucket G */
  synthesizedBy?: string;
};

export function goldByBucket(
  all: CallEdgeGold[],
  bucket: CallBucket
): CallEdgeGold[] {
  return all.filter((g) => g.bucket === bucket);
}

/** A — 跨模块 static direct */
export const BUCKET_A_MUST: CallEdgeGold[] = [
  {
    bucket: 'A',
    note: 'DateFmt.weekTitle() 跨模块 Class.method',
    callerFile: 'mod_b/src/main/ets/UtilB.ets',
    callerName: 'helperB',
    calleeFile: 'mod_a/src/main/ets/DateFmt.ets',
    calleeName: 'weekTitle',
  },
  {
    bucket: 'A',
    note: 'helperB → helperA 跨模块函数',
    callerFile: 'mod_b/src/main/ets/UtilB.ets',
    callerName: 'helperB',
    calleeFile: 'mod_a/src/main/ets/UtilA.ets',
    calleeName: 'helperA',
  },
  {
    bucket: 'A',
    note: 'helperC → helperB 跨模块函数',
    callerFile: 'mod_c/src/main/ets/UtilC.ets',
    callerName: 'helperC',
    calleeFile: 'mod_b/src/main/ets/UtilB.ets',
    calleeName: 'helperB',
  },
  {
    bucket: 'A',
    note: 'helperD → helperC 跨模块函数',
    callerFile: 'mod_d/src/main/ets/UtilD.ets',
    callerName: 'helperD',
    calleeFile: 'mod_c/src/main/ets/UtilC.ets',
    calleeName: 'helperC',
  },
  {
    bucket: 'A',
    note: 'helperE → helperD 跨模块函数',
    callerFile: 'mod_e/src/main/ets/UtilE.ets',
    callerName: 'helperE',
    calleeFile: 'mod_d/src/main/ets/UtilD.ets',
    calleeName: 'helperD',
  },
];

/** B — 非 RTA entry / 未 export helper */
export const BUCKET_B_MUST: CallEdgeGold[] = [
  {
    bucket: 'B',
    note: '未 export 的 hiddenHelperA 仍被 helperA 召回',
    callerFile: 'mod_a/src/main/ets/UtilA.ets',
    callerName: 'helperA',
    calleeFile: 'mod_a/src/main/ets/UtilA.ets',
    calleeName: 'hiddenHelperA',
  },
  {
    bucket: 'B',
    note: 'mapAllA → helperA（同文件非 entry 可达）',
    callerFile: 'mod_a/src/main/ets/UtilA.ets',
    callerName: 'mapAllA',
    calleeFile: 'mod_a/src/main/ets/UtilA.ets',
    calleeName: 'helperA',
  },
  {
    bucket: 'B',
    note: 'mapAllB → helperB',
    callerFile: 'mod_b/src/main/ets/UtilB.ets',
    callerName: 'mapAllB',
    calleeFile: 'mod_b/src/main/ets/UtilB.ets',
    calleeName: 'helperB',
  },
];

/** C — 扇出负例（must-not） */
export const BUCKET_C_MUST_NOT: CallEdgeGold[] = [
  {
    bucket: 'C',
    note: 'helperA 不得洪水到 FanoutTrap.getInstance',
    callerFile: 'mod_a/src/main/ets/UtilA.ets',
    callerName: 'helperA',
    calleeFile: 'mod_a/src/main/ets/FanoutTrap.ets',
    calleeName: 'getInstance',
  },
  {
    bucket: 'C',
    note: 'aboutToAppear 不得洪水到 FanoutTrap.error',
    callerFile: 'mod_a/src/main/ets/PageA.ets',
    callerName: 'aboutToAppear',
    calleeFile: 'mod_a/src/main/ets/FanoutTrap.ets',
    calleeName: 'error',
  },
  {
    bucket: 'C',
    note: 'aboutToAppear 不得洪水到 FanoutTrap.info',
    callerFile: 'mod_a/src/main/ets/PageA.ets',
    callerName: 'aboutToAppear',
    calleeFile: 'mod_a/src/main/ets/FanoutTrap.ets',
    calleeName: 'info',
  },
  {
    bucket: 'C',
    note: 'helperC 不得塌成直连 helperA（禁止传递折叠）',
    callerFile: 'mod_c/src/main/ets/UtilC.ets',
    callerName: 'helperC',
    calleeFile: 'mod_a/src/main/ets/UtilA.ets',
    calleeName: 'helperA',
  },
  {
    bucket: 'C',
    note: 'PageA.build 不得误连 DateFmt.weekTitle',
    callerFile: 'mod_a/src/main/ets/PageA.ets',
    callerName: 'build',
    calleeFile: 'mod_a/src/main/ets/DateFmt.ets',
    calleeName: 'weekTitle',
  },
  {
    bucket: 'C',
    note: 'runLibA 不得洪水到 FanoutTrap.getInstance',
    callerFile: 'mod_a/src/main/ets/LibA.ets',
    callerName: 'runLibA',
    calleeFile: 'mod_a/src/main/ets/FanoutTrap.ets',
    calleeName: 'getInstance',
  },
];

/** D — 同模块清晰调用 */
export const BUCKET_D_MUST: CallEdgeGold[] = [
  {
    bucket: 'D',
    note: '同模块 runLibA → WorkerA.run',
    callerFile: 'mod_a/src/main/ets/LibA.ets',
    callerName: 'runLibA',
    calleeFile: 'mod_a/src/main/ets/LibA.ets',
    calleeName: 'run',
  },
  {
    bucket: 'D',
    note: '同文件 this.touch（LibA.run 体）',
    callerFile: 'mod_a/src/main/ets/LibA.ets',
    callerName: 'run',
    calleeFile: 'mod_a/src/main/ets/LibA.ets',
    calleeName: 'touch',
  },
  {
    bucket: 'D',
    note: '同模块 runLibB → run',
    callerFile: 'mod_b/src/main/ets/LibB.ets',
    callerName: 'runLibB',
    calleeFile: 'mod_b/src/main/ets/LibB.ets',
    calleeName: 'run',
  },
  {
    bucket: 'D',
    note: '同文件 this.touch（LibB.run 体）',
    callerFile: 'mod_b/src/main/ets/LibB.ets',
    callerName: 'run',
    calleeFile: 'mod_b/src/main/ets/LibB.ets',
    calleeName: 'touch',
  },
  {
    bucket: 'D',
    note: '同模块 runLibC → run',
    callerFile: 'mod_c/src/main/ets/LibC.ets',
    callerName: 'runLibC',
    calleeFile: 'mod_c/src/main/ets/LibC.ets',
    calleeName: 'run',
  },
  {
    bucket: 'D',
    note: '同文件 this.touch（LibC.run 体）',
    callerFile: 'mod_c/src/main/ets/LibC.ets',
    callerName: 'run',
    calleeFile: 'mod_c/src/main/ets/LibC.ets',
    calleeName: 'touch',
  },
  {
    bucket: 'D',
    note: '同模块 runLibD → run',
    callerFile: 'mod_d/src/main/ets/LibD.ets',
    callerName: 'runLibD',
    calleeFile: 'mod_d/src/main/ets/LibD.ets',
    calleeName: 'run',
  },
  {
    bucket: 'D',
    note: '同模块 runLibE → run',
    callerFile: 'mod_e/src/main/ets/LibE.ets',
    callerName: 'runLibE',
    calleeFile: 'mod_e/src/main/ets/LibE.ets',
    calleeName: 'run',
  },
];

/** D — 同模块不应靠 CFG 灌到跨模块/高扇出 */
export const BUCKET_D_MUST_NOT: CallEdgeGold[] = [
  {
    bucket: 'D',
    note: 'LibA.run 不得跨模块灌到 helperB',
    callerFile: 'mod_a/src/main/ets/LibA.ets',
    callerName: 'run',
    calleeFile: 'mod_b/src/main/ets/UtilB.ets',
    calleeName: 'helperB',
  },
  {
    bucket: 'D',
    note: 'LibA.run 不得灌到 DateFmt.weekTitle',
    callerFile: 'mod_a/src/main/ets/LibA.ets',
    callerName: 'run',
    calleeFile: 'mod_a/src/main/ets/DateFmt.ets',
    calleeName: 'weekTitle',
  },
  {
    bucket: 'D',
    note: 'LibA.touch 不得灌到 FanoutTrap.getInstance',
    callerFile: 'mod_a/src/main/ets/LibA.ets',
    callerName: 'touch',
    calleeFile: 'mod_a/src/main/ets/FanoutTrap.ets',
    calleeName: 'getInstance',
  },
];

/** E — lifecycle / DummyMain 主路径 */
export const BUCKET_E_MUST: CallEdgeGold[] = [
  {
    bucket: 'E',
    note: 'PageA.aboutToAppear → runLibA',
    callerFile: 'mod_a/src/main/ets/PageA.ets',
    callerName: 'aboutToAppear',
    calleeFile: 'mod_a/src/main/ets/LibA.ets',
    calleeName: 'runLibA',
  },
  {
    bucket: 'E',
    note: 'PageA.build → ChildA constructor',
    callerFile: 'mod_a/src/main/ets/PageA.ets',
    callerName: 'build',
    calleeFile: 'mod_a/src/main/ets/ChildA.ets',
    calleeName: 'constructor',
  },
  {
    bucket: 'E',
    note: 'PageB.aboutToAppear → runLibB',
    callerFile: 'mod_b/src/main/ets/PageB.ets',
    callerName: 'aboutToAppear',
    calleeFile: 'mod_b/src/main/ets/LibB.ets',
    calleeName: 'runLibB',
  },
  {
    bucket: 'E',
    note: 'PageB.build → ChildB constructor',
    callerFile: 'mod_b/src/main/ets/PageB.ets',
    callerName: 'build',
    calleeFile: 'mod_b/src/main/ets/ChildB.ets',
    calleeName: 'constructor',
  },
  {
    bucket: 'E',
    note: 'PageC.aboutToAppear → runLibC',
    callerFile: 'mod_c/src/main/ets/PageC.ets',
    callerName: 'aboutToAppear',
    calleeFile: 'mod_c/src/main/ets/LibC.ets',
    calleeName: 'runLibC',
  },
  {
    bucket: 'E',
    note: 'PageC.build → ChildC constructor',
    callerFile: 'mod_c/src/main/ets/PageC.ets',
    callerName: 'build',
    calleeFile: 'mod_c/src/main/ets/ChildC.ets',
    calleeName: 'constructor',
  },
  {
    bucket: 'E',
    note: 'PageD.aboutToAppear → runLibD',
    callerFile: 'mod_d/src/main/ets/PageD.ets',
    callerName: 'aboutToAppear',
    calleeFile: 'mod_d/src/main/ets/LibD.ets',
    calleeName: 'runLibD',
  },
  {
    bucket: 'E',
    note: 'PageE.aboutToAppear → runLibE',
    callerFile: 'mod_e/src/main/ets/PageE.ets',
    callerName: 'aboutToAppear',
    calleeFile: 'mod_e/src/main/ets/LibE.ets',
    calleeName: 'runLibE',
  },
];

/** A — 跨模块不得跳级直连 */
export const BUCKET_A_MUST_NOT: CallEdgeGold[] = [
  {
    bucket: 'A',
    note: 'helperE 不得跳级直连 helperA',
    callerFile: 'mod_e/src/main/ets/UtilE.ets',
    callerName: 'helperE',
    calleeFile: 'mod_a/src/main/ets/UtilA.ets',
    calleeName: 'helperA',
  },
  {
    bucket: 'A',
    note: 'helperD 不得跳级直连 helperA',
    callerFile: 'mod_d/src/main/ets/UtilD.ets',
    callerName: 'helperD',
    calleeFile: 'mod_a/src/main/ets/UtilA.ets',
    calleeName: 'helperA',
  },
  {
    bucket: 'A',
    note: 'helperC 不得跳级直连 DateFmt.weekTitle',
    callerFile: 'mod_c/src/main/ets/UtilC.ets',
    callerName: 'helperC',
    calleeFile: 'mod_a/src/main/ets/DateFmt.ets',
    calleeName: 'weekTitle',
  },
];

/**
 * G — HomeGraph heuristic must（只写 fixture 里已验证存在的正确边）
 * 不含：constructor 桥、aboutToAppear→build 的 arkui-state 过近似。
 */
export const BUCKET_G_MUST: CallEdgeGold[] = [
  {
    bucket: 'G',
    note: 'interface-impl: IFaceA.tag → BaseA.tag',
    synthesizedBy: 'interface-impl',
    callerFile: 'mod_a/src/main/ets/BaseA.ets',
    callerName: 'tag',
    calleeFile: 'mod_a/src/main/ets/BaseA.ets',
    calleeName: 'tag',
    calleeStart: 6,
  },
  {
    bucket: 'G',
    note: 'interface-impl: IFaceB.tag → BaseB.tag',
    synthesizedBy: 'interface-impl',
    callerFile: 'mod_b/src/main/ets/BaseB.ets',
    callerName: 'tag',
    calleeFile: 'mod_b/src/main/ets/BaseB.ets',
    calleeName: 'tag',
    calleeStart: 6,
  },
  {
    bucket: 'G',
    note: 'interface-impl: IFaceC.tag → BaseC.tag',
    synthesizedBy: 'interface-impl',
    callerFile: 'mod_c/src/main/ets/BaseC.ets',
    callerName: 'tag',
    calleeFile: 'mod_c/src/main/ets/BaseC.ets',
    calleeName: 'tag',
    calleeStart: 6,
  },
  {
    bucket: 'G',
    note: 'interface-impl: IFaceD.tag → BaseD.tag',
    synthesizedBy: 'interface-impl',
    callerFile: 'mod_d/src/main/ets/BaseD.ets',
    callerName: 'tag',
    calleeFile: 'mod_d/src/main/ets/BaseD.ets',
    calleeName: 'tag',
    calleeStart: 6,
  },
  {
    bucket: 'G',
    note: 'interface-impl: IFaceE.tag → BaseE.tag',
    synthesizedBy: 'interface-impl',
    callerFile: 'mod_e/src/main/ets/BaseE.ets',
    callerName: 'tag',
    calleeFile: 'mod_e/src/main/ets/BaseE.ets',
    calleeName: 'tag',
    calleeStart: 6,
  },
  {
    bucket: 'G',
    note: 'arkui-state: PageA.bumpCount → build（@State 赋值）',
    synthesizedBy: 'arkui-state',
    callerFile: 'mod_a/src/main/ets/PageA.ets',
    callerName: 'bumpCount',
    calleeFile: 'mod_a/src/main/ets/PageA.ets',
    calleeName: 'build',
  },
  {
    bucket: 'G',
    note: 'arkui-state: PageB.bumpCount → build（@State 赋值）',
    synthesizedBy: 'arkui-state',
    callerFile: 'mod_b/src/main/ets/PageB.ets',
    callerName: 'bumpCount',
    calleeFile: 'mod_b/src/main/ets/PageB.ets',
    calleeName: 'build',
  },
];

/** Flat lists for tooling / full-suite scans */
export const CALLS_MUST: CallEdgeGold[] = [
  ...BUCKET_A_MUST,
  ...BUCKET_B_MUST,
  ...BUCKET_D_MUST,
  ...BUCKET_E_MUST,
  ...BUCKET_G_MUST,
];

export const CALLS_MUST_NOT: CallEdgeGold[] = [
  ...BUCKET_A_MUST_NOT,
  ...BUCKET_C_MUST_NOT,
  ...BUCKET_D_MUST_NOT,
];
