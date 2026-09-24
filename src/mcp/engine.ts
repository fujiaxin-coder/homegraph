/**
 * MCP shared engine — the heavyweight, *shared* state for an MCP server:
 * the project's {@link HomeGraph} instance, file watcher, and the
 * {@link ToolHandler} cache for cross-project queries.
 *
 * One engine, many sessions:
 * - direct mode (single stdio session) instantiates one engine + one session;
 * - daemon mode instantiates one engine and a new session per socket
 *   connection. Every session reads from the same SQLite WAL and the same
 *   inotify watch set — that's the entire point of issue #411.
 */

import * as os from 'os';
import * as path from 'path';
import type HomeGraph from '../index';
import { findNearestHomeGraphRoot, isInitialized } from '../directory';
import { watchDisabledReason } from '../sync';
import { ToolHandler } from './tools';
import { QueryPool, resolvePoolSize } from './query-pool';
import { shouldSkipCatchUpSync } from './memory-budget';
import { getDatabasePath } from '../db';
import { resolveGraphSources, graphSourceFlags } from '../graph-sources';
import { validateProjectPath } from '../utils';
import { logLifecycle, logLifecycleError } from '../runtime-log';
import { isIndexableRoot, parseDeferProbeMs } from './indexable-root';

// Lazy-load the heavy HomeGraph chain (sqlite + query/graph/context layers) OFF
// the MCP startup path. It's only needed once a tool actually opens a project —
// not to answer initialize/tools-list — so deferring it lets `serve mcp` (and
// the daemon it spawns) bind + register tools in ~Node-startup time instead of
// ~800ms, closing the "No such tool available" cold-start race that made headless
// agents flounder. Prefer dynamic import (vitest + CJS); sync require remains for
// the sync retry path after an async load has warmed the cache (or under dist/).
let homeGraphCtor: typeof import('../index').default | null = null;

const loadHomeGraph = async (): Promise<typeof import('../index').default> => {
  if (!homeGraphCtor) {
    homeGraphCtor = (await import('../index')).default;
  }
  return homeGraphCtor;
};

const loadHomeGraphSync = (): typeof import('../index').default => {
  if (homeGraphCtor) return homeGraphCtor;
  homeGraphCtor = (require('../index') as typeof import('../index')).default;
  return homeGraphCtor;
};

export interface MCPEngineOptions {
  /**
   * Whether to start the file watcher when initializing. Daemon and direct
   * modes both want this true; tests may set it false to keep the engine
   * cheap. Honors {@link watchDisabledReason} regardless.
   */
  watch?: boolean;
  /**
   * Whether to off-load read-tool dispatch to a worker-thread pool. Only the
   * SHARED daemon wants this — concurrent clients on one event loop. Direct /
   * proxy-fallback leave it off: each worker is a second V8 + DB open and blew
   * RSS on large indexes. `CODEGRAPH_QUERY_POOL_SIZE=0` disables it in daemon
   * mode too.
   */
  queryPool?: boolean;
  /**
   * Upper bound for root resolution: an ancestor `.homegraph/` above this
   * directory is never adopted. Set from the MCP host's explicit `--path`
   * (CLI flag / client rootUri) — a stray ancestor index otherwise hijacks
   * every nested server (spec 0028). Absent → unbounded git-style walk-up.
   */
  rootFloor?: string | null;
}

/**
 * Shared MCP engine. Thread-safe in the sense that multiple sessions can
 * call its methods concurrently — internally it serializes initialization
 * through a single promise so multiple sessions racing each other on first
 * connect never double-open the SQLite file.
 */
