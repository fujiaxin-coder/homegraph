/**
 * 将已审核 aa-scene-inventory.json 写入 tests/contract.ts。
 * 流程：node aa-scene-inventory.js → 人工审 → node sync-contract-from-inventory.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const inv = JSON.parse(fs.readFileSync(path.join(HERE, 'aa-scene-inventory.json'), 'utf8'));
if (inv.meta?.projectPath) {
  throw new Error('inventory 含绝对路径 — 重跑 aa-scene-inventory.js');
}
const c = inv.contract;
if (!c?.fingerprints || !c?.expected || !c?.scene) {
  throw new Error('inventory.contract 缺 scene/fingerprints/expected — 升级采集脚本后重跑');
}

const amKeysLit = c.fingerprints.amKeys
  .map((k) => {
    if (k.split('\0').length !== 3) throw new Error(`bad amKey ${JSON.stringify(k)}`);
    return `      ${JSON.stringify(k)},`;
  })
  .join('\n');

const vt = JSON.stringify(c.fingerprints.viewtreeByVia, null, 2)
  .split('\n')
  .map((line, i) => (i === 0 ? line : `    ${line}`))
  .join('\n');
const nbk = JSON.stringify(c.expected.nodesByKind, null, 2)
  .split('\n')
  .map((line, i) => (i === 0 ? line : `    ${line}`))
  .join('\n');
const ebk = JSON.stringify(c.expected.edgesByKind, null, 2)
  .split('\n')
  .map((line, i) => (i === 0 ? line : `    ${line}`))
  .join('\n');

const lines = [];
const L = (s = '') => lines.push(s);

L('/**');
L(' * 鸿蒙图稳定性合同（AA 锚定基线）。');
L(' *');
L(' * 刷新：node ../aa-scene-inventory.js → 审 JSON → node ../sync-contract-from-inventory.js');
L(' * 真值只来自 AA 全量 Scene + 审核。禁止 HG 回填。');
L(' */');
L('');
L('export type KindCounts = Record<string, number>;');
L('');
L('/** AA 全量 Scene %AM 清单（审计用）。HG 测例只核数量 + 名为 %AM*。 */');
L('export type AmKey = string;');
L('');
L('export const CONTRACT = {');
L('  meta: {');
L(`    arkanalyzer: ${JSON.stringify(inv.meta.arkanalyzer)},`);
L("    fixture: 'project/',");
L("    inventory: '../aa-scene-inventory.json',");
L('    filled: {');
L('      scene: true,');
L('      fingerprints: true,');
L('      expected: true,');
L('    },');
L('  },');
L('');
L('  scene: {');
L(`    files: ${c.scene.files},`);
L(`    classes: ${c.scene.classes},`);
L(`    methods: ${c.scene.methods},`);
L(`    extendsAllInScene: ${c.scene.extendsAllInScene},`);
L(`    implementsAllInScene: ${c.scene.implementsAllInScene},`);
L('  },');
L('');
L('  fingerprints: {');
L(`    etsFileNodes: ${c.fingerprints.etsFileNodes},`);
L(`    imports: ${c.fingerprints.imports},`);
L(`    extends: ${c.fingerprints.extends},`);
L(`    implements: ${c.fingerprints.implements},`);
L('    amKeys: [');
L(amKeysLit);
L('    ] as AmKey[],');
L(`    amKeyCount: ${c.fingerprints.amKeyCount},`);
L(`    amFileCount: ${c.fingerprints.amFileCount},`);
L(`    viewtreeByVia: ${vt} as KindCounts,`);
L('  },');
L('');
L('  /** HG persist expected：去 %AC + DummyMain/callable 偏移 + RTA−无节点 SDK。 */');
L('  expected: {');
L(`    nodesByKind: ${nbk} as KindCounts,`);
L(`    edgesByKind: ${ebk} as KindCounts,`);
L(`    containsTotal: ${c.expected.containsTotal},`);
L(`    callEdgeCount: ${c.expected.callEdgeCount},`);
L(
  `    callEdgeCountAll: ${c.expected.callEdgeCountAll ?? c.expected.callEdgeCount},`
);
L(`    viewtreeEdgeTotal: ${c.expected.viewtreeEdgeTotal},`);
L(`    types: ${c.expected.types},`);
L(`    methods: ${c.expected.methods},`);
L(`    fields: ${c.expected.fields},`);
L(`    components: ${c.expected.components},`);
L(
  `    fileNodesWithDummyMain: ${c.expected.fileNodesWithDummyMain ?? c.fingerprints.etsFileNodes + 1},`
);
L(
  `    classNodesWithDummyMain: ${c.expected.classNodesWithDummyMain ?? (c.expected.nodesByKind.class ?? 0) + 1},`
);
L(
  `    callableNodesWithDummyMain: ${c.expected.callableNodesWithDummyMain ?? c.expected.methods},`
);
L('  },');
L('} as const;');
L('');
L('export type StabilityContract = typeof CONTRACT;');
L('');
L('export function viewtreeEdgeTotal(byVia: KindCounts): number {');
L('  let n = 0;');
L('  for (const v of Object.values(byVia)) n += v;');
L('  return n;');
L('}');
L('');

const outPath = path.join(HERE, 'tests', 'contract.ts');
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.error(
  `wrote ${outPath} contains=${c.expected.containsTotal} calls=${c.expected.callEdgeCount} am=${c.fingerprints.amKeyCount}`
);
