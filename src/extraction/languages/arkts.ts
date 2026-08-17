/**
 * ArkTS (.ets) extraction via ArkAnalyzer.
 *
 * Unlike tree-sitter languages, ArkTS is batch-complete: the first `.ets`
 * parse builds a Scene, runs RTA, persists every `.ets` file (nodes, edges,
 * cross-file RTA calls) directly to the DB, then returns the requested file's
 * result. Later `.ets` hits in the same batch short-circuit (orchestrator store
 * skips via matching content hash).
 *
 * HarmonyOS multi-module projects (`build-profile.json5`) use
 * `Scene.analyseByModule` so each HAP/HSP/HAR is the atomic unit (like a file
 * for tree-sitter languages): symbols + ViewTree + **intra-module RTA** while
 * the module has BODIES. Per-module RTA entries = DummyMain (Ability/Component
 * lifecycle) **plus the module export surface** (exported functions and methods
 * of exported classes), so non-UI libraries still grow reachable call edges.
 * CFG does **not** stitch same-module calls (that densified past unlimited RTA).
 * Cross-module edges come from RTA with an exact MethodSignature map, plus a
 * CFG `%unk` bridge that recovers Class.method / free functions from stmt text,
 * UnclearReferenceType names, or PascalCase base locals (import + unique target
 * + fan-out blocklist). Deps load to SIGNATURES.
 *
 * Sync can re-index a **dirty module subset** (`primeArkTSBatch` + `changedFiles`)
 * via `ModuleAnalysisConfig.setTargetModuleIds`, instead of rebuilding every
 * PROJECT module. Unchanged modules stay in the DB; incoming cross-file edges
 * into dirty files are snapshotted and re-bound like file-level sync (#899).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  Scene,
  buildSceneConfigFromProject,
  ArkClass,
  ArkField,
  ArkFile,
  ArkMethod,
  ArkModule,
  ArkNamespace,
  ModuleAnalysisConfig,
  ModuleBuilder,
  ModuleDepthLevel,
  ModuleLoadState,
  ModuleType,
  ANONYMOUS_METHOD_PREFIX,
  DEFAULT_ARK_METHOD_NAME,
  INSTANCE_INIT_METHOD_NAME,
  NAME_DELIMITER,
  NAME_PREFIX,
  STATIC_BLOCK_METHOD_NAME_PREFIX,
  STATIC_INIT_METHOD_NAME,
  DummyMainCreater,
  CALLBACK_METHOD_NAME,
  ClassSignature,
  MethodSignature,
} from 'arkanalyzer';
import type { AliasType, Local, Stmt, ViewTreeNode } from 'arkanalyzer';
import {
  Edge,
  ExtractionError,
  ExtractionResult,
  FileRecord,
  Language,
  Node,
  NodeKind,
} from '../../types';
import type { QueryBuilder } from '../../db/queries';
import { DatabaseConnection } from '../../db';
import { QueryBuilder as QueryBuilderClass } from '../../db/queries';
import { isHomeGraphDataDir } from '../../directory';
import { loadExcludePatterns } from '../../project-config';
import { bindExtractionContext, getExtractionProjectRoot, getExtractionQueries, reportArkTSBatchProgress, resetExtractionContext, setArktsBatchRunning } from '../context';
import type { IndexProgress, IndexResult } from '../index';
import { buildDefaultIgnore } from '../default-ignore';
import { detectGeneratedFile } from '../generated-detection';
import { EXTRACTION_VERSION } from '../extraction-version';
import { HomeGraphPackageVersion } from '../../mcp/version';
import { runWithoutLivenessWatchdog } from '../../mcp/liveness-watchdog';
import {
  OBSERVATION_DECORATORS,
  encodeDecoratorEntries,
  lineOfOffset,
  parseDecoratorArgFromContent,
  scanStorageApiKeys,
} from '../../arkui/migrate-semantics';
import { collectPassagesForViewTreeNode } from '../../arkui/migrate-passage';
import { generateNodeId } from '../tree-sitter-helpers';
import { buildRelaunchArgv, maxOldSpaceSizeFlag, resolveMaxOldSpaceSizeMb } from '../wasm-runtime-flags';
import ignore, { type Ignore } from 'ignore';

/** Primitive / void return types — not stored in nodes.return_type (inference-only column). */
const ARKTS_NON_CLASS_RETURN = new Set([
  'void',
  'number',
  'string',
  'boolean',
  'bigint',
  'undefined',
  'null',
  'never',
  'any',
  'unknown',
  'Object',
]);

/** Strip arkanalyzer file-location prefixes from type text (`@proj/file.ets: Foo` → `Foo`). */
export function cleanArkTypeString(raw: string): string {
  return raw.replace(/@[^/\s]+\/[^\s:]*:\s*/g, '').trim();
}

/**
 * Normalize an ArkTS method return type to a bare class name for receiver inference
 * (aligned with C++/Java `return_type` usage elsewhere in HomeGraph).
 */
export function normalizeArktsReturnType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let t = cleanArkTypeString(raw);
  if (!t || ARKTS_NON_CLASS_RETURN.has(t)) return undefined;
  // Unwrap common wrappers to the pointee (`Promise<Foo>` → `Foo`).
  const wrapper = t.match(/\b(?:Promise|Array|ReadonlyArray|Set|Map)\s*<\s*([^,>]+?)\s*>/);
  if (wrapper?.[1]) t = wrapper[1].trim();
  t = t.replace(/<[^>]*>/g, ' ').replace(/\[\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || ARKTS_NON_CLASS_RETURN.has(t)) return undefined;
  const last = t.split('.').filter(Boolean).pop() ?? t;
  return last || undefined;
}

function formatArkMethodSignatureLine(
  method: ArkMethod,
  sig: MethodSignature,
  useParamNames: boolean
): string {
  const sub = sig.getMethodSubSignature();
  const name = sub.getMethodName();
  const ret = cleanArkTypeString(sub.getReturnType()?.toString() ?? 'void');
  const paramTypes = sub.getParameterTypes();

  let params: string;
  if (useParamNames) {
    const named = method.getParameters();
    if (named.length > 0 && named.length === paramTypes.length) {
      params = named
        .map((p, i) => {
          const rest = p.isRest?.() ? '...' : '';
          const optional = p.isOptional?.() ? '?' : '';
          const typeStr = cleanArkTypeString(
            p.getType()?.toString() ?? paramTypes[i]?.toString() ?? 'unknown'
          );
          return `${rest}${p.getName()}${optional}: ${typeStr}`;
        })
        .join(', ');
    } else {
      params = paramTypes
        .map((t) => cleanArkTypeString(t?.toString() ?? 'unknown'))
        .join(', ');
    }
  } else {
    params = paramTypes
      .map((t) => cleanArkTypeString(t?.toString() ?? 'unknown'))
      .join(', ');
  }

  const prefix = sub.isStatic() ? 'static ' : '';
  return `${prefix}${name}(${params}): ${ret}`;
}

/** Collect human-readable signature lines (canonical first, overloads on following lines). */
export function buildArkMethodSignatureFields(
  method: ArkMethod
): { signature?: string; returnType?: string } {
  const impl = method.getImplementationSignature();
  const declares = method.getDeclareSignatures();
  const primary = impl ?? method.getSignature();
  if (!primary && (!declares || declares.length === 0)) return {};

  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    lines.push(trimmed);
  };

  if (impl) {
    push(formatArkMethodSignatureLine(method, impl, true));
  }

  if (declares?.length) {
    for (const d of declares) {
      push(formatArkMethodSignatureLine(method, d, false));
    }
  } else if (!impl && primary) {
    push(formatArkMethodSignatureLine(method, primary, true));
  }

  if (lines.length === 0) return {};

  const canonicalSig = impl ?? declares?.[0] ?? primary!;
  const retRaw = canonicalSig.getMethodSubSignature().getReturnType()?.toString();

  return {
    signature: lines.join('\n'),
    returnType: normalizeArktsReturnType(retRaw),
  };
}

/** Parallel read chunk size during ArkTS batch persist (writes stay sequential for SQLite). */
function resolveArkTSPersistParallel(etsFileCount: number): number {
  const raw = process.env.HOMEGRAPH_ARKTS_PERSIST_PARALLEL?.trim();
  if (raw !== undefined && raw !== '') {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 1) return n;
  }
  // Large repos: serial reads — slower but stable on Windows / huge trees.
  if (etsFileCount >= 500) return 1;
  return 8;
}

/** Stack sizes (KB) for isolated ArkTS worker retries (Windows native stack overflow). */
function resolveArkTSWorkerStackSizesKb(): number[] {
  const raw = process.env.HOMEGRAPH_ARKTS_STACK_SIZES_KB?.trim();
  if (raw) {
    const parsed = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
    if (parsed.length > 0) return parsed;
  }
  return [32768, 65536, 131072, 262144];
}

/** Windows STATUS_STACK_OVERFLOW — process killed during deep native/JS recursion. */
function isStackOverflowExitCode(code: number | null): boolean {
  if (code === null) return false;
  return code === 3221225725 || code === -1073741571;
}

/**
 * Opt-in isolated ArkTS Scene build (child process + enlarged `--stack-size`).
 * Default is in-process: faster and avoids a Windows-only auto-isolated path that
 * could burn minutes on failed stack-size retries before giving up. Set
 * `HOMEGRAPH_ARKTS_ISOLATED=1` only when an in-process Scene build stack-overflows
 * the indexer (rare Photos-scale Windows cases).
 */
export function shouldUseIsolatedArkTSBuild(): boolean {
  const mode = process.env.HOMEGRAPH_ARKTS_ISOLATED?.trim();
  return mode === '1' || mode === 'true';
}

/**
 * Scene eviction budget sits below the V8 heap cap (heap default 3584MB so process
 * RSS stays near 4GB — native memory sits outside the heap). Small reserve only.
 */
const ARKTS_HOMEGRAPH_RESERVE_MB = 256;
/** Default Scene `memoryLimitMB`. Override with HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB. */
function defaultArkTSSceneMemoryLimitMB(): number {
  return Math.max(512, resolveMaxOldSpaceSizeMb() - ARKTS_HOMEGRAPH_RESERVE_MB);
}

/**
 * RSS limit passed to ArkAnalyzer `SceneOptions.memoryLimitMB`.
 * When exceeded, `analyseByModule` evicts cached modules before loading the next.
 * Set `HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB=0` to disable Scene eviction.
 */
function resolveArkTSSceneMemoryLimitMB(): number {
  const raw = process.env.HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB?.trim();
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return defaultArkTSSceneMemoryLimitMB();
}

/** Prefer modular Scene build when the project has Harmony module metadata. */
function shouldUseModularArkTSBuild(rootDir: string): boolean {
  const mode = process.env.HOMEGRAPH_ARKTS_MODULAR?.trim();
  if (mode === '0' || mode === 'false') return false;
  if (mode === '1' || mode === 'true') return true;
  return fs.existsSync(path.join(rootDir, 'build-profile.json5'));
}

/** One PROJECT module from root `build-profile.json5`. */
export interface HarmonyModuleRef {
  name: string;
  /** Project-relative POSIX path (no `./` prefix, no trailing slash). */
  srcPath: string;
}

/** Normalize build-profile `srcPath` / relative file paths for prefix matching. */
export function normalizeHarmonyModuleSrcPath(srcPath: string): string {
  return srcPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/**
 * Read PROJECT modules from root `build-profile.json5` (name + srcPath).
 * Returns [] when missing or unparsable — callers should fall back to full Scene.
 */
export function listHarmonyProjectModules(rootDir: string): HarmonyModuleRef[] {
  const profilePath = path.join(rootDir, 'build-profile.json5');
  if (!fs.existsSync(profilePath)) return [];
  let raw: unknown;
  try {
    raw = parseJson5Minimal(fs.readFileSync(profilePath, 'utf-8'));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const modules = (raw as { modules?: unknown }).modules;
  if (!Array.isArray(modules)) return [];
  const out: HarmonyModuleRef[] = [];
  for (const entry of modules) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as { name?: unknown; srcPath?: unknown };
    if (typeof rec.name !== 'string' || typeof rec.srcPath !== 'string') continue;
    const srcPath = normalizeHarmonyModuleSrcPath(rec.srcPath);
    if (!srcPath) continue;
    out.push({ name: rec.name, srcPath });
  }
  return out;
}

function findLongestHarmonyModule(
  fileRel: string,
  modules: HarmonyModuleRef[]
): HarmonyModuleRef | null {
  const file = normIndexPath(fileRel);
  let best: HarmonyModuleRef | null = null;
  for (const mod of modules) {
    const src = mod.srcPath;
    if (file === src || file.startsWith(`${src}/`)) {
      if (!best || mod.srcPath.length > best.srcPath.length) best = mod;
    }
  }
  return best;
}

export type DirtyHarmonyModuleResolution =
  | { mode: 'full'; reason: string }
  | { mode: 'modules'; moduleSrcPaths: string[] }
  | { mode: 'none' };

/**
 * Map changed/removed paths to Harmony modules for incremental ArkTS sync.
 * Structural project files (`build-profile.json5`, root `oh-package.json5`) or
 * ArkAnalyzer sources outside every module force a full rebuild.
 */
export function resolveDirtyHarmonyModules(
  rootDir: string,
  changedFiles: Iterable<string>
): DirtyHarmonyModuleResolution {
  if (!shouldUseModularArkTSBuild(rootDir)) {
    return { mode: 'full', reason: 'non-modular ArkTS project' };
  }
  const modules = listHarmonyProjectModules(rootDir);
  if (modules.length === 0) {
    return { mode: 'full', reason: 'no PROJECT modules in build-profile.json5' };
  }

  const changed = [...changedFiles].map(normIndexPath).filter(Boolean);
  if (changed.length === 0) return { mode: 'none' };

  for (const f of changed) {
    if (f === 'build-profile.json5' || f.endsWith('/build-profile.json5')) {
      return { mode: 'full', reason: 'build-profile.json5 changed' };
    }
    if (f === 'oh-package.json5') {
      return { mode: 'full', reason: 'root oh-package.json5 changed' };
    }
  }

  const dirty = new Set<string>();
  const unmatched: string[] = [];
  for (const f of changed) {
    // Virtual ArkAnalyzer paths are batch artifacts, not Harmony module sources.
    if (f.startsWith('@')) continue;

    const isModuleMeta = f.endsWith('/module.json5') || f.endsWith('/oh-package.json5');
    const isArkSrc = isArkAnalyzerSourcePath(f);
    if (!isArkSrc && !isModuleMeta) continue;

    const match = findLongestHarmonyModule(f, modules);
    if (match) dirty.add(match.srcPath);
    else if (isArkSrc) unmatched.push(f);
  }

  if (unmatched.length > 0) {
    return {
      mode: 'full',
      reason: `ArkTS sources outside modules: ${unmatched.slice(0, 5).join(', ')}`,
    };
  }
  if (dirty.size === 0) return { mode: 'none' };
  return { mode: 'modules', moduleSrcPaths: [...dirty].sort() };
}

function homegraphDbPath(rootDir: string): string {
  return path.join(rootDir, '.homegraph', 'homegraph.db');
}

const ARK_PROVENANCE = 'heuristic';
/** Virtual file path for ArkAnalyzer's in-scene dummy entry (not on disk). */
const ARKANALYZER_DUMMY_FILE = '@dummyFile.ets';

function fieldSigKey(classSig: string, fieldName: string): string {
  return `${classSig}::${fieldName}`;
}

/** HarmonyOS sources indexed via ArkAnalyzer Scene batch (`.ets`, `.ts`, `.d.ts`). */
export function isArkAnalyzerSourcePath(filePath: string): boolean {
  const base = path.basename(filePath);
  // `.d.ts` ends with `.ts` (Node extname) — one `.ts` suffix covers both.
  return base.endsWith('.ets') || base.endsWith('.ts');
}

function isEtsFileName(name: string): boolean {
  return name.endsWith('.ets');
}

function isCoLocatedArkTsFileName(name: string): boolean {
  return isArkAnalyzerSourcePath(name) && !isEtsFileName(name);
}

/**
 * Ignore matchers aligned with `scanDirectoryWalk`'s base set (built-in defaults
 * + root `.gitignore` + `homegraph.json` `exclude`).
 */
function arktsScanIgnoreMatchers(rootDir: string): Ignore[] {
  const matchers: Ignore[] = [buildDefaultIgnore(rootDir)];
  const exclude = loadExcludePatterns(rootDir);
  if (exclude.length > 0) matchers.push(ignore().add(exclude));
  return matchers;
}

function isArktsScanIgnored(relPath: string, isDir: boolean, matchers: Ignore[]): boolean {
  const probe = isDir ? `${relPath.replace(/\/$/, '')}/` : relPath;
  return matchers.some((ig) => ig.ignores(probe));
}

/** True when the tree looks like a HarmonyOS / ArkTS project (not a generic TS repo). */
function hasHarmonyProjectMarkers(rootDir: string): boolean {
  const matchers = arktsScanIgnoreMatchers(rootDir);
  const found: string[] = [];
  function walk(dir: string): void {
    if (found.length > 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (entry.name === '.git' || isHomeGraphDataDir(entry.name)) continue;
        if (isArktsScanIgnored(rel, true, matchers)) continue;
        walk(full);
      } else if (entry.isFile() && (isEtsFileName(entry.name) || entry.name === 'module.json5')) {
        if (isArktsScanIgnored(rel, false, matchers)) continue;
        found.push(full);
        return;
      }
    }
  }
  walk(rootDir);
  return found.length > 0;
}

function normIndexPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** Photos-style member calls: `sdk.Asset_setCropRect(`. */
const NAPI_MEMBER_CALL_RE = /\.\s*([A-Z][A-Za-z0-9_]*(?:_[A-Za-z0-9_]+)+)\s*\(/g;

/** `libFoo.so` module path from ArkAnalyzer import infos. */
const LIB_SO_MODULE_RE = /^lib[A-Za-z0-9_]+\.so$/;

function isNapiSymbolName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*_[A-Za-z0-9_]+$/.test(name);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ArkTSBatchIndex {
  fileResults: Map<string, ExtractionResult>;
  crossFileEdges: Edge[];
  nodeIds: Set<string>;
  errors: ExtractionError[];
  /**
   * Paths already written to SQLite during a streaming modular build
   * (`fileResults` may be empty while this is set).
   */
  streamedPersistedPaths?: Set<string>;
}

interface PersistedBatch extends ArkTSBatchIndex {
  rootDir: string;
  batchKey: string;
  etsFiles: string[];
}

let persistedBatch: PersistedBatch | null = null;
/** File that triggered the most recent batch persist (for indexAll edge stats). */
let batchTriggerFile: string | null = null;
/** Paths written by the current in-memory batch (fast skip for later .ets hits). */
let batchPersistedPaths: Set<string> = new Set();

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function emptyResult(filePath: string, message: string, severity: ExtractionError['severity']): ExtractionResult {
  return {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [{ message, filePath, severity }],
    durationMs: 0,
  };
}

/**
 * Enumerate ArkAnalyzer sources under `rootDir`, using the same ignore rules as
 * `scanDirectory` (defaults like `build/`/`dist/`, root `.gitignore`, exclude).
 * Previously this walk only skipped `node_modules`/`.git`/`.homegraph`, so
 * HarmonyOS build-output `.ets` files got written into the DB and non-git
 * `homegraph status` reported them as Pending Removed.
 */
export function scanEtsFiles(rootDir: string): string[] {
  const etsFiles: string[] = [];
  const coLocated: string[] = [];
  const matchers = arktsScanIgnoreMatchers(rootDir);
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (entry.name === '.git' || isHomeGraphDataDir(entry.name)) continue;
        if (isArktsScanIgnored(rel, true, matchers)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (isArktsScanIgnored(rel, false, matchers)) continue;
        if (isEtsFileName(entry.name)) {
          etsFiles.push(rel);
        } else if (isCoLocatedArkTsFileName(entry.name)) {
          coLocated.push(rel);
        }
      }
    }
  }
  walk(rootDir);
  if (etsFiles.length === 0 && !hasHarmonyProjectMarkers(rootDir)) {
    return [];
  }
  const found = etsFiles.length > 0 ? [...etsFiles, ...coLocated] : coLocated;
  found.sort();
  return found;
}

function computeBatchKey(rootDir: string, etsFiles: string[]): string {
  // mtime + size only — full content hashes happen per-file at persist time.
  return etsFiles
    .map((rel) => {
      const full = path.join(rootDir, rel);
      const stat = fs.statSync(full);
      return `${rel}:${stat.mtimeMs}:${stat.size}`;
    })
    .join('\0');
}

/** True when a full ArkTS batch has been committed for this index run. */
let batchBuildCommitted = false;

function reportBatchProgress(
  subphase: 'scene' | 'persist',
  current: number,
  total: number,
  currentFile?: string
): void {
  reportArkTSBatchProgress({ subphase, current, total, currentFile });
}

function persistFileResult(
  queries: QueryBuilder,
  filePath: string,
  content: string,
  stats: fs.Stats,
  result: ExtractionResult,
  options?: { force?: boolean }
): void {
  const contentHash = hashContent(content);
  const existingFile = queries.getFileByPath(filePath);
  if (!options?.force && existingFile?.contentHash === contentHash) {
    return;
  }

  const crossFileIncomingEdges =
    existingFile && typeof queries.getCrossFileIncomingEdgesWithTarget === 'function'
      ? queries.getCrossFileIncomingEdgesWithTarget(filePath)
      : [];

  if (existingFile) {
    queries.deleteFile(filePath);
  }

  const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);
  if (validNodes.length > 0) {
    queries.insertNodes(validNodes);
  }

  if (result.edges.length > 0) {
    const insertedIds = new Set(validNodes.map((n) => n.id));
    const validEdges = result.edges.filter(
      (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
    );
    if (validEdges.length > 0) {
      queries.insertEdges(validEdges);
    }
  }

  if (crossFileIncomingEdges.length > 0) {
    const newNodesByKindName = new Map<string, string>();
    for (const n of validNodes) {
      newNodesByKindName.set(`${n.kind}\0${n.name}`, n.id);
    }
    const reinserted: Edge[] = [];
    for (const e of crossFileIncomingEdges) {
      const newTargetId = newNodesByKindName.get(`${e.targetKind}\0${e.targetName}`);
      if (newTargetId) {
        reinserted.push({
          source: e.source,
          target: newTargetId,
          kind: e.kind,
          metadata: e.metadata,
          line: e.line,
          column: e.column,
          provenance: e.provenance,
        });
      }
    }
    if (reinserted.length > 0) {
      queries.insertEdges(reinserted);
    }
  }

  if (result.unresolvedReferences.length > 0) {
    const insertedIds = new Set(validNodes.map((n) => n.id));
    const refsWithContext = result.unresolvedReferences
      .filter((ref) => insertedIds.has(ref.fromNodeId))
      .map((ref) => ({
        ...ref,
        filePath: ref.filePath ?? filePath,
        language: ref.language ?? ('arkts' as Language),
      }));
    if (refsWithContext.length > 0) {
      queries.insertUnresolvedRefsBatch(refsWithContext);
    }
  }

  const fileRecord: FileRecord = {
    path: filePath,
    contentHash,
    language: 'arkts',
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    indexedAt: Date.now(),
    nodeCount: result.nodes.length,
    errors: result.errors.length > 0 ? result.errors : undefined,
    generated: detectGeneratedFile(filePath, content),
  };
  queries.upsertFile(fileRecord);
}