export class MCPEngine {
  private cg: HomeGraph | null = null;
  private toolHandler: ToolHandler;
  // Project root we resolved to. Null until `ensureInitialized` succeeds
  // (or null forever if no .homegraph/ ever turned up — that's a valid
  // state for the engine, since cross-project queries still work).
  private projectPath: string | null = null;
  // Set on first `ensureInitialized` so subsequent sessions don't redo work.
  private initPromise: Promise<void> | null = null;
  private watcherStarted = false;
  private opts: Required<MCPEngineOptions>;
  private closed = false;
  // Off-loop read-tool pool (daemon mode only). Created lazily once the default
  // project is open — workers each hold their own WAL read connection.
  private queryPool: QueryPool | null = null;
  /**
   * Spec 0049: auto-init deferred because the root was empty. Probe until
   * indexable, then run the normal create-DB path once.
   */
  private deferredAutoInitRoot: string | null = null;
  private deferProbeTimer: ReturnType<typeof setInterval> | null = null;
  private deferAutoInitPromise: Promise<boolean> | null = null;

  constructor(opts: MCPEngineOptions = {}) {
    this.opts = { watch: opts.watch ?? true, queryPool: opts.queryPool ?? false, rootFloor: opts.rootFloor ?? null };
    this.toolHandler = new ToolHandler(null);
  }

  /**
   * Start the worker-thread query pool once a default project is open (daemon
   * mode only; honors `CODEGRAPH_QUERY_POOL_SIZE`). Idempotent and best-effort:
   * if workers can't spawn on this platform the ToolHandler keeps serving reads
   * in-process, so the pool can only help, never break, tool calls.
   */
  private maybeStartPool(root: string): void {
    if (!this.opts.queryPool || this.queryPool || this.closed) return;
    const size = resolvePoolSize(process.env.CODEGRAPH_QUERY_POOL_SIZE, os.cpus().length);
    if (size <= 0) {
      process.stderr.write('[CodeGraph MCP] Query pool disabled (CODEGRAPH_QUERY_POOL_SIZE=0); serving reads in-process.\n');
      return;
    }
    try {
      this.queryPool = new QueryPool({ root, size });
      this.toolHandler.setQueryPool(this.queryPool);
      process.stderr.write(`[CodeGraph MCP] Query pool: up to ${size} worker thread(s) for concurrent reads.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Query pool unavailable (${msg}); serving reads in-process.\n`);
      this.queryPool = null;
    }
  }

  /**
   * Convenience for {@link MCPServer} compatibility: pre-seed an explicit
   * project path (from the `--path` CLI flag) without yet opening it. This
   * keeps the synchronous constructor cheap; the actual open happens on the
   * first `ensureInitialized` call.
   */
  setProjectPathHint(projectPath: string): void {
    this.projectPath = projectPath;
    this.toolHandler.setDefaultProjectHint(projectPath);
  }

  /** Project root that the engine resolved on first init (null if none). */
  getProjectPath(): string | null {
    return this.projectPath;
  }

  /** Shared ToolHandler — sessions delegate tool dispatch through this. */
  getToolHandler(): ToolHandler {
    return this.toolHandler;
  }

  /**
   * Spec 0047: true while auto-init / full symbol build is in flight.
   * Used by the daemon idle timer — never idle-exit mid-build when clients=0.
   * Does not include routine watch/sync increments.
   */
  isIndexBuildInProgress(): boolean {
    if (!this.cg) return false;
    try {
      const phase = this.cg.getBuildPhase();
      return phase === 'building_fast' || phase === 'indexing';
    } catch {
      return false;
    }
  }

  /** Whether the default project's HomeGraph is open. */
  hasDefaultHomeGraph(): boolean {
    return this.toolHandler.hasDefaultHomeGraph();
  }

  /** Spec 0049: true while auto-init is waiting for an empty root to grow sources. */
  isAutoInitDeferred(): boolean {
    return this.deferredAutoInitRoot !== null && !this.toolHandler.hasDefaultHomeGraph();
  }

  /**
   * Spec 0049: on tool call (or timer), re-check the deferred root and start
   * the normal auto-init once it becomes indexable. Idempotent.
   */
  async kickDeferredAutoInit(): Promise<boolean> {
    if (this.closed || this.toolHandler.hasDefaultHomeGraph()) return false;
    const root = this.deferredAutoInitRoot;
    if (!root) return false;
    return this.tryAutoInit(root);
  }

