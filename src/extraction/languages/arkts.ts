/**
 * ArkTS (.ets) extraction via ArkAnalyzer.
 *
 * Unlike tree-sitter languages, ArkTS is batch-complete: the first `.ets`
 * parse builds one Scene for the whole project, runs RTA, persists every
 * `.ets` file (nodes, edges, cross-file RTA calls) directly to the DB, then
 * returns the requested file's result. Later `.ets` hits in the same batch
 * short-circuit (orchestrator store skips via matching content hash).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  Scene,
  buildSceneConfigFromProject,
  ArkClass,
  ArkField,
  ArkFile,
  ArkMethod,
  ArkNamespace,
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
import { bindExtractionContext, getExtractionProjectRoot, getExtractionQueries, reportArkTSBatchProgress, setArktsBatchRunning } from '../context';
import { generateNodeId } from '../tree-sitter-helpers';
import { buildRelaunchArgv } from '../wasm-runtime-flags';

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

function shouldUseIsolatedArkTSBuild(etsCount: number): boolean {
  const mode = process.env.HOMEGRAPH_ARKTS_ISOLATED?.trim();
  if (mode === '1' || mode === 'true') return true;
  if (mode === '0' || mode === 'false') return false;
  // Photos-scale repos on Windows: build Scene in a child with a larger stack.
  if (process.platform === 'win32' && etsCount >= 500) return true;
  return false;
}

function homegraphDbPath(rootDir: string): string {
  return path.join(rootDir, '.homegraph', 'homegraph.db');
}

const ARK_PROVENANCE = 'heuristic';
/** Virtual file path for ArkAnalyzer's in-scene dummy entry (not on disk). */
const ARKANALYZER_DUMMY_FILE = '@dummyFile.ets';

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

