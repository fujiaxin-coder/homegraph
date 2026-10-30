/**
 * 将已审核的 aa-scene-inventory.json 写入 tests/contract.ts。
 *
 * 流程：node aa-scene-inventory.js → 人工审 JSON → node sync-contract-from-inventory.js
 * 合同测例必须对 fingerprints 做精确相等；过不了用 describe.skip + TODO，禁止软化断言。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const invPath = path.join(HERE, 'aa-scene-inventory.json');
const outPath = path.join(HERE, 'tests', 'contract.ts');

const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
if (inv.meta?.projectPath) {
  throw new Error('aa-scene-inventory.json 含绝对路径 meta.projectPath — 请重跑 aa-scene-inventory.js');
}
const c = inv.contract;
if (!c?.amKeys || !c.viewtreeByVia) {
  throw new Error('inventory 缺少 contract.amKeys / contract.viewtreeByVia');
}
const scene = inv.summary?.scene ?? {};

const amKeysLit = c.amKeys
  .map((k) => {
    if (k.split('\0').length !== 3) throw new Error(`bad amKey: ${JSON.stringify(k)}`);
    return `      ${JSON.stringify(k)},`;
  })
  .join('\n');

const vtInner = JSON.stringify(c.viewtreeByVia, null, 2)
  .split('\n')
  .map((line, i) => (i === 0 ? line : `    ${line}`))
  .join('\n');

const lines = [];
const L = (s = '') => lines.push(s);

L('/**');
L(' * 鸿蒙图稳定性合同（AA 锚定基线）。');
L(' *');
L(' * 数据来源（唯一）：');
L(' *   ../aa-scene-inventory.json');
L(' *   ← node ../aa-scene-inventory.js   （全量 Scene：buildSceneFromProjectDir + inferTypes）');
L(' *   ← 人工审核 JSON 后');
L(' *   ← node ../sync-contract-from-inventory.js');
L(' *');
L(' * 比较语义：');
L(' *   HomeGraph 索引 project/ 的产物必须与下方 fingerprints 精确一致。');
L(' *   真值是 AA Scene IR（经审核），不是「源码理想计数」，也不是「先跑 HG 再回填」。');
L(' *');
L(' * 刷新：改 fixture / 升级 arkanalyzer → 重跑 inventory → 人工审 JSON → sync → 本文件。');
L(' * 禁止：把断言改成 >= 1；禁止写入本机绝对路径。');
L(' */');
L('');
L('export type KindCounts = Record<string, number>;');
L('');
L('/**');
L(' * 匿名方法指纹（排序后精确比对）。');
L(' * 格式：相对 project 的 posix 路径 + NUL + AA 方法名 + NUL + 起始行');
L(' */');
L('export type AmKey = string;');
L('');
L('export const CONTRACT = {');
L('  meta: {');
L('    /** 采集时 package 中的 arkanalyzer 版本；升级 AA 必须重采。 */');
L(`    arkanalyzer: ${JSON.stringify(inv.meta.arkanalyzer)},`);
L("    /** 相对本套件目录的 fixture。 */");
L("    fixture: 'project/',");
L('    /** 已审核的 inventory 落盘；合同数字应与其中 contract 段一致。 */');
L("    inventory: '../aa-scene-inventory.json',");
L('    /**');
L('     * 各段是否已写入可测基线。');
L('     * true  → 对应测例必须做精确断言（过不了就 describe.skip 并写明原因，禁止软化）。');
L('     * false → 对应测例保持 skip，且字段为 null。');
L('     */');
L('    filled: {');
L('      etsFiles: true,');
L('      imports: true,');
L('      extends: true,');
L('      implements: true,');
L('      amKeys: true,');
L('      viewtreeByVia: true,');
L('      /**');
L('       * HG 整图 nodes/edges 与 by-kind：不是 AA Scene 直接字段。');
L('       * 待单独从 HomeGraph 落库结果固化后改为 true。');
L('       */');
L('      totals: false,');
L('    },');
L('  },');
L('');
L('  // ---------------------------------------------------------------------------');
L('  // L1 / L2 — HomeGraph 整图规模（非 AA Scene 计数；未填）');
L('  // ---------------------------------------------------------------------------');
L('  totals: {');
L('    nodes: null as number | null,');
L('    edges: null as number | null,');
L('  },');
L('  nodesByKind: null as KindCounts | null,');
L('  edgesByKind: null as KindCounts | null,');
L('');
L('  // ---------------------------------------------------------------------------');
L('  // L3 — AA 全量 Scene 指纹（已审核；测例精确比对）');
L('  // ---------------------------------------------------------------------------');
L('  fingerprints: {');
L('    /** 工程内 .ets 文件数（排除 @dummyFile）。期望：5 模块 x 5 文件 = 25。 */');
L(`    etsFileNodes: ${c.etsFileNodes},`);
L('');
L('    /** ArkFile.getImportInfos() 条数合计。 */');
L(`    imports: ${c.imports},`);
L('');
L('    /**');
L('     * 用户侧 extends（WorkerX → BaseX）。');
L('     * 不含 SDK 超类（Page/Child → CustomComponent）；全量见 scene.extendsAllInScene。');
L('     */');
L(`    extends: ${c.extends},`);
L('');
L('    /** BaseX implements IFaceX（每模块 1）。 */');
L(`    implements: ${c.implements},`);
L('');
L('    /**');
L('     * 全量 Scene 下全部 %AM* 指纹（已排序）。');
L('     * 测例必须：expect(amNodeKeys(nodes)).toEqual(CONTRACT.fingerprints.amKeys)');
L('     */');
L('    amKeys: [');
L(amKeysLit);
L('    ] as AmKey[],');
L('');
L('    /** 与 amKeys.length 一致。 */');
L(`    amKeyCount: ${c.amKeyCount},`);
L('    /** 至少含一条 %AM 的 .ets 文件数。 */');
L(`    amFileCount: ${c.amFileCount},`);
L('');
L('    /**');
L('     * ViewTree 关系按 via 分桶（对齐 HG synthesizedBy=viewtree 的 via）。');
L('     */');
L(`    viewtreeByVia: ${vtInner} as KindCounts,`);
L('  },');
L('');
L('  /**');
L('   * AA Scene 自身规模（inventory.summary.scene），供对照，不是 HG DB totals。');
L('   */');
L('  scene: {');
L(`    files: ${scene.files ?? 'null'},`);
L(`    classes: ${scene.classes ?? 'null'},`);
L(`    methods: ${scene.methods ?? 'null'},`);
L(`    extendsAllInScene: ${inv.summary?.extendsAllInScene ?? 'null'},`);
L(`    implementsAllInScene: ${inv.summary?.implementsAllInScene ?? 'null'},`);
L('  },');
L('} as const;');
L('');
L('export type StabilityContract = typeof CONTRACT;');
L('');
L('/** 读取已填充合同字段；未填则抛错（防止 skip 去掉后静默用 null）。 */');
L('export function requireFilled<T>(value: T | null | undefined, path: string): T {');
L('  if (value === null || value === undefined) {');
L('    throw new Error(');
L(
  "      `CONTRACT.${path} 未填充 — 先跑 aa-scene-inventory.js 并人工审核（arkanalyzer ${CONTRACT.meta.arkanalyzer})`"
);
L('    );');
L('  }');
L('  return value;');
L('}');
L('');
L('export function viewtreeEdgeTotal(byVia: KindCounts): number {');
L('  let n = 0;');
L('  for (const v of Object.values(byVia)) n += v;');
L('  return n;');
L('}');
L('');

fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.error(
  `wrote ${outPath} (am=${c.amKeyCount}, viewtree=${Object.values(c.viewtreeByVia).reduce((a, b) => a + b, 0)})`
);
