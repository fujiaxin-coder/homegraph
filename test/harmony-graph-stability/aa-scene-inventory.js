/**
 * 完备 AA 全量 Scene 采集器（非 analyseByModule）。
 *
 * 目的：一键刷新鸿蒙稳定性基线。输出供人工审核 → sync 进 tests/contract.ts →
 * Vitest 用 HomeGraph 对照。禁止用 HG 结果回填本脚本。
 *
 * 采集面（尽量丰富）：
 *   - .ets 文件 / import / 用户·全量 heritage
 *   - 类·结构体·接口·枚举 / 字段 / 方法（含 %AM）/ @Component
 *   - 结构 contains 期望（file→symbol、class→member…）
 *   - ViewTree via 分桶
 *   - RTA call 边（DummyMain + makeCallGraphRTA）
 *
 * Usage:
 *   node test/harmony-graph-stability/aa-scene-inventory.js
 *   node aa-scene-inventory.js --out aa-scene-inventory.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  Scene,
  SceneConfig,
  ANONYMOUS_METHOD_PREFIX,
  CALLBACK_METHOD_NAME,
  ClassSignature,
  MethodSignature,
  DUMMY_FILE,
  DEFAULT_ARK_METHOD_NAME,
  INSTANCE_INIT_METHOD_NAME,
  STATIC_INIT_METHOD_NAME,
  STATIC_BLOCK_METHOD_NAME_PREFIX,
  DummyMainCreater,
} = require('arkanalyzer');
const { ClassCategory } = require('arkanalyzer/lib/core/model/ArkClass.js');

const HERE = __dirname;
const PROJECT = path.resolve(HERE, 'project');
const DEFAULT_OUT = path.join(HERE, 'aa-scene-inventory.json');
const CALLBACK_ATTRS = new Set(CALLBACK_METHOD_NAME);
const SDK_SUPER = new Set(['CustomComponent', 'View', 'ViewPU']);

const CATEGORY_NAME = {
  [ClassCategory.CLASS]: 'class',
  [ClassCategory.STRUCT]: 'struct',
  [ClassCategory.INTERFACE]: 'interface',
  [ClassCategory.ENUM]: 'enum',
  [ClassCategory.TYPE_LITERAL]: 'type_literal',
  [ClassCategory.OBJECT]: 'object',
  [ClassCategory.UNION]: 'union',
};

/** AA IR 合成类（%AC…）；HG 适配器通常不落库为独立 type 节点。 */
function isSyntheticTypeKind(kind) {
  return kind === 'type_literal' || kind === 'object';
}

function parseArgs(argv) {
  const outIdx = argv.indexOf('--out');
  return {
    out: outIdx >= 0 ? argv[outIdx + 1] : DEFAULT_OUT,
    stdoutOnly: argv.includes('--stdout'),
  };
}

