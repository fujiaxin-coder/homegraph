#!/usr/bin/env node
/**
 * Source-only gold miner for applications_photos.
 * Does NOT read HomeGraph index — only .ets text.
 *
 * Usage:
 *   node tools/mine-gold-from-source.mjs --project D:/code/applications_photos
 *   node tools/mine-gold-from-source.mjs --project ... --write
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOAK = path.resolve(HERE, '..');
const BUCKETS = ['A', 'B', 'C', 'D', 'E', 'F'];
const MUST_TARGET = { A: 45, B: 25, C: 10, D: 50, E: 40, F: 30 }; // = 200
const MUST_NOT_TARGET = { A: 20, B: 10, C: 30, D: 15, E: 15, F: 10 }; // = 100

function parseArgs(argv) {
  const out = { project: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--write') out.write = true;
  }
  return out;
}

function norm(p) {
  return p.replace(/\\/g, '/');
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
      else if (e.isFile() && e.name.endsWith('.ets')) out.push(p);
    }
  }
  rec(root);
  return out;
}

function moduleKey(rel) {
  const p = norm(rel);
  const m = p.match(/^(feature|product|common|browserCommon|browserCommonPC|browserCommonPhone|AppScope|imageEditor|demo)\/([^/]+)/);
  if (m) return `${m[1]}/${m[2]}`;
  const top = p.split('/')[0];
  return top || p;
}

/** Map @ohos/pkg → absolute dir by scanning oh-package.json5 name fields. */
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
          /* ignore bad json5 */
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
    // @ohos/common/src/main/ets/foo → <commonDir>/src/main/ets/foo
    const parts = spec.split('/');
    // @ohos/common or @ohos/tools
    const pkg = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
    const pkgRoot = pkgMap.get(pkg);
    if (!pkgRoot) return null;
    const rest = parts.slice(2).join('/');
    base = rest ? path.join(pkgRoot, rest) : pkgRoot;
  } else {
    return null;
  }
  const cands = [base, base + '.ets', path.join(base, 'index.ets'), base + '.ts'];
  for (const c of cands) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Collect exported + local function/method defs: name -> {start, exported, kind} */
function collectDefs(src) {
  const defs = new Map();
  const re =
    /^[ \t]*(export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)\s*\(|^[ \t]*(export\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?::\s*[^{;]+)?\s*\{/gm;
  let m;
  while ((m = re.exec(src))) {
    const exported = !!(m[1] || m[3]);
    const name = m[2] || m[4];
    if (!name || name === 'if' || name === 'for' || name === 'while' || name === 'switch') continue;
    if (defs.has(name)) continue;
    defs.set(name, { start: lineAt(src, m.index), exported, idx: m.index });
  }
  // struct/class names
  const typeRe = /^[ \t]*(?:export\s+)?(?:struct|class|interface)\s+([A-Za-z_][\w]*)/gm;
  while ((m = typeRe.exec(src))) {
    defs.set(m[1], {
      start: lineAt(src, m.index),
      exported: true,
      idx: m.index,
      isType: true,
    });
  }
  return defs;
}

/** Rough function body ranges by brace match from def idx */
function bodyRange(src, fromIdx) {
  const brace = src.indexOf('{', fromIdx);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { start: brace, end: i };
    }
  }
  return null;
}

function enclosingDef(defs, src, callIdx) {
  let best = null;
  for (const [name, d] of defs) {
    if (d.isType) continue;
    const range = bodyRange(src, d.idx);
    if (!range) continue;
    if (callIdx > range.start && callIdx < range.end) {
      if (!best || d.idx >= best.idx) best = { name, ...d };
    }
  }
  return best;
}

function parseImports(src, file, root, pkgMap) {
  const imports = [];
  // Supports: import { X }, import lazy { X }, import type { X }
  const re =
    /import\s+(?:lazy\s+)?(?:type\s+)?(?:(\w+)\s*,\s*)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]|import\s+(?:lazy\s+)?(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[3] || m[5];
    const resolved = resolveImport(file, spec, root, pkgMap);
    if (!resolved) continue;
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
          line: lineAt(src, m.index),
        });
      }
    } else if (m[4]) {
      imports.push({
        local: m[4],
        exported: m[4],
        file: resolved,
        line: lineAt(src, m.index),
        default: true,
      });
    }
  }
  return imports;
}