  /**
   * Walk up from `searchFrom` to find the nearest `.homegraph/` and open it.
   * Idempotent: concurrent callers share one in-flight init; subsequent
   * callers after success are no-ops.
   *
   * The original `MCPServer.tryInitializeDefault` carried the same retry-on-
   * subsequent-tool-call semantics; we preserve them by NOT throwing when the
   * search misses (just leaves `cg` null so the next call can retry).
   */
  async ensureInitialized(searchFrom: string, floor?: string): Promise<void> {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultHomeGraph()) return;
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* let caller retry */ }
      return;
    }

    this.initPromise = this.doInitialize(searchFrom, floor).finally(() => {
      this.initPromise = null;
    });
    try {
      await this.initPromise;
    } catch {
      // Init errors are logged inside `doInitialize`; falling through here
      // matches MCPServer's previous "retry on next tool call" behavior.
    }
  }

  /**
   * Synchronous last-resort init used by the per-session retry loop when the
   * background `ensureInitialized` already finished (or failed) and we need
   * to pick up a project that appeared *after* the engine started.
   */
  retryInitializeSync(searchFrom: string, floor?: string): void {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultHomeGraph()) return;
    this.toolHandler.setDefaultProjectHint(searchFrom);
    const resolvedRoot = findNearestHomeGraphRoot(searchFrom, floor ?? this.opts.rootFloor ?? undefined);
    if (!resolvedRoot) return;
    try {
      const mode = resolveGraphSources();
      if (!graphSourceFlags(mode).openProjectDb) return;
      // Close any previously failed instance to avoid leaking resources.
      if (this.cg) {
        try { this.cg.close(); } catch { /* ignore */ }
        this.cg = null;
      }
      this.cg = loadHomeGraphSync().openSync(resolvedRoot, { sources: mode });
      this.projectPath = resolvedRoot;
      this.toolHandler.setDefaultHomeGraph(this.cg);
      this.startWatching();
      this.catchUpSync();
      this.maybeStartPool(resolvedRoot);
    } catch {
      // Still failing — caller will try again on the next tool call.
    }
  }

  /**
   * Close everything. Used on graceful daemon shutdown (SIGTERM/idle timeout)
   * and on direct-mode stop. Idempotent.
   */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearDeferProbe();
    // Detach + terminate the worker pool first so no tool call routes to a
    // worker mid-teardown; outstanding pool calls resolve with graceful guidance.
    this.toolHandler.setQueryPool(null);
    if (this.queryPool) {
      void this.queryPool.destroy();
      this.queryPool = null;
    }
    this.toolHandler.closeAll();
    if (this.cg) {
      try { this.cg.close(); } catch { /* ignore */ }
      this.cg = null;
    }
  }

  private async doInitialize(searchFrom: string, floor?: string): Promise<void> {
    this.toolHandler.setDefaultProjectHint(searchFrom);

    let resolvedRoot = findNearestHomeGraphRoot(searchFrom, floor ?? this.opts.rootFloor ?? undefined);
    if (!resolvedRoot && autoInitEnabled()) {
      const created = await this.tryAutoInit(searchFrom);
      if (created) return; // cg + watch + background index already running
      // fall through — still no index; tools return NotIndexed guidance
      this.projectPath = searchFrom;
      return;
    }
    if (!resolvedRoot) {
      // No .homegraph/ above searchFrom. Sessions may still discover one later via roots/list
      this.projectPath = searchFrom;
      return;
    }

    this.projectPath = resolvedRoot;
    try {
      const mode = resolveGraphSources();
      if (!graphSourceFlags(mode).openProjectDb) {
        process.stderr.write(
          `[HomeGraph MCP] Graph sources=${mode} — skipping project/SDK open (tools return guidance).\n`
        );
        return;
      }
      this.cg = await (await loadHomeGraph()).open(resolvedRoot, { sources: mode });
      this.toolHandler.setDefaultHomeGraph(this.cg);
      this.healBuildPhase(this.cg);
      this.startWatching();
      this.catchUpSync();
      this.maybeStartPool(resolvedRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[HomeGraph MCP] Failed to open project at ${resolvedRoot}: ${msg}\n`);
    }
  }

  /**
   * Product hosts (e.g. DevEco Code) pass `--auto-init` / HOMEGRAPH_AUTO_INIT=1 so
   * opening an unindexed workspace creates `.homegraph/`, builds a fast project
   * map (modules + files), then starts a background full index + watcher —
   * no separate `homegraph init` step for the user.
   *
   * @returns true if the engine is fully wired to a new (or racing) index
   */
  private async tryAutoInit(searchFrom: string): Promise<boolean> {
    const root = path.resolve(searchFrom);
    const invalid = validateProjectPath(root);
    if (invalid) {
      process.stderr.write(`[HomeGraph MCP] Auto-init skipped — ${invalid}\n`);
      return false;
    }
    // Race: another process finished init before we entered — open, don't bail
    // (Spec 0032). Returning false here left the session with no cg forever.
    if (isInitialized(root)) {
      this.clearDeferProbe();
      return this.openAfterAutoInitRace(root);
    }

    // Spec 0049: empty workspace — do not create `.homegraph/` (blocks
    // in-place `devecocli create`). Probe later / on tool kick.
    if (!isIndexableRoot(root)) {
      this.armDeferProbe(root);
      process.stderr.write(
        `[HomeGraph MCP] Auto-init deferred — empty root at ${root} ` +
          `(no build-profile.json5 / indexable sources yet)\n`
      );
      logLifecycle('auto-init.deferred', { projectRoot: root });
      this.projectPath = root;
      return false;
    }

    if (this.deferAutoInitPromise) {
      return this.deferAutoInitPromise;
    }

    this.deferAutoInitPromise = this.runAutoInitCreate(root).finally(() => {
      this.deferAutoInitPromise = null;
    });
    return this.deferAutoInitPromise;
  }

  /** Spec 0049: create DB + fast map + background full (shared by first hit and kick). */
  private async runAutoInitCreate(root: string): Promise<boolean> {
    this.clearDeferProbe();
    try {
      process.stderr.write(`[HomeGraph MCP] Auto-init at ${root}\n`);
      logLifecycle('auto-init.start', { projectRoot: root });
      const HomeGraph = await loadHomeGraph();
      // Create DB immediately so tools/open succeed; index in background.
      const cg = await HomeGraph.init(root, { index: false });
      // Pin empty state before returning so the first tool call cannot see `none`
      // while the async fast-map task has not started (Spec 0032).
      cg.setBuildPhase('building_fast');
      this.cg = cg;
      this.projectPath = root;
      this.toolHandler.setDefaultHomeGraph(cg);
      // Defer watch/catch-up until the full build finishes so auto-sync does not
      // contend with the same-process writer (Spec 0032).
      this.maybeStartPool(root);
      // Fast build in-process (seconds). Full build continues in *this* process
      // as a background task — no sibling CLI (avoids second writer / lock fights).
      // indexAll already yields between batches so MCP stdio can still answer
      // tools with empty/fast/syncing guidance while the full build runs.
      void (async () => {
        try {
          cg.setBuildPhase('building_fast');
          const map = cg.buildProjectMap();
          cg.setBuildPhase('fast');
          process.stderr.write(
            `[HomeGraph MCP] Fast build ready — modules=${map.modules.length} files=${map.files.length} (${map.durationMs}ms)\n`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[HomeGraph MCP] Fast build failed: ${msg}\n`);
          logLifecycleError('auto-init.fail', { projectRoot: root, phase: 'fast', msg });
        }
        this.startBackgroundFullBuild(cg);
      })();
      return true;
    } catch (err) {
      // Concurrent init from another process — treat as success path via open.
      if (await this.openAfterAutoInitRace(root)) {
        return true;
      }
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[HomeGraph MCP] Auto-init failed: ${msg}\n`);
      logLifecycleError('auto-init.fail', { projectRoot: root, msg });
      // Keep probing so a later scaffold (or retry) can still land.
      if (!isInitialized(root)) {
        this.armDeferProbe(root);
      }
      return false;
    }
  }

  /** Spec 0049: remember empty root and (optionally) poll until indexable. */
  private armDeferProbe(root: string): void {
    this.deferredAutoInitRoot = root;
    if (this.deferProbeTimer) return;
    const ms = parseDeferProbeMs(process.env.HOMEGRAPH_DEFER_PROBE_MS);
    if (ms <= 0) return;
    this.deferProbeTimer = setInterval(() => {
      if (this.closed || this.toolHandler.hasDefaultHomeGraph()) {
        this.clearDeferProbe();
        return;
      }
      const target = this.deferredAutoInitRoot;
      if (!target) {
        this.clearDeferProbe();
        return;
      }
      if (!isIndexableRoot(target)) return;
      void this.tryAutoInit(target).then((ok) => {
        if (ok) this.clearDeferProbe();
      });
    }, ms);
    // Don't keep the process alive solely for the probe in direct mode.
    if (typeof this.deferProbeTimer.unref === 'function') {
      this.deferProbeTimer.unref();
    }
  }

  private clearDeferProbe(): void {
    this.deferredAutoInitRoot = null;
    if (this.deferProbeTimer) {
      clearInterval(this.deferProbeTimer);
      this.deferProbeTimer = null;
    }
  }

  /**
   * Open an index another process just created (Spec 0032 cold-start race).
   * Brief retries cover the window between mkdir and db file create.
   */
  private async openAfterAutoInitRace(root: string): Promise<boolean> {
    const mode = resolveGraphSources();
    if (!graphSourceFlags(mode).openProjectDb) return false;

    for (let i = 0; i < 25; i++) {
      if (!isInitialized(root)) {
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      try {
        process.stderr.write(`[HomeGraph MCP] Auto-init raced; opening existing index at ${root}\n`);
        this.cg = await (await loadHomeGraph()).open(root, { sources: mode });
        this.projectPath = root;
        this.toolHandler.setDefaultHomeGraph(this.cg);
        this.healBuildPhase(this.cg);
        this.startWatching();
        this.catchUpSync();
        this.maybeStartPool(root);
        return true;
      } catch (openErr) {
        const msg = openErr instanceof Error ? openErr.message : String(openErr);
        process.stderr.write(`[HomeGraph MCP] Auto-init open-after-race retry: ${msg}\n`);
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    return false;
  }

  /**
   * If a previous auto-init child finished indexing but never flipped
   * build_phase (MCP died mid-flight), heal so deep tools unlock.
   */
  private healBuildPhase(cg: HomeGraph): void {
    try {
      const phase = cg.getBuildPhase();
      if (phase === 'full') return;
      const state = cg.getQueryBuilder().getMetadata('index_state');
      if (state === 'complete' || state === 'partial') {
        cg.setBuildPhase('full');
        process.stderr.write(`[HomeGraph MCP] Healed build_phase → full (index_state=${state})\n`);
        return;
      }
      // Symbols present after a full-build attempt — unlock deep tools even if
      // metadata stayed on indexing/fast (crash mid-flight or soft fail).
      let nodes = 0;
      try {
        nodes = cg.getStats().nodeCount;
      } catch {
        return;
      }
      if (nodes > 0 && state !== 'failed' && (phase === 'indexing' || phase === 'fast')) {
        cg.setBuildPhase('full');
        process.stderr.write(
          `[HomeGraph MCP] Healed build_phase → full (nodes=${nodes}, index_state=${state ?? 'null'})\n`,
        );
      }
    } catch {
      /* advisory */
    }
  }

  /**
   * Full symbol build in this MCP/daemon process (Spec 0032).
   * Fire-and-forget: MCP tools keep answering with empty/fast/syncing while
   * indexAll yields between batches. One writer — no sibling CLI process.
   */
  private startBackgroundFullBuild(cg: HomeGraph): void {
    cg.setBuildPhase('indexing');
    process.stderr.write('[HomeGraph MCP] Full build starting in-process (background)\n');
    let projectRoot: string | undefined;
    try {
      projectRoot = cg.getProjectRoot();
    } catch {
      projectRoot = this.projectPath ?? undefined;
    }
    logLifecycle('index.start', { projectRoot, via: 'auto-init' });
    void cg
      .indexAll()
      .then((result) => {
        const files =
          result && typeof result === 'object' && 'filesIndexed' in result
            ? Number((result as { filesIndexed?: number }).filesIndexed ?? 0)
            : 0;
        const ok = !result || (result as { success?: boolean }).success !== false;
        let nodes = 0;
        try {
          nodes = cg.getStats().nodeCount;
        } catch {
          /* busy */
        }
        // Prefer symbols on disk over a soft failure flag — agents must unlock
        // deep tools once a usable graph exists.
        if (ok || nodes > 0 || files > 0) {
          cg.setBuildPhase('full');
          process.stderr.write(
            `[HomeGraph MCP] Full build complete — files=${files || '?'} nodes=${nodes}` +
              (ok ? '\n' : ' (soft-fail but symbols present)\n'),
          );
          logLifecycle('index.done', { projectRoot, files, nodes });
          logLifecycle('auto-init.done', { projectRoot, files, nodes });
        } else {
          cg.setBuildPhase('fast');
          process.stderr.write('[HomeGraph MCP] Full build finished with no symbols — staying on fast map\n');
          logLifecycle('index.done', { projectRoot, files: 0, nodes: 0, note: 'no-symbols' });
        }
        this.startWatchingAfterAutoInit();
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[HomeGraph MCP] Full build failed: ${msg}\n`);
        logLifecycleError('index.fail', { projectRoot, msg });
        try {
          let nodes = 0;
          try {
            nodes = cg.getStats().nodeCount;
          } catch {
            /* ignore */
          }
          cg.setBuildPhase(nodes > 0 ? 'full' : 'fast');
          if (nodes > 0) {
            process.stderr.write(
              `[HomeGraph MCP] Full build error after symbols written — phase=full (nodes=${nodes})\n`,
            );
          }
        } catch {
          /* ignore */
        }
        this.startWatchingAfterAutoInit();
      });
  }

  /** Enable watch + catch-up once auto-init full build is done (or gave up). */
  private startWatchingAfterAutoInit(): void {
    if (this.watcherStarted) return;
    this.startWatching();
    this.catchUpSync();
  }

  /**
   * Start file watching on the active HomeGraph instance. Idempotent — the
   * watcher is per-engine, not per-session, which is why the daemon path
   * collapses N inotify sets to one. The wording of the disabled-reason log
   * exactly matches the prior in-tree implementation so log-driven dashboards
   * keep working.
   */
  private startWatching(): void {
    if (!this.cg || this.watcherStarted || !this.opts.watch) return;

    const disabledReason = watchDisabledReason(this.projectPath ?? process.cwd());
    if (disabledReason) {
      process.stderr.write(
        `[HomeGraph MCP] File watcher disabled — ${disabledReason}. ` +
        `The graph will not auto-update; run \`homegraph sync\` (or install the git sync hooks via \`homegraph init\`) to refresh.\n`
      );
      this.watcherStarted = true;
      return;
    }

    // Optional overrides:
    // - HOMEGRAPH_WATCH_FIXED_WINDOW_MS: first-change fixed window (e.g. 300000 = 5min),
    //   later edits in the window do not extend the timer (product hosts / DevEco).
    // - HOMEGRAPH_WATCH_DEBOUNCE_MS: classic trailing quiet window ([100ms, 60s]).
    const fixedWindowMs = parseFixedWindowEnv(process.env.HOMEGRAPH_WATCH_FIXED_WINDOW_MS);
    const debounceMs = fixedWindowMs ?? parseDebounceEnv(process.env.HOMEGRAPH_WATCH_DEBOUNCE_MS);
    if (fixedWindowMs !== undefined) {
      process.stderr.write(
        `[HomeGraph MCP] File watcher fixed window: ${fixedWindowMs}ms ` +
          `(HOMEGRAPH_WATCH_FIXED_WINDOW_MS; first change starts timer, later changes do not extend)\n`
      );
    } else if (debounceMs !== undefined) {
      process.stderr.write(`[HomeGraph MCP] File watcher debounce: ${debounceMs}ms (HOMEGRAPH_WATCH_DEBOUNCE_MS)\n`);
    }

    const started = this.cg.watch({
      debounceMs,
      fixedWindow: fixedWindowMs !== undefined,
      onSyncComplete: (result) => {
        if (result.filesChanged > 0) {
          process.stderr.write(
            `[HomeGraph MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms\n`
          );
        }
      },
      onSyncError: (err) => {
        process.stderr.write(`[HomeGraph MCP] Auto-sync error: ${err.message}\n`);
      },
      onDegraded: (reason) => {
        // Live watching gave up permanently (watch-resource exhaustion or a
        // write lock held past the retry budget). Say so loudly and ONCE — the
        // graph will no longer auto-update, so a long-running MCP session must
        // not keep assuming it's fresh. The reason already names the remedy
        // (`homegraph sync` / git sync hooks).
        process.stderr.write(`[HomeGraph MCP] File watcher degraded — ${reason}\n`);
      },
    });

    this.watcherStarted = true;
    if (started) {
      process.stderr.write('[HomeGraph MCP] File watcher active — graph will auto-sync on changes\n');
    } else {
      process.stderr.write(
        '[HomeGraph MCP] File watcher unavailable on this platform — run `homegraph sync` to refresh the graph after changes.\n'
      );
    }
  }

  /**
   * Reconcile the index with the current filesystem once, right after open —
   * catches edits, adds, deletes, and `git pull`/`checkout` changes made while
   * no watcher was running. Runs in the background, but the returned promise
   * is pushed into the ToolHandler as a one-shot gate so the *first* tool
   * call awaits completion before serving (without this, a tool call that
   * races past sync returns rows for files that no longer exist on disk —
   * and the per-file staleness banner can't help because `getPendingFiles()`
   * is populated by the watcher, not by catch-up).
   */
  private catchUpSync(): void {
    const cg = this.cg;
    if (!cg) return;
    let dbPath: string | null = null;
    try {
      dbPath = getDatabasePath(cg.getProjectRoot());
    } catch {
      dbPath = null;
    }
    if (shouldSkipCatchUpSync(dbPath)) {
      process.stderr.write(
        '[HomeGraph MCP] Skipping catch-up sync (large index / HOMEGRAPH_SKIP_CATCHUP_SYNC). ' +
          'Run `homegraph sync` if the graph may be stale.\n',
      );
      return;
    }
    const p = cg
      .sync()
      .then((result) => {
        const changed = result.filesAdded + result.filesModified + result.filesRemoved;
        if (changed > 0) {
          process.stderr.write(`[HomeGraph MCP] Caught up ${changed} file(s) changed since last run\n`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[HomeGraph MCP] Catch-up sync failed: ${msg}\n`);
      });
    this.toolHandler.setCatchUpGate(p);
  }
}

/** DevEco / product hosts opt in via `--auto-init` or HOMEGRAPH_AUTO_INIT=1. */
function autoInitEnabled(): boolean {
  const v = (process.env.HOMEGRAPH_AUTO_INIT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Parse HOMEGRAPH_WATCH_FIXED_WINDOW_MS — first-change fixed coalesce window.
 * Range: 1s … 30min. Used by product hosts (e.g. DevEco Code = 5 minutes).
 */
export function parseFixedWindowEnv(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 1000 || n > 30 * 60 * 1000) return undefined;
  return n;
}

export { isIndexableRoot, parseDeferProbeMs } from './indexable-root';

/**
 * Parse and clamp the HOMEGRAPH_WATCH_DEBOUNCE_MS env override.
 *
 * Issue #403: workspaces with bursty writes (formatter-on-save, multi-file
 * refactors) sometimes want a longer quiet window before sync. Returns
 * `undefined` for unset / empty / non-numeric / out-of-range values so the
 * FileWatcher default (2000ms) takes over — never throws.
 *
 * Clamp range: 100ms (faster would mean a sync per keystroke) to 60s (longer
 * and the watcher feels broken). Out-of-range values are treated as "ignore
 * this misconfiguration" rather than capped, since silently capping a 0 or
 * a typoed value would mask a real config bug.
 */
export function parseDebounceEnv(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 100 || n > 60000) return undefined;
  return n;
}