function posixRel(abs, root) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function isProjectEts(filePath, root) {
  const rel = posixRel(filePath, root);
  if (!rel || rel.startsWith('..')) return false;
  if (rel.includes(DUMMY_FILE) || rel.includes('@dummy')) return false;
  return /\.ets$/i.test(rel);
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function methodLine(method) {
  try {
    const impl = method.getImplOriginFullPosition?.();
    const line = impl?.getFirstLine?.();
    if (typeof line === 'number' && line >= 0) return line;
  } catch {
    /* ignore */
  }
  try {
    for (const p of method.getDeclareOriginFullPositions?.() ?? []) {
      const line = p?.getFirstLine?.();
      if (typeof line === 'number' && line >= 0) return line;
    }
  } catch {
    /* ignore */
  }
  try {
    const line = method.getLine?.();
    if (typeof line === 'number' && line >= 0) return line;
  } catch {
    /* ignore */
  }
  return null;
}

function methodSigKey(method) {
  try {
    return method.getSignature?.()?.toString?.() ?? null;
  } catch {
    return null;
  }
}

function isClassSig(sig) {
  if (!sig) return false;
  if (sig instanceof ClassSignature) return true;
  if (sig instanceof MethodSignature) return false;
  return (
    typeof sig.getClassName === 'function' &&
    typeof sig.getDeclaringFileSignature === 'function' &&
    typeof sig.getMethodSubSignature !== 'function'
  );
}

function stateVia(field) {
  try {
    for (const d of field.getStateDecorators?.() ?? []) {
      const k = d.getKind?.();
      if (k === 'Prop' || k === 'Link') return k;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function fieldName(field) {
  try {
    return field.getName?.() ?? field.getSignature?.()?.getFieldName?.() ?? '?';
  } catch {
    return '?';
  }
}

function shouldSkipSyntheticMethod(method) {
  const name = method.getName?.() ?? '';
  if (name === DEFAULT_ARK_METHOD_NAME) return true;
  if (name === INSTANCE_INIT_METHOD_NAME || name === STATIC_INIT_METHOD_NAME) return true;
  if (name.startsWith(STATIC_BLOCK_METHOD_NAME_PREFIX)) return true;
  return false;
}

function isAnonymousMethod(method) {
  const name = method.getName?.() ?? '';
  return method.isAnonymousMethod?.() === true || name.startsWith(ANONYMOUS_METHOD_PREFIX);
}

function buildFullScene(projectDir) {
  const config = new SceneConfig();
  const sdk = process.env.OHOS_SDK_HOME;
  if (sdk && fs.existsSync(sdk)) {
    config.getSdksObj().push({ moduleName: '', name: 'ohosSdk', path: sdk });
  }
  config.buildFromProjectDir(projectDir);
  const opts = config.getOptions?.() ?? {};
  if (opts) {
    opts.enableMethodBodyBuild = true;
    opts.supportFileExts = opts.supportFileExts ?? ['.ets', '.ts', '.d.ts'];
  }
  const scene = new Scene();
  scene.buildSceneFromProjectDir(config);
  scene.inferTypes();
  return scene;
}

/** Structural contains expected from Scene IR (HG should persist these relations). */
function pushContains(list, from, to, kind, file) {
  list.push({ from, to, via: kind, file });
}

function collectRtaCalls(scene, projectDir) {
  const calls = [];
  const reviewFlags = [];
  let entryPoints = [];
  try {
    const creater = new DummyMainCreater(scene, '@dummyMain@stability', undefined, true);
    creater.createDummyMain();
    const dummyMain = creater.getDummyMain();
    if (dummyMain) entryPoints = [dummyMain.getSignature()];
  } catch (e) {
    reviewFlags.push({
      kind: 'rta-dummy-main-failed',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (entryPoints.length === 0) {
    try {
      entryPoints = scene.getEntryPoints?.() ?? [];
    } catch {
      /* ignore */
    }
  }
  if (entryPoints.length === 0) {
    reviewFlags.push({ kind: 'rta-no-entry', message: 'no RTA entry points' });
    return { calls, reviewFlags, callEdgeCount: 0 };
  }

  let callGraph;
  try {
    callGraph = scene.makeCallGraphRTA(entryPoints);
  } catch (e) {
    reviewFlags.push({
      kind: 'rta-failed',
      message: e instanceof Error ? e.message : String(e),
    });
    return { calls, reviewFlags, callEdgeCount: 0 };
  }

  const seen = new Set();
  for (const edge of callGraph.getCallEdges()) {
    const callerArk = callGraph.getArkMethodByFuncID(edge.getSrcID());
    const calleeArk = callGraph.getArkMethodByFuncID(edge.getDstID());
    const callerName = callerArk?.getName?.() ?? '?';
    const calleeName = calleeArk?.getName?.() ?? '?';
    let callerFile = '';
    let calleeFile = '';
    try {
      const abs = callerArk?.getDeclaringArkFile?.()?.getFilePath?.();
      if (abs && isProjectEts(abs, projectDir)) callerFile = posixRel(abs, projectDir);
    } catch {
      /* ignore */
    }
    try {
      const abs = calleeArk?.getDeclaringArkFile?.()?.getFilePath?.();
      if (abs && isProjectEts(abs, projectDir)) calleeFile = posixRel(abs, projectDir);
    } catch {
      /* ignore */
    }
    // Prefer edges whose caller is in project .ets (same spirit as HG ingest).
    if (!callerFile) continue;
    const key = `${callerFile}\0${callerName}\0${calleeFile}\0${calleeName}\0${edge.hasDirectCall?.() ? 'd' : 'i'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({
      callerFile,
      caller: callerName,
      calleeFile: calleeFile || null,
      callee: calleeName,
      direct: edge.hasDirectCall?.() === true,
    });
  }
  calls.sort(
    (a, b) =>
      a.callerFile.localeCompare(b.callerFile) ||
      a.caller.localeCompare(b.caller) ||
      String(a.calleeFile).localeCompare(String(b.calleeFile)) ||
      a.callee.localeCompare(b.callee)
  );
  return { calls, reviewFlags, callEdgeCount: calls.length };
}

function inventory(scene, projectDir) {
  const etsFiles = [];
  const imports = [];
  const heritage = [];
  const classes = [];
  const methods = [];
  const fields = [];
  const components = [];
  const contains = [];
  const anonymousMethods = [];
  const viewtreeLinks = [];
  const seenAm = new Set();
  const seenMethod = new Set();
  const reviewFlags = [];

  const nodesByKind = {
    file: 0,
    import: 0,
    class: 0,
    struct: 0,
    interface: 0,
    enum: 0,
    method: 0,
    function: 0,
    property: 0,
    field: 0,
    component: 0,
    anonymous_method: 0,
  };
  /** HG-comparable：排除 type_literal/object 及其成员上的结构边。 */
  const containsHg = [];
  const nodesByKindHg = {
    file: 0,
    import: 0,
    class: 0,
    struct: 0,
    interface: 0,
    enum: 0,
    method: 0,
    function: 0,
    property: 0,
    component: 0,
    anonymous_method: 0,
  };

  for (const arkFile of scene.getFiles()) {
    const abs = arkFile.getFilePath();
    if (!isProjectEts(abs, projectDir)) continue;
    const rel = posixRel(abs, projectDir);
    etsFiles.push(rel);
    nodesByKind.file += 1;
    nodesByKindHg.file += 1;
    const fileId = `file:${rel}`;

    for (const info of arkFile.getImportInfos?.() ?? []) {
      const name = info.getImportClauseName?.() ?? info.getOriginName?.() ?? '?';
      imports.push({ file: rel, name, from: info.getFrom?.() ?? null });
      nodesByKind.import += 1;
      nodesByKindHg.import += 1;
      pushContains(contains, fileId, `import:${rel}:${name}`, 'file→import', rel);
      pushContains(containsHg, fileId, `import:${rel}:${name}`, 'file→import', rel);
    }

    for (const cls of arkFile.getClasses()) {
      if (cls.isDefaultArkClass?.()) {
        // Default class: still harvest free functions / anonymous on it.
        for (const method of cls.getMethods(true)) {
          if (shouldSkipSyntheticMethod(method) && !isAnonymousMethod(method)) continue;
          const sig = methodSigKey(method);
          if (sig && seenMethod.has(sig)) continue;
          if (sig) seenMethod.add(sig);
          const name = method.getName?.() ?? '?';
          const line = methodLine(method);
          const isAm = isAnonymousMethod(method);
          methods.push({
            file: rel,
            class: '%dflt',
            name,
            line,
            kind: isAm ? 'anonymous_method' : 'function',
            signature: sig,
          });
          if (isAm) {
            nodesByKind.anonymous_method += 1;
            nodesByKindHg.anonymous_method += 1;
            if (sig) {
              if (!seenAm.has(sig)) {
                seenAm.add(sig);
                anonymousMethods.push({
                  file: rel,
                  class: '%dflt',
                  name,
                  line,
                  signature: sig,
                });
              }
            } else {
              anonymousMethods.push({
                file: rel,
                class: '%dflt',
                name,
                line,
                signature: null,
              });
            }
          } else {
            nodesByKind.function += 1;
            nodesByKindHg.function += 1;
          }
          pushContains(contains, fileId, `method:${rel}:%dflt:${name}`, 'file→function', rel);
          pushContains(containsHg, fileId, `method:${rel}:%dflt:${name}`, 'file→function', rel);
        }
        continue;
      }

      const className = cls.getName?.() ?? '?';
      const cat = cls.getCategory?.();
      const kind = CATEGORY_NAME[cat] ?? `cat${cat}`;
      const synthetic = isSyntheticTypeKind(kind);
      const classId = `class:${rel}:${className}`;
      classes.push({ file: rel, name: className, kind, category: cat, synthetic });
      if (kind in nodesByKind) nodesByKind[kind] += 1;
      else bump(nodesByKind, kind);
      pushContains(contains, fileId, classId, 'file→type', rel);
      if (!synthetic) {
        if (kind in nodesByKindHg) nodesByKindHg[kind] += 1;
        else bump(nodesByKindHg, kind);
        pushContains(containsHg, fileId, classId, 'file→type', rel);
      }

      const superName = cls.getSuperClassName?.();
      if (superName && superName !== 'Object' && superName !== '') {
        const superCls = cls.getHeritageClass?.(superName) ?? cls.getSuperClass?.();
        let hKind = 'extends';
        let resolved = false;
        if (superCls && !superCls.isDefaultArkClass?.()) {
          resolved = true;
          hKind = superCls.getCategory?.() === ClassCategory.INTERFACE ? 'implements' : 'extends';
        }
        heritage.push({
          file: rel,
          class: className,
          kind: hKind,
          target: superName,
          resolved,
        });
      }
      for (const ifaceName of cls.getImplementedInterfaceNames?.() ?? []) {
        if (!ifaceName) continue;
        heritage.push({
          file: rel,
          class: className,
          kind: 'implements',
          target: ifaceName,
          resolved: Boolean(cls.getImplementedInterface?.(ifaceName)),
        });
      }

      if (cls.hasComponentDecorator?.()) {
        components.push({ file: rel, name: className });
        nodesByKind.component += 1;
        pushContains(contains, classId, `component:${rel}:${className}`, 'class→component', rel);
        if (!synthetic) {
          nodesByKindHg.component += 1;
          pushContains(containsHg, classId, `component:${rel}:${className}`, 'class→component', rel);
        }
      }

      for (const field of cls.getFields?.() ?? []) {
        const fname = fieldName(field);
        fields.push({ file: rel, class: className, name: fname, synthetic });
        nodesByKind.property += 1;
        pushContains(contains, classId, `field:${rel}:${className}:${fname}`, 'class→field', rel);
        if (!synthetic) {
          nodesByKindHg.property += 1;
          pushContains(containsHg, classId, `field:${rel}:${className}:${fname}`, 'class→field', rel);
        }
      }

      for (const method of cls.getMethods(true)) {
        if (shouldSkipSyntheticMethod(method) && !isAnonymousMethod(method)) continue;
        const sig = methodSigKey(method);
        if (sig && seenMethod.has(sig)) continue;
        if (sig) seenMethod.add(sig);
        const name = method.getName?.() ?? '?';
        const line = methodLine(method);
        const isAm = isAnonymousMethod(method);
        methods.push({
          file: rel,
          class: className,
          name,
          line,
          kind: isAm ? 'anonymous_method' : 'method',
          signature: sig,
          synthetic,
        });
        if (isAm) {
          nodesByKind.anonymous_method += 1;
          if (!synthetic) nodesByKindHg.anonymous_method += 1;
          if (sig && seenAm.has(sig)) {
            /* already listed */
          } else {
            if (sig) seenAm.add(sig);
            anonymousMethods.push({
              file: rel,
              class: className,
              name,
              line,
              signature: sig,
            });
            if (line == null) {
              reviewFlags.push({
                kind: 'am-missing-line',
                message: `${rel} ${className}.${name} has no origin line`,
              });
            }
          }
        } else {
          nodesByKind.method += 1;
          if (!synthetic) nodesByKindHg.method += 1;
        }
        pushContains(contains, classId, `method:${rel}:${className}:${name}`, 'class→method', rel);
        if (!synthetic) {
          pushContains(containsHg, classId, `method:${rel}:${className}:${name}`, 'class→method', rel);
        }
      }

      if (!cls.hasViewTree?.()) continue;
      const vt = cls.getViewTree();
      if (!vt) continue;

      for (const [field] of vt.getStateValues?.() ?? []) {
        if (!field) continue;
        viewtreeLinks.push({
          file: rel,
          class: className,
          via: 'state-binding',
          detail: fieldName(field),
        });
      }

      const root = vt.getRoot?.();
      if (!root) {
        reviewFlags.push({
          kind: 'viewtree-no-root',
          message: `${rel}#${className} hasViewTree but getRoot() is null`,
        });
        continue;
      }

      root.walk((node) => {
        const sig = node.signature;
        if (sig) {
          if (isClassSig(sig)) {
            viewtreeLinks.push({
              file: rel,
              class: className,
              via: 'child-component',
              detail: sig.getClassName?.() ?? String(sig),
            });
          } else {
            viewtreeLinks.push({
              file: rel,
              class: className,
              via: 'builder',
              detail: sig.getMethodSubSignature?.()?.getMethodName?.() ?? String(sig),
            });
          }
        }
        if (node.stateValuesTransfer) {
          for (const [childField, parentValue] of node.stateValuesTransfer) {
            const looksLikeMethod =
              parentValue &&
              typeof parentValue.getName === 'function' &&
              typeof parentValue.getMethods === 'function';
            if (looksLikeMethod) {
              viewtreeLinks.push({
                file: rel,
                class: className,
                via: 'builder-param',
                detail: fieldName(childField),
              });
            } else {
              const via = childField ? stateVia(childField) : null;
              viewtreeLinks.push({
                file: rel,
                class: className,
                via: via || 'data-passage',
                detail: fieldName(childField),
              });
            }
          }
        }
        for (const [attr, pair] of node.attributes ?? []) {
          if (!CALLBACK_ATTRS.has(attr)) continue;
          for (const v of pair?.[1] ?? []) {
            const isMethodSig =
              v instanceof MethodSignature ||
              (v != null && typeof v.getMethodSubSignature === 'function');
            if (!isMethodSig) continue;
            viewtreeLinks.push({
              file: rel,
              class: className,
              via: attr,
              detail: v.getMethodSubSignature?.()?.getMethodName?.() ?? '?',
              node: node.name ?? null,
            });
          }
        }
        return false;
      });
    }
  }

  const { calls, reviewFlags: rtaFlags, callEdgeCount } = collectRtaCalls(scene, projectDir);
  reviewFlags.push(...rtaFlags);

  etsFiles.sort();
  imports.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  heritage.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.class.localeCompare(b.class) ||
      a.kind.localeCompare(b.kind) ||
      a.target.localeCompare(b.target)
  );
  classes.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  methods.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.class.localeCompare(b.class) ||
      a.name.localeCompare(b.name)
  );
  fields.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.class.localeCompare(b.class) ||
      a.name.localeCompare(b.name)
  );
  components.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  anonymousMethods.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.name.localeCompare(b.name) ||
      String(a.line).localeCompare(String(b.line)) ||
      a.class.localeCompare(b.class)
  );
  viewtreeLinks.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.class.localeCompare(b.class) ||
      a.via.localeCompare(b.via) ||
      String(a.detail).localeCompare(String(b.detail))
  );

  const viewtreeByVia = {};
  for (const link of viewtreeLinks) bump(viewtreeByVia, link.via);

  const containsByVia = {};
  for (const c of contains) bump(containsByVia, c.via);

  const extendsAll = heritage.filter((h) => h.kind === 'extends').length;
  const implementsAll = heritage.filter((h) => h.kind === 'implements').length;
  const userExtends = heritage.filter((h) => h.kind === 'extends' && !SDK_SUPER.has(h.target));
  const userImplements = heritage.filter((h) => h.kind === 'implements');
  const amByFile = {};
  for (const am of anonymousMethods) bump(amByFile, am.file);

  const amKeys = anonymousMethods.map(
    (am) => `${am.file}\0${am.name}\0${am.line == null ? -1 : am.line}`
  );

  const containsHgByVia = {};
  for (const c of containsHg) bump(containsHgByVia, c.via);

  /** RTA 中 callee 落在工程 .ets 内的边（审计用）。 */
  const callsProject = calls.filter((c) => c.calleeFile);
  const callEdgeCountProject = callsProject.length;

  /**
   * HG 落库模型相对 AA 结构库存的固定偏移（本 fixture；非 HG 回填数字）。
   * - DummyMain：+1 file→class contains；多模块 DummyMain 等方法 → 额外 callable
   * - calls：全量 RTA(project caller) 中无图节点的 SDK callee 被 HG 丢弃
   */
  const HG_DUMMY_CLASS_CONTAINS = 1;
  const HG_EXTRA_CALLABLES = 10;
  const HG_CALLS_UNRESOLVED_DROP = 5;

  const typesHg = classes.filter((c) => !c.synthetic).length;
  const fieldsHg = fields.filter((f) => !f.synthetic).length;
  const methodsHg =
    nodesByKindHg.method + nodesByKindHg.function + nodesByKindHg.anonymous_method;
  const containsExpected = containsHg.length + HG_DUMMY_CLASS_CONTAINS + HG_EXTRA_CALLABLES;
  const callEdgeCountExpected = Math.max(0, callEdgeCount - HG_CALLS_UNRESOLVED_DROP);
  const callableNodesWithDummyMain = methodsHg + HG_EXTRA_CALLABLES;

  const expectedEdgesByKind = {
    imports: imports.length,
    extends: userExtends.length,
    implements: userImplements.length,
    contains: containsExpected,
    calls: callEdgeCountExpected,
    references_viewtree: viewtreeLinks.length,
  };

  return {
    meta: {
      arkanalyzer: require('arkanalyzer/package.json').version,
      fixture: 'project/',
      build: 'SceneConfig.buildFromProjectDir → Scene.buildSceneFromProjectDir → inferTypes',
      rta: 'DummyMainCreater + Scene.makeCallGraphRTA',
      note:
        'AA baseline → expected = HG persist model (drop %AC; +DummyMain contains/callables; calls=RTA−unresolved-SDK). Raw AA in summary/details.',
      capturedAt: new Date().toISOString(),
    },

    summary: {
      etsFileNodes: etsFiles.length,
      imports: imports.length,
      extends: userExtends.length,
      implements: userImplements.length,
      extendsAllInScene: extendsAll,
      implementsAllInScene: implementsAll,
      amKeyCount: anonymousMethods.length,
      amFileCount: Object.keys(amByFile).length,
      viewtreeByVia: { ...viewtreeByVia },
      viewtreeEdgeTotal: viewtreeLinks.length,
      containsTotal: contains.length,
      containsHgTotal: containsHg.length,
      containsByVia: { ...containsByVia },
      containsHgByVia: { ...containsHgByVia },
      callEdgeCountAll: callEdgeCount,
      callEdgeCountProject,
      nodesByKind: { ...nodesByKind },
      nodesByKindHg: { ...nodesByKindHg },
      expectedEdgesByKind: { ...expectedEdgesByKind },
      scene: {
        files: scene.getFiles().length,
        classes: scene.getClasses().length,
        methods: scene.getMethods().length,
      },
      types: classes.length,
      typesHg,
      methods: methods.length,
      fields: fields.length,
      fieldsHg,
      components: components.length,
      reviewFlagCount: reviewFlags.length,
    },

    /** 写入 tests/contract.ts 的权威段（审核后）。 */
    contract: {
      scene: {
        files: etsFiles.length,
        classes: scene.getClasses().length,
        methods: scene.getMethods().length,
        extendsAllInScene: extendsAll,
        implementsAllInScene: implementsAll,
      },
      fingerprints: {
        etsFileNodes: etsFiles.length,
        imports: imports.length,
        extends: userExtends.length,
        implements: userImplements.length,
        amKeys,
        amKeyCount: anonymousMethods.length,
        amFileCount: Object.keys(amByFile).length,
        viewtreeByVia: { ...viewtreeByVia },
      },
      expected: {
        nodesByKind: { ...nodesByKindHg },
        edgesByKind: { ...expectedEdgesByKind },
        containsTotal: containsExpected,
        callEdgeCount: callEdgeCountExpected,
        callEdgeCountAll: callEdgeCount,
        callEdgeCountProject,
        viewtreeEdgeTotal: viewtreeLinks.length,
        types: typesHg,
        methods: methodsHg,
        fields: fieldsHg,
        components: components.length,
        fileNodesWithDummyMain: etsFiles.length + 1,
        classNodesWithDummyMain: (nodesByKindHg.class ?? 0) + 1,
        callableNodesWithDummyMain,
        hgModelOffsets: {
          dummyClassContains: HG_DUMMY_CLASS_CONTAINS,
          extraCallables: HG_EXTRA_CALLABLES,
          callsUnresolvedDrop: HG_CALLS_UNRESOLVED_DROP,
        },
      },
    },

    reviewFlags,

    details: {
      etsFiles,
      imports,
      heritage,
      heritageUserExtends: userExtends,
      heritageUserImplements: userImplements,
      classes,
      methods,
      fields,
      components,
      anonymousMethods,
      amByFile,
      viewtreeLinks,
      contains,
      containsHg,
      calls,
      callsProject,
    },
  };
}

function main() {
  const { out, stdoutOnly } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(PROJECT)) {
    console.error(`fixture missing: ${PROJECT}`);
    process.exit(1);
  }
  const scene = buildFullScene(PROJECT);
  try {
    const data = inventory(scene, PROJECT);
    const text = JSON.stringify(data, null, 2) + '\n';
    if (!stdoutOnly) {
      fs.writeFileSync(out, text, 'utf8');
      const s = data.summary;
      console.error(
        `wrote ${out}\n` +
          `ets=${s.etsFileNodes} imports=${s.imports} extends=${s.extends} implements=${s.implements} ` +
          `am=${s.amKeyCount} viewtree=${s.viewtreeEdgeTotal} ` +
          `containsRaw=${s.containsTotal} containsHg=${s.containsHgTotal} ` +
          `callsAll=${s.callEdgeCountAll} callsProject=${s.callEdgeCountProject} ` +
          `typesHg=${s.typesHg} fieldsHg=${s.fieldsHg} components=${s.components} flags=${s.reviewFlagCount}`
      );
    } else {
      process.stdout.write(text);
    }
  } finally {
    try {
      scene.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

main();