function parseHeritage(src, file, root, imports) {
  const edges = [];
  const byLocal = new Map(imports.map((i) => [i.local, i]));
  const re =
    /(?:export\s+)?(?:class|struct)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g;
  let m;
  while ((m = re.exec(src))) {
    const cls = m[1];
    const clsLine = lineAt(src, m.index);
    if (m[2]) {
      const imp = byLocal.get(m[2]);
      edges.push({
        kind: 'extends',
        callerFile: norm(path.relative(root, file)),
        callerName: cls,
        callerStart: clsLine,
        calleeFile: imp
          ? norm(path.relative(root, imp.file))
          : norm(path.relative(root, file)),
        calleeName: m[2],
        calleeStart: imp?.line,
        note: `extends ${m[2]}`,
      });
    }
    if (m[3]) {
      for (const raw of m[3].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        const imp = byLocal.get(name);
        edges.push({
          kind: 'implements',
          callerFile: norm(path.relative(root, file)),
          callerName: cls,
          callerStart: clsLine,
          calleeFile: imp
            ? norm(path.relative(root, imp.file))
            : norm(path.relative(root, file)),
          calleeName: name,
          note: `implements ${name}`,
        });
      }
    }
  }
  return edges;
}

function findCallsInFile(src, file, root, imports, defs) {
  const rel = norm(path.relative(root, file));
  const byLocal = new Map(imports.map((i) => [i.local, i]));
  const calls = [];

  // Ident.method(  or Ident(
  const callRe = /\b([A-Za-z_][\w]*)\s*(?:\.\s*([A-Za-z_][\w]*))?\s*\(/g;
  let m;
  while ((m = callRe.exec(src))) {
    const recv = m[1];
    const method = m[2] || null;
    if (
      [
        'if',
        'for',
        'while',
        'switch',
        'catch',
        'function',
        'new',
        'return',
        'await',
        'typeof',
        'console',
        'Column',
        'Row',
        'Text',
        'Button',
        'Stack',
        'List',
        'Grid',
        'Flex',
        'Scroll',
        'Blank',
        'Divider',
        'Image',
        'ForEach',
        'LazyForEach',
        'If',
        'Else',
        'Tabs',
        'TabContent',
      ].includes(recv)
    ) {
      continue;
    }
    const enc = enclosingDef(defs, src, m.index);
    if (!enc) continue;
    const callLine = lineAt(src, m.index);

    if (method) {
      if (recv === 'this') {
        const d = defs.get(method);
        if (!d || d.isType) continue;
        calls.push({
          kind: 'calls',
          callerFile: rel,
          callerName: enc.name,
          callerStart: enc.start,
          calleeFile: rel,
          calleeName: method,
          calleeStart: d.start,
          note: `this.${method}()`,
          sameFile: true,
        });
      } else {
        const imp = byLocal.get(recv);
        if (!imp) continue;
        // Class.staticMethod or instance from import — treat as call to method name in import file
        calls.push({
          kind: 'calls',
          callerFile: rel,
          callerName: enc.name,
          callerStart: enc.start,
          calleeFile: norm(path.relative(root, imp.file)),
          calleeName: method,
          note: `${recv}.${method}()`,
          crossImport: true,
        });
      }
    } else {
      // bare call
      if (recv === enc.name) continue;
      const imp = byLocal.get(recv);
      if (imp) {
        calls.push({
          kind: 'calls',
          callerFile: rel,
          callerName: enc.name,
          callerStart: enc.start,
          calleeFile: norm(path.relative(root, imp.file)),
          calleeName: imp.exported,
          calleeStart: imp.line,
          note: `imported ${recv}()`,
          crossImport: true,
        });
      } else {
        const d = defs.get(recv);
        if (!d || d.isType) continue;
        calls.push({
          kind: 'calls',
          callerFile: rel,
          callerName: enc.name,
          callerStart: enc.start,
          calleeFile: rel,
          calleeName: recv,
          calleeStart: d.start,
          note: `local ${recv}()`,
          sameFile: true,
          calleeExported: d.exported,
        });
      }
    }
  }
  return calls;
}

function uiCaller(name) {
  return /^(aboutToAppear|aboutToDisappear|onPageShow|onPageHide|onBackPress|build|onClick|onAppear|onDisappear)$/.test(
    name
  );
}

const NOISE_NAMES = new Set([
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'then',
  'catch',
  'finally',
  'map',
  'forEach',
  'filter',
  'reduce',
  'find',
  'some',
  'every',
  'push',
  'pop',
  'parse',
  'stringify',
  'get',
  'set',
  'has',
  'add',
  'delete',
  'next',
  'valueOf',
  'toString',
  // ArkUI / runtime globals often mistaken as local defs
  'animateTo',
  'animateToImmediately',
  'getContext',
  'getInspectorInfo',
  'xp',
  'px2vp',
  'vp2px',
  'fp2px',
  'lpx2px',
  'px2lpx',
  'AppStorage',
  'LocalStorage',
  'PersistentStorage',
  'env',
  'emit',
  'on',
  'off',
  // declarative UI components / builders mistaken as local callees
  'Column',
  'Row',
  'Text',
  'Button',
  'Stack',
  'List',
  'ListItem',
  'ListItemGroup',
  'Grid',
  'GridItem',
  'Flex',
  'Scroll',
  'Blank',
  'Divider',
  'Image',
  'ForEach',
  'LazyForEach',
  'If',
  'Else',
  'Tabs',
  'TabContent',
  'Menu',
  'MenuItem',
  'MenuItemGroup',
  'Binder',
  'Span',
  'RelativeContainer',
  'Swiper',
  'WaterFlow',
  'FlowItem',
  'Refresh',
  'Sidebar',
  'Navigation',
  'NavDestination',
  'AlphabetIndexer',
  'TextInput',
  'TextArea',
  'Search',
  'Slider',
  'Toggle',
  'Checkbox',
  'Radio',
  'Progress',
  'LoadingProgress',
  'Badge',
  'Canvas',
  'Video',
  'Web',
  'XComponent',
  'Marquee',
  'PluginComponent',
  'FormComponent',
  'Component',
  'Entry',
  'Builder',
  'describe',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'it',
  'expect',
]);

function isNoisePath(p) {
  const s = norm(p);
  return (
    s.includes('/tsIgnore/') ||
    s.includes('/open_source/') ||
    s.endsWith('.e.ts') ||
    s.includes('/signature/') ||
    /\/test\//i.test(s) ||
    /\.(test|spec)\.(ets|ts)$/i.test(s) ||
    /Test\.ets$/i.test(s)
  );
}

function isNoiseEdge(e) {
  // constructor as caller is usually a false enclosing-def; as callee is OK (new X)
  if (e.callerName === 'constructor') return true;
  if (NOISE_NAMES.has(e.callerName) || NOISE_NAMES.has(e.calleeName)) return true;
  if (isNoisePath(e.callerFile) || isNoisePath(e.calleeFile)) return true;
  // Log.* dominates photos — keep a few but prefer real business edges
  if (/\/Log\.(ets|ts)$/.test(e.calleeFile) && /^(error|info|debug|warn)$/.test(e.calleeName)) {
    return true;
  }
  return false;
}

function classifyMust(edge, rootRelCaller, rootRelCallee) {
  if (edge.kind !== 'calls') return 'F';
  if (uiCaller(edge.callerName) || uiCaller(edge.calleeName)) return 'E';
  const mc = moduleKey(edge.callerFile);
  const mt = moduleKey(edge.calleeFile);
  if (mc !== mt) return 'A';
  if (edge.sameFile && edge.calleeExported === false) return 'B';
  if (edge.sameFile || mc === mt) return 'D';
  return 'D';
}

function edgeKey(e) {
  return `${e.kind}|${e.callerFile}|${e.callerName}|${e.calleeFile}|${e.calleeName}`;
}

function takeUnique(list, n, seen) {
  const out = [];
  for (const e of list) {
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

function diversify(list) {
  // Prefer spreading across files/modules
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = args.project;
  if (!project || !fs.existsSync(project)) {
    console.error('Need --project <applications_photos path>');
    process.exit(1);
  }
  const root = path.resolve(project);
  const files = walkEts(root);
  const pkgMap = buildPackageMap(root);
  console.error(`Scanning ${files.length} .ets under ${root} (packages=${pkgMap.size})`);

  const allCalls = [];
  const heritage = [];
  const importEdges = [];
  const defsByFile = new Map();

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const src = stripComments(raw);
    const defs = collectDefs(src);
    defsByFile.set(norm(path.relative(root, file)), defs);
    const imports = parseImports(src, file, root, pkgMap);
    for (const imp of imports) {
      importEdges.push({
        kind: 'imports',
        callerFile: norm(path.relative(root, file)),
        callerName: imp.local,
        callerStart: imp.line,
        calleeFile: norm(path.relative(root, imp.file)),
        calleeName: imp.exported,
        note: `import { ${imp.exported} }`,
      });
    }
    heritage.push(...parseHeritage(src, file, root, imports));
    allCalls.push(...findCallsInFile(src, file, root, imports, defs));
  }

  console.error(
    `calls=${allCalls.length} imports=${importEdges.length} heritage=${heritage.length}`
  );

  const mustPools = { A: [], B: [], C: [], D: [], E: [], F: [] };
  const callsClean = allCalls.filter((e) => !isNoiseEdge(e));
  for (const e of callsClean) {
    const b = classifyMust(e);
    mustPools[b].push(e);
  }
  // C must = legitimate calls INTO hot/fanout-shaped APIs (positive controls)
  const inDegAll = new Map();
  for (const e of allCalls) {
    const k = `${e.calleeFile}\0${e.calleeName}`;
    inDegAll.set(k, (inDegAll.get(k) || 0) + 1);
  }
  mustPools.C = callsClean.filter((e) => {
    const deg = inDegAll.get(`${e.calleeFile}\0${e.calleeName}`) || 0;
    return deg >= 6 || /^(getInstance|getContext)$/.test(e.calleeName);
  });

  mustPools.F = diversify([
    ...importEdges.filter(
      (e) =>
        moduleKey(e.callerFile) !== moduleKey(e.calleeFile) &&
        !isNoisePath(e.callerFile) &&
        !isNoisePath(e.calleeFile) &&
        !/\/Log\.(ets|ts)$/.test(e.calleeFile)
    ),
    ...heritage.filter((e) => !isNoisePath(e.callerFile) && !isNoisePath(e.calleeFile)),
  ]);

  for (const b of BUCKETS) {
    mustPools[b] = diversify(mustPools[b]);
  }

  const seenMust = new Set();
  const mustByBucket = {};
  for (const b of BUCKETS) {
    mustByBucket[b] = takeUnique(mustPools[b], MUST_TARGET[b], seenMust).map((e) => ({
      bucket: b,
      kind: e.kind,
      callerFile: e.callerFile,
      callerName: e.callerName,
      callerStart: e.callerStart,
      calleeFile: e.calleeFile,
      calleeName: e.calleeName,
      calleeStart: e.calleeStart,
      note: e.note,
      status: 'active',
      provenance: 'source-mine+review',
    }));
  }

  // must-not: transitive collapse + fanout strangers + skip-level
  const adj = new Map();
  for (const e of callsClean) {
    const a = `${e.callerFile}\0${e.callerName}`;
    const b = `${e.calleeFile}\0${e.calleeName}`;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }
  const directSet = new Set(callsClean.map(edgeKey));
  const mustNotPools = { A: [], B: [], C: [], D: [], E: [], F: [] };

  for (const e of callsClean) {
    const mid = `${e.calleeFile}\0${e.calleeName}`;
    const nexts = adj.get(mid);
    if (!nexts) continue;
    for (const n of nexts) {
      const [cf, cn] = n.split('\0');
      const fake = {
        kind: 'calls',
        callerFile: e.callerFile,
        callerName: e.callerName,
        callerStart: e.callerStart,
        calleeFile: cf,
        calleeName: cn,
        note: 'transitive collapse forbidden',
      };
      if (directSet.has(edgeKey(fake))) continue;
      const mc = moduleKey(e.callerFile);
      const mt = moduleKey(cf);
      if (mc !== mt) mustNotPools.A.push(fake);
      else mustNotPools.D.push(fake);
    }
  }

  // Fanout: high-degree callees must not be linked from unrelated UI callers
  const inDeg = new Map();
  for (const e of callsClean) {
    const k = `${e.calleeFile}\0${e.calleeName}`;
    inDeg.set(k, (inDeg.get(k) || 0) + 1);
  }
  const hot = [...inDeg.entries()]
    .filter(([k, n]) => n >= 8 && !/\/Log\.(ets|ts)\0/.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([k]) => k);

  const uiCallers = callsClean.filter((e) => uiCaller(e.callerName));
  for (const hotKey of hot) {
    const [hf, hn] = hotKey.split('\0');
    for (const u of uiCallers) {
      const fake = {
        kind: 'calls',
        callerFile: u.callerFile,
        callerName: u.callerName,
        callerStart: u.callerStart,
        calleeFile: hf,
        calleeName: hn,
        note: 'fanout: UI must not flood to hot callee',
      };
      if (directSet.has(edgeKey(fake))) continue;
      if (u.calleeFile === hf && u.calleeName === hn) continue;
      mustNotPools.C.push(fake);
      if (mustNotPools.C.length > 500) break;
    }
    if (mustNotPools.C.length > 500) break;
  }

  // B must-not: exported caller should not gain edge to random other-file hidden name
  for (const e of mustByBucket.B) {
    mustNotPools.B.push({
      kind: 'calls',
      callerFile: e.callerFile,
      callerName: e.callerName,
      calleeFile: e.calleeFile,
      calleeName: 'getInstance',
      note: 'local helper caller must not flood getInstance',
    });
  }

  // E must-not: aboutToAppear should not jump to unrelated hot
  for (const u of uiCallers.slice(0, 200)) {
    for (const hotKey of hot.slice(0, 5)) {
      const [hf, hn] = hotKey.split('\0');
      if (moduleKey(u.callerFile) === moduleKey(hf) && u.calleeName === hn) continue;
      const fake = {
        kind: 'calls',
        callerFile: u.callerFile,
        callerName: u.callerName,
        callerStart: u.callerStart,
        calleeFile: hf,
        calleeName: hn,
        note: 'lifecycle must not flood hot callee',
      };
      if (directSet.has(edgeKey(fake))) continue;
      mustNotPools.E.push(fake);
    }
  }

  // F must-not: wrong extends direction
  for (const h of heritage.filter((x) => x.kind === 'extends').slice(0, 80)) {
    mustNotPools.F.push({
      kind: 'extends',
      callerFile: h.calleeFile,
      callerName: h.calleeName,
      calleeFile: h.callerFile,
      calleeName: h.callerName,
      note: 'extends reverse forbidden',
    });
  }

  for (const b of BUCKETS) {
    mustNotPools[b] = diversify(mustNotPools[b]);
  }

  const seenNo = new Set();
  const mustNotByBucket = {};
  for (const b of BUCKETS) {
    mustNotByBucket[b] = takeUnique(mustNotPools[b], MUST_NOT_TARGET[b], seenNo).map((e) => ({
      bucket: b,
      kind: e.kind || 'calls',
      callerFile: e.callerFile,
      callerName: e.callerName,
      callerStart: e.callerStart,
      calleeFile: e.calleeFile,
      calleeName: e.calleeName,
      calleeStart: e.calleeStart,
      note: e.note,
      status: 'active',
      provenance: 'source-mine+review',
    }));
  }

  const mustTotal = BUCKETS.reduce((s, b) => s + mustByBucket[b].length, 0);
  const mustNotTotal = BUCKETS.reduce((s, b) => s + mustNotByBucket[b].length, 0);
  console.error(`selected must=${mustTotal} must-not=${mustNotTotal}`);
  for (const b of BUCKETS) {
    console.error(
      `  ${b}: must=${mustByBucket[b].length}/${MUST_TARGET[b]} must-not=${mustNotByBucket[b].length}/${MUST_NOT_TARGET[b]}`
    );
  }

  if (!args.write) {
    console.log(JSON.stringify({ mustByBucket, mustNotByBucket }, null, 2));
    return;
  }

  const names = {
    A: 'A-cross-module',
    B: 'B-non-rta-helper',
    C: 'C-fanout',
    D: 'D-same-module',
    E: 'E-lifecycle-ui',
    F: 'F-import-heritage',
  };
  for (const b of BUCKETS) {
    const mustPath = path.join(SOAK, 'gold', 'must', `${names[b]}.json`);
    const notPath = path.join(SOAK, 'gold', 'must-not', `${names[b]}.json`);
    fs.mkdirSync(path.dirname(mustPath), { recursive: true });
    fs.mkdirSync(path.dirname(notPath), { recursive: true });
    fs.writeFileSync(
      mustPath,
      JSON.stringify(
        {
          bucket: b,
          polarity: 'must',
          targetRepo: 'applications_photos',
          edges: mustByBucket[b],
        },
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
  console.error('Wrote gold/must/*.json and gold/must-not/*.json');
}

main();
