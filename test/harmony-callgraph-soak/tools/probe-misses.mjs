import { HomeGraph } from '../../../dist/index.js';

const root = 'D:/code/applications_photos';
const cg = HomeGraph.openSync(root);
const nodes = cg.getQueryBuilder().getAllNodes();
const byId = new Map(nodes.map((n) => [n.id, n]));
const norm = (p) => String(p || '').replace(/\\/g, '/');

function outs(pred, kind) {
  const hits = [];
  for (const node of nodes) {
    if (!pred(node)) continue;
    for (const e of cg.getOutgoingEdges(node.id)) {
      if (kind && e.kind !== kind) continue;
      const t = byId.get(e.target);
      if (!t) continue;
      hits.push({
        from: node.name,
        fromKind: node.kind,
        fromFile: norm(node.filePath),
        kind: e.kind,
        to: t.name,
        toKind: t.kind,
        toFile: norm(t.filePath),
        synth: e.metadata?.synthesizedBy,
      });
    }
  }
  return hits;
}

const importSamples = [];
for (const node of nodes) {
  for (const e of cg.getOutgoingEdges(node.id)) {
    if (e.kind !== 'imports') continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const sf = norm(s.filePath);
    if (!sf.includes('SideBar.ets') && !sf.includes('BaseEditorController')) continue;
    importSamples.push({
      sKind: s.kind,
      sName: s.name,
      sFile: sf,
      tKind: t.kind,
      tName: t.name,
      tFile: norm(t.filePath),
    });
    if (importSamples.length >= 10) break;
  }
  if (importSamples.length >= 10) break;
}
console.log('IMPORT_SHAPE', JSON.stringify(importSamples, null, 2));

const listStyle = outs(
  (n) =>
    norm(n.filePath).endsWith('feature/browser/src/main/ets/default/view/SideBar.ets') &&
    (n.name === 'listStyle' || String(n.name).endsWith('$listStyle')),
  'calls'
);
console.log(
  'listStyle_calls',
  listStyle.filter((h) => /isPc|DeviceInfo/i.test(h.to + h.toFile)).slice(0, 10)
);
console.log('listStyle_call_count', listStyle.length);

const leftMenus = outs(
  (n) =>
    norm(n.filePath).endsWith(
      'browserCommon/src/main/ets/default/view/actionbar/ActionBar.ets'
    ) &&
    (n.name === 'LeftMenus' || String(n.name).endsWith('$LeftMenus')),
  'calls'
);
console.log(
  'LeftMenus_to_createArray',
  leftMenus.filter((h) => h.to.includes('createArray')).slice(0, 5)
);
console.log(
  'LeftMenus_sample',
  leftMenus.slice(0, 12).map((h) => h.to)
);

cg.close();