/** True when the tree looks like a HarmonyOS / ArkTS project (not a generic TS repo). */
function hasHarmonyProjectMarkers(rootDir: string): boolean {
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
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.homegraph') {
          continue;
        }
        walk(full);
      } else if (entry.isFile() && (isEtsFileName(entry.name) || entry.name === 'module.json5')) {
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

/** Member calls through a native `.so` binding: `sdk.Asset_setCropRect(`. */
const NAPI_MEMBER_CALL_RE = /\.\s*([A-Z][A-Za-z0-9_]*(?:_[A-Za-z0-9_]+)+)\s*\(/g;

function isNapiSymbolName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*_[A-Za-z0-9_]+$/.test(name);
}

interface ArkTSBatchIndex {
  fileResults: Map<string, ExtractionResult>;
  crossFileEdges: Edge[];
  nodeIds: Set<string>;
  errors: ExtractionError[];
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

function scanEtsFiles(rootDir: string): string[] {
  const etsFiles: string[] = [];
  const coLocated: string[] = [];
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
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.homegraph') continue;
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
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
  result: ExtractionResult
): void {
  const contentHash = hashContent(content);
  const existingFile = queries.getFileByPath(filePath);
  if (existingFile?.contentHash === contentHash) {
    return;
  }
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
  };
  queries.upsertFile(fileRecord);
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
  batchPersistedPaths = new Set(
    [...index.fileResults.keys()].map(normIndexPath)
  );
  persistedBatch = { ...index, rootDir, batchKey, etsFiles };
  batchTriggerFile = normIndexPath(triggerFile);
  if (index.fileResults.size > 0) {
    batchBuildCommitted = true;
  }
  return persistedBatch;
}

function tryReturnCachedBatch(
  rootDir: string,
  triggerFile: string,
  etsFiles: string[]
): PersistedBatch | null {
  const normalizedTrigger = normIndexPath(triggerFile);

  if (
    persistedBatch &&
    persistedBatch.rootDir === rootDir &&
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
      `\n\x1b[33m    ArkTS: full Scene build in isolated process (--stack-size=${stackKb} KB, enableMethodBodyBuild=true)...\x1b[0m\n`
    );
    const argv = buildRelaunchArgv(
      workerPath,
      [rootDir, dbPath, triggerFile],
      [`--stack-size=${stackKb}`]
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
      throw new Error(fatal?.message ?? 'ArkTS batch produced no indexed files');
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
  if (shouldUseIsolatedArkTSBuild(etsFiles.length)) {
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
            'Try HOMEGRAPH_ARKTS_STACK_SIZES_KB=65536,131072,262144'
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

  const batchKey = etsFiles.length > 0 ? computeBatchKey(rootDir, etsFiles) : '';
  return runArkTSBatchFull(rootDir, queries, normalizedTrigger, etsFiles, batchKey);
}

/** Async batch build with parallel file reads during persist (used by indexAll). */
export async function primeArkTSBatch(
  rootDir: string,
  queries: QueryBuilder,
  triggerFile: string
): Promise<void> {
  const normalizedTrigger = normIndexPath(triggerFile);
  const etsFiles = scanEtsFiles(rootDir);
  const cached = tryReturnCachedBatch(rootDir, normalizedTrigger, etsFiles);
  if (cached) {
    return;
  }

  const batchKey = etsFiles.length > 0 ? computeBatchKey(rootDir, etsFiles) : '';

  batchTriggerFile = null;
  batchPersistedPaths = new Set();

  if (etsFiles.length === 0) {
    persistedBatch = null;
    batchBuildCommitted = false;
    return;
  }

  if (shouldUseIsolatedArkTSBuild(etsFiles.length)) {
    runArkTSBatchFull(rootDir, queries, normalizedTrigger, etsFiles, batchKey);
    return;
  }

  setArktsBatchRunning(true);
  try {
    reportBatchProgress('scene', 0, etsFiles.length);
    const index = buildArkTSIndex(rootDir, etsFiles);
    if (index.fileResults.size === 0) {
      const fatal = index.errors.find((e) => e.severity === 'error');
      throw new Error(fatal?.message ?? 'ArkTS batch produced no indexed files');
    }
    queries.deleteArkTSCrossFileCallEdges();
    await persistBatchResultsAsync(rootDir, queries, index);

    if (index.crossFileEdges.length > 0) {
      const valid = index.crossFileEdges.filter(
        (e) => index.nodeIds.has(e.source) && index.nodeIds.has(e.target)
      );
      if (valid.length > 0) {
        queries.insertEdges(valid);
      }
    }

    commitArkTSBatch(rootDir, batchKey, etsFiles, index, normalizedTrigger);
  } finally {
    setArktsBatchRunning(false);
  }
}

/** True when this `.ets` file was already written by the in-memory ArkTS batch. */
export function isArkTSBatchPersisted(filePath: string): boolean {
  return batchPersistedPaths.has(normIndexPath(filePath));
}

/** Clear cached batch state (tests and full re-index). */
export function resetArkTSBatch(): void {
  persistedBatch = null;
  batchTriggerFile = null;
  batchPersistedPaths = new Set();
  batchBuildCommitted = false;
  arktsIndexNotices = [];
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
  getDecorators?: () => Iterable<{ getKind: () => string }>;
}

function normalizeRelPath(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).replace(/\\/g, '/');
}

/** Map ArkAnalyzer synthetic files (e.g. @dummyFile) to our virtual indexed path. */
function resolveArkanalyzerVirtualPath(arkFile: ArkFile): string | null {
  const base = path.basename(arkFile.getFilePath()).replace(/\\/g, '/');
  if (base === '@dummyFile' || base.endsWith('@dummyFile')) {
    return ARKANALYZER_DUMMY_FILE;
  }
  return null;
}

function relPathForArkFile(rootDir: string, arkFile: ArkFile): string {
  return resolveArkanalyzerVirtualPath(arkFile) ?? normalizeRelPath(rootDir, arkFile.getFilePath());
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

function collectComponentScope(scene: Scene): ArkClass[] {
  const scope: ArkClass[] = [];
  for (const cls of scene.getClasses()) {
    if (cls.isDefaultArkClass()) continue;
    if (cls.hasComponentDecorator()) {
      scope.push(cls);
    }
  }
  return scope;
}

function collectNonUiRtaEntryPoints(scene: Scene): MethodSignature[] {
  const entries: MethodSignature[] = [];
  for (const file of scene.getFiles()) {
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

function resolveRtaEntryPoints(scene: Scene): RtaEntryResolution {
  const explicit = scene.getEntryPoints();
  if (explicit.length > 0) {
    return { entryPoints: explicit, dummyMain: null };
  }

  if (sceneHasArkUiEntries(scene)) {
    try {
      const componentScope = collectComponentScope(scene);
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

  const fallback = collectNonUiRtaEntryPoints(scene);
  return { entryPoints: fallback, dummyMain: null };
}

function sceneHasArkUiEntries(scene: Scene): boolean {
  for (const file of scene.getFiles()) {
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
    line: number
  ): void;
  ensureMethodNode(
    method: ArkMethod,
    relativePath: string,
    result: ExtractionResult,
    parentId: string
  ): string | null;
  resolveClassNodeId(cls: ArkClass): string | null;
  markFieldStateDecorators?: (field: ArkField, fieldNodeId: string, result: ExtractionResult) => void;
}

function viewTreeLineFromStmt(stmt: Stmt | undefined): number {
  return stmt?.getOriginFullPosition()?.getFirstLine() ?? 1;
}

function isViewTreeClassSignature(sig: ClassSignature | MethodSignature): sig is ClassSignature {
  return sig instanceof ClassSignature;
}

function walkViewTree(node: ViewTreeNode, visit: (node: ViewTreeNode) => void): void {
  visit(node);
  for (const child of node.children) {
    walkViewTree(child, visit);
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
    line: number
  ) => {
    const key = `${source}>${target}>${kind}>${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    ctx.addEdge(result, source, target, kind, relativePath, via, line);
  };

  for (const [field] of viewTree.getStateValues()) {
    const fieldId = ctx.fieldToId.get(field);
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
      if (isViewTreeClassSignature(sig)) {
        const childCls = ctx.scene.getClass(sig);
        if (childCls) {
          const childId = ctx.resolveClassNodeId(childCls);
          if (childId) {
            const firstAttr = node.attributes.values().next().value;
            const line = firstAttr
              ? viewTreeLineFromStmt(firstAttr[0])
              : buildMethod.getImplOriginFullPosition()?.getFirstLine() ?? 1;
            link(buildId, childId, 'references', 'child-component', line);
          }
        }
      } else {
        const builderMethod = ctx.scene.getMethod(sig);
        if (builderMethod) {
          const builderId = ctx.ensureMethodNode(builderMethod, relativePath, result, classNodeId);
          if (builderId) {
            link(
              buildId,
              builderId,
              'references',
              'builder',
              builderMethod.getImplOriginFullPosition()?.getFirstLine() ?? 1
            );
          }
        }
      }
    }

    if (node.stateValuesTransfer) {
      for (const [childField, parentValue] of node.stateValuesTransfer) {
        const childFieldId = ctx.fieldToId.get(childField);
        if (parentValue instanceof ArkField) {
          const via = stateTransferViaForField(childField);
          if (!via || !childFieldId) continue;
          ctx.markFieldStateDecorators?.(childField, childFieldId, result);
          const parentFieldId = ctx.fieldToId.get(parentValue);
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
          const builderId = ctx.ensureMethodNode(parentValue, relativePath, result, classNodeId);
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

    for (const [attr, [stmt, values]] of node.attributes) {
      if (!VIEWTREE_CALLBACK_ATTRS.has(attr)) continue;
      const line = viewTreeLineFromStmt(stmt);
      for (const v of values) {
        if (!(v instanceof MethodSignature)) continue;
        const handler = ctx.scene.getMethod(v);
        if (!handler) continue;
        const handlerId = ctx.ensureMethodNode(handler, relativePath, result, classNodeId);
        if (handlerId) link(buildId, handlerId, 'references', attr, line);
      }
    }
  });
}

class ArkTSAdapter {
  private readonly rootDir: string;
  private readonly scanned: Set<string>;
  private scene: Scene | null = null;
  private readonly methodToId = new Map<ArkMethod, string>();
  private readonly classToId = new Map<ArkClass, string>();
  private readonly componentToId = new Map<ArkClass, string>();
  private readonly fieldToId = new Map<ArkField, string>();
  private readonly nodeIds = new Set<string>();
  private readonly fileResults = new Map<string, ExtractionResult>();
  private readonly crossFileEdges: Edge[] = [];

  constructor(rootDir: string, scannedFiles: Iterable<string>) {
    this.rootDir = rootDir;
    this.scanned = new Set(scannedFiles);
  }

  build(scene: Scene): ArkTSBatchIndex {
    this.scene = scene;
    const { entryPoints, dummyMain } = resolveRtaEntryPoints(scene);

    for (const arkFile of scene.getFiles()) {
      const relativePath = normalizeRelPath(this.rootDir, arkFile.getFilePath());
      if (!this.scanned.has(relativePath)) continue;
      if (!isArkAnalyzerSourcePath(relativePath)) continue;
      this.indexFile(arkFile);
    }

    for (const cls of scene.getClasses()) {
      if (!cls.hasViewTree()) continue;
      const arkFile = cls.getDeclaringArkFile();
      const relativePath = normalizeRelPath(this.rootDir, arkFile.getFilePath());
      if (!this.scanned.has(relativePath) || !isArkAnalyzerSourcePath(relativePath)) continue;
      const result = this.fileResults.get(relativePath);
      if (!result) continue;
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

    if (dummyMain) {
      this.indexArkanalyzerDummyMain(dummyMain);
    }

    let callGraph;
    try {
      callGraph =
        entryPoints.length > 0 ? scene.makeCallGraphRTA(entryPoints) : null;
    } catch {
      callGraph = null;
    }

    if (callGraph) {
      for (const edge of callGraph.getCallEdges()) {
        const caller = callGraph.getArkMethodByFuncID(edge.getSrcID());
        const callee = callGraph.getArkMethodByFuncID(edge.getDstID());
        if (!caller || !callee) continue;
        if (
          shouldSkipArkMethod(caller) &&
          !isAnonymousArkMethod(caller) &&
          !caller.getDeclaringArkClass().isDefaultArkClass() &&
          !caller.isGenerated()
        ) {
          continue;
        }

        const callerId = this.resolveMethodNodeId(caller);
        const calleeId = this.resolveMethodNodeId(callee);
        if (!callerId || !calleeId) continue;

        const callerFile = relPathForArkFile(this.rootDir, caller.getDeclaringArkFile());
        const callEdge = arkEdge(callerId, calleeId, 'calls', {
          metadata: {
            synthesizedBy: 'arkanalyzer',
            dispatch: edge.hasDirectCall() ? 'direct' : 'indirect',
            sourceFile: callerFile,
            rtaEntry: caller.isGenerated?.() && caller.getName() === '@dummyMain'
              ? '@dummyMain'
              : undefined,
          },
        });

        const callerResult = this.fileResults.get(callerFile);
        if (callerResult && this.nodeInFile(calleeId, callerFile)) {
          callerResult.edges.push(callEdge);
        } else {
          this.crossFileEdges.push(callEdge);
        }
      }
    }

    return {
      fileResults: this.fileResults,
      crossFileEdges: this.crossFileEdges,
      nodeIds: this.nodeIds,
      errors: [],
    };
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
    const relativePath = normalizeRelPath(this.rootDir, arkFile.getFilePath());
    const language: Language = 'arkts';
    let lineCount = 1;
    try {
      lineCount = arkFile.getCode()?.split('\n').length ?? 1;
    } catch {
      // use default
    }
    const result = this.ensureFileResult(relativePath, lineCount);
    const fileId = `file:${relativePath}`;

    for (const ns of arkFile.getNamespaces()) {
      this.indexNamespace(relativePath, language, result, ns, fileId);
    }

    this.indexClassesInNamespace(relativePath, language, result, arkFile.getClasses(), fileId);
    this.indexDefaultClass(relativePath, language, result, arkFile.getDefaultClass(), fileId);
    this.indexTypeAliases(relativePath, language, result, arkFile, undefined, fileId);
    this.indexModuleLocals(relativePath, language, result, arkFile, undefined, fileId);
    this.indexImports(relativePath, language, result, arkFile, fileId);
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
    const classNode = makeNode(relativePath, language, kind, displayName, qn, line, endLine, col, {
      ...modelModifiersToNodeExtras(cls),
    });
    this.addNode(result, classNode);
    this.classToId.set(cls, classNode.id);
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
        { ...modelModifiersToNodeExtras(cls) }
      );
      this.addNode(result, componentNode);
      this.componentToId.set(cls, componentNode.id);
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
    const stateDecs = stateDecoratorKinds(field);
    const fieldNode = makeNode(relativePath, language, kind, name, qn, line, endLine, col, {
      signature: field.getType()?.toString(),
      ...(stateDecs.length > 0 ? { decorators: stateDecs } : {}),
      ...modelModifiersToNodeExtras(field),
    });
    this.addNode(result, fieldNode);
    this.fieldToId.set(field, fieldNode.id);
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
        line: number
      ) => this.addViewTreeEdge(result, source, target, kind, callerFile, via, line),
      ensureMethodNode: (
        method: ArkMethod,
        relativePath: string,
        result: ExtractionResult,
        parentId: string
      ) => this.ensureMethodNode(method, relativePath, result, parentId),
      resolveClassNodeId: (cls: ArkClass) => this.resolveClassNodeId(cls),
      markFieldStateDecorators: (field: ArkField, fieldNodeId: string, result: ExtractionResult) => {
        const kinds = stateDecoratorKinds(field);
        if (kinds.length === 0) return;
        const node = result.nodes.find((n) => n.id === fieldNodeId);
        if (node) node.decorators = kinds;
      },
    };
  }

  private resolveClassNodeId(cls: ArkClass): string | null {
    return this.componentToId.get(cls) ?? this.classToId.get(cls) ?? null;
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

    if (shouldSkipArkMethod(method) && !isAnonymousArkMethod(method)) return null;

    const displayName = arkMethodDisplayName(method);
    if (!displayName) return null;

    const arkFile = method.getDeclaringArkFile();
    const relativePath = normalizeRelPath(this.rootDir, arkFile.getFilePath());
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
    line: number
  ): void {
    const edge = arkEdge(source, target, kind, {
      metadata: {
        synthesizedBy: 'viewtree',
        via,
        registeredAt: `${callerFile}:${line}`,
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
    NAPI_MEMBER_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NAPI_MEMBER_CALL_RE.exec(code)) !== null) {
      const symbol = m[1]!;
      if (!isNapiSymbolName(symbol)) continue;
      const lineOffset = code.slice(0, m.index).split('\n').length - 1;
      const line = baseLine + lineOffset;
      const dedupKey = `${symbol}:${line}`;
      if (seenAtLine.has(dedupKey)) continue;
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
          const targetRel = normalizeRelPath(this.rootDir, targetFile.getFilePath());
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

function buildSceneConfig(rootDir: string) {
  return buildSceneConfigFromProject(rootDir, process.env.OHOS_SDK_HOME, {
    supportFileExts: ['.ets', '.ts', '.d.ts'],
    enableMethodBodyBuild: true,
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

function buildArkTSIndex(rootDir: string, scannedFiles: Iterable<string>): ArkTSBatchIndex {
  const { scene, errors } = tryBuildArkScene(rootDir);
  if (!scene) {
    return emptyArkTSBatchIndex(errors);
  }

  try {
    const adapter = new ArkTSAdapter(rootDir, scannedFiles);
    const index = adapter.build(scene);
    index.errors.push(...errors);
    return index;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ message: `ArkTS adapter failed: ${message}`, severity: 'error' });
    return emptyArkTSBatchIndex(errors);
  }
}
