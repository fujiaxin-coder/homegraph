/**
 * Dump AA Scene inventory for `project/` (full Scene build — NOT analyseByModule).
 *
 * Pattern mirrors arkanalyzer unit tests (ViewTree.test.ts / Anonymous.test.ts):
 *   SceneConfig → buildFromProjectDir → Scene.buildSceneFromProjectDir → inferTypes
 *
 * Usage:
 *   node test/harmony-graph-stability/aa-scene-inventory.js
 *   node aa-scene-inventory.js --out path.json   # default: ./aa-scene-inventory.json
 *
 * Output is structured for human review (summary + detail lists). Re-run after
 * fixture or arkanalyzer upgrades; then copy reviewed numbers into tests/contract.ts.
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
} = require('arkanalyzer');

const HERE = __dirname;
const PROJECT = path.resolve(HERE, 'project');
const DEFAULT_OUT = path.join(HERE, 'aa-scene-inventory.json');
const CALLBACK_ATTRS = new Set(CALLBACK_METHOD_NAME);
/** ClassCategory.INTERFACE in arkanalyzer. */
const CLASS_CATEGORY_INTERFACE = 2;

function parseArgs(argv) {
  const outIdx = argv.indexOf('--out');
  const stdoutOnly = argv.includes('--stdout');
  return {
    out: outIdx >= 0 ? argv[outIdx + 1] : DEFAULT_OUT,
    stdoutOnly,
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

function methodLine(method) {
  try {
    const impl = method.getImplOriginFullPosition?.();
    if (impl) {
      const line = impl.getFirstLine?.();
      if (typeof line === 'number' && line >= 0) return line;
    }
  } catch {
    /* ignore */
  }
  try {
    const declares = method.getDeclareOriginFullPositions?.() ?? [];
    for (const p of declares) {
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

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
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

function inventory(scene, projectDir) {
  const etsFiles = [];
  const imports = [];
  const heritage = [];
  const anonymousMethods = [];
  const viewtreeLinks = [];
  const seenAm = new Set();
  const reviewFlags = [];

  for (const arkFile of scene.getFiles()) {
    const abs = arkFile.getFilePath();
    if (!isProjectEts(abs, projectDir)) continue;
    const rel = posixRel(abs, projectDir);
    etsFiles.push(rel);

    for (const info of arkFile.getImportInfos?.() ?? []) {
      imports.push({
        file: rel,
        name: info.getImportClauseName?.() ?? info.getOriginName?.() ?? '?',
        from: info.getFrom?.() ?? null,
      });
    }

    for (const cls of arkFile.getClasses()) {
      const className = cls.getName?.() ?? '?';

      const superName = cls.getSuperClassName?.();
      if (superName && superName !== 'Object' && superName !== '') {
        const superCls = cls.getHeritageClass?.(superName) ?? cls.getSuperClass?.();
        let kind = 'extends';
        let resolved = false;
        if (superCls && !superCls.isDefaultArkClass?.()) {
          resolved = true;
          kind = superCls.getCategory?.() === CLASS_CATEGORY_INTERFACE ? 'implements' : 'extends';
        }
        heritage.push({
          file: rel,
          class: className,
          kind,
          target: superName,
          resolved,
        });
      }
      for (const ifaceName of cls.getImplementedInterfaceNames?.() ?? []) {
        if (!ifaceName) continue;
        const iface = cls.getImplementedInterface?.(ifaceName);
        heritage.push({
          file: rel,
          class: className,
          kind: 'implements',
          target: ifaceName,
          resolved: Boolean(iface),
        });
      }

      for (const method of cls.getMethods(true)) {
        const name = method.getName?.() ?? '';
        if (!name.startsWith(ANONYMOUS_METHOD_PREFIX)) continue;
        const sig = methodSigKey(method);
        if (sig) {
          if (seenAm.has(sig)) continue;
          seenAm.add(sig);
        }
        const declAbs = method.getDeclaringArkFile?.()?.getFilePath?.() ?? abs;
        const declRel = isProjectEts(declAbs, projectDir)
          ? posixRel(declAbs, projectDir)
          : rel;
        const line = methodLine(method);
        const entry = {
          file: declRel,
          class: className,
          name,
          line,
          signature: sig,
        };
        anonymousMethods.push(entry);
        if (line == null) {
          reviewFlags.push({
            kind: 'am-missing-line',
            message: `${declRel} ${className}.${name} has no origin line`,
          });
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
          const values = pair?.[1] ?? [];
          for (const v of values) {
            const isMethodSig =
              v instanceof MethodSignature ||
              (v != null && typeof v.getMethodSubSignature === 'function');
            if (!isMethodSig) continue;
            const mname = v.getMethodSubSignature?.()?.getMethodName?.() ?? '?';
            viewtreeLinks.push({
              file: rel,
              class: className,
              via: attr,
              detail: mname,
              node: node.name ?? null,
            });
          }
        }
        return false;
      });
    }
  }

  etsFiles.sort();
  imports.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  heritage.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.class.localeCompare(b.class) ||
      a.kind.localeCompare(b.kind) ||
      a.target.localeCompare(b.target)
  );
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

  const extendsN = heritage.filter((h) => h.kind === 'extends').length;
  const implementsN = heritage.filter((h) => h.kind === 'implements').length;
  const amByFile = {};
  for (const am of anonymousMethods) bump(amByFile, am.file);

  // Contract-shaped amKeys (file\0name\0line) — line null → -1 for stable sort key.
  const amKeys = anonymousMethods.map(
    (am) => `${am.file}\0${am.name}\0${am.line == null ? -1 : am.line}`
  );

  // HG contract heritage: user IR only (Worker→Base / Base→IFace).
  // AA also reports Page/Child → CustomComponent (SDK); those are listed in details.heritage.
  const sdkSuper = new Set(['CustomComponent', 'View', 'ViewPU']);
  const userExtends = heritage.filter((h) => h.kind === 'extends' && !sdkSuper.has(h.target));
  const userImplements = heritage.filter((h) => h.kind === 'implements');

  return {
    meta: {
      arkanalyzer: require('arkanalyzer/package.json').version,
      fixture: 'project/',
      build: 'SceneConfig.buildFromProjectDir → Scene.buildSceneFromProjectDir → inferTypes',
      note: 'AA full Scene inventory (unit-test style). Not analyseByModule. Feed summary/contract into tests/contract.ts.',
      capturedAt: new Date().toISOString(),
    },

    /** Numbers for tests/contract.ts fingerprints (HG-persistable AA truth). */
    summary: {
      etsFileNodes: etsFiles.length,
      imports: imports.length,
      /** User extends only (excludes SDK CustomComponent). */
      extends: userExtends.length,
      implements: userImplements.length,
      /** Raw AA heritage counts (includes SDK supers). */
      extendsAllInScene: extendsN,
      implementsAllInScene: implementsN,
      amKeyCount: anonymousMethods.length,
      amFileCount: Object.keys(amByFile).length,
      viewtreeByVia: { ...viewtreeByVia },
      viewtreeEdgeTotal: viewtreeLinks.length,
      scene: {
        files: scene.getFiles().length,
        classes: scene.getClasses().length,
        methods: scene.getMethods().length,
      },
      reviewFlagCount: reviewFlags.length,
    },

    /** Drop into CONTRACT.fingerprints (amKeys use \\0 separators). */
    contract: {
      etsFileNodes: etsFiles.length,
      imports: imports.length,
      extends: userExtends.length,
      implements: userImplements.length,
      amKeys,
      amKeyCount: anonymousMethods.length,
      amFileCount: Object.keys(amByFile).length,
      viewtreeByVia: { ...viewtreeByVia },
    },

    reviewFlags,

    details: {
      etsFiles,
      imports,
      heritage,
      heritageUserExtends: userExtends,
      heritageUserImplements: userImplements,
      anonymousMethods,
      amByFile,
      viewtreeLinks,
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
      console.error(
        `wrote ${out}\n` +
          `summary: ets=${data.summary.etsFileNodes} imports=${data.summary.imports} ` +
          `extends=${data.summary.extends} implements=${data.summary.implements} ` +
          `am=${data.summary.amKeyCount} viewtree=${data.summary.viewtreeEdgeTotal} ` +
          `flags=${data.summary.reviewFlagCount}`
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
