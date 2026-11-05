#!/usr/bin/env node
/**
 * Source-only gold miner — diverse kinds/scopes, label+evidence.
 * Does NOT read HomeGraph.
 *
 *   node tools/mine-gold-from-source.mjs --project D:/code/applications_photos --write
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOAK = path.resolve(HERE, '..');

/** Must quotas by (bucket, kind) — total ≈ 320 */
const MUST_QUOTAS = [
  { bucket: 'A', kind: 'calls', scope: 'cross-module', n: 55 },
  { bucket: 'B', kind: 'calls', scope: 'same-file', n: 30, helper: true },
  { bucket: 'C', kind: 'calls', scope: null, n: 15, fanoutPos: true },
  { bucket: 'D', kind: 'calls', scope: 'cross-file', n: 40 },
  { bucket: 'D', kind: 'calls', scope: 'same-file', n: 25 },
  { bucket: 'E', kind: 'calls', scope: null, n: 40, ui: true },
  { bucket: 'F', kind: 'imports', scope: 'cross-module', n: 45 },
  { bucket: 'F', kind: 'extends', scope: null, n: 28 },
  { bucket: 'F', kind: 'implements', scope: null, n: 18 },
  { bucket: 'F', kind: 'contains', scope: 'same-file', n: 24 },
];

/** Must-not quotas — total ≈ 150 */
const MUST_NOT_QUOTAS = [
  { bucket: 'A', n: 25, mode: 'transitive-cross' },
  { bucket: 'C', n: 40, mode: 'fanout-flood' },
  { bucket: 'D', n: 25, mode: 'transitive-same' },
  { bucket: 'B', n: 15, mode: 'unimported' },
  { bucket: 'E', n: 20, mode: 'lifecycle-flood' },
  { bucket: 'F', n: 15, mode: 'extends-reverse' },
  { bucket: 'A', n: 10, mode: 'unknown-sample' },
];

const NAMES = {
  A: 'A-cross-module',
  B: 'B-non-rta-helper',
  C: 'C-fanout',
  D: 'D-same-module',
  E: 'E-lifecycle-ui',
  F: 'F-import-heritage',
};

const NOISE = new Set([
  'setTimeout', 'setInterval', 'then', 'catch', 'map', 'forEach', 'filter',
  'animateTo', 'animateToImmediately', 'getContext', 'Column', 'Row', 'Text',
  'Button', 'List', 'ListItem', 'Image', 'ForEach', 'LazyForEach', 'PanGesture',
  'MenuItem', 'describe', 'beforeEach', 'it', 'expect', 'push', 'get', 'set',
]);

function parseArgs(argv) {
  const out = { project: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--write') out.write = true;
  }
  return out;
}

function norm(p) {
  return String(p).replace(/\\/g, '/');
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

function lineAt(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

function walkEts(root) {
  const out = [];
  const skip = new Set(['node_modules', '.git', '.hvigor', 'oh_modules', 'build', '.homegraph', 'open_source']);
  function rec(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile() && e.name.endsWith('.ets')) out.push(p);
    }
  }
  rec(root);
  return out;
}

function moduleKey(rel) {
  const p = norm(rel);
  const m = p.match(
    /^(feature|product|common|browserCommon|browserCommonPC|browserCommonPhone|AppScope|imageEditor|demo|tools)\/([^/]+)/
  );
  return m ? `${m[1]}/${m[2]}` : p.split('/')[0] || p;
}

function scopeOf(a, b) {
  a = norm(a);
  b = norm(b);
  if (a === b) return 'same-file';
  if (moduleKey(a) !== moduleKey(b)) return 'cross-module';
  return 'cross-file';
}

function isTestPath(f) {
  const p = norm(f);
  return /\/test\//i.test(p) || /ohosTest/i.test(p) || /\.(test|spec)\./i.test(p);
}

function isNoisePath(p) {
  const s = norm(p);
  return (
    s.includes('/tsIgnore/') ||
    s.endsWith('.e.ts') ||
    s.includes('/signature/') ||
    /\/test\//i.test(s) ||
    /ohosTest/i.test(s)
  );
}