/** Force-rewrite every file in an incremental module index (edges may change without content). */
function persistIncrementalModuleResults(
  rootDir: string,
  queries: QueryBuilder,
  index: Pick<ArkTSBatchIndex, 'fileResults'>
): void {
  const persistTotal = index.fileResults.size;
  let persistIndex = 0;
  for (const [filePath, fileResult] of index.fileResults) {
    persistIndex++;
    reportBatchProgress('persist', persistIndex, persistTotal, filePath);
    const isVirtual = filePath.startsWith('@');
    const full = path.join(rootDir, filePath);
    const content = isVirtual ? '' : fs.readFileSync(full, 'utf-8');
    const stats = isVirtual
      ? ({ size: 0, mtimeMs: Date.now() } as fs.Stats)
      : fs.statSync(full);
    persistFileResult(queries, filePath, content, stats, fileResult, { force: true });
  }
}

/**
 * Persist a module slice then drop it from the in-memory map (streaming modular build).
 * Returns the number of files written.
 */
function persistAndDropModuleSlice(
  rootDir: string,
  queries: QueryBuilder,
  slice: Map<string, ExtractionResult>,
  streamedPersistedPaths: Set<string>,
  persistOrdinal: { done: number; totalHint: number }
): number {
  if (slice.size === 0) return 0;
  for (const [filePath, fileResult] of slice) {
    persistOrdinal.done++;
    reportBatchProgress(
      'persist',
      Math.min(persistOrdinal.done, persistOrdinal.totalHint),
      persistOrdinal.totalHint,
      filePath
    );
    const isVirtual = filePath.startsWith('@');
    const full = path.join(rootDir, filePath);
    const content = isVirtual ? '' : fs.readFileSync(full, 'utf-8');
    const stats = isVirtual
      ? ({ size: 0, mtimeMs: Date.now() } as fs.Stats)
      : fs.statSync(full);
    persistFileResult(queries, filePath, content, stats, fileResult, { force: true });
    streamedPersistedPaths.add(normIndexPath(filePath));
  }
  return slice.size;
}

async function persistBatchResultsAsync(
  rootDir: string,
  queries: QueryBuilder,
  index: ArkTSBatchIndex
): Promise<void> {
  const entries = [...index.fileResults.entries()];
  const persistTotal = entries.length;
  const parallel = resolveArkTSPersistParallel(persistTotal);

  for (let start = 0; start < entries.length; start += parallel) {
    const chunk = entries.slice(start, start + parallel);
    const prepared = await Promise.all(
      chunk.map(async ([filePath, fileResult]) => {
        const isVirtual = filePath.startsWith('@');
        if (isVirtual) {
          return {
            filePath,
            fileResult,
            content: '',
            stats: { size: 0, mtimeMs: Date.now() } as fs.Stats,
          };
        }
        const full = path.join(rootDir, filePath);
        const [content, stats] = await Promise.all([
          fsp.readFile(full, 'utf-8'),
          fsp.stat(full),
        ]);
        return { filePath, fileResult, content, stats };
      })
    );

    for (let i = 0; i < prepared.length; i++) {
      const persistIndex = start + i + 1;
      const item = prepared[i]!;
      reportBatchProgress('persist', persistIndex, persistTotal, item.filePath);
      persistFileResult(queries, item.filePath, item.content, item.stats, item.fileResult);
    }
  }
}

function persistBatchResultsSync(
  rootDir: string,
  queries: QueryBuilder,
  index: ArkTSBatchIndex
): void {
  const persistTotal = index.fileResults.size;
  let persistIndex = 0;
  for (const [filePath, fileResult] of index.fileResults) {
    persistIndex++;
    reportBatchProgress('persist', persistIndex, persistTotal, filePath);
    const isVirtual = filePath.startsWith('@');
    const full = path.join(rootDir, filePath);
    const content = isVirtual ? '' : fs.readFileSync(full, 'utf-8');
    const stats = isVirtual
      ? ({ size: 0, mtimeMs: Date.now() } as fs.Stats)
      : fs.statSync(full);
    persistFileResult(queries, filePath, content, stats, fileResult);
  }
}

function commitArkTSBatch(
  rootDir: string,
  batchKey: string,
  etsFiles: string[],
  index: ArkTSBatchIndex,
  triggerFile: string
): PersistedBatch {
  const streamed = index.streamedPersistedPaths;
  batchPersistedPaths =
    streamed && streamed.size > 0
      ? new Set([...streamed].map(normIndexPath))
      : new Set([...index.fileResults.keys()].map(normIndexPath));
  persistedBatch = { ...index, rootDir, batchKey, etsFiles };
  batchTriggerFile = normIndexPath(triggerFile);
  if (batchPersistedPaths.size > 0 || index.fileResults.size > 0) {
    batchBuildCommitted = true;
  }
  return persistedBatch;
}

/**
 * Drop in-memory ExtractionResults / edges after they are in SQLite.
 * Keep path sets so `isArkTSBatchPersisted` still skips re-parse; matches the
 * isolated-worker commit shape (empty fileResults).
 */
function releaseArkTSBatchHeavyPayload(): void {
  if (!persistedBatch) return;
  persistedBatch.fileResults.clear();
  persistedBatch.crossFileEdges = [];
  persistedBatch.nodeIds.clear();
  persistedBatch.errors = [];
}

/** Best-effort reclaim after Scene / batch teardown (needs `node --expose-gc`). */
function tryForceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    try {
      gc();
    } catch {
      // ignore
    }
  }
}

/**
 * Unload every module's IR then dispose Scene globals. Plain `scene.dispose()`
 * only clears SDK helpers / moduleCache — project ArkFiles stay reachable and
 * pin multi-GB RSS into Parsing/Resolving.
 */
function releaseArkAnalyzerScene(scene: Scene): void {
  try {
    for (const mod of scene.getModules()) {
      try {
        scene.disposeModule(mod);
        mod.setFileDepGraph(undefined);
        mod.clearFilesMap();
        mod.setLoadState(ModuleLoadState.NOT_LOADED);
      } catch {
        // per-module best-effort
      }
    }
  } catch {
    // ignore
  }
  try {
    scene.dispose();
  } catch {
    // ignore
  }
  tryForceGc();
}

/**
 * ArkAnalyzer 1.0.92 keeps INDEX hollow on {@link ModuleBuilder} as a private
 * method (public eviction paths call it internally). HomeGraph needs the same
 * post-ingest hollow; call through a narrow cast until a public API exists.
 */
function hollowModuleToIndex(builder: ModuleBuilder, moduleId: number): void {
  (
    builder as unknown as {
      downgradeModule(id: number, level: ModuleDepthLevel): void;
    }
  ).downgradeModule(moduleId, ModuleDepthLevel.INDEX);
}

function tryReturnCachedBatch(
  rootDir: string,
  triggerFile: string,
  etsFiles: string[]
): PersistedBatch | null {
  const normalizedTrigger = normIndexPath(triggerFile);

  // Only reuse when payload is still in memory. After
  // releaseArkTSBatchHeavyPayload(), fileResults is empty — fall through to
  // rebuild (same as isolated-worker commit) rather than return a hollow cache.
  if (
    persistedBatch &&
    persistedBatch.rootDir === rootDir &&
    persistedBatch.fileResults.size > 0 &&
    batchPersistedPaths.has(normalizedTrigger)
  ) {
    return persistedBatch;
  }

  const batchKey = etsFiles.length > 0 ? computeBatchKey(rootDir, etsFiles) : '';

  if (
    persistedBatch &&
    persistedBatch.rootDir === rootDir &&
    persistedBatch.batchKey === batchKey &&
    persistedBatch.fileResults.size > 0
  ) {
    batchPersistedPaths = new Set(
      [...persistedBatch.fileResults.keys()].map(normIndexPath)
    );
    return persistedBatch;
  }

  if (
    batchBuildCommitted &&
    persistedBatch &&
    persistedBatch.rootDir === rootDir &&
    persistedBatch.fileResults.size > 0 &&
    persistedBatch.batchKey === batchKey
  ) {
    return persistedBatch;
  }

  return null;
}

function markBatchCommittedAfterWorker(
  rootDir: string,
  triggerFile: string,
  etsFiles: string[],
  batchKey: string
): PersistedBatch {
  batchTriggerFile = normIndexPath(triggerFile);
  batchPersistedPaths = new Set(etsFiles.map(normIndexPath));
  batchBuildCommitted = true;
  persistedBatch = {
    fileResults: new Map(),
    crossFileEdges: [],
    nodeIds: new Set(),
    errors: [],
    rootDir,
    batchKey,
    etsFiles,
  };
  return persistedBatch;
}

function spawnIsolatedArkTSBatchWorker(
  rootDir: string,
  dbPath: string,
  triggerFile: string
): { ok: boolean; lastCode: number | null } {
  const workerPath = path.join(__dirname, '..', 'arkts-batch-worker.js');
  let lastCode: number | null = null;

  for (const stackKb of resolveArkTSWorkerStackSizesKb()) {
    process.stderr.write(
      `\n\x1b[33m    ArkTS: Scene build in isolated process (--stack-size=${stackKb} KB; modular if build-profile.json5)...\x1b[0m\n`
    );
    const argv = buildRelaunchArgv(
      workerPath,
      [rootDir, dbPath, triggerFile],
      [
        ...process.execArgv,
        `--stack-size=${stackKb}`,
        maxOldSpaceSizeFlag(),
      ]
    );
    const result = spawnSync(process.execPath, argv, {
      stdio: 'inherit',
      env: process.env,
      timeout: 60 * 60 * 1000,
      windowsHide: true,
    });
    lastCode = result.status;
    if (result.status === 0) {
      return { ok: true, lastCode };
    }
    if (!isStackOverflowExitCode(result.status)) {
      break;
    }
  }
  return { ok: false, lastCode };
}

function runArkTSBatchFullCore(
  rootDir: string,
  queries: QueryBuilder,
  triggerFile: string,
  etsFiles: string[],
  batchKey: string
): PersistedBatch {
  batchTriggerFile = null;
  batchPersistedPaths = new Set();

  if (etsFiles.length === 0) {
    persistedBatch = null;
    batchBuildCommitted = false;
    return {
      fileResults: new Map(),
      crossFileEdges: [],
      nodeIds: new Set(),
      errors: [],
      rootDir,
      batchKey: '',
      etsFiles: [],
    };
  }

  setArktsBatchRunning(true);
  try {
    reportBatchProgress('scene', 0, etsFiles.length);
    const index = buildArkTSIndex(rootDir, etsFiles);
    if (index.fileResults.size === 0) {
      const fatal = index.errors.find((e) => e.severity === 'error');
      const detail = index.errors.map((e) => `[${e.severity}] ${e.message}`).join(' | ');
      throw new Error(
        fatal?.message ??
          `ArkTS batch produced no indexed files${detail ? ` (${detail})` : ' (no Scene/adapter errors recorded)'}`
      );
    }
    queries.deleteArkTSCrossFileCallEdges();
    persistBatchResultsSync(rootDir, queries, index);

    if (index.crossFileEdges.length > 0) {
      const valid = index.crossFileEdges.filter(
        (e) => index.nodeIds.has(e.source) && index.nodeIds.has(e.target)
      );
      if (valid.length > 0) {
        queries.insertEdges(valid);
      }
    }

    // Keep payload in memory for ArkTSExtractor.extract() same-batch hits.
    // indexAll uses primeArkTSBatch → releaseArkTSBatchHeavyPayload after persist.
    return commitArkTSBatch(rootDir, batchKey, etsFiles, index, triggerFile);
  } finally {
    setArktsBatchRunning(false);
  }
}

function runArkTSBatchFull(
  rootDir: string,
  queries: QueryBuilder,
  triggerFile: string,
  etsFiles: string[],
  batchKey: string
): PersistedBatch {
  if (shouldUseIsolatedArkTSBuild()) {
    const dbPath = homegraphDbPath(rootDir);
    if (!fs.existsSync(dbPath)) {
      throw new Error(`ArkTS isolated build requires ${dbPath}`);
    }
    setArktsBatchRunning(true);
    try {
      reportBatchProgress('scene', 0, etsFiles.length);
      const spawned = spawnIsolatedArkTSBatchWorker(rootDir, dbPath, triggerFile);
      if (!spawned.ok) {
        throw new Error(
          `ArkTS isolated Scene build failed (exit ${spawned.lastCode ?? 'unknown'}). ` +
            'Unset HOMEGRAPH_ARKTS_ISOLATED to use the default in-process build, ' +
            'or raise HOMEGRAPH_ARKTS_STACK_SIZES_KB (e.g. 65536,131072,262144)'
        );
      }
      return markBatchCommittedAfterWorker(rootDir, triggerFile, etsFiles, batchKey);
    } finally {
      setArktsBatchRunning(false);
    }
  }
  return runArkTSBatchFullCore(rootDir, queries, triggerFile, etsFiles, batchKey);
}

/** Worker entry — full batch in an isolated process (no nested spawn). */
export function runIsolatedArkTSBatchEntry(
  rootDir: string,
  dbPath: string,
  triggerFile: string
): void {
  const db = DatabaseConnection.open(dbPath);
  try {
    const queries = new QueryBuilderClass(db.getDb());
    bindExtractionContext(rootDir, queries);
    const etsFiles = scanEtsFiles(rootDir);
    const batchKey = etsFiles.length > 0 ? computeBatchKey(rootDir, etsFiles) : '';
    runArkTSBatchFullCore(rootDir, queries, normIndexPath(triggerFile), etsFiles, batchKey);
  } finally {
    db.close();
  }
}

/** Build Scene, run RTA, and write every `.ets` file + cross-file edges to the DB. */
function runArkTSBatch(rootDir: string, queries: QueryBuilder, triggerFile: string): PersistedBatch {
  const normalizedTrigger = normIndexPath(triggerFile);
  const etsFiles = scanEtsFiles(rootDir);
  const cached = tryReturnCachedBatch(rootDir, normalizedTrigger, etsFiles);
  if (cached) {
    return cached;
  }

  // indexAll releases the in-memory payload after SQLite persist. A later
  // ArkTSExtractor hit must NOT rebuild the entire Scene (looks like a restart).
  if (
    batchBuildCommitted &&
    persistedBatch &&
    persistedBatch.rootDir === rootDir &&
    batchPersistedPaths.has(normalizedTrigger)
  ) {
    return {
      fileResults: new Map(),
      crossFileEdges: [],
      nodeIds: new Set(),
      errors: [
        {
          message: 'ArkTS batch already persisted this run; in-memory payload released',
          severity: 'warning',
        },
      ],
      rootDir,
      batchKey: persistedBatch.batchKey,
      etsFiles: persistedBatch.etsFiles,
    };
  }

  const batchKey = etsFiles.length > 0 ? computeBatchKey(rootDir, etsFiles) : '';
  return runArkTSBatchFull(rootDir, queries, normalizedTrigger, etsFiles, batchKey);
}

/** Async batch build with parallel file reads during persist (used by indexAll / sync). */
export interface PrimeArkTSBatchOptions {
  /**
   * Changed or removed ArkAnalyzer sources (and module meta). When set on a
   * multi-module Harmony project, only dirty modules are re-analysed.
   */
  changedFiles?: Iterable<string>;
}

/** Async batch build with parallel file reads during persist (used by indexAll). */
export async function primeArkTSBatch(
  rootDir: string,
  queries: QueryBuilder,
  triggerFile: string,
  options?: PrimeArkTSBatchOptions
): Promise<void> {
  const normalizedTrigger = normIndexPath(triggerFile);
  const etsFiles = scanEtsFiles(rootDir);

  const changed = options?.changedFiles
    ? [...options.changedFiles].map(normIndexPath).filter(Boolean)
    : null;

  if (changed) {
    const resolution = resolveDirtyHarmonyModules(rootDir, changed);
    if (resolution.mode === 'none') {
      return;
    }
    if (resolution.mode === 'modules') {
      await runArkTSBatchIncrementalModules(
        rootDir,
        queries,
        normalizedTrigger,
        etsFiles,
        resolution.moduleSrcPaths
      );
      return;
    }
    // mode === 'full': fall through to full rebuild (ignore in-memory cache).
  } else {
    const cached = tryReturnCachedBatch(rootDir, normalizedTrigger, etsFiles);
    if (cached) {
      return;
    }
  }

  const batchKey = etsFiles.length > 0 ? computeBatchKey(rootDir, etsFiles) : '';

  batchTriggerFile = null;
  batchPersistedPaths = new Set();

  if (etsFiles.length === 0) {
    persistedBatch = null;
    batchBuildCommitted = false;
    return;
  }

  if (shouldUseIsolatedArkTSBuild()) {
    runArkTSBatchFull(rootDir, queries, normalizedTrigger, etsFiles, batchKey);
    return;
  }

  setArktsBatchRunning(true);
  try {
    reportBatchProgress('scene', 0, etsFiles.length);
    const streamModular = shouldUseModularArkTSBuild(rootDir);
    if (streamModular) {
      // Clear stale cross-file RTA edges before streaming module persists.
      queries.deleteArkTSCrossFileCallEdges();
    }
    const index = buildArkTSIndex(rootDir, etsFiles, {
      streamQueries: streamModular ? queries : undefined,
    });
    const streamed = index.streamedPersistedPaths?.size ?? 0;
    if (index.fileResults.size === 0 && streamed === 0) {
      const fatal = index.errors.find((e) => e.severity === 'error');
      const detail = index.errors.map((e) => `[${e.severity}] ${e.message}`).join(' | ');
      throw new Error(
        fatal?.message ??
          `ArkTS batch produced no indexed files${detail ? ` (${detail})` : ' (no Scene/adapter errors recorded)'}`
      );
    }
    if (!streamModular) {
      queries.deleteArkTSCrossFileCallEdges();
    }
    if (index.fileResults.size > 0) {
      await persistBatchResultsAsync(rootDir, queries, index);
    }

    if (index.crossFileEdges.length > 0) {
      const valid = index.crossFileEdges.filter(
        (e) => index.nodeIds.has(e.source) && index.nodeIds.has(e.target)
      );
      if (valid.length > 0) {
        queries.insertEdges(valid);
      }
    }

    commitArkTSBatch(rootDir, batchKey, etsFiles, index, normalizedTrigger);
    releaseArkTSBatchHeavyPayload();
    tryForceGc();
  } finally {
    setArktsBatchRunning(false);
  }
}

async function runArkTSBatchIncrementalModules(
  rootDir: string,
  queries: QueryBuilder,
  triggerFile: string,
  etsFiles: string[],
  moduleSrcPaths: string[]
): Promise<void> {
  // Isolated worker has no module-subset protocol yet — fall back to full.
  if (shouldUseIsolatedArkTSBuild()) {
    const batchKey = etsFiles.length > 0 ? computeBatchKey(rootDir, etsFiles) : '';
    runArkTSBatchFull(rootDir, queries, triggerFile, etsFiles, batchKey);
    return;
  }

  batchTriggerFile = null;
  batchPersistedPaths = new Set();

  setArktsBatchRunning(true);
  try {
    reportBatchProgress('scene', 0, etsFiles.length);
    queries.deleteArkTSCrossFileCallEdges();
    const index = buildArkTSIndexByModule(rootDir, etsFiles, {
      targetModuleSrcPaths: moduleSrcPaths,
      streamQueries: queries,
    });
    const streamed = index.streamedPersistedPaths?.size ?? 0;
    if (index.fileResults.size === 0 && streamed === 0) {
      const fatal = index.errors.find((e) => e.severity === 'error');
      // Fall back to full project batch when the subset produced nothing.
      const batchKey = etsFiles.length > 0 ? computeBatchKey(rootDir, etsFiles) : '';
      if (fatal) {
        process.stderr.write(
          `\n\x1b[33m    ArkTS: incremental modules failed (${fatal.message}); full rebuild\x1b[0m\n`
        );
      }
      const full = buildArkTSIndex(rootDir, etsFiles);
      if (full.fileResults.size === 0 && (full.streamedPersistedPaths?.size ?? 0) === 0) {
        throw new Error(fatal?.message ?? 'ArkTS incremental batch produced no indexed files');
      }
      queries.deleteArkTSCrossFileCallEdges();
      if (full.fileResults.size > 0) {
        await persistBatchResultsAsync(rootDir, queries, full);
      }
      if (full.crossFileEdges.length > 0) {
        const valid = full.crossFileEdges.filter(
          (e) => full.nodeIds.has(e.source) && full.nodeIds.has(e.target)
        );
        if (valid.length > 0) queries.insertEdges(valid);
      }
      commitArkTSBatch(rootDir, batchKey, etsFiles, full, triggerFile);
      releaseArkTSBatchHeavyPayload();
      tryForceGc();
      return;
    }

    if (index.fileResults.size > 0) {
      persistIncrementalModuleResults(rootDir, queries, index);
    }

    if (index.crossFileEdges.length > 0) {
      const valid = index.crossFileEdges.filter(
        (e) => index.nodeIds.has(e.source) && index.nodeIds.has(e.target)
      );
      if (valid.length > 0) {
        queries.insertEdges(valid);
      }
    }

    // Unique key so a partial index is never mistaken for a full-project cache hit.
    const batchKey = `incremental:${moduleSrcPaths.join(',')}`;
    commitArkTSBatch(rootDir, batchKey, etsFiles, index, triggerFile);
    releaseArkTSBatchHeavyPayload();
    tryForceGc();
    process.stderr.write(
      `\n\x1b[33m    ArkTS: incremental module reindex done (${moduleSrcPaths.join(', ')})\x1b[0m\n`
    );
  } finally {
    setArktsBatchRunning(false);
  }
}

/** True when this `.ets` file was already written by the in-memory ArkTS batch. */
export function isArkTSBatchPersisted(filePath: string): boolean {
  return batchPersistedPaths.has(normIndexPath(filePath));
}

/** True after a successful ArkTS batch was committed to SQLite this index run. */
export function isArkTSBatchCommitted(): boolean {
  return batchBuildCommitted;
}

/** Clear cached batch state (tests and full re-index). */
export function resetArkTSBatch(): void {
  persistedBatch = null;
  batchTriggerFile = null;
  batchPersistedPaths = new Set();
  batchBuildCommitted = false;
  arktsIndexNotices = [];
}

/**
 * After parse workers no longer need skip-path metadata beyond
 * `batchPersistedPaths`, drop the heavy path-list / batchKey strings.
 */