function buildPackageMap(root) {
  const map = new Map();
  const skip = new Set(['node_modules', '.git', '.hvigor', 'oh_modules', 'build', '.homegraph']);
  function rec(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name === 'oh-package.json5' || e.name === 'oh-package.json') {
        try {
          const raw = fs.readFileSync(p, 'utf8').replace(/,\s*([}\]])/g, '$1');
          const j = JSON.parse(raw);
          if (j.name) map.set(j.name, path.dirname(p));
        } catch {
          /* ignore */
        }
      }
    }
  }
  rec(root);
  return map;
}

function resolveImport(fromFile, spec, root, pkgMap) {
  let base;
  if (spec.startsWith('.') || spec.startsWith('/')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith('@')) {
    const parts = spec.split('/');
    const pkg = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
    const pkgRoot = pkgMap.get(pkg);
    if (!pkgRoot) return null;
    const rest = parts.slice(2).join('/');
    base = rest ? path.join(pkgRoot, rest) : pkgRoot;
  } else return null;
  for (const c of [base, base + '.ets', path.join(base, 'index.ets'), base + '.ts']) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function collectDefs(src) {
  const defs = new Map();
  const types = new Map();
  let m;
  const fnRe = /^[ \t]*(export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)\s*\(/gm;
  while ((m = fnRe.exec(src))) {
    defs.set(m[2], {
      start: lineAt(src, m.index),
      exported: !!m[1],
      idx: m.index,
      nodeKind: 'function',
    });
  }
  const methodRe =
    /^[ \t]*(export\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_][\w]*)\s*\([^;{]*\)\s*(?::\s*[^{;]+)?\s*\{/gm;
  while ((m = methodRe.exec(src))) {
    const name = m[2];
    if (NOISE.has(name) || defs.has(name)) continue;
    defs.set(name, {
      start: lineAt(src, m.index),
      exported: !!m[1],
      idx: m.index,
      nodeKind: 'method',
    });
  }
  const typeRe = /^[ \t]*(?:export\s+)?(struct|class|interface)\s+([A-Za-z_][\w]*)/gm;
  while ((m = typeRe.exec(src))) {
    types.set(m[2], {
      start: lineAt(src, m.index),
      idx: m.index,
      nodeKind: m[1] === 'struct' ? 'struct' : m[1] === 'interface' ? 'interface' : 'class',
    });
  }
  return { defs, types };
}

function bodyRange(src, fromIdx) {
  const brace = src.indexOf('{', fromIdx);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { start: brace, end: i };
    }
  }
  return null;
}

function enclosingDef(defs, src, callIdx) {
  let best = null;
  for (const [name, d] of defs) {
    const range = bodyRange(src, d.idx);
    if (!range || callIdx <= range.start || callIdx >= range.end) continue;
    if (!best || d.idx >= best.idx) best = { name, ...d };
  }
  return best;
}

function enclosingType(types, src, idx) {
  let best = null;
  for (const [name, d] of types) {
    const range = bodyRange(src, d.idx);
    if (!range || idx <= range.start || idx >= range.end) continue;
    if (!best || d.idx >= best.idx) best = { name, ...d };
  }
  return best;
}

function parseImports(src, file, root, pkgMap) {
  const imports = [];
  const re =
    /import\s+(?:lazy\s+)?(?:type\s+)?(?:(\w+)\s*,\s*)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]|import\s+(?:lazy\s+)?(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[3] || m[5];
    const resolved = resolveImport(file, spec, root, pkgMap);
    if (!resolved) continue;
    const line = lineAt(src, m.index);
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const bit = part.trim();
        if (!bit || bit.startsWith('type ')) continue;
        const am = bit.match(/^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/);
        if (!am) continue;
        imports.push({
          local: am[2] || am[1],
          exported: am[1],
          file: resolved,
          line,
        });
      }
    } else if (m[4]) {
      imports.push({ local: m[4], exported: m[4], file: resolved, line, default: true });
    }
  }
  return imports;
}

function uiCaller(name) {
  return /^(aboutToAppear|aboutToDisappear|onPageShow|onPageHide|onBackPress|build|onClick|onAppear|onDisappear|onCreate|onDestroy)$/.test(
    name
  );
}

function edgeKey(e) {
  return `${e.kind}|${e.callerFile}|${e.callerName}|${e.calleeFile}|${e.calleeName}`;
}

function enrich(e, rootRelCaller) {
  const scope = e.scope || scopeOf(e.callerFile, e.calleeFile);
  const suite = isTestPath(e.callerFile) ? 'test' : 'prod';
  const evidence = `${e.callerFile}:${e.callerStart || e.evidenceLine || 1}`;
  return {
    ...e,
    scope,
    suite,
    evidence,
    label: e.label || 'true',
    status: 'active',
    provenance: 'source-mine+review',
  };
}