export function shrinkArkTSBatchPostParse(): void {
  if (!persistedBatch) return;
  persistedBatch.etsFiles = [];
  persistedBatch.batchKey = '';
}

export class ArkTSExtractor {
  private filePath: string;

  constructor(filePath: string, _source: string) {
    this.filePath = filePath;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const rootDir = getExtractionProjectRoot();
    const queries = getExtractionQueries();
    if (!rootDir || !queries) {
      return {
        ...emptyResult(this.filePath, 'Extraction context not bound', 'error'),
        durationMs: Date.now() - startTime,
      };
    }

    const batch = runArkTSBatch(rootDir, queries, normIndexPath(this.filePath));
    if (batch.fileResults.size === 0) {
      return {
        ...emptyResult(this.filePath, 'No .ets files in project', 'warning'),
        durationMs: Date.now() - startTime,
      };
    }

    const cached = batch.fileResults.get(normIndexPath(this.filePath));
    if (!cached) {
      return {
        ...emptyResult(this.filePath, 'File not present in ArkTS index', 'warning'),
        durationMs: Date.now() - startTime,
      };
    }

    const edges =
      normIndexPath(this.filePath) === batchTriggerFile
        ? [...cached.edges, ...batch.crossFileEdges]
        : cached.edges;

    return {
      nodes: cached.nodes,
      edges,
      unresolvedReferences: cached.unresolvedReferences,
      errors: [...cached.errors],
      durationMs: Date.now() - startTime,
    };
  }
}

const CLASS_CATEGORY = {
  CLASS: 0,
  STRUCT: 1,
  INTERFACE: 2,
  ENUM: 3,
} as const;

/** ArkAnalyzer {@link FieldCategory} values (not re-exported from the npm entry). */
const FIELD_CATEGORY = {
  PROPERTY_DECLARATION: 0,
  PROPERTY_ASSIGNMENT: 1,
  SHORT_HAND_PROPERTY_ASSIGNMENT: 2,
  SPREAD_ASSIGNMENT: 3,
  PROPERTY_SIGNATURE: 4,
  ENUM_MEMBER: 5,
  INDEX_SIGNATURE: 6,
  GET_ACCESSOR: 7,
  PARAMETER_PROPERTY: 8,
} as const;

/** {@link ModifierType.CONST} — not re-exported from the arkanalyzer npm entry. */
const MODIFIER_CONST = 128;

interface ModelWithModifiers {
  isExport?: () => boolean;
  isPublic?: () => boolean;
  isPrivate?: () => boolean;
  isProtected?: () => boolean;
  isStatic?: () => boolean;
  containsModifier?: (modifier: number) => boolean;
  getDecorators?: () => Iterable<{ getKind: () => string; getContent?: () => string }>;
}

/** `realpathSync` when the path (or its dirname) exists; otherwise `path.resolve`. */
function realpathExisting(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * If `absolutePath` is under `canonicalRoot`, return the project-relative posix
 * path; otherwise null. Windows compares case-insensitively.
 */
function tryStripRootPrefix(canonicalRoot: string, absolutePath: string): string | null {
  const root = toPosixPath(canonicalRoot);
  const abs = toPosixPath(absolutePath);
  const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
  const absCmp = process.platform === 'win32' ? abs.toLowerCase() : abs;
  if (absCmp === rootCmp) return '';
  const prefix = rootCmp.endsWith('/') ? rootCmp : `${rootCmp}/`;
  if (!absCmp.startsWith(prefix)) return null;
  const sliceFrom = root.endsWith('/') ? root.length : root.length + 1;
  return abs.slice(sliceFrom);
}

export interface ArkRelPathNormalizer {
  /** realpath'd project root used for all joins in this batch. */
  readonly rootDir: string;
  normalize(absolutePath: string): string;
}

/**
 * Project-relative paths for ArkAnalyzer absolutes.
 *
 * ArkAnalyzer often returns realpath'd absolutes (macOS: `/private/var/...`),
 * while HomeGraph's `rootDir` from `mkdtemp` / callers may be unresolved
 * (`/var/...`). We realpath the root **once**, then strip by prefix on the hot
 * path; only prefix misses pay a per-path `realpath` (cached for the batch).
 */
export function createArkRelPathNormalizer(rootDir: string): ArkRelPathNormalizer {
  const canonicalRoot = realpathExisting(rootDir);
  const cache = new Map<string, string>();

  const normalizeOnce = (absolutePath: string): string => {
    const fast = tryStripRootPrefix(canonicalRoot, absolutePath);
    if (fast !== null) return fast;
    const abs = realpathExisting(absolutePath);
    const after = tryStripRootPrefix(canonicalRoot, abs);
    if (after !== null) return after;
    return toPosixPath(path.relative(canonicalRoot, abs));
  };

  return {
    rootDir: canonicalRoot,
    normalize(absolutePath: string): string {
      const hit = cache.get(absolutePath);
      if (hit !== undefined) return hit;
      const rel = normalizeOnce(absolutePath);
      cache.set(absolutePath, rel);
      return rel;
    },
  };
}

/** Map ArkAnalyzer synthetic files (e.g. @dummyFile) to our virtual indexed path. */
function resolveArkanalyzerVirtualPath(arkFile: ArkFile): string | null {
  const base = path.basename(arkFile.getFilePath()).replace(/\\/g, '/');
  if (base === '@dummyFile' || base.endsWith('@dummyFile')) {
    return ARKANALYZER_DUMMY_FILE;
  }
  return null;
}

function buildQualifiedName(parts: string[]): string {
  return parts.filter(Boolean).join('::');
}

function collectNamespaceChain(ns: ArkNamespace): string[] {
  const parts: string[] = [];
  let current: ArkNamespace | undefined | null = ns;
  while (current) {
    parts.unshift(current.getName());
    current = current.getDeclaringArkNamespace();
  }
  return parts;
}

function buildNamespaceQualifiedName(ns: ArkNamespace): string {
  return buildQualifiedName(collectNamespaceChain(ns));
}

function anonymousClassDisplayName(cls: ArkClass): string {
  let superName = cls.getSuperClassName() || 'Object';
  const lastSep = Math.max(superName.lastIndexOf('.'), superName.lastIndexOf('::'));
  if (lastSep >= 0) superName = superName.slice(lastSep + 1);
  superName = superName.trim() || 'Object';
  const line = cls.getOriginFullPosition()?.getFirstLine() ?? 1;
  return `<${superName}$anon@${line}>`;
}

function classDisplayName(cls: ArkClass): string {
  return cls.isAnonymousClass() ? anonymousClassDisplayName(cls) : cls.getName();
}

function isAnonymousArkMethod(method: ArkMethod): boolean {
  return method.isAnonymousMethod?.() === true || method.getName().startsWith(ANONYMOUS_METHOD_PREFIX);
}

function shouldSkipArkMethod(method: ArkMethod): boolean {
  if (method.isDefaultArkMethod()) return true;
  if (isAnonymousArkMethod(method)) return true;
  const name = method.getName();
  if (name === DEFAULT_ARK_METHOD_NAME) return true;
  if (name === INSTANCE_INIT_METHOD_NAME || name === STATIC_INIT_METHOD_NAME) return true;
  if (name.startsWith(STATIC_BLOCK_METHOD_NAME_PREFIX)) return true;
  if (resolveMethodDisplayName(method) === null) return true;
  return false;
}

/** User-facing or ArkAnalyzer-stable name for graph nodes (includes `%AMn` for anonymous). */
function arkMethodDisplayName(method: ArkMethod): string | null {
  const resolved = resolveMethodDisplayName(method);
  if (resolved) return resolved;
  if (isAnonymousArkMethod(method)) return method.getName();
  return null;
}

/** Decode ArkAnalyzer nested-method encoding (`%inner$outer`) to the user-visible name. */
function resolveMethodDisplayName(method: ArkMethod): string | null {
  const name = method.getName();
  if (name === DEFAULT_ARK_METHOD_NAME) return null;
  if (name === INSTANCE_INIT_METHOD_NAME || name === STATIC_INIT_METHOD_NAME) return null;
  if (name.startsWith(STATIC_BLOCK_METHOD_NAME_PREFIX)) return null;
  if (name.startsWith(ANONYMOUS_METHOD_PREFIX)) return null;

  if (name.startsWith(NAME_PREFIX) && name.includes(NAME_DELIMITER)) {
    const inner = name.slice(NAME_PREFIX.length, name.indexOf(NAME_DELIMITER));
    if (inner && !inner.startsWith('AM')) return inner;
  }

  if (name.startsWith(NAME_PREFIX)) return null;
  return name;
}

function shouldSkipLocalName(name: string): boolean {
  if (!name || name === 'this') return true;
  if (name.startsWith(NAME_PREFIX)) return true;
  return false;
}

function classNodeKind(cls: ArkClass): NodeKind {
  switch (cls.getCategory()) {
    case CLASS_CATEGORY.INTERFACE:
      return 'interface';
    case CLASS_CATEGORY.ENUM:
      return 'enum';
    case CLASS_CATEGORY.STRUCT:
      return 'struct';
    default:
      return 'class';
  }
}

function buildMethodQualifiedName(method: ArkMethod, displayName?: string): string {
  const cls = method.getDeclaringArkClass();
  const ns = cls.getDeclaringArkNamespace();
  const parts: string[] = [];
  if (ns) parts.push(...collectNamespaceChain(ns));
  if (!cls.isDefaultArkClass()) {
    parts.push(classDisplayName(cls));
  }
  const outer = method.getOuterMethod();
  if (outer) {
    const outerName = arkMethodDisplayName(outer);
    if (outerName) parts.push(outerName);
  }
  parts.push(displayName ?? arkMethodDisplayName(method) ?? method.getName());
  return buildQualifiedName(parts);
}

function buildClassQualifiedName(cls: ArkClass): string {
  const ns = cls.getDeclaringArkNamespace();
  const parts: string[] = [];
  if (ns) parts.push(...collectNamespaceChain(ns));
  if (!cls.isDefaultArkClass()) {
    parts.push(classDisplayName(cls));
  }
  return buildQualifiedName(parts) || classDisplayName(cls);
}

function buildFieldQualifiedName(field: ArkField): string {
  const cls = field.getDeclaringArkClass();
  const parts: string[] = [];
  const ns = cls.getDeclaringArkNamespace();
  if (ns) parts.push(...collectNamespaceChain(ns));
  if (!cls.isDefaultArkClass()) {
    parts.push(classDisplayName(cls));
  }
  parts.push(field.getName());
  return buildQualifiedName(parts);
}

function buildTypeAliasQualifiedName(name: string, ns?: ArkNamespace): string {
  const parts: string[] = [];
  if (ns) parts.push(...collectNamespaceChain(ns));
  parts.push(name);
  return buildQualifiedName(parts);
}

function linesFromPosition(pos?: { getFirstLine: () => number; getLastLine: () => number; getFirstCol: () => number }): {
  line: number;
  endLine: number;
  col: number;
} {
  if (!pos) return { line: 1, endLine: 1, col: 0 };
  const line = pos.getFirstLine();
  const endLine = pos.getLastLine();
  return {
    line: line > 0 ? line : 1,
    endLine: endLine > 0 ? endLine : line > 0 ? line : 1,
    col: pos.getFirstCol() >= 0 ? pos.getFirstCol() : 0,
  };
}

function modelModifiersToNodeExtras(model: ModelWithModifiers): Partial<Node> {
  const extra: Partial<Node> = {};
  if (model.isExport?.()) extra.isExported = true;
  if (model.isStatic?.()) extra.isStatic = true;
  if (model.isPublic?.()) extra.visibility = 'public';
  else if (model.isPrivate?.()) extra.visibility = 'private';
  else if (model.isProtected?.()) extra.visibility = 'protected';
  return extra;
}

function fieldNodeKind(field: ArkField, cls: ArkClass): NodeKind | null {
  switch (field.getCategory()) {
    case FIELD_CATEGORY.ENUM_MEMBER:
      return cls.getCategory() === CLASS_CATEGORY.ENUM ? 'enum_member' : null;
    case FIELD_CATEGORY.PROPERTY_SIGNATURE:
    case FIELD_CATEGORY.GET_ACCESSOR:
      return 'property';
    case FIELD_CATEGORY.INDEX_SIGNATURE:
    case FIELD_CATEGORY.SPREAD_ASSIGNMENT:
      return 'property';
    case FIELD_CATEGORY.PROPERTY_DECLARATION:
    case FIELD_CATEGORY.PROPERTY_ASSIGNMENT:
    case FIELD_CATEGORY.SHORT_HAND_PROPERTY_ASSIGNMENT:
    case FIELD_CATEGORY.PARAMETER_PROPERTY:
      if (cls.isDefaultArkClass()) {
        return field.containsModifier?.(MODIFIER_CONST) ? 'constant' : 'variable';
      }
      return 'property';
    default:
      return 'field';
  }
}

function makeNode(
  relativePath: string,
  language: Language,
  kind: NodeKind,
  name: string,
  qualifiedName: string,
  line: number,
  endLine: number,
  column: number,
  extra?: Partial<Node>
): Node {
  const safeLine = line > 0 ? line : 1;
  return {
    id: generateNodeId(relativePath, kind, qualifiedName, safeLine),
    kind,
    name,
    qualifiedName,
    filePath: relativePath,
    language,
    startLine: safeLine,
    endLine: endLine > 0 ? endLine : safeLine,
    startColumn: column >= 0 ? column : 0,
    endColumn: column >= 0 ? column : 0,
    updatedAt: Date.now(),
    ...extra,
  };
}

function makeFileNode(relativePath: string, language: Language, lineCount: number): Node {
  return {
    id: `file:${relativePath}`,
    kind: 'file',
    name: path.basename(relativePath),
    qualifiedName: relativePath,
    filePath: relativePath,
    language,
    startLine: 1,
    endLine: Math.max(lineCount, 1),
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    updatedAt: Date.now(),
  };
}

function arkEdge(
  source: string,
  target: string,
  kind: Edge['kind'],
  extra?: Partial<Edge>
): Edge {
  return {
    source,
    target,
    kind,
    provenance: ARK_PROVENANCE,
    metadata: { synthesizedBy: 'arkanalyzer', ...(extra?.metadata ?? {}) },
    ...extra,
  };
}

interface RtaEntryResolution {
  entryPoints: MethodSignature[];
  dummyMain: ArkMethod | null;
}

function collectComponentScopeFromFiles(files: Iterable<ArkFile>): ArkClass[] {
  const scope: ArkClass[] = [];
  for (const file of files) {
    for (const cls of file.getClasses()) {
      if (cls.isDefaultArkClass()) continue;
      if (cls.hasComponentDecorator()) {
        scope.push(cls);
      }
    }
  }
  return scope;
}

function collectNonUiRtaEntryPointsFromFiles(files: Iterable<ArkFile>): MethodSignature[] {
  const entries: MethodSignature[] = [];
  for (const file of files) {
    const defaultClass = file.getDefaultClass();
    for (const method of defaultClass.getMethods()) {
      if (shouldSkipArkMethod(method)) continue;
      const name = resolveMethodDisplayName(method);
      if (name === 'main') {
        entries.push(method.getSignature());
      }
    }
  }
  return entries;
}

/**
 * Methods another module can call into: module `export` surface as RTA entries.
 * - exported function/method → itself
 * - exported class/struct → all of its non-skip methods (with body)
 * Skips `export … from` re-exports (not this module's IR).
 */
export function collectExportedRtaEntryPointsFromFiles(
  files: Iterable<ArkFile>
): MethodSignature[] {
  const seen = new Set<string>();
  const out: MethodSignature[] = [];

  const addMethod = (method: ArkMethod): void => {
    if (shouldSkipArkMethod(method)) return;
    try {
      if (!method.getCfg()) return;
    } catch {
      return;
    }
    try {
      const sig = method.getSignature();
      const key = sig.toString();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(sig);
    } catch {
      // signature unavailable
    }
  };

  const addClass = (cls: ArkClass): void => {
    try {
      for (const method of cls.getMethods(true)) {
        addMethod(method);
      }
    } catch {
      // class IR unavailable
    }
  };

  const visitExportInfos = (infos: Iterable<{ getFrom?: () => string | undefined; getArkExport?: () => unknown }>): void => {
    for (const info of infos) {
      try {
        if (info.getFrom?.()) continue;
      } catch {
        continue;
      }
      let arkExport: unknown;
      try {
        arkExport = info.getArkExport?.() ?? null;
      } catch {
        continue;
      }
      if (!arkExport || typeof arkExport !== 'object') continue;

      const exp = arkExport as {
        getExportType?: () => number;
        getMethods?: (all?: boolean) => ArkMethod[];
        getClasses?: () => ArkClass[];
        getExportInfos?: () => unknown[];
        getDeclaringArkClass?: () => ArkClass;
        getSignature?: () => MethodSignature;
        getCfg?: () => unknown;
      };

      // Prefer ExportType when present (METHOD=2, CLASS=1, NAME_SPACE=0).
      let exportType: number | undefined;
      try {
        exportType = exp.getExportType?.();
      } catch {
        exportType = undefined;
      }

      if (exportType === 2 || (exportType === undefined && typeof exp.getDeclaringArkClass === 'function' && typeof exp.getCfg === 'function')) {
        addMethod(arkExport as ArkMethod);
        continue;
      }
      if (exportType === 1 || (exportType === undefined && typeof exp.getMethods === 'function')) {
        addClass(arkExport as ArkClass);
        continue;
      }
      if (exportType === 0 || typeof exp.getClasses === 'function') {
        try {
          for (const cls of exp.getClasses?.() ?? []) {
            addClass(cls);
          }
        } catch {
          // ignore
        }
        const nested = exp.getExportInfos?.();
        if (nested) visitExportInfos(nested as Iterable<{ getFrom?: () => string | undefined; getArkExport?: () => unknown }>);
      }
    }
  };

  for (const file of files) {
    try {
      visitExportInfos(file.getExportInfos());
    } catch {
      // ignore
    }
    try {
      for (const ns of file.getNamespaces()) {
        try {
          visitExportInfos(ns.getExportInfos());
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  return out;
}

/** Merge RTA entry signatures, preserving order and dropping duplicates. */
function mergeRtaEntryPoints(...groups: MethodSignature[][]): MethodSignature[] {
  const seen = new Set<string>();
  const out: MethodSignature[] = [];
  for (const group of groups) {
    for (const sig of group) {
      try {
        const key = sig.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(sig);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function resolveRtaEntryPoints(scene: Scene): RtaEntryResolution {
  return resolveRtaEntryPointsFromFiles(scene, scene.getFiles());
}

/** RTA entries scoped to the given files (one Harmony module while it is loaded). */
function resolveRtaEntryPointsFromFiles(scene: Scene, files: ArkFile[]): RtaEntryResolution {
  const explicit = scene.getEntryPoints();
  if (explicit.length > 0) {
    return { entryPoints: explicit, dummyMain: null };
  }

  if (filesHaveArkUiEntries(files)) {
    try {
      const componentScope = collectComponentScopeFromFiles(files);
      const dummy = new DummyMainCreater(
        scene,
        undefined,
        componentScope.length > 0 ? componentScope : undefined,
        true,
      );
      dummy.createDummyMain();
      const dummyMain = dummy.getDummyMain();
      return { entryPoints: [dummyMain.getSignature()], dummyMain };
    } catch {
      // fall through
    }
  }

  const fallback = collectNonUiRtaEntryPointsFromFiles(files);
  return { entryPoints: fallback, dummyMain: null };
}

function filesHaveArkUiEntries(files: Iterable<ArkFile>): boolean {
  for (const file of files) {
    for (const cls of file.getClasses()) {
      if (cls.isDefaultArkClass()) continue;
      if (cls.hasComponentDecorator()) return true;
      const names = new Set(cls.getMethods(true).map((m) => m.getName()));
      if (names.has('onWindowStageCreate') || (names.has('onCreate') && names.has('onDestroy'))) {
        return true;
      }
    }
  }
  return false;
}

// =============================================================================
// ArkUI ViewTree — component tree, @Prop/@Link transfer, event bindings
// =============================================================================

const VIEWTREE_CALLBACK_ATTRS = new Set<string>(CALLBACK_METHOD_NAME);

/** State decorator kinds on a field (@State, @Prop, @Link, …) from arkanalyzer. */
export function stateDecoratorKinds(field: ArkField): string[] {
  const decs = field.getStateDecorators?.();
  if (!decs) return [];
  return [...decs].map((d) => d.getKind()).filter(Boolean);
}

/** All field decorators with optional string args (Provide('theme') → theme). */
export function fieldDecoratorEntries(
  field: ArkField
): Array<{ kind: string; arg?: string }> {
  const out: Array<{ kind: string; arg?: string }> = [];
  const seen = new Set<string>();
  const push = (kind: string, arg?: string | null) => {
    if (!kind || seen.has(kind)) return;
    seen.add(kind);
    out.push(arg ? { kind, arg } : { kind });
  };
  try {
    for (const d of field.getDecorators?.() ?? []) {
      push(d.getKind(), parseDecoratorArgFromContent(d.getContent?.() ?? ''));
    }
  } catch {
    /* ignore */
  }
  if (out.length === 0) {
    for (const kind of stateDecoratorKinds(field)) push(kind);
  }
  return out;
}

/** Encoded decorators list for node.decorators (bare kinds + Kind@arg). */
export function fieldDecoratorsEncoded(field: ArkField): string[] {
  return encodeDecoratorEntries(fieldDecoratorEntries(field));
}

function modelDecoratorEntries(
  model: ModelWithModifiers
): Array<{ kind: string; arg?: string }> {
  const out: Array<{ kind: string; arg?: string }> = [];
  const seen = new Set<string>();
  try {
    for (const d of model.getDecorators?.() ?? []) {
      const kind = d.getKind();
      if (!kind || seen.has(kind)) continue;
      seen.add(kind);
      const arg = parseDecoratorArgFromContent(d.getContent?.() ?? '');
      out.push(arg ? { kind, arg } : { kind });
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Child @Prop / @Link — edge `via` uses the decorator name as-is. */
export function stateTransferViaForField(field: ArkField): 'Prop' | 'Link' | null {
  for (const kind of stateDecoratorKinds(field)) {
    if (kind === 'Prop' || kind === 'Link') return kind;
  }
  return null;
}

interface ViewTreeIndexerContext {
  scene: Scene;
  methodToId: Map<ArkMethod, string>;
  classToId: Map<ArkClass, string>;
  fieldToId: Map<ArkField, string>;
  addEdge(
    result: ExtractionResult,
    source: string,
    target: string,
    kind: Edge['kind'],
    callerFile: string,
    via: string,
    line: number,
    extraMeta?: Record<string, unknown>
  ): void;
  ensureMethodNode(
    method: ArkMethod,
    relativePath: string,
    result: ExtractionResult,
    parentId: string
  ): string | null;
  resolveClassNodeId(cls: ArkClass): string | null;
  /**
   * Already-indexed class/component id by signature (works after module unload).
   * Unclear (`%unk`) signatures also fall back to class name / importer.
   */
  resolveClassIdBySig(sig: ClassSignature, importer?: ArkClass): string | null;
  /**
   * Already-indexed method id by signature (works after module unload).
   * Unclear declaring-class signatures fall back to `ClassName::methodName`.
   */
  resolveMethodIdBySig(sig: MethodSignature, importer?: ArkClass): string | null;
  /** Already-indexed field id (live map, then classSig::name). */
  resolveFieldNodeId(field: ArkField): string | null;
  markFieldStateDecorators?: (field: ArkField, fieldNodeId: string, result: ExtractionResult) => void;
}

function viewTreeLineFromStmt(stmt: Stmt | undefined): number {
  return stmt?.getOriginFullPosition()?.getFirstLine() ?? 1;
}

function isViewTreeClassSignature(sig: ClassSignature | MethodSignature): sig is ClassSignature {
  // Prefer instanceof; duck-type fallback if duplicate arkanalyzer copies break instanceof.
  if (sig instanceof ClassSignature) return true;
  if (sig instanceof MethodSignature) return false;
  const anySig = sig as {
    getClassName?: unknown;
    getMethodSubSignature?: unknown;
    getDeclaringFileSignature?: unknown;
  };
  // Require ClassSignature shape — MethodSignature-like and other sigs must not enter getClass().
  return (
    typeof anySig.getClassName === 'function' &&
    typeof anySig.getDeclaringFileSignature === 'function' &&
    typeof anySig.getMethodSubSignature !== 'function'
  );
}

/** Skip anonymous / synthetic Ark names for name→id fallback maps. */
function isUsableArkTypeName(name: string): boolean {
  return !!name && !name.startsWith('%') && !name.startsWith('<');
}

/** Escape a literal for use inside a RegExp source. */
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ArkUI framework IR receivers — `View.create` / `Column.pop` / `If.branch`
 * are synthesizer noise, not project call sites. Never seed name-match from them.
 */
const ARKUI_IR_CALL_RECEIVERS = new Set([
  'View',
  'If',
  'ForEach',
  'LazyForEach',
  'Repeat',
  'Column',
  'Row',
  'Stack',
  'Flex',
  'Grid',
  'List',
  'Swiper',
  'Tabs',
  'TabContent',
  'Button',
  'Text',
  'Image',
  'Scroll',
  'WaterFlow',
  'RelativeContainer',
  'Blank',
  'Divider',
  'Span',
  'Canvas',
  'XComponent',
]);

const ARKUI_IR_CALL_METHODS = new Set(['create', 'pop', 'branch', 'iterator']);

const ARKTS_STDLIB_CALL_RECEIVERS = new Set([
  'Array',
  'Map',
  'Set',
  'Object',
  'Promise',
  'JSON',
  'String',
  'Number',
  'Boolean',
  'Error',
  'Date',
  'Math',
  'RegExp',
  'Symbol',
]);

function isJunkArkCallSeed(className: string, methodName: string): boolean {
  if (ARKTS_STDLIB_CALL_RECEIVERS.has(className)) return true;
  if (ARKUI_IR_CALL_RECEIVERS.has(className) && ARKUI_IR_CALL_METHODS.has(methodName)) {
    return true;
  }
  return false;
}

/**
 * CFG must not name-link these across modules: each is a unique `Class::method`
 * key that still fans out to tens of thousands of invoke sites (singletons,
 * loggers, constructors) — far denser than RTA reachability on unlimited indexes.
 */
const ARKTS_CFG_CROSS_MODULE_METHOD_BLOCKLIST = new Set([
  'getInstance',
  'constructor',
  'toString',
  'valueOf',
  'showInfo',
  'showError',
  'showWarn',
  'showDebug',
  'show',
  'create',
  'pop',
  'push',
  'splice',
  'isEmpty',
  'getContext',
  'copyFrom',
  // High fan-out helpers seen densifying same-module CFG on scene_board
  'getGridOccupyStatus',
  'isInStatusForGrid',
  'isInStatus',
  'getStatus',
  'isOccupied',
  'isFree',
  'markStatus',
  'markGridForCellAndSpan',
  'createRelativePath',
  'dealWantParams',
  'getPreviewContentWidth',
  'getIconArray',
  'getSizeX',
  'getSizeY',
]);

/**
 * When ArkAnalyzer leaves a cross-module static call as `%unk/.use()`, recover
 * `Lib.use` from the invoke's original source. Only PascalCase receivers — so
 * `obj.foo()` / `this.bar()` stay unresolved rather than bare-method magnets.
 *
 * Trust short snippets only. Allow `return` / simple `const|let|var x =` prefixes
 * (`const x = Lib.use(b)` is the common modular IR original-text shape).
 */
function recoverClassMethodFromStmt(stmt: Stmt | undefined, methodName: string): string | null {
  if (!stmt || !methodName) return null;
  let text: string | undefined;
  try {
    text = stmt.getOriginalText?.();
  } catch {
    text = undefined;
  }
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 160) return null;
  // Mock / matcher wrappers are not real call seeds.
  if (/^(?:when|mock|spyOn)\s*\(/i.test(trimmed)) return null;
  const re = new RegExp(
    `(?:^|(?:return\\s+)|(?:(?:const|let|var)\\s+[\\w$]+\\s*=\\s*))([A-Z][\\w$]*)\\.${escapeRegExpLiteral(methodName)}\\s*\\(`
  );
  const m = trimmed.match(re);
  return m?.[1] ? `${m[1]}.${methodName}` : null;
}

/**
 * Free-function call left as `%unk/.getOpaque()`: short text still contains
 * `getOpaque(` (not `Class.getOpaque`). Caller must import-gate + unique name.
 */
function recoverFreeFunctionFromStmt(stmt: Stmt | undefined, methodName: string): string | null {
  if (!stmt || !methodName) return null;
  if (!/^[a-z][\w$]*$/.test(methodName)) return null;
  let text: string | undefined;
  try {
    text = stmt.getOriginalText?.();
  } catch {
    text = undefined;
  }
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 160) return null;
  if (/^(?:when|mock|spyOn)\s*\(/i.test(trimmed)) return null;
  // Reject Class.method — that path belongs to recoverClassMethodFromStmt.
  if (new RegExp(`[A-Z][\\w$]*\\.${escapeRegExpLiteral(methodName)}\\s*\\(`).test(trimmed)) {
    return null;
  }
  const re = new RegExp(`(?:^|[^\\w.$])${escapeRegExpLiteral(methodName)}\\s*\\(`);
  return re.test(trimmed) ? methodName : null;
}

/**
 * Instance invoke whose MethodSignature is `%unk` may still carry a typed base:
 * ClassType (full sig) or UnclearReferenceType (type name string only — common
 * when deps are SIGNATURES-only).
 */
function recoverClassMethodFromInstanceType(invoke: unknown, methodName: string): string | null {
  if (!invoke || !methodName) return null;
  try {
    const base = (invoke as { getBase?: () => Local }).getBase?.();
    if (!base) return null;
    const type = base.getType?.();
    if (!type) return null;
    const fromClassSig =
      (type as { getClassSignature?: () => ClassSignature }).getClassSignature?.()?.getClassName?.() ??
      '';
    if (isUsableArkTypeName(fromClassSig) && !fromClassSig.includes('%')) {
      return `${fromClassSig}.${methodName}`;
    }
    // UnclearReferenceType: getName() === "Base" (no file path).
    const fromName =
      (type as { getName?: () => string }).getName?.() ??
      '';
    if (isUsableArkTypeName(fromName) && !fromName.includes('%') && /^[A-Z]/.test(fromName)) {
      return `${fromName}.${methodName}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Modular IR often models `Lib.use` as an instance invoke with base Local named
 * `Lib` and type unknown — recover from the PascalCase base name.
 */
function recoverClassMethodFromBaseName(invoke: unknown, methodName: string): string | null {
  if (!invoke || !methodName) return null;
  try {
    const base = (invoke as { getBase?: () => Local }).getBase?.();
    if (!base) return null;
    const baseName = base.getName?.() ?? '';
    if (!isUsableArkTypeName(baseName) || !/^[A-Z]/.test(baseName) || baseName.includes('%')) {
      return null;
    }
    return `${baseName}.${methodName}`;
  } catch {
    return null;
  }
}

export type CfgBridgeCallRef =
  | { name: string; kind: 'calls' | 'instantiates'; freeFunction?: false }
  | { name: string; kind: 'calls'; freeFunction: true };

/**
 * Cross-module `%unk` invoke → `Class.method`, free function name, or
 * `instantiates` class. Never emit a bare instance-method name alone.
 */
function callReferenceNameFromSig(
  sig: MethodSignature,
  opts?: { stmt?: Stmt; invoke?: unknown }
): CfgBridgeCallRef | null {
  try {
    const methodName = sig.getMethodSubSignature()?.getMethodName?.() ?? '';
    if (!methodName || methodName.startsWith('%') || methodName.startsWith('<')) return null;
    const className = sig.getDeclaringClassSignature()?.getClassName?.() ?? '';
    if (isUsableArkTypeName(className) && !className.includes('%')) {
      if (methodName === 'constructor') {
        return { name: className, kind: 'instantiates' };
      }
      if (isJunkArkCallSeed(className, methodName)) return null;
      return { name: `${className}.${methodName}`, kind: 'calls' };
    }
    if (methodName === 'constructor') return null;
    const recovered =
      recoverClassMethodFromStmt(opts?.stmt, methodName) ??
      recoverClassMethodFromInstanceType(opts?.invoke, methodName) ??
      recoverClassMethodFromBaseName(opts?.invoke, methodName);
    if (recovered) {
      const dot = recovered.indexOf('.');
      if (dot > 0 && isJunkArkCallSeed(recovered.slice(0, dot), recovered.slice(dot + 1))) {
        return null;
      }
      return { name: recovered, kind: 'calls' };
    }
    const free = recoverFreeFunctionFromStmt(opts?.stmt, methodName);
    if (free) return { name: free, kind: 'calls', freeFunction: true };
    return null;
  } catch {
    return null;
  }
}

/**
 * True when a ClassSignature still has ArkAnalyzer's placeholder file
 * (`%unk`) — common on ViewTree stubs after a dependency was evicted before
 * type inference could rewrite `new LiveCardListView` to a real file path.
 */
export function isUnclearArkClassSignature(sig: ClassSignature): boolean {
  try {
    const fileSig = sig.getDeclaringFileSignature();
    const fileName = fileSig.getFileName();
    const projectName = fileSig.getProjectName();
    if (fileName === '%unk' || projectName === '%unk') return true;
    if (fileName.includes('%unk') || projectName.includes('%unk')) return true;
    return sig.toString().includes('%unk');
  } catch {
    return true;
  }
}

export function isUnclearArkMethodSignature(sig: MethodSignature): boolean {
  try {
    return isUnclearArkClassSignature(sig.getDeclaringClassSignature());
  } catch {
    return true;
  }
}

/** Among candidate node ids, prefer a single `component` over same-name struct/class. */
export function pickPreferredClassNodeId(
  candidateIds: Iterable<string>,
  isComponent: (id: string) => boolean
): string | null {
  const ids = [...candidateIds];
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0] ?? null;
  const components = ids.filter((id) => isComponent(id));
  if (components.length === 1) return components[0] ?? null;
  return null;
}

/** Walk ViewTree with cycle protection (shared/cloned nodes can form graphs). */
function walkViewTree(node: ViewTreeNode, visit: (node: ViewTreeNode) => void, seen = new Set<ViewTreeNode>()): void {
  if (seen.has(node)) return;
  seen.add(node);
  visit(node);
  for (const child of node.children) {
    walkViewTree(child, visit, seen);
  }
}

function indexViewTreeForClass(
  ctx: ViewTreeIndexerContext,
  cls: ArkClass,
  result: ExtractionResult,
  relativePath: string
): void {
  if (!cls.hasViewTree()) return;
  const viewTree = cls.getViewTree();
  if (!viewTree) return;
  const root = viewTree.getRoot();
  if (!root) return;

  const classNodeId = ctx.resolveClassNodeId(cls);
  if (!classNodeId) return;

  const buildMethod = cls.getMethods(true).find((m) => m.getName() === 'build');
  if (!buildMethod) return;

  const buildId = ctx.ensureMethodNode(buildMethod, relativePath, result, classNodeId);
  if (!buildId) return;

  const seen = new Set<string>();
  const link = (
    source: string,
    target: string,
    kind: Edge['kind'],
    via: string,
    line: number,
    extraMeta?: Record<string, unknown>
  ) => {
    const key = `${source}>${target}>${kind}>${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    ctx.addEdge(result, source, target, kind, relativePath, via, line, extraMeta);
  };

  for (const [field] of viewTree.getStateValues()) {
    const fieldId = ctx.resolveFieldNodeId(field);
    if (fieldId) {
      ctx.markFieldStateDecorators?.(field, fieldId, result);
      const line =
        field.getOriginFullPosition?.()?.getFirstLine?.() ??
        buildMethod.getImplOriginFullPosition()?.getFirstLine() ??
        1;
      link(fieldId, buildId, 'references', 'state-binding', line);
    }
  }

  walkViewTree(root, (node) => {
    const sig = node.signature;
    if (sig) {
      try {
        if (isViewTreeClassSignature(sig)) {
          // Stub or live: prefer already-indexed sig→id (works after dep unload);
          // %unk stubs also fall back to class name / parent-file import.
          // Then fall back to live IR object maps when the class is still resident.
          // Guard getClass — a mis-typed signature must not abort the whole ViewTree walk.
          let childCls: ArkClass | null = null;
          try {
            childCls = ctx.scene.getClass(sig);
          } catch {
            childCls = null;
          }
          const childId =
            ctx.resolveClassIdBySig(sig, cls) ??
            (childCls ? ctx.resolveClassNodeId(childCls) : null);
          if (childId) {
            let line = buildMethod.getImplOriginFullPosition()?.getFirstLine() ?? 1;
            try {
              const firstAttr = node.attributes?.values()?.next()?.value;
              if (firstAttr) line = viewTreeLineFromStmt(firstAttr[0]);
            } catch {
              // keep build() line
            }
            link(buildId, childId, 'references', 'child-component', line);
          }
        } else {
          // MethodSignature: builder stub (sig only) or live ArkMethod.
          let builderMethod: ArkMethod | null = null;
          try {
            builderMethod = ctx.scene.getMethod(sig as MethodSignature);
          } catch {
            builderMethod = null;
          }
          const builderId =
            ctx.resolveMethodIdBySig(sig as MethodSignature, cls) ??
            (builderMethod
              ? ctx.ensureMethodNode(builderMethod, relativePath, result, classNodeId)
              : null);
          if (builderId) {
            const line = builderMethod
              ? builderMethod.getImplOriginFullPosition()?.getFirstLine() ?? 1
              : buildMethod.getImplOriginFullPosition()?.getFirstLine() ?? 1;
            link(buildId, builderId, 'references', 'builder', line);
          }
        }
      } catch {
        // Skip this node's signature edge; keep walking siblings/children.
      }
    }

    // Data passages for migrate snapshot (+ Prop/Link edges for explore).
    try {
      const passages = collectPassagesForViewTreeNode(node, ctx.scene, cls);
      for (const p of passages) {
        const toId = ctx.resolveFieldNodeId(p.toField);
        if (!toId) continue;
        ctx.markFieldStateDecorators?.(p.toField, toId, result);
        let fromId: string | null = null;
        if (p.fromField) {
          fromId = ctx.resolveFieldNodeId(p.fromField);
          if (fromId) ctx.markFieldStateDecorators?.(p.fromField, fromId, result);
        }
        if (!fromId && p.fromIsParentComponent) fromId = classNodeId;
        if (!fromId) continue;
        const line = p.toField.getOriginFullPosition()?.getFirstLine() ?? 1;
        link(fromId, toId, 'references', p.via || 'data-passage', line, {
          passageType: p.passageType,
          valueType: p.valueType,
          forcesMigration: p.forcesMigration,
          parentExpression: p.parentExpression,
        });
      }
    } catch {
      // Fall back to legacy Prop/Link-only transfer below.
      if (node.stateValuesTransfer) {
        for (const [childField, parentValue] of node.stateValuesTransfer) {
          const childFieldId = ctx.resolveFieldNodeId(childField);
          if (parentValue instanceof ArkField) {
            const via = stateTransferViaForField(childField);
            if (!via || !childFieldId) continue;
            ctx.markFieldStateDecorators?.(childField, childFieldId, result);
            const parentFieldId = ctx.resolveFieldNodeId(parentValue);
            if (parentFieldId) {
              ctx.markFieldStateDecorators?.(parentValue, parentFieldId, result);
              link(
                parentFieldId,
                childFieldId,
                'references',
                via,
                childField.getOriginFullPosition()?.getFirstLine() ?? 1
              );
            }
          } else if (parentValue instanceof ArkMethod) {
            let builderId = ctx.ensureMethodNode(parentValue, relativePath, result, classNodeId);
            if (!builderId) {
              try {
                builderId = ctx.resolveMethodIdBySig(parentValue.getSignature());
              } catch {
                builderId = null;
              }
            }
            if (childFieldId && builderId) {
              link(
                builderId,
                childFieldId,
                'references',
                'builder-param',
                childField.getOriginFullPosition()?.getFirstLine() ?? 1
              );
            }
          }
        }
      }
    }

    for (const [attr, [stmt, values]] of node.attributes) {
      if (!VIEWTREE_CALLBACK_ATTRS.has(attr)) continue;
      const line = viewTreeLineFromStmt(stmt);
      for (const v of values) {
        const isMethodSig =
          v instanceof MethodSignature ||
          (v != null &&
            typeof (v as { getMethodSubSignature?: unknown }).getMethodSubSignature === 'function');
        if (!isMethodSig) continue;
        const methodSig = v as MethodSignature;
        const handler = ctx.scene.getMethod(methodSig);
        const handlerId =
          ctx.resolveMethodIdBySig(methodSig, cls) ??
          (handler ? ctx.ensureMethodNode(handler, relativePath, result, classNodeId) : null);
        if (handlerId) link(buildId, handlerId, 'references', attr, line);
      }
    }
  });
}

class ArkTSAdapter {
  private readonly rootDir: string;
  private readonly pathNorm: ArkRelPathNormalizer;
  private readonly scanned: Set<string>;
  private scene: Scene | null = null;
  private readonly methodToId = new Map<ArkMethod, string>();
  private readonly classToId = new Map<ArkClass, string>();
  private readonly componentToId = new Map<ArkClass, string>();
  private readonly fieldToId = new Map<ArkField, string>();
  /** Stable across module unload — signature string → HomeGraph node id. */
  private readonly methodSigToId = new Map<string, string>();
  private readonly classSigToId = new Map<string, string>();
  private readonly fieldSigToId = new Map<string, string>();
  /**
   * Name → candidate node ids for ViewTree stub stitch when the signature is still
   * `@%unk/%unk: ClassName` after dependency eviction. Prefer `component` over
   * same-name struct/class; ambiguous multi-component names use the importer.
   */
  private readonly classNameToIds = new Map<string, Set<string>>();
  private readonly classIdFilePath = new Map<string, string>();
  private readonly classIdIsComponent = new Map<string, boolean>();
  /** `ClassName::methodName` → candidate method node ids (unclear MethodSignature stubs). */
  private readonly methodNameKeyToIds = new Map<string, Set<string>>();
  /** Bare default-class function name → ids (unique import-gated CFG bridge). */
  private readonly functionNameToIds = new Map<string, Set<string>>();
  private readonly methodIdFilePath = new Map<string, string>();
  private readonly emittedEdgeKeys = new Set<string>();
  private readonly nodeIds = new Set<string>();
  private readonly fileResults = new Map<string, ExtractionResult>();
  private readonly crossFileEdges: Edge[] = [];
  /** Per-module `@dummyMain@…` created during analyseByModule (for scene aggregator). */
  private readonly moduleDummyMains: ArkMethod[] = [];
  /**
   * Local import binding names from `lib*.so` per relative file path.
   * Filled before method bodies are scanned so `multimodalinput.getTidByName(`
   * can emit NAPI call refs (not only photos-style `Class_method` names).
   */
  private readonly soImportBindingsByFile = new Map<string, Set<string>>();

  constructor(rootDir: string, scannedFiles: Iterable<string>) {
    this.pathNorm = createArkRelPathNormalizer(rootDir);
    this.rootDir = this.pathNorm.rootDir;
    this.scanned = new Set(scannedFiles);
  }

  /** ArkAnalyzer absolute → project-relative (shared batch cache). */
  normalizeRelPath(absolutePath: string): string {
    return this.pathNorm.normalize(absolutePath);
  }

  private relPathForArkFile(arkFile: ArkFile): string {
    return resolveArkanalyzerVirtualPath(arkFile) ?? this.normalizeRelPath(arkFile.getFilePath());
  }

  build(scene: Scene): ArkTSBatchIndex {
    this.scene = scene;

    for (const arkFile of scene.getFiles()) {
      this.indexScannedFile(arkFile);
    }
    this.indexViewTreesFromFiles(scene.getFiles());
    this.finalizeCallGraph(scene);

    return this.toBatchIndex();
  }

  /**
   * Index one Harmony module while loaded (baseline = this module):
   * symbols → rebind resident deps → ViewTree/RTA from this module (B→A via
   * live IR or sig→id maps for already-indexed unloaded deps).
   */
  indexModule(module: ArkModule, scene: Scene): void {
    this.scene = scene;
    const files = [...module.getFilesMap().values()];
    const moduleFiles = new Set(
      files.map((f) => this.normalizeRelPath(f.getFilePath())).filter(Boolean)
    );
    for (const arkFile of files) {
      this.indexScannedFile(arkFile);
    }
    // Rebind still-resident deps so live getClass/getMethod works when topo kept them warm.
    this.bindLiveMapsFromResident(scene);
    // Incremental / first-in-topo: populate sig→id maps from other loaded modules
    // (deps at SIGNATURES) without persisting those files into this batch.
    this.seedMapsFromOtherLoadedFiles(scene, moduleFiles);
    this.indexViewTreesFromFiles(files);
    this.ingestModuleCallGraph(scene, module, files, moduleFiles);
    // CFG: only narrow `%unk` cross-module bridge (no same-module CFG calls).
    this.stitchModuleCfgCallsAndRefs(files, moduleFiles);
    // Drop live IR object keys so ArkAnalyzer can GC unloaded modules; keep sig→id maps.
    this.releaseLiveIrMaps();
    // Edges for this module are already in fileResults / crossFileEdges — drop
    // the string dedupe set so it does not grow across the whole project.
    this.emittedEdgeKeys.clear();
  }

  /**
   * Index symbols from already-loaded non-target modules into sig/name maps only.
   * Used so incremental BODIES targets can still resolve cross-module RTA/ViewTree
   * edges against deps that stay at SIGNATURES (and are not re-persisted).
   */
  private seedMapsFromOtherLoadedFiles(scene: Scene, excludeFiles: Set<string>): void {
    const seeded: string[] = [];
    for (const mod of scene.getModules()) {
      let filesMap: Map<string, ArkFile>;
      try {
        filesMap = mod.getFilesMap();
      } catch {
        continue;
      }
      for (const arkFile of filesMap.values()) {
        const rel = this.normalizeRelPath(arkFile.getFilePath());
        if (!rel || excludeFiles.has(rel) || this.fileResults.has(rel)) continue;
        if (!this.scanned.has(rel) || !isArkAnalyzerSourcePath(rel)) continue;
        this.indexScannedFile(arkFile);
        if (this.fileResults.has(rel)) seeded.push(rel);
      }
    }
    for (const rel of seeded) {
      this.fileResults.delete(rel);
    }
  }

  private bindLiveMapsFromResident(scene: Scene): void {
    const cache = scene.getModuleCache();
    if (!cache) return;
    const files: ArkFile[] = [];
    for (const id of cache.getLoadedModules()) {
      const mod = scene.getModule(id);
      if (!mod || mod.getModuleType() === ModuleType.SDK) continue;
      if (mod.getLoadState() < ModuleLoadState.SIGNATURES) continue;
      files.push(...mod.getFilesMap().values());
    }
    if (files.length > 0) this.bindLiveMapsFromFiles(files);
  }

  /** Re-attach live Ark* objects to already-indexed HomeGraph node ids (sig maps). */
  private bindLiveMapsFromFiles(files: Iterable<ArkFile>): void {
    for (const arkFile of files) {
      const relativePath = this.normalizeRelPath(arkFile.getFilePath());
      if (!this.scanned.has(relativePath) || !isArkAnalyzerSourcePath(relativePath)) continue;

      this.bindLiveClass(arkFile.getDefaultClass());
      for (const cls of arkFile.getClasses()) {
        this.bindLiveClass(cls);
      }
      for (const ns of arkFile.getNamespaces()) {
        this.bindLiveNamespace(ns);
      }
    }
  }

  private bindLiveNamespace(ns: ArkNamespace): void {
    this.bindLiveClass(ns.getDefaultClass());
    for (const cls of ns.getClasses()) {
      this.bindLiveClass(cls);
    }
    for (const child of ns.getNamespaces()) {
      this.bindLiveNamespace(child);
    }
  }

  private bindLiveClass(cls: ArkClass): void {
    try {
      const classSig = cls.getSignature().toString();
      const classId = this.classSigToId.get(classSig);
      if (classId) {
        this.classToId.set(cls, classId);
        if (cls.hasComponentDecorator()) {
          this.componentToId.set(cls, classId);
        }
      }
      for (const method of cls.getMethods(true)) {
        try {
          const mid = this.methodSigToId.get(method.getSignature().toString());
          if (mid) this.methodToId.set(method, mid);
        } catch {
          // skip
        }
      }
      for (const field of cls.getFields()) {
        const fid = this.fieldSigToId.get(fieldSigKey(classSig, field.getName()));
        if (fid) this.fieldToId.set(field, fid);
      }
    } catch {
      // signature unavailable
    }
  }

  finalizeCallGraph(scene: Scene): void {
    this.scene = scene;

    // Modular path: intra-module RTA already ran per module. Do NOT run a
    // scene aggregator RTA — that re-walks overlapping reachable sets and was
    // a major wall-clock cost. Cross-module gaps link only via exact
    // signature / unique Class.method maps (no unresolved name-match seeds).
    if (this.moduleDummyMains.length > 0) {
      try {
        for (const m of this.moduleDummyMains) {
          this.indexArkanalyzerDummyMain(m);
        }
      } catch {
        // ignore
      }
      return;
    }

    const { entryPoints, dummyMain } = resolveRtaEntryPoints(scene);

    if (dummyMain) {
      this.indexArkanalyzerDummyMain(dummyMain);
    }

    if (entryPoints.length === 0) return;
    let callGraph;
    try {
      callGraph = scene.makeCallGraphRTA(entryPoints);
    } catch {
      return;
    }
    this.ingestCallGraph(callGraph, null);
  }

  private ingestModuleCallGraph(
    scene: Scene,
    module: ArkModule,
    files: ArkFile[],
    moduleFiles: Set<string>
  ): void {
    let entryPoints: MethodSignature[] = [];
    let dummyMain: ArkMethod | null = null;

    try {
      // Prefer AA's forModule when present; otherwise DIY with the public ctor
      // (module-scoped name + this module's classes).
      const forModule = (
        DummyMainCreater as unknown as {
          forModule?: (s: Scene, m: ArkModule, extra?: boolean) => DummyMainCreater;
        }
      ).forModule;
      let creater: DummyMainCreater;
      if (typeof forModule === 'function') {
        creater = forModule(scene, module, true);
      } else {
        const classScope = collectComponentScopeFromFiles(files);
        const moduleName = module.getModuleName() || 'module';
        creater = new DummyMainCreater(
          scene,
          `@dummyMain@${moduleName}`,
          classScope.length > 0 ? classScope : undefined,
          true
        );
      }
      creater.createDummyMain();
      dummyMain = creater.getDummyMain();
      if (dummyMain) {
        entryPoints = [dummyMain.getSignature()];
        this.moduleDummyMains.push(dummyMain);
      }
    } catch {
      // Fall back to file-scoped DummyMain (components only) if creation fails.
      const resolved = resolveRtaEntryPointsFromFiles(scene, files);
      entryPoints = resolved.entryPoints;
      dummyMain = resolved.dummyMain;
    }

    if (dummyMain) {
      this.indexArkanalyzerDummyMain(dummyMain);
    }
    // Export surface = cross-module call-ins; seed them as RTA entries so
    // non-UI libraries (Manager.getInstance → …) grow intra-module edges
    // without waiting for a Component DummyMain to reach them.
    entryPoints = mergeRtaEntryPoints(
      entryPoints,
      collectExportedRtaEntryPointsFromFiles(files)
    );
    if (entryPoints.length === 0) return;
    let callGraph;
    try {
      callGraph = scene.makeCallGraphRTA(entryPoints);
    } catch {
      return;
    }
    this.ingestCallGraph(callGraph, moduleFiles);
  }

  /**
   * Keep ArkAnalyzer RTA edges whose **caller** is in the current module.
   *
   * - Same-module: live IR id, exact MethodSignature map, or unique Class.method
   *   name fallback (path-drift).
   * - Cross-module: **exact MethodSignature string or live callee only** — no
   *   Class.method name fallback (that + CFG densified scene_board to ~400k
   *   ark calls vs ~76k on an unlimited RTA index).
   */
  private ingestCallGraph(
    callGraph: NonNullable<ReturnType<Scene['makeCallGraphRTA']>>,
    moduleFiles: Set<string> | null
  ): void {
    for (const edge of callGraph.getCallEdges()) {
      const callerArk = callGraph.getArkMethodByFuncID(edge.getSrcID());
      const calleeArk = callGraph.getArkMethodByFuncID(edge.getDstID());
      const callerSig = callGraph.getMethodByFuncID(edge.getSrcID());
      const calleeSig = callGraph.getMethodByFuncID(edge.getDstID());

      if (
        callerArk &&
        shouldSkipArkMethod(callerArk) &&
        !isAnonymousArkMethod(callerArk) &&
        !callerArk.getDeclaringArkClass().isDefaultArkClass() &&
        !callerArk.isGenerated()
      ) {
        continue;
      }

      const callerFile =
        (callerArk ? this.relPathForArkFile(callerArk.getDeclaringArkFile()) : null) ??
        (callerSig ? this.relPathFromMethodSignature(callerSig) : null) ??
        '';

      if (moduleFiles && callerFile && !moduleFiles.has(callerFile)) {
        continue;
      }

      const calleeFile =
        (calleeArk ? this.relPathForArkFile(calleeArk.getDeclaringArkFile()) : null) ??
        (calleeSig ? this.relPathFromMethodSignature(calleeSig) : null);

      const callerId =
        (callerArk ? this.resolveMethodNodeId(callerArk) : null) ??
        (callerSig ? this.resolveMethodIdBySigExact(callerSig) : null);
      if (!callerId) continue;

      const sameModule =
        !!moduleFiles && !!calleeFile && moduleFiles.has(calleeFile);
      const dispatch = edge.hasDirectCall() ? 'direct' : 'indirect';

      // Full-scene path (no moduleFiles): keep prior resolveMethodIdBySig behavior.
      if (!moduleFiles) {
        const calleeId =
          (calleeArk ? this.resolveMethodNodeId(calleeArk) : null) ??
          (calleeSig ? this.resolveMethodIdBySig(calleeSig) : null);
        if (!calleeId) continue;
        this.emitArkCallEdge(callerId, calleeId, callerFile, dispatch, callerArk);
        continue;
      }

      if (!sameModule) {
        const calleeId =
          (calleeArk ? this.resolveMethodNodeId(calleeArk) : null) ??
          (calleeSig ? this.resolveMethodIdBySigExact(calleeSig) : null);
        if (calleeId) {
          this.emitArkCallEdge(callerId, calleeId, callerFile, dispatch, callerArk);
        }
        continue;
      }

      const calleeId =
        (calleeArk ? this.resolveMethodNodeId(calleeArk) : null) ??
        (calleeSig ? this.resolveMethodIdBySig(calleeSig) : null);
      if (!calleeId) continue;
      this.emitArkCallEdge(callerId, calleeId, callerFile, dispatch, callerArk);
    }
  }

  /**
   * CFG call stitch (modular): no same-module CFG call edges (those were the
   * ~150k `direct` flood past unlimited RTA). Only the narrow cross-module
   * `%unk` bridge for `return Lib.use(…)`-style static calls.
   */
  private stitchModuleCfgCallsAndRefs(files: ArkFile[], _moduleFiles: Set<string>): void {
    for (const arkFile of files) {
      const callerFile = this.normalizeRelPath(arkFile.getFilePath());
      const visitClass = (cls: ArkClass) => {
        for (const method of cls.getMethods(true)) {
          if (
            shouldSkipArkMethod(method) &&
            !isAnonymousArkMethod(method) &&
            !method.isGenerated()
          ) {
            continue;
          }
          const callerId =
            this.resolveMethodNodeId(method) ??
            (() => {
              try {
                return this.methodSigToId.get(method.getSignature().toString()) ?? null;
              } catch {
                return null;
              }
            })();
          if (!callerId) continue;
          let cfg;
          try {
            cfg = method.getCfg();
          } catch {
            continue;
          }
          if (!cfg) continue;
          for (const stmt of cfg.getStmts()) {
            let invoke;
            try {
              invoke = stmt.getInvokeExpr();
            } catch {
              continue;
            }
            if (!invoke) continue;
            let calleeSig: MethodSignature;
            try {
              calleeSig = invoke.getMethodSignature();
            } catch {
              continue;
            }
            if (!calleeSig) continue;

            // Skip clear same-module paths — RTA owns those. Only `%unk` /
            // missing-path invokes may take the narrow cross-module bridge.
            const calleeFile = this.relPathFromMethodSignature(calleeSig);
            if (calleeFile) continue;

            this.tryLinkCfgCrossModuleUnk(
              callerId,
              callerFile,
              calleeSig,
              method,
              stmt,
              invoke,
              arkFile
            );
          }
        }
      };

      visitClass(arkFile.getDefaultClass());
      for (const cls of arkFile.getClasses()) visitClass(cls);
      const walkNs = (ns: ArkNamespace) => {
        visitClass(ns.getDefaultClass());
        for (const cls of ns.getClasses()) visitClass(cls);
        for (const child of ns.getNamespaces()) walkNs(child);
      };
      for (const ns of arkFile.getNamespaces()) walkNs(ns);
    }
  }

  private emitArkCallEdge(
    callerId: string,
    calleeId: string,
    callerFile: string,
    dispatch: string,
    callerArk: ArkMethod | null
  ): void {
    const edgeKey = `${callerId}\0${calleeId}\0calls\0${dispatch}`;
    if (this.emittedEdgeKeys.has(edgeKey)) return;
    if (this.emittedEdgeKeys.has(`${callerId}\0${calleeId}\0calls\0direct`)) return;
    if (this.emittedEdgeKeys.has(`${callerId}\0${calleeId}\0calls\0indirect`)) return;
    this.emittedEdgeKeys.add(edgeKey);

    const callEdge = arkEdge(callerId, calleeId, 'calls', {
      metadata: {
        synthesizedBy: 'arkanalyzer',
        dispatch,
        sourceFile: callerFile || undefined,
        rtaEntry:
          callerArk?.isGenerated?.() && callerArk.getName() === '@dummyMain'
            ? '@dummyMain'
            : undefined,
      },
    });

    const callerResult = callerFile ? this.fileResults.get(callerFile) : undefined;
    if (callerResult && this.nodeInFile(calleeId, callerFile)) {
      callerResult.edges.push(callEdge);
    } else {
      this.crossFileEdges.push(callEdge);
    }
  }

  /**
   * CFG `%unk` bridge: recover Class.method / free function from invoke crumbs
   * (stmt text, UnclearReferenceType name, PascalCase base local), require
   * import + unique indexed target, skip fan-out blocklist. No unresolved refs.
   */
  private tryLinkCfgCrossModuleUnk(
    callerId: string,
    callerFile: string,
    calleeSig: MethodSignature,
    callerArk: ArkMethod | null,
    stmt: Stmt,
    invoke: unknown,
    arkFile: ArkFile
  ): void {
    // Only for unclear / %unk signatures — clear typed cross-module invokes
    // stay RTA-only so we do not densify past unlimited RTA.
    if (!isUnclearArkMethodSignature(calleeSig)) {
      try {
        const className = calleeSig.getDeclaringClassSignature()?.getClassName?.() ?? '';
        if (isUsableArkTypeName(className) && !className.includes('%')) return;
      } catch {
        // treat as unclear
      }
    }

    const parsed = callReferenceNameFromSig(calleeSig, { stmt, invoke });
    if (!parsed || parsed.kind !== 'calls') return;

    if (parsed.freeFunction) {
      const fnName = parsed.name;
      if (!fnName || ARKTS_CFG_CROSS_MODULE_METHOD_BLOCKLIST.has(fnName)) return;
      if (!this.fileImportsLocalName(arkFile, fnName)) return;
      const calleeId = this.resolveFunctionIdByName(fnName);
      if (!calleeId) return;
      this.emitArkCallEdge(callerId, calleeId, callerFile, 'direct', callerArk);
      return;
    }

    const dot = parsed.name.indexOf('.');
    if (dot <= 0) return;
    const className = parsed.name.slice(0, dot);
    const methodName = parsed.name.slice(dot + 1);
    if (!className || !methodName) return;
    if (ARKTS_CFG_CROSS_MODULE_METHOD_BLOCKLIST.has(methodName)) return;
    if (isJunkArkCallSeed(className, methodName)) return;
    if (!this.fileImportsLocalName(arkFile, className)) return;

    const calleeId = this.resolveMethodIdByName(className, methodName);
    if (!calleeId) return;
    this.emitArkCallEdge(callerId, calleeId, callerFile, 'direct', callerArk);
  }

  private fileImportsLocalName(arkFile: ArkFile, localName: string): boolean {
    try {
      return !!arkFile.getImportInfoBy(localName);
    } catch {
      return false;
    }
  }

  /** Exact MethodSignature.toString() → node id (no Class.method name fallback). */
  private resolveMethodIdBySigExact(sig: MethodSignature): string | null {
    try {
      return this.methodSigToId.get(sig.toString()) ?? null;
    } catch {
      return null;
    }
  }

  /** Project-relative path from a MethodSignature's declaring file (may be %unk). */
  private relPathFromMethodSignature(sig: MethodSignature): string | null {
    try {
      const fileName = sig.getDeclaringClassSignature().getDeclaringFileSignature().getFileName();
      if (!fileName || fileName === '%unk' || fileName.includes('%unk')) return null;
      return this.normalizeRelPath(fileName);
    } catch {
      return null;
    }
  }

  private releaseLiveIrMaps(): void {
    this.methodToId.clear();
    this.classToId.clear();
    this.componentToId.clear();
    this.fieldToId.clear();
  }

  toBatchIndex(errors: ExtractionError[] = []): ArkTSBatchIndex {
    return {
      fileResults: this.fileResults,
      crossFileEdges: this.crossFileEdges,
      nodeIds: this.nodeIds,
      errors: [...errors],
    };
  }

  /**
   * Remove and return ExtractionResults for the given paths so callers can
   * persist+GC mid-Scene (streaming modular build). Keeps sig→id maps / nodeIds.
   */
  takeFileResults(paths: Iterable<string>): Map<string, ExtractionResult> {
    const out = new Map<string, ExtractionResult>();
    for (const raw of paths) {
      const p = normIndexPath(raw);
      const result = this.fileResults.get(p);
      if (!result) continue;
      out.set(p, result);
      this.fileResults.delete(p);
    }
    return out;
  }

  /** Re-insert a previously taken file result (stream persist failure recovery). */
  putFileResult(filePath: string, result: ExtractionResult): void {
    this.fileResults.set(normIndexPath(filePath), result);
  }

  /** All paths currently held in fileResults (for final flush). */
  fileResultPaths(): string[] {
    return [...this.fileResults.keys()];
  }

  private indexScannedFile(arkFile: ArkFile): void {
    const relativePath = this.normalizeRelPath(arkFile.getFilePath());
    if (!this.scanned.has(relativePath)) return;
    if (!isArkAnalyzerSourcePath(relativePath)) return;
    this.indexFile(arkFile);
  }

  private indexViewTreesFromFiles(files: Iterable<ArkFile>): void {
    for (const arkFile of files) {
      const relativePath = this.normalizeRelPath(arkFile.getFilePath());
      if (!this.scanned.has(relativePath) || !isArkAnalyzerSourcePath(relativePath)) continue;
      const result = this.fileResults.get(relativePath);
      if (!result) continue;
      for (const cls of arkFile.getClasses()) {
        if (!cls.hasViewTree()) continue;
        try {
          indexViewTreeForClass(this.viewTreeContext(), cls, result, relativePath);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          result.errors.push({
            message: `ViewTree indexing skipped for ${cls.getName()}: ${message}`,
            filePath: relativePath,
            severity: 'warning',
          });
        }
      }
    }
    this.indexObservedClassRefs();
  }

  /**
   * State / Param fields whose type names an @Observed / @ObservedV2 class →
   * `references` via `observed-ref` (arkui-migrate).
   */
  private indexObservedClassRefs(): void {
    const observedByName = new Map<string, string[]>();
    for (const [, result] of this.fileResults) {
      for (const n of result.nodes) {
        if (n.kind !== 'class' && n.kind !== 'struct') continue;
        const decs = n.decorators ?? [];
        if (!decs.some((d) => OBSERVATION_DECORATORS.has(d.split('@')[0]!))) continue;
        const arr = observedByName.get(n.name) ?? [];
        arr.push(n.id);
        observedByName.set(n.name, arr);
      }
    }
    if (observedByName.size === 0) return;

    for (const [relativePath, result] of this.fileResults) {
      for (const field of result.nodes) {
        if (field.kind !== 'property' && field.kind !== 'field') continue;
        const typeStr = field.signature ?? '';
        const bare = typeStr.replace(/<.*>/, '').split(/[.\s|]/).filter(Boolean).pop();
        if (!bare) continue;
        const targets = observedByName.get(bare);
        if (!targets || targets.length === 0) continue;
        // Prefer unique name; if ambiguous, same-file first
        let targetId = targets[0]!;
        if (targets.length > 1) {
          const sameFile = targets.find((id) => {
            const n = result.nodes.find((x) => x.id === id);
            return n?.filePath === relativePath;
          });
          if (sameFile) targetId = sameFile;
          else continue; // ambiguous cross-file — skip (precision > recall)
        }
        const edgeKey = `${field.id}\0${targetId}\0observed-ref`;
        if (this.emittedEdgeKeys.has(edgeKey)) continue;
        this.emittedEdgeKeys.add(edgeKey);
        const edge = arkEdge(field.id, targetId, 'references', {
          metadata: {
            synthesizedBy: 'arkui-migrate',
            via: 'observed-ref',
            registeredAt: `${relativePath}:${field.startLine}`,
          },
        });
        if (this.nodeInFile(targetId, relativePath)) {
          result.edges.push(edge);
        } else {
          this.crossFileEdges.push(edge);
        }
      }
    }
  }

  /** Index ArkAnalyzer's in-scene @dummyMain (DummyMainCreater output), not a HomeGraph synthetic node. */
  private indexArkanalyzerDummyMain(dummyMain: ArkMethod): void {
    const result = this.ensureFileResult(ARKANALYZER_DUMMY_FILE, 1);
    const dummyClass = dummyMain.getDeclaringArkClass();
    const className = dummyClass.getName();
    const classNode = makeNode(
      ARKANALYZER_DUMMY_FILE,
      'arkts',
      'class',
      className,
      className,
      1,
      1,
      0,
      { signature: 'ArkAnalyzer RTA synthetic entry class' },
    );
    this.addNode(result, classNode);
    this.classToId.set(dummyClass, classNode.id);
    result.edges.push(arkEdge(`file:${ARKANALYZER_DUMMY_FILE}`, classNode.id, 'contains'));
    this.indexMethod(ARKANALYZER_DUMMY_FILE, 'arkts', result, dummyMain, classNode.id, 'function');
  }

  private nodeInFile(nodeId: string, relativePath: string): boolean {
    const result = this.fileResults.get(relativePath);
    return result?.nodes.some((n) => n.id === nodeId) ?? false;
  }

  private ensureFileResult(relativePath: string, lineCount: number): ExtractionResult {
    let result = this.fileResults.get(relativePath);
    if (!result) {
      result = {
        nodes: [makeFileNode(relativePath, 'arkts', lineCount)],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
      this.fileResults.set(relativePath, result);
      this.nodeIds.add(`file:${relativePath}`);
    }
    return result;
  }

  private addNode(result: ExtractionResult, node: Node): void {
    if (this.nodeIds.has(node.id)) return;
    result.nodes.push(node);
    this.nodeIds.add(node.id);
  }

  private indexFile(arkFile: ArkFile): void {
    const relativePath = this.normalizeRelPath(arkFile.getFilePath());
    const language: Language = 'arkts';
    let lineCount = 1;
    try {
      lineCount = arkFile.getCode()?.split('\n').length ?? 1;
    } catch {
      // use default
    }
    const result = this.ensureFileResult(relativePath, lineCount);
    const fileId = `file:${relativePath}`;

    // Before methods: record `lib*.so` bindings so body NAPI call scan can see them.
    this.collectSoImportBindings(relativePath, arkFile);

    for (const ns of arkFile.getNamespaces()) {
      this.indexNamespace(relativePath, language, result, ns, fileId);
    }

    this.indexClassesInNamespace(relativePath, language, result, arkFile.getClasses(), fileId);
    this.indexDefaultClass(relativePath, language, result, arkFile.getDefaultClass(), fileId);
    this.indexTypeAliases(relativePath, language, result, arkFile, undefined, fileId);
    this.indexModuleLocals(relativePath, language, result, arkFile, undefined, fileId);
    this.indexImports(relativePath, language, result, arkFile, fileId);
    this.indexStorageApiKeys(relativePath, arkFile, result);
  }

  /** AppStorage / LocalStorage / … literal keys → arkui-migrate edges from each component. */
  private indexStorageApiKeys(
    relativePath: string,
    arkFile: ArkFile,
    result: ExtractionResult
  ): void {
    let code = '';
    try {
      code = arkFile.getCode() ?? '';
    } catch {
      return;
    }
    if (!code) return;
    const hits = scanStorageApiKeys(code);
    if (hits.length === 0) return;

    const componentIds = result.nodes
      .filter((n) => n.kind === 'component' && n.filePath === relativePath)
      .map((n) => n.id);
    if (componentIds.length === 0) return;

    for (const hit of hits) {
      const line = lineOfOffset(code, hit.index);
      for (const compId of componentIds) {
        const edgeKey = `${compId}\0storage-api\0${hit.channel}\0${hit.key}`;
        if (this.emittedEdgeKeys.has(edgeKey)) continue;
        this.emittedEdgeKeys.add(edgeKey);
        result.edges.push(
          arkEdge(compId, compId, 'references', {
            metadata: {
              synthesizedBy: 'arkui-migrate',
              via: 'storage-api',
              channel: hit.channel,
              key: hit.key,
              method: hit.method,
              registeredAt: `${relativePath}:${line}`,
            },
          })
        );
      }
    }
  }

  private collectSoImportBindings(relativePath: string, arkFile: ArkFile): void {
    const set = new Set<string>();
    for (const importInfo of arkFile.getImportInfos()) {
      const modulePath = importInfo.getFrom();
      if (!modulePath || !LIB_SO_MODULE_RE.test(modulePath)) continue;
      const clause = importInfo.getImportClauseName();
      if (clause) set.add(clause);
    }
    if (set.size > 0) this.soImportBindingsByFile.set(relativePath, set);
  }

  private indexModuleLocals(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    arkFile: ArkFile,
    ns: ArkNamespace | undefined,
    parentId: string
  ): void {
    const declaringClass = ns ? ns.getDefaultClass() : arkFile.getDefaultClass();
    const body = declaringClass.getDefaultArkMethod()?.getBody();
    if (!body) return;

    for (const [name, local] of body.getLocals()) {
      this.indexLocal(relativePath, language, result, name, local, ns, parentId);
    }
  }

  private indexLocal(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    name: string,
    local: Local,
    ns: ArkNamespace | undefined,
    parentId: string
  ): void {
    if (shouldSkipLocalName(name)) return;

    const kind: NodeKind = local.getConstFlag() ? 'constant' : 'variable';
    const stmt = local.getDeclaringStmt();
    const { line, endLine, col } = linesFromPosition(stmt?.getOriginFullPosition());
    const qn = buildTypeAliasQualifiedName(name, ns);
    const localNode = makeNode(relativePath, language, kind, name, qn, line, endLine, col, {
      signature: local.getType()?.toString(),
      ...modelModifiersToNodeExtras(local),
    });
    this.addNode(result, localNode);
    result.edges.push(arkEdge(parentId, localNode.id, 'contains'));
  }

  private indexTypeAliases(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    arkFile: ArkFile,
    ns: ArkNamespace | undefined,
    parentId: string
  ): void {
    const declaringClass = ns ? ns.getDefaultClass() : arkFile.getDefaultClass();
    const body = declaringClass.getDefaultArkMethod()?.getBody();
    const aliasMap = body?.getAliasTypeMap();
    if (!aliasMap) return;

    for (const [name, entry] of aliasMap) {
      const aliasType: AliasType = entry[0];
      const stmt = entry[1];
      const { line, endLine, col } = linesFromPosition(stmt.getOriginFullPosition());
      const qn = buildTypeAliasQualifiedName(name, ns);
      const aliasNode = makeNode(relativePath, language, 'type_alias', name, qn, line, endLine, col, {
        signature: aliasType.getOriginalType()?.toString(),
        ...modelModifiersToNodeExtras(aliasType),
      });
      this.addNode(result, aliasNode);
      result.edges.push(arkEdge(parentId, aliasNode.id, 'contains'));
      this.indexDecorators(result, aliasNode.id, aliasType, relativePath, language, line);
    }
  }

  private indexDecorators(
    result: ExtractionResult,
    fromNodeId: string,
    model: ModelWithModifiers,
    relativePath: string,
    language: Language,
    line: number
  ): void {
    const decorators = model.getDecorators?.();
    if (!decorators) return;
    for (const dec of decorators) {
      const kind = dec.getKind();
      if (!kind) continue;
      result.unresolvedReferences.push({
        fromNodeId,
        referenceName: kind,
        referenceKind: 'decorates',
        line,
        column: 0,
        filePath: relativePath,
        language,
      });
    }
  }

  private indexNamespace(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    ns: ArkNamespace,
    parentId: string
  ): void {
    const qn = buildNamespaceQualifiedName(ns);
    const positions = ns.getOriginFullPositions();
    const { line, endLine, col } = linesFromPosition(positions[0]);
    const nsNode = makeNode(relativePath, language, 'namespace', ns.getName(), qn, line, endLine, col, {
      ...modelModifiersToNodeExtras(ns),
    });
    this.addNode(result, nsNode);
    result.edges.push(arkEdge(parentId, nsNode.id, 'contains'));
    this.indexDecorators(result, nsNode.id, ns, relativePath, language, line);

    this.indexClassesInNamespace(relativePath, language, result, ns.getClasses(), nsNode.id);
    this.indexDefaultClass(relativePath, language, result, ns.getDefaultClass(), nsNode.id);
    this.indexTypeAliases(relativePath, language, result, ns.getDeclaringArkFile(), ns, nsNode.id);
    this.indexModuleLocals(relativePath, language, result, ns.getDeclaringArkFile(), ns, nsNode.id);

    for (const childNs of ns.getNamespaces()) {
      this.indexNamespace(relativePath, language, result, childNs, nsNode.id);
    }
  }

  private indexClassesInNamespace(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    classes: Iterable<ArkClass>,
    parentId: string
  ): void {
    for (const cls of classes) {
      this.indexClass(relativePath, language, result, cls, parentId);
    }
  }

  private indexClass(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    cls: ArkClass,
    parentId: string
  ): void {
    if (cls.isDefaultArkClass()) return;

    const displayName = classDisplayName(cls);
    const qn = buildClassQualifiedName(cls);
    const kind = classNodeKind(cls);
    const { line, endLine, col } = linesFromPosition(cls.getOriginFullPosition());
    const classDecs = encodeDecoratorEntries(modelDecoratorEntries(cls));
    const classNode = makeNode(relativePath, language, kind, displayName, qn, line, endLine, col, {
      ...modelModifiersToNodeExtras(cls),
      ...(classDecs.length > 0 ? { decorators: classDecs } : {}),
    });
    this.addNode(result, classNode);
    this.classToId.set(cls, classNode.id);
    try {
      this.classSigToId.set(cls.getSignature().toString(), classNode.id);
    } catch {
      // signature unavailable
    }
    this.rememberClassName(displayName, classNode.id, relativePath, false);
    result.edges.push(arkEdge(parentId, classNode.id, 'contains'));
    this.indexDecorators(result, classNode.id, cls, relativePath, language, line);

    if (cls.isAnonymousClass()) {
      const superName = cls.getSuperClassName();
      if (superName) {
        result.unresolvedReferences.push({
          fromNodeId: classNode.id,
          referenceName: superName.includes('.') ? superName.split('.').pop()! : superName,
          referenceKind: 'extends',
          line,
          column: col,
          filePath: relativePath,
          language,
        });
      }
    }

    if (cls.hasComponentDecorator()) {
      const componentNode = makeNode(
        relativePath,
        language,
        'component',
        displayName,
        qn,
        line,
        endLine,
        col,
        {
          ...modelModifiersToNodeExtras(cls),
          ...(classDecs.length > 0 ? { decorators: classDecs } : {}),
        }
      );
      this.addNode(result, componentNode);
      this.componentToId.set(cls, componentNode.id);
      try {
        this.classSigToId.set(cls.getSignature().toString(), componentNode.id);
      } catch {
        // signature unavailable
      }
      this.rememberClassName(displayName, componentNode.id, relativePath, true);
      result.edges.push(arkEdge(classNode.id, componentNode.id, 'contains'));
    }

    const superName = cls.getSuperClassName();
    if (superName) {
      const superCls = cls.getHeritageClass(superName);
      if (superCls && !superCls.isDefaultArkClass()) {
        const superId = this.classToId.get(superCls);
        if (superId) {
          const edgeKind =
            superCls.getCategory() === CLASS_CATEGORY.INTERFACE ? 'implements' : 'extends';
          result.edges.push(arkEdge(classNode.id, superId, edgeKind));
        }
      }
    }

    for (const ifaceName of cls.getImplementedInterfaceNames()) {
      const iface = cls.getImplementedInterface(ifaceName);
      if (iface && this.classToId.has(iface)) {
        result.edges.push(arkEdge(classNode.id, this.classToId.get(iface)!, 'implements'));
      }
    }

    for (const method of cls.getMethods(true)) {
      if (shouldSkipArkMethod(method)) continue;
      this.indexMethod(relativePath, language, result, method, classNode.id);
    }

    for (const field of cls.getFields()) {
      this.indexField(relativePath, language, result, field, classNode.id, cls);
    }

    this.indexClassScopedTypeAliases(relativePath, language, result, cls, classNode.id);
  }

  private indexClassScopedTypeAliases(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    cls: ArkClass,
    parentId: string
  ): void {
    const candidates = [cls.getDefaultArkMethod(), cls.getInstanceInitMethod(), cls.getStaticInitMethod()];
    for (const method of candidates) {
      if (!method) continue;
      const aliasMap = method.getBody()?.getAliasTypeMap();
      if (!aliasMap) continue;
      for (const [name, entry] of aliasMap) {
        const aliasType: AliasType = entry[0];
        const stmt = entry[1];
        const { line, endLine, col } = linesFromPosition(stmt.getOriginFullPosition());
        const qn = buildQualifiedName([buildClassQualifiedName(cls), name]);
        const aliasNode = makeNode(relativePath, language, 'type_alias', name, qn, line, endLine, col, {
          signature: aliasType.getOriginalType()?.toString(),
          ...modelModifiersToNodeExtras(aliasType),
        });
        this.addNode(result, aliasNode);
        result.edges.push(arkEdge(parentId, aliasNode.id, 'contains'));
        this.indexDecorators(result, aliasNode.id, aliasType, relativePath, language, line);
      }
    }
  }

  private indexDefaultClass(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    cls: ArkClass,
    fileId: string
  ): void {
    for (const method of cls.getMethods(true)) {
      if (shouldSkipArkMethod(method)) continue;
      const kind: NodeKind = cls.isDefaultArkClass() ? 'function' : 'method';
      const parentId = cls.isDefaultArkClass()
        ? fileId
        : (this.classToId.get(cls) ?? fileId);
      this.indexMethod(relativePath, language, result, method, parentId, kind);
    }

    for (const field of cls.getFields()) {
      const parentId = cls.isDefaultArkClass() ? fileId : (this.classToId.get(cls) ?? fileId);
      this.indexField(relativePath, language, result, field, parentId, cls);
    }
  }

  private indexField(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    field: ArkField,
    parentId: string,
    cls: ArkClass
  ): void {
    const name = field.getName();
    if (!name || shouldSkipLocalName(name)) return;

    const kind = fieldNodeKind(field, cls);
    if (!kind) return;

    const { line, endLine, col } = linesFromPosition(field.getOriginFullPosition());
    const qn = buildFieldQualifiedName(field);
    const encodedDecs = fieldDecoratorsEncoded(field);
    const fieldNode = makeNode(relativePath, language, kind, name, qn, line, endLine, col, {
      signature: field.getType()?.toString(),
      ...(encodedDecs.length > 0 ? { decorators: encodedDecs } : {}),
      ...modelModifiersToNodeExtras(field),
    });
    this.addNode(result, fieldNode);
    this.fieldToId.set(field, fieldNode.id);
    try {
      this.fieldSigToId.set(fieldSigKey(cls.getSignature().toString(), name), fieldNode.id);
    } catch {
      // signature unavailable
    }
    result.edges.push(arkEdge(parentId, fieldNode.id, 'contains'));
    this.indexDecorators(result, fieldNode.id, field, relativePath, language, line);
  }

  private viewTreeContext() {
    if (!this.scene) {
      throw new Error('ArkTSAdapter scene not initialized');
    }
    return {
      rootDir: this.rootDir,
      scene: this.scene,
      language: 'arkts' as Language,
      methodToId: this.methodToId,
      classToId: this.classToId,
      fieldToId: this.fieldToId,
      nodeIds: this.nodeIds,
      addEdge: (
        result: ExtractionResult,
        source: string,
        target: string,
        kind: Edge['kind'],
        callerFile: string,
        via: string,
        line: number,
        extraMeta?: Record<string, unknown>
      ) => this.addViewTreeEdge(result, source, target, kind, callerFile, via, line, extraMeta),
      ensureMethodNode: (
        method: ArkMethod,
        relativePath: string,
        result: ExtractionResult,
        parentId: string
      ) => this.ensureMethodNode(method, relativePath, result, parentId),
      resolveClassNodeId: (cls: ArkClass) => this.resolveClassNodeId(cls),
      resolveClassIdBySig: (sig: ClassSignature, importer?: ArkClass) =>
        this.resolveClassIdBySig(sig, importer),
      resolveMethodIdBySig: (sig: MethodSignature, importer?: ArkClass) =>
        this.resolveMethodIdBySig(sig, importer),
      resolveFieldNodeId: (field: ArkField) => this.resolveFieldNodeId(field),
      markFieldStateDecorators: (field: ArkField, fieldNodeId: string, result: ExtractionResult) => {
        const encoded = fieldDecoratorsEncoded(field);
        if (encoded.length === 0) return;
        const node = result.nodes.find((n) => n.id === fieldNodeId);
        if (node) node.decorators = encoded;
      },
    };
  }

  private resolveClassNodeId(cls: ArkClass): string | null {
    const live = this.componentToId.get(cls) ?? this.classToId.get(cls);
    if (live) return live;
    try {
      return this.classSigToId.get(cls.getSignature().toString()) ?? null;
    } catch {
      return null;
    }
  }

  private rememberClassName(
    name: string,
    nodeId: string,
    filePath: string,
    isComponent: boolean
  ): void {
    if (!isUsableArkTypeName(name)) return;
    let set = this.classNameToIds.get(name);
    if (!set) {
      set = new Set();
      this.classNameToIds.set(name, set);
    }
    set.add(nodeId);
    this.classIdFilePath.set(nodeId, filePath);
    if (isComponent) this.classIdIsComponent.set(nodeId, true);
  }

  private rememberMethodName(
    className: string,
    methodName: string,
    nodeId: string,
    filePath: string
  ): void {
    const key = `${className}::${methodName}`;
    let set = this.methodNameKeyToIds.get(key);
    if (!set) {
      set = new Set();
      this.methodNameKeyToIds.set(key, set);
    }
    set.add(nodeId);
    this.methodIdFilePath.set(nodeId, filePath);
  }

  private rememberFunctionName(functionName: string, nodeId: string, filePath: string): void {
    if (!isUsableArkTypeName(functionName) || !/^[a-z]/.test(functionName)) return;
    let set = this.functionNameToIds.get(functionName);
    if (!set) {
      set = new Set();
      this.functionNameToIds.set(functionName, set);
    }
    set.add(nodeId);
    this.methodIdFilePath.set(nodeId, filePath);
  }

  private resolveFunctionIdByName(functionName: string): string | null {
    const ids = this.functionNameToIds.get(functionName);
    if (!ids || ids.size !== 1) return null;
    return [...ids][0] ?? null;
  }

  private resolveClassIdByName(className: string, importer?: ArkClass): string | null {
    const ids = this.classNameToIds.get(className);
    if (!ids || ids.size === 0) return null;

    let candidates = [...ids];
    // Same-file components (ForEach item builders, local @Component) have no import —
    // prefer ids from the importer's file before treating the name as ambiguous.
    if (importer) {
      try {
        const importerPath = this.normalizeRelPath(importer.getDeclaringArkFile().getFilePath());
        const sameFile = candidates.filter((id) => this.classIdFilePath.get(id) === importerPath);
        if (sameFile.length > 0) candidates = sameFile;
      } catch {
        // keep full candidate set
      }
    }

    const preferred = pickPreferredClassNodeId(candidates, (id) => !!this.classIdIsComponent.get(id));
    if (preferred) return preferred;

    if (!importer) return null;
    try {
      const importInfo = importer.getDeclaringArkFile().getImportInfoBy(className);
      if (!importInfo) return null;

      const exportInfo = importInfo.getLazyExportInfo?.() ?? null;
      const arkExport = exportInfo?.getArkExport?.() ?? null;
      if (arkExport instanceof ArkClass) {
        const byLive = this.resolveClassNodeId(arkExport);
        if (byLive) return byLive;
      }

      const from = importInfo.getFrom?.();
      if (!from) return null;
      const fromBase = path.basename(from).replace(/\.(ets|ts|d\.ts)$/i, '');
      const byPath = [...ids].filter((id) => {
        const fp = this.classIdFilePath.get(id);
        if (!fp) return false;
        const norm = fp.replace(/\\/g, '/');
        const fromNorm = from.replace(/\\/g, '/');
        return (
          norm.includes(fromNorm) ||
          fromNorm.includes(norm) ||
          path.basename(norm, path.extname(norm)) === fromBase ||
          path.basename(norm, path.extname(norm)) === className
        );
      });
      return pickPreferredClassNodeId(byPath, (id) => !!this.classIdIsComponent.get(id));
    } catch {
      return null;
    }
  }

  private resolveMethodIdByName(className: string, methodName: string): string | null {
    const key = `${className}::${methodName}`;
    const ids = this.methodNameKeyToIds.get(key);
    if (!ids || ids.size !== 1) return null;
    return [...ids][0] ?? null;
  }

  private resolveClassIdBySig(sig: ClassSignature, importer?: ArkClass): string | null {
    try {
      const exact = this.classSigToId.get(sig.toString());
      if (exact) return exact;
    } catch {
      // fall through to name fallback when possible
    }
    // Name fallback for %unk stubs AND clear-but-unmapped sig strings (path drift).
    // Same-file / import disambiguation happens inside resolveClassIdByName.
    try {
      const className = sig.getClassName();
      return className ? this.resolveClassIdByName(className, importer) : null;
    } catch {
      return null;
    }
  }

  private resolveMethodIdBySig(sig: MethodSignature, _importer?: ArkClass): string | null {
    try {
      const exact = this.methodSigToId.get(sig.toString());
      if (exact) return exact;
    } catch {
      // fall through
    }
    // Name fallback for %unk stubs AND path-drifted but clear signatures so
    // RTA edges to signature-only / unloaded callees still map to indexed nodes.
    try {
      const className = sig.getDeclaringClassSignature().getClassName();
      const methodName = sig.getMethodSubSignature().getMethodName();
      if (!className || !methodName) return null;
      return this.resolveMethodIdByName(className, methodName);
    } catch {
      return null;
    }
  }

  private resolveFieldNodeId(field: ArkField): string | null {
    const live = this.fieldToId.get(field);
    if (live) return live;
    try {
      const classSig = field.getDeclaringArkClass().getSignature().toString();
      return this.fieldSigToId.get(fieldSigKey(classSig, field.getName())) ?? null;
    } catch {
      return null;
    }
  }

  /** Parent node id for a method: owning class/component, or file for default-class methods. */
  private resolveMethodParentId(method: ArkMethod, relativePath: string, result: ExtractionResult): string {
    const cls = method.getDeclaringArkClass();
    if (cls.isDefaultArkClass()) {
      return `file:${relativePath}`;
    }
    const classId = this.resolveClassNodeId(cls);
    if (classId) return classId;
    const fileId = `file:${relativePath}`;
    this.indexClass(relativePath, 'arkts', result, cls, fileId);
    return this.resolveClassNodeId(cls) ?? fileId;
  }

  /**
   * Resolve a method to a graph node id, lazily indexing anonymous ArkMethods
   * that RTA / ViewTree reference but the main file walk skipped.
   */
  private resolveMethodNodeId(method: ArkMethod): string | null {
    const existing = this.methodToId.get(method);
    if (existing) return existing;
    try {
      const bySig = this.methodSigToId.get(method.getSignature().toString());
      if (bySig) {
        this.methodToId.set(method, bySig);
        return bySig;
      }
    } catch {
      // fall through
    }

    if (shouldSkipArkMethod(method) && !isAnonymousArkMethod(method)) return null;

    const displayName = arkMethodDisplayName(method);
    if (!displayName) return null;

    const arkFile = method.getDeclaringArkFile();
    const relativePath = this.normalizeRelPath(arkFile.getFilePath());
    if (!this.scanned.has(relativePath) || !isArkAnalyzerSourcePath(relativePath)) return null;

    let lineCount = 1;
    try {
      lineCount = arkFile.getCode()?.split('\n').length ?? 1;
    } catch {
      // use default
    }
    const result = this.fileResults.get(relativePath) ?? this.ensureFileResult(relativePath, lineCount);
    const parentId = this.resolveMethodParentId(method, relativePath, result);
    const cls = method.getDeclaringArkClass();
    const kind: NodeKind = cls.isDefaultArkClass() ? 'function' : 'method';
    this.indexMethod(relativePath, 'arkts', result, method, parentId, kind, displayName);
    return this.methodToId.get(method) ?? null;
  }

  private addViewTreeEdge(
    result: ExtractionResult,
    source: string,
    target: string,
    kind: Edge['kind'],
    callerFile: string,
    via: string,
    line: number,
    extraMeta?: Record<string, unknown>
  ): void {
    const edgeKey = `${source}\0${target}\0${kind}\0${via}`;
    if (this.emittedEdgeKeys.has(edgeKey)) return;
    this.emittedEdgeKeys.add(edgeKey);

    const edge = arkEdge(source, target, kind, {
      metadata: {
        synthesizedBy: 'viewtree',
        via,
        registeredAt: `${callerFile}:${line}`,
        ...(extraMeta ?? {}),
      },
    });
    if (this.nodeInFile(target, callerFile)) {
      result.edges.push(edge);
    } else {
      this.crossFileEdges.push(edge);
    }
  }

  private ensureMethodNode(
    method: ArkMethod,
    relativePath: string,
    result: ExtractionResult,
    parentId: string
  ): string | null {
    const existing = this.methodToId.get(method);
    if (existing) return existing;
    try {
      const bySig = this.methodSigToId.get(method.getSignature().toString());
      if (bySig) {
        this.methodToId.set(method, bySig);
        return bySig;
      }
    } catch {
      // fall through
    }

    if (shouldSkipArkMethod(method) && !isAnonymousArkMethod(method)) return null;

    const displayName = arkMethodDisplayName(method);
    if (!displayName) return null;

    const cls = method.getDeclaringArkClass();
    const kind: NodeKind = cls.isDefaultArkClass() ? 'function' : 'method';
    this.indexMethod(relativePath, 'arkts', result, method, parentId, kind, displayName);
    return this.methodToId.get(method) ?? null;
  }

  private indexMethod(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    method: ArkMethod,
    parentId: string,
    forcedKind?: NodeKind,
    forcedDisplayName?: string
  ): void {
    const displayName = forcedDisplayName ?? resolveMethodDisplayName(method);
    if (!displayName) return;

    const cls = method.getDeclaringArkClass();
    const kind: NodeKind =
      forcedKind ?? (cls.isDefaultArkClass() ? 'function' : 'method');
    const qn = buildMethodQualifiedName(method, displayName);
    const { line, endLine, col } = linesFromPosition(method.getImplOriginFullPosition());
    const { signature, returnType } = buildArkMethodSignatureFields(method);
    const methodNode = makeNode(relativePath, language, kind, displayName, qn, line, endLine, col, {
      ...(signature ? { signature } : {}),
      ...(returnType ? { returnType } : {}),
      ...modelModifiersToNodeExtras(method),
    });
    this.addNode(result, methodNode);
    this.methodToId.set(method, methodNode.id);
    try {
      this.methodSigToId.set(method.getSignature().toString(), methodNode.id);
    } catch {
      // signature unavailable
    }
    try {
      const ownerName = classDisplayName(cls);
      if (isUsableArkTypeName(ownerName) && isUsableArkTypeName(displayName)) {
        this.rememberMethodName(ownerName, displayName, methodNode.id, relativePath);
      } else if (cls.isDefaultArkClass() && kind === 'function') {
        this.rememberFunctionName(displayName, methodNode.id, relativePath);
      }
    } catch {
      // class name unavailable
    }
    result.edges.push(arkEdge(parentId, methodNode.id, 'contains'));
    this.indexDecorators(result, methodNode.id, method, relativePath, language, line);
    this.indexNativeNapiCalls(method, methodNode.id, relativePath, language, result);
  }

  private indexNativeNapiCalls(
    method: ArkMethod,
    fromNodeId: string,
    relativePath: string,
    language: Language,
    result: ExtractionResult
  ): void {
    const code = method.getCode();
    if (!code) return;

    const baseLine = method.getImplOriginFullPosition()?.getFirstLine() ?? 1;
    const seenAtLine = new Set<string>();
    const pushCall = (symbol: string, matchIndex: number): void => {
      if (!symbol) return;
      const lineOffset = code.slice(0, matchIndex).split('\n').length - 1;
      const line = baseLine + lineOffset;
      const dedupKey = `${symbol}:${line}`;
      if (seenAtLine.has(dedupKey)) return;
      seenAtLine.add(dedupKey);
      result.unresolvedReferences.push({
        fromNodeId,
        referenceName: symbol,
        referenceKind: 'calls',
        line,
        column: 0,
        filePath: relativePath,
        language,
      });
    };

    // Photos-style `Class_method` on any receiver.
    NAPI_MEMBER_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAPI_MEMBER_CALL_RE.exec(code)) !== null) {
      const symbol = m[1]!;
      if (!isNapiSymbolName(symbol)) continue;
      pushCall(symbol, m.index);
    }

    // `import x from 'libFoo.so'` → `x.draw(` / `x.getTidByName(` (camelCase OK).
    const soBindings = this.soImportBindingsByFile.get(relativePath);
    if (soBindings) {
      for (const binding of soBindings) {
        const re = new RegExp(
          `\\b${escapeRegExp(binding)}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`,
          'g'
        );
        while ((m = re.exec(code)) !== null) {
          pushCall(m[1]!, m.index);
        }
      }

      // define_class / instance path: `this.inst?.addVerticalRuler(` — receiver is
      // not the import binding. Only in files that already import a lib*.so.
      const anyMemberRe = /\?\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(|\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      while ((m = anyMemberRe.exec(code)) !== null) {
        const symbol = m[1] ?? m[2];
        if (!symbol) continue;
        // Skip photos-style names already handled above; keep camelCase / plain ids.
        pushCall(symbol, m.index);
      }
    }
  }

  private indexImports(
    relativePath: string,
    language: Language,
    result: ExtractionResult,
    arkFile: ArkFile,
    fileId: string
  ): void {
    for (const importInfo of arkFile.getImportInfos()) {
      const modulePath = importInfo.getFrom();
      const line = importInfo.getOriginFullPosition().getFirstLine();
      const clause = importInfo.getImportClauseName() || modulePath || 'import';
      const importNode = makeNode(
        relativePath,
        language,
        'import',
        clause,
        `${relativePath}::import::${clause}::${line}`,
        line,
        line,
        0,
        { signature: modulePath }
      );
      this.addNode(result, importNode);
      result.edges.push(arkEdge(fileId, importNode.id, 'contains'));

      const exportInfo = importInfo.getLazyExportInfo();
      if (exportInfo) {
        const targetFile = exportInfo.getDeclaringArkFile();
        if (targetFile) {
          const targetRel = this.normalizeRelPath(targetFile.getFilePath());
          const targetFileId = `file:${targetRel}`;
          if (this.nodeIds.has(targetFileId)) {
            result.edges.push(
              arkEdge(importNode.id, targetFileId, 'imports', {
                metadata: { synthesizedBy: 'arkanalyzer', module: modulePath },
              })
            );
          }
        }
      } else if (modulePath) {
        result.unresolvedReferences.push({
          fromNodeId: importNode.id,
          referenceName: modulePath,
          referenceKind: 'imports',
          line,
          column: 0,
          filePath: relativePath,
          language,
        });
      }
    }
  }
}

/** User-visible notices from the most recent ArkTS batch (surfaced in CLI / IndexResult). */
let arktsIndexNotices: ExtractionError[] = [];

/** Drain notices for merging into IndexResult.errors (clears the buffer). */
export function drainArkTSIndexNotices(): ExtractionError[] {
  const out = arktsIndexNotices;
  arktsIndexNotices = [];
  return out;
}

function buildSceneConfig(rootDir: string, extra?: { memoryLimitMB?: number }) {
  return buildSceneConfigFromProject(rootDir, process.env.OHOS_SDK_HOME, {
    supportFileExts: ['.ets', '.ts', '.d.ts'],
    enableMethodBodyBuild: true,
    ...(extra?.memoryLimitMB !== undefined ? { memoryLimitMB: extra.memoryLimitMB } : {}),
  });
}

function tryBuildArkScene(rootDir: string): { scene: Scene | null; errors: ExtractionError[] } {
  const errors: ExtractionError[] = [];
  const scene = new Scene();
  try {
    scene.buildSceneFromProjectDir(buildSceneConfig(rootDir));
    scene.inferTypes();
    return { scene, errors };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ message: `ArkTS Scene build failed: ${message}`, severity: 'error' });
    return { scene: null, errors };
  }
}

function emptyArkTSBatchIndex(errors: ExtractionError[]): ArkTSBatchIndex {
  return {
    fileResults: new Map(),
    crossFileEdges: [],
    nodeIds: new Set(),
    errors,
  };
}

/**
 * Harmony multi-module path: load each PROJECT module to BODIES, index into
 * HomeGraph structures in the callback, let ArkAnalyzer evict under memoryLimitMB.
 * When `targetModuleSrcPaths` is set, only those modules are BODIES targets
 * (deps still load at SIGNATURES) — used for incremental sync.
 *
 * Runs with the #850 liveness watchdog suspended: ArkAnalyzer's native BODIES
 * load between module callbacks routinely exceeds the 60s heartbeat window on
 * large Harmony projects, and there is no JS yield point inside that span.
 * When `streamQueries` is set, each module's ExtractionResults are written to
 * SQLite immediately and dropped from RAM (cross-file call edges stay until end).
 */
function buildArkTSIndexByModule(
  rootDir: string,
  scannedFiles: Iterable<string>,
  options?: { targetModuleSrcPaths?: string[]; streamQueries?: QueryBuilder }
): ArkTSBatchIndex {
  return runWithoutLivenessWatchdog(() => buildArkTSIndexByModuleInner(rootDir, scannedFiles, options));
}

function buildArkTSIndexByModuleInner(
  rootDir: string,
  scannedFiles: Iterable<string>,
  options?: { targetModuleSrcPaths?: string[]; streamQueries?: QueryBuilder }
): ArkTSBatchIndex {
  const errors: ExtractionError[] = [];
  const memoryLimitMB = resolveArkTSSceneMemoryLimitMB();
  const sceneConfig = buildSceneConfig(rootDir, { memoryLimitMB });
  const scene = new Scene();
  const adapter = new ArkTSAdapter(rootDir, scannedFiles);
  let modulesIndexed = 0;
  const targetSrc = options?.targetModuleSrcPaths?.map(normalizeHarmonyModuleSrcPath);
  const targetSrcSet = targetSrc && targetSrc.length > 0 ? new Set(targetSrc) : null;
  const streamQueries = options?.streamQueries;
  const streamedPersistedPaths = new Set<string>();
  const scannedList = [...scannedFiles].map(normIndexPath);
  const persistOrdinal = {
    done: 0,
    totalHint: Math.max(1, scannedList.filter((f) => isArkAnalyzerSourcePath(f)).length),
  };

  try {
    scene.config(sceneConfig);

    const config = new ModuleAnalysisConfig();
    config.setLoadLevel(ModuleDepthLevel.BODIES);
    // SIGNATURES is enough for ViewTree stubs / types; BODIES on deps caused
    // each module's RTA to re-walk shared library CFGs (multi-hour indexes).
    config.setDependencyLoadLevel(ModuleDepthLevel.SIGNATURES);

    if (targetSrcSet) {
      // Prep + SDK only (no PROJECT targets) so we can resolve ModuleIDs.
      scene.analyseByModule(() => {}, new ModuleAnalysisConfig());
      const wantAbs = new Set(
        [...targetSrcSet].map((src) => {
          const resolved = path.resolve(rootDir, src);
          try {
            return fs.realpathSync(resolved).toLowerCase();
          } catch {
            return resolved.toLowerCase();
          }
        })
      );
      const ids: number[] = [];
      for (const mod of scene.getModules()) {
        if (mod.getModuleType() !== ModuleType.PROJECT) continue;
        let modAbs: string;
        try {
          modAbs = fs.realpathSync(mod.getModulePath());
        } catch {
          modAbs = path.resolve(mod.getModulePath());
        }
        if (wantAbs.has(modAbs.toLowerCase())) {
          ids.push(scene.getModuleId(mod));
        }
      }
      if (ids.length === 0) {
        errors.push({
          message: `ArkTS incremental: no modules matched [${[...targetSrcSet].join(', ')}]`,
          severity: 'warning',
        });
        return emptyArkTSBatchIndex(errors);
      }
      config.setTargetModuleIds(ids);
      process.stderr.write(
        `\n\x1b[33m    ArkTS: analyseByModule incremental (${ids.length} module(s)→BODIES, deps→SIGNATURES, memoryLimitMB=${memoryLimitMB}${streamQueries ? ', streamPersist' : ''})...\x1b[0m\n`
      );
    } else {
      config.setIncludeType(ModuleType.PROJECT, true);
      process.stderr.write(
        `\n\x1b[33m    ArkTS: analyseByModule (PROJECT→BODIES, deps→SIGNATURES, memoryLimitMB=${memoryLimitMB}, maxOldSpace=${resolveMaxOldSpaceSizeMb()}${streamQueries ? ', streamPersist' : ''})...\x1b[0m\n`
      );
    }

    scene.analyseByModule((module, scn) => {
      const moduleFileRels = [...module.getFilesMap().values()]
        .map((f) => adapter.normalizeRelPath(f.getFilePath()))
        .filter((p) => p && isArkAnalyzerSourcePath(p))
        .map(normIndexPath);

      adapter.indexModule(module, scn);
      // HomeGraph already captured this module's symbols/edges. Hollow every
      // currently-loaded module still above INDEX (target + oh_modules /
      // SIGNATURES deps left in ModuleCache). Topo order means PROJECT deps of
      // the current target are often already INDEX from their own callback, so
      // BFS-from-self alone left depHollowed=0; sweeping the cache catches the
      // fat non-target SIGNATURES that memoryLimitMB rarely evicts under a large
      // soft budget. INDEX keeps export-reachable shells; loadModule upgrades
      // when a later target needs SIGNATURES/BODIES.
      let depHollowed = 0;
      try {
        const builder = new ModuleBuilder(scn);
        const selfId = scn.getModuleId(module);
        hollowModuleToIndex(builder, selfId);

        const cache = scn.getModuleCache();
        if (cache) {
          for (const modId of cache.getLoadedModules()) {
            if (modId === selfId) continue;
            const depMod = builder.getModule(modId);
            if (!depMod || depMod.getLoadState() <= ModuleLoadState.INDEX) continue;
            hollowModuleToIndex(builder, modId);
            depHollowed++;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({
          message: `ArkTS post-index INDEX hollow failed for ${module.getModuleName() || module.getModulePath()}: ${message}`,
          severity: 'warning',
        });
      }

      if (streamQueries) {
        // Persist this module's file bodies now; keep @dummyFile until finalize.
        const slicePaths = moduleFileRels.filter((p) => p !== ARKANALYZER_DUMMY_FILE);
        const slice = adapter.takeFileResults(slicePaths);
        try {
          persistAndDropModuleSlice(
            rootDir,
            streamQueries,
            slice,
            streamedPersistedPaths,
            persistOrdinal
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          errors.push({
            message: `ArkTS stream persist failed for ${module.getModuleName() || module.getModulePath()}: ${message}`,
            severity: 'error',
          });
          throw e;
        }
      }

      modulesIndexed++;
      const name = module.getModuleName() || path.basename(module.getModulePath());
      const st = ModuleLoadState[module.getLoadState()] ?? String(module.getLoadState());
      const depNote = depHollowed > 0 ? `, hollowed ${depHollowed} deps` : '';
      process.stderr.write(
        `\x1b[33m    ArkTS: indexed module ${modulesIndexed}: ${name} → ${st}${depNote}${streamQueries ? ` (streamed ${moduleFileRels.length} files)` : ''}\x1b[0m\n`
      );
    }, config);

    if (process.env.HOMEGRAPH_ARKTS_DIAG === '1') {
      const sceneDiag = scene as Scene & { getModuleEvictionStats?: () => unknown };
      const ev =
        typeof sceneDiag.getModuleEvictionStats === 'function'
          ? sceneDiag.getModuleEvictionStats()
          : null;
      const mu = process.memoryUsage();
      const cacheN = scene.getModuleCache()?.size?.() ?? scene.getModuleCache()?.getLoadedModules?.()?.length ?? -1;
      process.stderr.write(
        `\x1b[36m    ArkTS DIAG eviction: ${JSON.stringify(ev)} cacheLoaded=${cacheN} ` +
          `heapUsedMB=${(mu.heapUsed / 1024 / 1024).toFixed(1)} rssMB=${(mu.rss / 1024 / 1024).toFixed(1)}\x1b[0m\n`
      );
    }

    if (modulesIndexed === 0) {
      errors.push({
        message:
          'ArkTS analyseByModule found no PROJECT modules (check build-profile.json5); falling back to full Scene build',
        severity: 'warning',
      });
      return emptyArkTSBatchIndex(errors);
    }

    try {
      adapter.finalizeCallGraph(scene);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({
        message: `ArkTS modular leftover RTA skipped: ${message}`,
        severity: 'warning',
      });
    }

    if (streamQueries) {
      const leftover = adapter.takeFileResults(adapter.fileResultPaths());
      persistAndDropModuleSlice(
        rootDir,
        streamQueries,
        leftover,
        streamedPersistedPaths,
        persistOrdinal
      );
    }

    const index = adapter.toBatchIndex(errors);
    if (streamQueries) {
      index.streamedPersistedPaths = streamedPersistedPaths;
    }
    if (index.fileResults.size === 0 && streamedPersistedPaths.size === 0) {
      errors.push({
        message: 'ArkTS analyseByModule indexed modules but no scanned source files matched',
        severity: 'warning',
      });
      return emptyArkTSBatchIndex(errors);
    }
    return index;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({
      message: `ArkTS analyseByModule failed: ${message}; falling back to full Scene build`,
      severity: 'warning',
    });
    return emptyArkTSBatchIndex(errors);
  } finally {
    try {
      releaseArkAnalyzerScene(scene);
    } catch {
      // ignore dispose failures
    }
  }
}

function buildArkTSIndexFull(
  rootDir: string,
  scannedFiles: Iterable<string>,
  priorErrors: ExtractionError[] = []
): ArkTSBatchIndex {
  // Full Scene build is the same opaque native stall as analyseByModule.
  return runWithoutLivenessWatchdog(() => {
    const { scene, errors } = tryBuildArkScene(rootDir);
    const allErrors = [...priorErrors, ...errors];
    if (!scene) {
      return emptyArkTSBatchIndex(allErrors);
    }

    try {
      const adapter = new ArkTSAdapter(rootDir, scannedFiles);
      const index = adapter.build(scene);
      index.errors.push(...allErrors);
      return index;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      allErrors.push({ message: `ArkTS adapter failed: ${message}`, severity: 'error' });
      return emptyArkTSBatchIndex(allErrors);
    } finally {
      try {
        releaseArkAnalyzerScene(scene);
      } catch {
        // ignore
      }
    }
  });
}

function buildArkTSIndex(
  rootDir: string,
  scannedFiles: Iterable<string>,
  options?: { streamQueries?: QueryBuilder }
): ArkTSBatchIndex {
  if (shouldUseModularArkTSBuild(rootDir)) {
    const modular = buildArkTSIndexByModule(rootDir, scannedFiles, {
      streamQueries: options?.streamQueries,
    });
    const fatal = modular.errors.find((e) => e.severity === 'error');
    const hasOutput =
      modular.fileResults.size > 0 ||
      (modular.streamedPersistedPaths?.size ?? 0) > 0 ||
      modular.nodeIds.size > 0;
    if (hasOutput && !fatal) {
      return modular;
    }
    // Warnings like "no PROJECT modules" / modular failure → full Scene fallback.
    return buildArkTSIndexFull(rootDir, scannedFiles, modular.errors);
  }
  return buildArkTSIndexFull(rootDir, scannedFiles);
}

// =============================================================================
// OHOS SDK input resolution + prebuilt API database indexing
// =============================================================================

const OHOS_ARCHIVE_EXTENSIONS = ['.tar.gz', '.tgz', '.zip', '.tar'] as const;

export class OhosSdkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OhosSdkInputError';
  }
}

/** Parse `6.1.1.290` or `commandline-tools-linux-x64-6.1.1.290.zip` → `6.1.1`. */
export function parseOhosToolsVersionFromName(name: string): string | null {
  const base = path.basename(name);
  const withoutExt = stripOhosArchiveExtension(base);
  const match = withoutExt.match(/(\d+\.\d+\.\d+)(?:\.\d+)?$/);
  return match?.[1] ?? null;
}

function stripOhosArchiveExtension(filename: string): string {
  for (const ext of OHOS_ARCHIVE_EXTENSIONS) {
    if (filename.toLowerCase().endsWith(ext)) {
      return filename.slice(0, -ext.length);
    }
  }
  return filename;
}

export function isArchivePath(inputPath: string): boolean {
  const lower = inputPath.toLowerCase();
  return OHOS_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Locate `sdk/default` that contains `openharmony/ets` under an extracted tree. */
export function findOhosSdkHome(searchRoot: string): string | null {
  const resolved = path.resolve(searchRoot);
  const direct = [
    path.join(resolved, 'sdk', 'default'),
    path.join(resolved, 'command-line-tools', 'sdk', 'default'),
  ];
  for (const candidate of direct) {
    if (hasOpenHarmonyEts(candidate)) {
      return candidate;
    }
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: resolved, depth: 0 }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (seen.has(dir) || depth > 5) continue;
    seen.add(dir);

    const sdkDefault = path.join(dir, 'sdk', 'default');
    if (hasOpenHarmonyEts(sdkDefault)) {
      return sdkDefault;
    }

    if (depth >= 5) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  return null;
}

export function hasOpenHarmonyEts(sdkHome: string): boolean {
  return fs.existsSync(path.join(sdkHome, 'openharmony', 'ets'));
}

export function listOhosApiEtsRoots(sdkHome: string): string[] {
  const roots: string[] = [];
  const openharmony = path.join(sdkHome, 'openharmony', 'ets');
  if (fs.existsSync(openharmony)) {
    roots.push(openharmony);
  }
  const hms = path.join(sdkHome, 'hms', 'ets');
  if (fs.existsSync(hms)) {
    roots.push(hms);
  }
  return roots;
}

export interface ResolvedOhosSdkInput {
  sdkHome: string;
  version: string;
  sourcePath: string;
  /** Present when the input archive was extracted to a temp directory. */
  cleanup?: () => void;
}

export interface ResolveOhosSdkInputOptions {
  inputPath: string;
  /** When set, overrides any version parsed from the path name. */
  versionOverride?: string;
}

/** Resolve a command-line-tools archive or directory to an SDK home + API db version. */
export function resolveOhosSdkInput(options: ResolveOhosSdkInputOptions): ResolvedOhosSdkInput {
  const inputPath = path.resolve(options.inputPath);
  if (!fs.existsSync(inputPath)) {
    throw new OhosSdkInputError(`Path does not exist: ${inputPath}`);
  }

  let searchRoot = inputPath;
  let cleanup: (() => void) | undefined;

  if (fs.statSync(inputPath).isFile()) {
    if (!isArchivePath(inputPath)) {
      throw new OhosSdkInputError(
        `Unsupported file type: ${path.basename(inputPath)} (expected .zip, .tar.gz, .tgz, or .tar)`
      );
    }
    const extracted = extractOhosSdkArchive(inputPath);
    searchRoot = extracted.dir;
    cleanup = extracted.cleanup;
  }

  const sdkHome = findOhosSdkHome(searchRoot);
  if (!sdkHome) {
    cleanup?.();
    throw new OhosSdkInputError(
      `Could not find sdk/default/openharmony/ets under ${inputPath}. ` +
        'Expected HarmonyOS command-line-tools layout.'
    );
  }

  const version =
    options.versionOverride?.trim() ||
    parseOhosToolsVersionFromName(inputPath) ||
    parseOhosToolsVersionFromName(searchRoot);

  if (!version) {
    cleanup?.();
    throw new OhosSdkInputError(
      'Could not determine API db version. Use a path like commandline-tools-linux-x64-6.1.1.290.zip ' +
        'or pass the version as the second argument.'
    );
  }

  return {
    sdkHome,
    version,
    sourcePath: inputPath,
    cleanup,
  };
}

function extractOhosSdkArchive(archivePath: string): { dir: string; cleanup: () => void } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-ohos-sdk-'));
  const lower = archivePath.toLowerCase();

  try {
    if (lower.endsWith('.zip')) {
      execFileSync('unzip', ['-q', archivePath, '-d', tempDir], { stdio: 'pipe' });
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      execFileSync('tar', ['-xzf', archivePath, '-C', tempDir], { stdio: 'pipe' });
    } else if (lower.endsWith('.tar')) {
      execFileSync('tar', ['-xf', archivePath, '-C', tempDir], { stdio: 'pipe' });
    } else {
      throw new OhosSdkInputError(`Unsupported archive: ${path.basename(archivePath)}`);
    }
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new OhosSdkInputError(`Failed to extract ${archivePath}: ${msg}`);
  }

  return {
    dir: tempDir,
    cleanup: () => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** Default filename for a versioned OHOS API db. */
export function ohosApiDbFilename(version: string): string {
  return `ohos-api-${version}.db`;
}

/** Metadata / publish id — one package per API version (e.g. homegraph-ohos-api-db-6.0.1). */
export function ohosApiDbPackageName(version: string): string {
  return `homegraph-ohos-api-db-${version}`;
}

/** Target path under ~/.homegraph/api/ for a versioned db. */
export function ohosApiDbInstallPath(version: string): string {
  return path.join(os.homedir(), '.homegraph', 'api', ohosApiDbFilename(version));
}

export interface OhosApiIndexOptions {
  sdkHome: string;
  version: string;
  outputPath?: string;
  onProgress?: (progress: IndexProgress) => void;
}

function scanFirstOhosApiTriggerFile(etsRoot: string): string | null {
  let found: string | null = null;
  function walk(dir: string): void {
    if (found) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (
          lower.endsWith('.ets') ||
          lower.endsWith('.d.ts') ||
          lower.endsWith('.d.ets') ||
          (lower.endsWith('.ts') && !lower.endsWith('.d.ts'))
        ) {
          found = path.relative(etsRoot, full).replace(/\\/g, '/');
          return;
        }
      }
    }
  }
  walk(etsRoot);
  return found;
}

function countOhosApiSources(etsRoot: string): number {
  let count = 0;
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (
          lower.endsWith('.ets') ||
          lower.endsWith('.d.ts') ||
          lower.endsWith('.d.ets') ||
          (lower.endsWith('.ts') && !lower.endsWith('.d.ts'))
        ) {
          count++;
        }
      }
    }
  }
  walk(etsRoot);
  return count;
}

/** Index OpenHarmony (and optional HMS) SDK API declarations into a SQLite db. */
export async function indexOhosApiDb(options: OhosApiIndexOptions): Promise<IndexResult> {
  const sdkHome = path.resolve(options.sdkHome);
  if (!hasOpenHarmonyEts(sdkHome)) {
    throw new Error(`SDK home is missing openharmony/ets: ${sdkHome}`);
  }

  const etsRoots = listOhosApiEtsRoots(sdkHome);
  if (etsRoots.length === 0) {
    throw new Error(`No API ets roots found under ${sdkHome}`);
  }

  const outputPath = path.resolve(
    options.outputPath ?? path.join(process.cwd(), ohosApiDbFilename(options.version))
  );
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  const startTime = Date.now();
  const errors: IndexResult['errors'] = [];
  let filesIndexed = 0;

  const db = DatabaseConnection.initialize(outputPath);
  const queries = new QueryBuilderClass(db.getDb());

  try {
    for (const etsRoot of etsRoots) {
      const trigger = scanFirstOhosApiTriggerFile(etsRoot);
      if (!trigger) {
        errors.push({
          message: `No ArkTS sources under ${etsRoot}`,
          severity: 'warning',
        });
        continue;
      }

      const total = countOhosApiSources(etsRoot);
      options.onProgress?.({
        phase: 'arkts-batch',
        current: 0,
        total,
        currentFile: etsRoot,
        subphase: 'scene',
      });

      resetArkTSBatch();
      resetExtractionContext();
      bindExtractionContext(etsRoot, queries);
      await primeArkTSBatch(etsRoot, queries, trigger);
      filesIndexed += total;

      options.onProgress?.({
        phase: 'arkts-batch',
        current: total,
        total,
        currentFile: etsRoot,
        subphase: 'persist',
      });
    }

    const counts = queries.getNodeAndEdgeCount();
    queries.setMetadata('ohos_api_version', options.version);
    queries.setMetadata('ohos_api_sdk_home', sdkHome);
    queries.setMetadata('ohos_api_db_kind', ohosApiDbPackageName(options.version));
    queries.setMetadata('indexed_with_version', HomeGraphPackageVersion);
    queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION));

    db.runMaintenance();

    return {
      success: errors.every((e) => e.severity !== 'error'),
      filesIndexed,
      filesSkipped: 0,
      filesErrored: errors.filter((e) => e.severity === 'error').length,
      nodesCreated: counts.nodes,
      edgesCreated: counts.edges,
      errors,
      durationMs: Date.now() - startTime,
    };
  } finally {
    resetArkTSBatch();
    resetExtractionContext();
    db.close();
  }
}

// =============================================================================
// OHOS API db consumer: compileSdkVersion detect, local SDK build, ATTACH
// =============================================================================

export const OHOS_API_FILE_PREFIX = 'ohos-sdk:';
export const OHOS_API_VERSION_META = 'ohos_api_version';
export const OHOS_API_DB_PATH_META = 'ohos_api_db_path';

export interface OhosApiDbBinding {
  version: string;
  dbPath: string;
  packageName: string;
  /** True when this call built the db from a local SDK (vs already on disk). */
  installed: boolean;
}

export interface OhosApiDbBindingWarning {
  message: string;
  code:
    | 'ohos_api_version_unknown'
    | 'ohos_api_sdk_missing'
    | 'ohos_api_build_failed'
    | 'ohos_api_db_missing'
    /** @deprecated Prefer ohos_api_sdk_missing — kept for older log readers. */
    | 'ohos_api_install_failed';
}

export interface LocalOhosSdkCandidate {
  sdkHome: string;
  version: string | null;
}

export interface EnsureOhosApiDbOptions {
  /** Prefer this SDK home when it matches the requested version. */
  sdkHomeHint?: string;
  onProgress?: (progress: IndexProgress) => void;
  /** When false, only reuse an existing ~/.homegraph/api db (never build). Default true. */
  build?: boolean;
}

export interface BindOhosApiDbOptions extends EnsureOhosApiDbOptions {}

/** Prefix applied to API db node file paths so explore can render without disk reads. */
export function markOhosApiFilePath(relativePath: string): string {
  return `${OHOS_API_FILE_PREFIX}${relativePath.replace(/\\/g, '/')}`;
}

export function isOhosApiFilePath(filePath: string): boolean {
  return filePath.startsWith(OHOS_API_FILE_PREFIX);
}

/** Strip json5 comments/trailing commas enough for compileSdkVersion extraction. */
export function parseJson5Minimal(text: string): unknown {
  const stripped = text
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

/** Normalize compileSdkVersion values like "6.0.1(21)" → "6.0.1". */
export function normalizeOhosApiVersion(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    const s = String(raw);
    if (/^\d+$/.test(s) && s.length >= 8) {
      const major = Math.floor(Number(s) / 1_000_000);
      const minor = Math.floor((Number(s) % 1_000_000) / 1000);
      const patch = Number(s) % 1000;
      return `${major}.${minor}.${patch}`;
    }
    return null;
  }
  const match = String(raw).match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function findBuildProfileFiles(projectRoot: string): string[] {
  const found: string[] = [];
  const rootProfile = path.join(projectRoot, 'build-profile.json5');
  if (fs.existsSync(rootProfile)) found.push(rootProfile);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.homegraph') continue;
    const nested = path.join(projectRoot, entry.name, 'build-profile.json5');
    if (fs.existsSync(nested)) found.push(nested);
  }
  return found;
}

function extractCompileSdkFromObject(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;
  for (const key of ['compileSdkVersion', 'compileSdk', 'targetSdkVersion']) {
    const v = normalizeOhosApiVersion(record[key]);
    if (v) return v;
  }
  const app = record.app;
  if (app && typeof app === 'object') {
    const products = (app as Record<string, unknown>).products;
    if (Array.isArray(products)) {
      for (const product of products) {
        const v = extractCompileSdkFromObject(product);
        if (v) return v;
      }
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const v = extractCompileSdkFromObject(value);
      if (v) return v;
    }
  }
  return null;
}

/** Read compileSdkVersion from build-profile.json5 (root or module). */
export function detectOhosCompileSdkVersion(projectRoot: string): string | null {
  const envOverride = process.env.HOMEGRAPH_OHOS_API_VERSION?.trim();
  if (envOverride) {
    return normalizeOhosApiVersion(envOverride) ?? envOverride;
  }

  for (const profilePath of findBuildProfileFiles(projectRoot)) {
    try {
      const text = fs.readFileSync(profilePath, 'utf-8');
      const parsed = parseJson5Minimal(text);
      const version = extractCompileSdkFromObject(parsed);
      if (version) return version;
    } catch {
      const match = fs.readFileSync(profilePath, 'utf-8').match(/compileSdkVersion\s*:\s*['"]?([^'"\s,)]+)/);
      const v = normalizeOhosApiVersion(match?.[1]);
      if (v) return v;
    }
  }
  return null;
}

export function isOhosArktsProject(projectRoot: string, languages?: string[]): boolean {
  if (languages?.includes('arkts')) return true;
  if (findBuildProfileFiles(projectRoot).length > 0) return true;
  return hasEtsUnder(projectRoot, 0);
}

function hasEtsUnder(dir: string, depth: number): boolean {
  if (depth > 4) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.ets')) return true;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.homegraph') continue;
      if (hasEtsUnder(full, depth + 1)) return true;
    }
  }
  return false;
}

/** Read platformVersion from sdk-pkg.json / oh-uni-package.json under an SDK home. */
export function readOhosSdkPlatformVersion(sdkHome: string): string | null {
  const pkgPaths = [
    path.join(sdkHome, 'sdk-pkg.json'),
    path.join(sdkHome, 'openharmony', 'ets', 'oh-uni-package.json'),
    path.join(sdkHome, 'openharmony', 'oh-uni-package.json'),
  ];
  for (const pkgPath of pkgPaths) {
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const data =
        raw.data && typeof raw.data === 'object'
          ? (raw.data as Record<string, unknown>)
          : raw;
      const v =
        normalizeOhosApiVersion(data.platformVersion) ||
        normalizeOhosApiVersion(data.version) ||
        normalizeOhosApiVersion(raw.platformVersion) ||
        normalizeOhosApiVersion(raw.version);
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  return normalizeOhosApiVersion(path.basename(sdkHome));
}

/** Expand a user/env path into concrete sdk/default-style homes that contain openharmony/ets. */
function expandLocalOhosSdkHomes(input: string): string[] {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) return [];

  const homes: string[] = [];
  const push = (p: string) => {
    if (hasOpenHarmonyEts(p)) homes.push(p);
  };

  push(resolved);
  push(path.join(resolved, 'default'));
  push(path.join(resolved, 'sdk', 'default'));

  const viaFind = findOhosSdkHome(resolved);
  if (viaFind) homes.push(viaFind);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return [...new Set(homes)];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = path.join(resolved, entry.name);
    push(child);
    push(path.join(child, 'default'));
  }

  return [...new Set(homes)];
}

function localOhosSdkSearchRoots(): string[] {
  const roots: string[] = [];
  for (const key of ['HOMEGRAPH_OHOS_SDK', 'OHOS_SDK_HOME', 'DEVECO_SDK_HOME', 'HOS_SDK_HOME']) {
    const v = process.env[key]?.trim();
    if (v) roots.push(v);
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA;
    if (lad) {
      roots.push(path.join(lad, 'OpenHarmony', 'Sdk'));
      roots.push(path.join(lad, 'Huawei', 'Sdk'));
    }
    roots.push(path.join('C:\\', 'Program Files', 'Huawei', 'DevEco Studio', 'sdk'));
    roots.push(path.join(home, 'Huawei', 'Sdk'));
    roots.push(path.join(home, 'OpenHarmony', 'Sdk'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Huawei', 'Sdk'));
    roots.push(path.join(home, 'Library', 'OpenHarmony', 'Sdk'));
    roots.push('/Applications/DevEco-Studio.app/Contents/sdk');
  } else {
    roots.push(path.join(home, 'Huawei', 'Sdk'));
    roots.push(path.join(home, 'OpenHarmony', 'Sdk'));
  }
  return roots;
}

/** Discover local DevEco / OpenHarmony SDK homes (env vars + common install paths). */
export function discoverLocalOhosSdkCandidates(): LocalOhosSdkCandidate[] {
  const out: LocalOhosSdkCandidate[] = [];
  const seen = new Set<string>();
  for (const root of localOhosSdkSearchRoots()) {
    for (const sdkHome of expandLocalOhosSdkHomes(root)) {
      if (seen.has(sdkHome)) continue;
      seen.add(sdkHome);
      out.push({ sdkHome, version: readOhosSdkPlatformVersion(sdkHome) });
    }
  }
  return out;
}

/**
 * Pick a local SDK home.
 * When `preferredVersion` is set, require an exact platformVersion match.
 * When unset, return the first candidate that has a readable version (else any).
 */
export function findLocalOhosSdkForVersion(
  preferredVersion?: string | null
): LocalOhosSdkCandidate | null {
  const candidates = discoverLocalOhosSdkCandidates();
  if (candidates.length === 0) return null;
  if (preferredVersion) {
    return candidates.find((c) => c.version === preferredVersion) ?? null;
  }
  return candidates.find((c) => c.version) ?? candidates[0]!;
}

/**
 * Resolve the API db version for a project: build-profile / env first, else local SDK.
 */
export function resolveOhosApiVersionForProject(projectRoot: string): string | null {
  const fromProject = detectOhosCompileSdkVersion(projectRoot);
  if (fromProject) return fromProject;
  return findLocalOhosSdkForVersion(null)?.version ?? null;
}

function attachOhosApiDbBinding(
  queries: QueryBuilder,
  binding: OhosApiDbBinding
): OhosApiDbBinding | OhosApiDbBindingWarning {
  try {
    queries.attachOhosApiDb(binding.dbPath);
    queries.setMetadata(OHOS_API_VERSION_META, binding.version);
    queries.setMetadata(OHOS_API_DB_PATH_META, binding.dbPath);
    return binding;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      code: 'ohos_api_db_missing',
      message: `Failed to attach OHOS API db at ${binding.dbPath}: ${msg}`,
    };
  }
}

/** Last-resort prebuilt npm package when the project's API version cannot be obtained. */
const OHOS_API_FALLBACK_VERSION = '6.1.0';

function runNpmPack(args: string[], cwd: string): void {
  const inv =
    process.platform === 'win32'
      ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...args].join(' ')] }
      : { cmd: 'npm', args };
  execFileSync(inv.cmd, inv.args, {
    cwd,
    stdio: 'pipe',
    timeout: 180_000,
    windowsHide: true,
    env: process.env,
  });
}

/**
 * Fetch `homegraph-ohos-api-db-<version>` from npm and copy the db into
 * `~/.homegraph/api/`. Returns null when downloads are disabled, the package
 * is missing, or install fails. Opt out: HOMEGRAPH_OHOS_API_NO_DOWNLOAD=1.
 */
export function tryDownloadOhosApiDbFromNpm(version: string): OhosApiDbBinding | null {
  if (process.env.HOMEGRAPH_OHOS_API_NO_DOWNLOAD === '1') return null;

  const dbPath = ohosApiDbInstallPath(version);
  const packageName = ohosApiDbPackageName(version);
  if (fs.existsSync(dbPath)) {
    return { version, dbPath, packageName, installed: false };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ohos-api-npm-'));
  try {
    runNpmPack(['pack', packageName, '--silent'], tmp);
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) return null;

    const extractDir = path.join(tmp, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', extractDir], {
      stdio: 'pipe',
      timeout: 60_000,
      windowsHide: true,
    });

    const dbName = ohosApiDbFilename(version);
    const src =
      [
        path.join(extractDir, 'package', dbName),
        path.join(extractDir, dbName),
      ].find((p) => fs.existsSync(p)) ?? null;
    if (!src) return null;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(src, dbPath);
    return { version, dbPath, packageName, installed: true };
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build (or reuse) ~/.homegraph/api/ohos-api-<version>.db from a local SDK,
 * then npm prebuilts. Never throws — missing SDK / build / download failure
 * returns a warning.
 *
 * Order: existing db → local SDK build → npm pack for that version →
 * npm pack homegraph-ohos-api-db-6.1.0 fallback.
 */
export async function ensureOhosApiDb(
  version: string,
  options: EnsureOhosApiDbOptions = {}
): Promise<OhosApiDbBinding | OhosApiDbBindingWarning> {
  const dbPath = ohosApiDbInstallPath(version);
  const packageName = ohosApiDbPackageName(version);

  // 1. Local db for the requested version
  if (fs.existsSync(dbPath)) {
    return { version, dbPath, packageName, installed: false };
  }

  if (options.build === false || process.env.HOMEGRAPH_OHOS_API_SKIP === '1') {
    return {
      code: 'ohos_api_db_missing',
      message:
        `${ohosApiDbFilename(version)} is not under ~/.homegraph/api/ yet. ` +
        'Re-run `homegraph init -i` / `homegraph index` with a local OHOS SDK, or `homegraph index-api <sdk>`. ' +
        'Explore will use project code only.',
    };
  }

  // 2. Build from a local DevEco / OpenHarmony SDK
  let sdkHome: string | null = null;
  if (options.sdkHomeHint) {
    const hintHomes = expandLocalOhosSdkHomes(options.sdkHomeHint);
    const match = hintHomes.find((h) => readOhosSdkPlatformVersion(h) === version) ?? hintHomes[0];
    if (match && hasOpenHarmonyEts(match)) sdkHome = match;
  }
  if (!sdkHome) {
    sdkHome = findLocalOhosSdkForVersion(version)?.sdkHome ?? null;
  }

  if (sdkHome) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    options.onProgress?.({
      phase: 'ohos-api',
      current: 0,
      total: 1,
      currentFile: version,
    });

    try {
      const result = await indexOhosApiDb({
        sdkHome,
        version,
        outputPath: dbPath,
        onProgress: options.onProgress
          ? (progress) => {
              options.onProgress?.({
                phase: 'ohos-api',
                current: progress.current,
                total: progress.total || 1,
                currentFile: progress.currentFile
                  ? `${version} ${path.basename(progress.currentFile)}`
                  : version,
                subphase: progress.subphase,
              });
            }
          : undefined,
      });

      if (result.success && fs.existsSync(dbPath)) {
        options.onProgress?.({
          phase: 'ohos-api',
          current: 1,
          total: 1,
          currentFile: version,
        });
        return { version, dbPath, packageName, installed: true };
      }

      try {
        fs.unlinkSync(dbPath);
      } catch {
        /* ignore */
      }
    } catch {
      try {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      } catch {
        /* ignore */
      }
    }
  }

  // 3. Download prebuilt for the requested version from npm
  const fromNpm = tryDownloadOhosApiDbFromNpm(version);
  if (fromNpm) return fromNpm;

  // 4. Last resort: homegraph-ohos-api-db-6.1.0
  if (version !== OHOS_API_FALLBACK_VERSION) {
    const fallbackPath = ohosApiDbInstallPath(OHOS_API_FALLBACK_VERSION);
    if (fs.existsSync(fallbackPath)) {
      return {
        version: OHOS_API_FALLBACK_VERSION,
        dbPath: fallbackPath,
        packageName: ohosApiDbPackageName(OHOS_API_FALLBACK_VERSION),
        installed: false,
      };
    }
    const fallback = tryDownloadOhosApiDbFromNpm(OHOS_API_FALLBACK_VERSION);
    if (fallback) return fallback;
  }

  return {
    code: 'ohos_api_sdk_missing',
    message:
      `OHOS API db for ${version} unavailable (no local SDK build, npm ${packageName} failed` +
      (version !== OHOS_API_FALLBACK_VERSION
        ? `, and fallback ${ohosApiDbPackageName(OHOS_API_FALLBACK_VERSION)} failed`
        : '') +
      '). Set OHOS_SDK_HOME / DEVECO_SDK_HOME or install the matching DevEco SDK. ' +
      'SDK API lookup disabled; project indexing continues normally.',
  };
}

/**
 * Attach a prebuilt API db if present — never builds. Used on open / wireLayers.
 */
export function attachExistingOhosApiDbForProject(
  projectRoot: string,
  queries: QueryBuilder,
  languages?: string[]
): OhosApiDbBinding | OhosApiDbBindingWarning | null {
  if (!isOhosArktsProject(projectRoot, languages)) return null;

  const version = resolveOhosApiVersionForProject(projectRoot);
  if (!version) return null;

  const dbPath = ohosApiDbInstallPath(version);
  if (!fs.existsSync(dbPath)) return null;

  return attachOhosApiDbBinding(queries, {
    version,
    dbPath,
    packageName: ohosApiDbPackageName(version),
    installed: false,
  });
}

/**
 * Detect version, build from local SDK when needed, persist metadata, ATTACH — never throws.
 * Pass `{ build: true }` (default) after init/index; `{ build: false }` on open.
 */
export async function bindOhosApiDbForProject(
  projectRoot: string,
  queries: QueryBuilder,
  languages?: string[],
  options: BindOhosApiDbOptions = {}
): Promise<OhosApiDbBinding | OhosApiDbBindingWarning | null> {
  if (!isOhosArktsProject(projectRoot, languages)) return null;

  const version = resolveOhosApiVersionForProject(projectRoot);
  if (!version) {
    return {
      code: 'ohos_api_version_unknown',
      message:
        'HarmonyOS project detected but compileSdkVersion was not found in build-profile.json5 ' +
        'and no local OHOS SDK was discovered (set OHOS_SDK_HOME / DEVECO_SDK_HOME). ' +
        'SDK API lookup disabled; project indexing continues normally.',
    };
  }

  const ensured = await ensureOhosApiDb(version, options);
  if ('code' in ensured) return ensured;

  return attachOhosApiDbBinding(queries, ensured);
}

/** Re-ATTACH from project metadata after reopen / new QueryBuilder. */
export function restoreOhosApiDbAttach(queries: QueryBuilder): OhosApiDbBinding | null {
  const dbPath = queries.getMetadata(OHOS_API_DB_PATH_META);
  const version = queries.getMetadata(OHOS_API_VERSION_META);
  if (!dbPath || !version || !fs.existsSync(dbPath)) return null;
  try {
    queries.attachOhosApiDb(dbPath);
    return {
      version,
      dbPath,
      packageName: ohosApiDbPackageName(version),
      installed: false,
    };
  } catch {
    return null;
  }
}