function diversify(list) {
  const byMod = new Map();
  for (const e of list) {
    const m = moduleKey(e.callerFile);
    if (!byMod.has(m)) byMod.set(m, []);
    byMod.get(m).push(e);
  }
  const mods = [...byMod.keys()].sort();
  const out = [];
  let i = 0;
  while (out.length < list.length) {
    let added = false;
    for (const m of mods) {
      const arr = byMod.get(m);
      if (i < arr.length) {
        out.push(arr[i]);
        added = true;
      }
    }
    if (!added) break;
    i++;
  }
  return out;
}

function take(list, n, seen) {
  const out = [];
  for (const e of diversify(list)) {
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

function isNoiseEdge(e) {
  if (e.callerName === 'constructor') return true;
  if (NOISE.has(e.callerName) || NOISE.has(e.calleeName)) return true;
  if (isNoisePath(e.callerFile) || isNoisePath(e.calleeFile)) return true;
  if (/\/Log\.(ets|ts)$/.test(e.calleeFile) && /^(error|info|debug|warn)$/.test(e.calleeName)) {
    return true;
  }
  return false;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project || !fs.existsSync(args.project)) {
    console.error('Need --project <applications_photos path>');
    process.exit(1);
  }
  const root = path.resolve(args.project);
  const files = walkEts(root);
  const pkgMap = buildPackageMap(root);
  console.error(`Scanning ${files.length} .ets (packages=${pkgMap.size})`);

  const allCalls = [];
  const importEdges = [];
  const heritage = [];
  const contains = [];
  const importedLocals = new Map(); // file -> Set of imported local names

  for (const file of files) {
    const rel = norm(path.relative(root, file));
    if (isNoisePath(rel)) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const { defs, types } = collectDefs(src);
    const imports = parseImports(src, file, root, pkgMap);
    importedLocals.set(rel, new Set(imports.map((i) => i.local)));

    for (const imp of imports) {
      importEdges.push({
        kind: 'imports',
        bucket: 'F',
        callerFile: rel,
        callerName: imp.local,
        callerStart: imp.line,
        callerNodeKind: 'import',
        calleeFile: norm(path.relative(root, imp.file)),
        calleeName: imp.exported,
        calleeStart: imp.line,
        calleeNodeKind: 'file',
        note: `import { ${imp.exported} }`,
      });
    }

    // heritage
    const byLocal = new Map(imports.map((i) => [i.local, i]));
    const hRe =
      /(?:export\s+)?(?:class|struct)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
    let hm;
    while ((hm = hRe.exec(src))) {
      const cls = hm[1];
      const clsLine = lineAt(src, hm.index);
      const tmeta = types.get(cls);
      if (hm[2]) {
        const imp = byLocal.get(hm[2]);
        heritage.push({
          kind: 'extends',
          bucket: 'F',
          callerFile: rel,
          callerName: cls,
          callerStart: clsLine,
          callerNodeKind: tmeta?.nodeKind || 'class',
          calleeFile: imp ? norm(path.relative(root, imp.file)) : rel,
          calleeName: hm[2],
          calleeNodeKind: 'class',
          note: `extends ${hm[2]}`,
        });
      }
      if (hm[3]) {
        for (const raw of hm[3].split(',')) {
          const name = raw.trim();
          if (!name) continue;
          const imp = byLocal.get(name);
          heritage.push({
            kind: 'implements',
            bucket: 'F',
            callerFile: rel,
            callerName: cls,
            callerStart: clsLine,
            callerNodeKind: tmeta?.nodeKind || 'class',
            calleeFile: imp ? norm(path.relative(root, imp.file)) : rel,
            calleeName: name,
            calleeNodeKind: 'interface',
            note: `implements ${name}`,
          });
        }
      }
    }

    // contains: type → method/function inside body
    for (const [tName, t] of types) {
      const range = bodyRange(src, t.idx);
      if (!range) continue;
      for (const [dName, d] of defs) {
        if (d.idx <= range.start || d.idx >= range.end) continue;
        if (NOISE.has(dName)) continue;
        contains.push({
          kind: 'contains',
          bucket: 'F',
          callerFile: rel,
          callerName: tName,
          callerStart: t.start,
          callerNodeKind: t.nodeKind,
          calleeFile: rel,
          calleeName: dName,
          calleeStart: d.start,
          calleeNodeKind: d.nodeKind,
          note: `${t.nodeKind} contains ${dName}`,
          scope: 'same-file',
        });
      }
    }

    // calls
    const callRe = /\b([A-Za-z_][\w]*)\s*(?:\.\s*([A-Za-z_][\w]*))?\s*\(/g;
    let cm;
    while ((cm = callRe.exec(src))) {
      const recv = cm[1];
      const method = cm[2] || null;
      if (NOISE.has(recv) || (method && NOISE.has(method))) continue;
      const enc = enclosingDef(defs, src, cm.index);
      if (!enc || enc.name === 'constructor') continue;
      const callLine = lineAt(src, cm.index);
      let edge = null;
      if (method) {
        if (recv === 'this') {
          const d = defs.get(method);
          if (!d) continue;
          edge = {
            kind: 'calls',
            callerFile: rel,
            callerName: enc.name,
            callerStart: enc.start,
            callerNodeKind: enc.nodeKind,
            calleeFile: rel,
            calleeName: method,
            calleeStart: d.start,
            calleeNodeKind: d.nodeKind,
            note: `this.${method}()`,
            sameFile: true,
            calleeExported: d.exported,
          };
        } else {
          const imp = byLocal.get(recv);
          if (!imp) continue;
          edge = {
            kind: 'calls',
            callerFile: rel,
            callerName: enc.name,
            callerStart: enc.start,
            callerNodeKind: enc.nodeKind,
            calleeFile: norm(path.relative(root, imp.file)),
            calleeName: method,
            note: `${recv}.${method}()`,
            crossImport: true,
            calleeNodeKind: 'method',
          };
        }
      } else {
        const imp = byLocal.get(recv);
        if (imp) {
          edge = {
            kind: 'calls',
            callerFile: rel,
            callerName: enc.name,
            callerStart: enc.start,
            callerNodeKind: enc.nodeKind,
            calleeFile: norm(path.relative(root, imp.file)),
            calleeName: imp.exported,
            note: `imported ${recv}()`,
            crossImport: true,
            calleeNodeKind: 'function',
          };
        } else {
          const d = defs.get(recv);
          if (!d) continue;
          edge = {
            kind: 'calls',
            callerFile: rel,
            callerName: enc.name,
            callerStart: enc.start,
            callerNodeKind: enc.nodeKind,
            calleeFile: rel,
            calleeName: recv,
            calleeStart: d.start,
            calleeNodeKind: d.nodeKind,
            note: `local ${recv}()`,
            sameFile: true,
            calleeExported: d.exported,
          };
        }
      }
      if (edge) allCalls.push(edge);
    }
  }

  console.error(
    `raw calls=${allCalls.length} imports=${importEdges.length} heritage=${heritage.length} contains=${contains.length}`
  );

  const callsClean = allCalls.filter((e) => !isNoiseEdge(e));
  const inDeg = new Map();
  for (const e of callsClean) {
    const k = `${e.calleeFile}\0${e.calleeName}`;
    inDeg.set(k, (inDeg.get(k) || 0) + 1);
  }

  const pools = {
    calls_cross_module: callsClean.filter((e) => scopeOf(e.callerFile, e.calleeFile) === 'cross-module'),
    calls_same_file_helper: callsClean.filter(
      (e) => e.sameFile && e.calleeExported === false && scopeOf(e.callerFile, e.calleeFile) === 'same-file'
    ),
    calls_fanout_pos: callsClean.filter((e) => (inDeg.get(`${e.calleeFile}\0${e.calleeName}`) || 0) >= 6),
    calls_cross_file: callsClean.filter((e) => scopeOf(e.callerFile, e.calleeFile) === 'cross-file'),
    calls_same_file: callsClean.filter((e) => scopeOf(e.callerFile, e.calleeFile) === 'same-file'),
    calls_ui: callsClean.filter((e) => uiCaller(e.callerName)),
    imports_xm: importEdges.filter(
      (e) => scopeOf(e.callerFile, e.calleeFile) === 'cross-module' && !isNoisePath(e.calleeFile)
    ),
    extends: heritage.filter((e) => e.kind === 'extends' && !isNoisePath(e.calleeFile)),
    implements: heritage.filter((e) => e.kind === 'implements' && !isNoisePath(e.calleeFile)),
    contains: contains.filter((e) => !NOISE.has(e.calleeName)),
  };

  const seenMust = new Set();
  const mustByBucket = { A: [], B: [], C: [], D: [], E: [], F: [] };

  function addMust(bucket, list, n, extra = {}) {
    const taken = take(list, n, seenMust).map((e) =>
      enrich({ ...e, bucket, ...extra, label: 'true' })
    );
    mustByBucket[bucket].push(...taken);
    return taken.length;
  }

  addMust('A', pools.calls_cross_module, 55, { kind: 'calls' });
  addMust('B', pools.calls_same_file_helper, 30, { kind: 'calls' });
  addMust('C', pools.calls_fanout_pos, 15, { kind: 'calls' });
  addMust('D', pools.calls_cross_file, 40, { kind: 'calls' });
  addMust('D', pools.calls_same_file, 25, { kind: 'calls' });
  addMust('E', pools.calls_ui, 40, { kind: 'calls' });
  addMust('F', pools.imports_xm, 45, { kind: 'imports' });
  addMust('F', pools.extends, 28, { kind: 'extends' });
  addMust('F', pools.implements, 18, { kind: 'implements' });
  addMust('F', pools.contains, 24, { kind: 'contains' });

  // must-not
  const adj = new Map();
  const directSet = new Set(callsClean.map(edgeKey));
  for (const e of callsClean) {
    const a = `${e.callerFile}\0${e.callerName}`;
    const b = `${e.calleeFile}\0${e.calleeName}`;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }
  const hot = [...inDeg.entries()]
    .filter(([k, n]) => n >= 8 && !/\/Log\./.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([k]) => k);

  const transitive = [];
  for (const e of callsClean) {
    const mid = `${e.calleeFile}\0${e.calleeName}`;
    for (const n of adj.get(mid) || []) {
      const [cf, cn] = n.split('\0');
      const fake = {
        kind: 'calls',
        callerFile: e.callerFile,
        callerName: e.callerName,
        callerStart: e.callerStart,
        callerNodeKind: e.callerNodeKind,
        calleeFile: cf,
        calleeName: cn,
        note: 'transitive collapse forbidden',
      };
      if (directSet.has(edgeKey(fake))) continue;
      transitive.push(fake);
    }
  }

  const uiCallers = callsClean.filter((e) => uiCaller(e.callerName));
  const flood = [];
  for (const hotKey of hot) {
    const [hf, hn] = hotKey.split('\0');
    for (const u of uiCallers) {
      const fake = {
        kind: 'calls',
        callerFile: u.callerFile,
        callerName: u.callerName,
        callerStart: u.callerStart,
        callerNodeKind: u.callerNodeKind,
        calleeFile: hf,
        calleeName: hn,
        note: 'fanout/lifecycle flood forbidden',
      };
      if (directSet.has(edgeKey(fake))) continue;
      flood.push(fake);
    }
  }

  const unimported = [];
  for (const e of callsClean.slice(0, 2000)) {
    // fabricate: same caller → a class name never imported in that file
    const locals = importedLocals.get(e.callerFile) || new Set();
    for (const h of heritage.slice(0, 200)) {
      if (locals.has(h.callerName)) continue;
      if (h.callerFile === e.callerFile) continue;
      unimported.push({
        kind: 'calls',
        callerFile: e.callerFile,
        callerName: e.callerName,
        callerStart: e.callerStart,
        calleeFile: h.callerFile,
        calleeName: h.callerName,
        note: 'call to class not imported in caller file',
      });
      if (unimported.length > 400) break;
    }
    if (unimported.length > 400) break;
  }

  const extendsRev = pools.extends.map((h) => ({
    kind: 'extends',
    callerFile: h.calleeFile,
    callerName: h.calleeName,
    calleeFile: h.callerFile,
    calleeName: h.callerName,
    note: '继承方向反了（子类←父类 不应成立）',
  }));

  const implementsRev = pools.implements.map((h) => ({
    kind: 'implements',
    callerFile: h.calleeFile,
    callerName: h.calleeName,
    calleeFile: h.callerFile,
    calleeName: h.callerName,
    note: '接口实现方向反了',
  }));

  // Wrong import target: keep importer symbol, point to an unrelated file
  const importsWrong = [];
  const importPool = pools.imports_xm;
  for (let i = 0; i < importPool.length; i++) {
    const a = importPool[i];
    const b = importPool[(i + 17) % importPool.length];
    if (!b || a.calleeFile === b.calleeFile) continue;
    importsWrong.push({
      kind: 'imports',
      callerFile: a.callerFile,
      callerName: a.callerName,
      callerStart: a.callerStart,
      callerNodeKind: 'import',
      calleeFile: b.calleeFile,
      calleeName: b.calleeName,
      calleeNodeKind: 'file',
      note: '导入目标文件张冠李戴',
    });
  }

  // Wrong contains: class claimed to contain a method from another type in same file set
  const containsWrong = [];
  for (let i = 0; i < pools.contains.length; i++) {
    const a = pools.contains[i];
    const b = pools.contains[(i + 23) % pools.contains.length];
    if (!b || a.callerFile !== b.callerFile) continue;
    if (a.callerName === b.callerName && a.calleeName === b.calleeName) continue;
    containsWrong.push({
      kind: 'contains',
      callerFile: a.callerFile,
      callerName: a.callerName,
      callerStart: a.callerStart,
      callerNodeKind: a.callerNodeKind,
      calleeFile: a.callerFile,
      calleeName: b.calleeName,
      calleeStart: b.calleeStart,
      calleeNodeKind: b.calleeNodeKind,
      note: '类/结构并不包含该方法',
      scope: 'same-file',
    });
  }

  const seenNo = new Set();
  const mustNotByBucket = { A: [], B: [], C: [], D: [], E: [], F: [] };

  function addNot(bucket, list, n, label = 'false') {
    const taken = take(list, n, seenNo).map((e) =>
      enrich({ ...e, bucket, label })
    );
    mustNotByBucket[bucket].push(...taken);
  }

  // Diversified must-not (~150): not only calls
  addNot(
    'A',
    transitive.filter((e) => scopeOf(e.callerFile, e.calleeFile) === 'cross-module'),
    18
  );
  addNot('C', flood, 22);
  addNot(
    'D',
    transitive.filter((e) => scopeOf(e.callerFile, e.calleeFile) !== 'cross-module'),
    18
  );
  addNot('B', unimported, 12);
  addNot('E', flood.filter((e) => uiCaller(e.callerName)), 12);
  addNot('F', extendsRev, 18);
  addNot('F', implementsRev, 15);
  addNot('F', importsWrong, 20);
  addNot('F', containsWrong, 15);
  // unknown samples — ambiguous / review queue, not in P/R
  addNot('A', transitive.slice(500, 800), 10, 'unknown');

  let mustTotal = 0;
  let mustNotTotal = 0;
  for (const b of Object.keys(NAMES)) {
    mustTotal += mustByBucket[b].length;
    mustNotTotal += mustNotByBucket[b].length;
    console.error(
      `  ${b}: must=${mustByBucket[b].length} must-not=${mustNotByBucket[b].length}`
    );
  }
  console.error(`selected must=${mustTotal} must-not=${mustNotTotal}`);

  // kind distribution
  const kindCount = {};
  const kindNot = {};
  for (const b of Object.keys(mustByBucket)) {
    for (const e of mustByBucket[b]) kindCount[e.kind] = (kindCount[e.kind] || 0) + 1;
    for (const e of mustNotByBucket[b]) kindNot[e.kind] = (kindNot[e.kind] || 0) + 1;
  }
  console.error('must kinds', kindCount);
  console.error('must-not kinds', kindNot);

  if (!args.write) {
    console.log(JSON.stringify({ mustByBucket, mustNotByBucket }, null, 2));
    return;
  }

  for (const b of Object.keys(NAMES)) {
    const mustPath = path.join(SOAK, 'gold', 'must', `${NAMES[b]}.json`);
    const notPath = path.join(SOAK, 'gold', 'must-not', `${NAMES[b]}.json`);
    fs.mkdirSync(path.dirname(mustPath), { recursive: true });
    fs.writeFileSync(
      mustPath,
      JSON.stringify(
        { bucket: b, polarity: 'must', targetRepo: 'applications_photos', edges: mustByBucket[b] },
        null,
        2
      ) + '\n'
    );
    fs.writeFileSync(
      notPath,
      JSON.stringify(
        {
          bucket: b,
          polarity: 'must-not',
          targetRepo: 'applications_photos',
          edges: mustNotByBucket[b],
        },
        null,
        2
      ) + '\n'
    );
  }
  console.error('Wrote gold/must|must-not/*.json');
}

main();
