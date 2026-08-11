/**
 * HomeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'path';
import {
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
  SegmentMatch,
  NodeKind,
} from './types';
import { DatabaseConnection, getDatabasePath, removeDatabaseFiles } from './db';
import { WalCheckpointValve, resolveWalValveMb } from './db/wal-valve';
import { QueryBuilder } from './db/queries';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
} from './directory';
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexResult,
  SyncResult,
  extractFromSource,
  initGrammars,
} from './extraction';
import { bindExtractionContext } from './extraction/context';
import {
  bindOhosApiDbForProject,
  attachExistingOhosApiDbForProject,
  restoreOhosApiDbAttach,
  ohosApiDbPackageName,
  resetArkTSBatch,
  type OhosApiDbBinding,
  OHOS_API_DB_PATH_META,
  OHOS_API_VERSION_META,
} from './extraction/languages/arkts';
import {
  ReferenceResolver,
  createResolver,
  ResolutionResult,
} from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import {
  buildArkUIMigrateSnapshot,
  type ArkUIMigrateSnapshot,
} from './arkui/migrate-snapshot';
import { ContextBuilder, createContextBuilder } from './context';
import { Mutex, FileLock } from './utils';
import { FileWatcher, WatchOptions, PendingFile, LockUnavailableError } from './sync';
import { EXTRACTION_VERSION } from './extraction/extraction-version';
import { getHomeGraphDir } from './directory';
import { deriveProjectNameTokens } from './search/query-utils';
import { segmentLookupVariants, splitIdentifierSegments } from './search/identifier-segments';
import { createYielder } from './resolution/cooperative-yield';
import { minRefsForPool } from './resolution/resolver-pool';
import { HomeGraphPackageVersion } from './mcp/version';
import {
  type GraphSourcesMode,
  resolveGraphSources,
  graphSourceFlags,
} from './graph-sources';

// Re-export types for consumers
export * from './types';
export {
  type GraphSourcesMode,
  GRAPH_SOURCES_ENV,
  GRAPH_SOURCES_MODES,
  resolveGraphSources,
  graphSourceFlags,
  parseGraphSourcesMode,
} from './graph-sources';
// Storage building blocks for embedded/SDK consumers that drive the graph
// directly (open a DB, run prepared queries) rather than through the HomeGraph
// facade. Exposed from the package entry so they no longer require deep imports
// into dist/ (issue #354).
export { getDatabasePath, DatabaseConnection } from './db';
export { QueryBuilder } from './db/queries';
export {
  getHomeGraphDir,
  isInitialized,
  findNearestHomeGraphRoot,
  HOMEGRAPH_DIR,
} from './directory';
export { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './extraction';
export { ResolutionResult } from './resolution';
export {
  HomeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { FileWatcher, WatchOptions, PendingFile, LockUnavailableError } from './sync';
export { MCPServer } from './mcp';
export {
  buildArkUIMigrateSnapshot,
  ARKUI_MIGRATE_SCHEMA_VERSION,
  DEFAULT_DIRECTORY_COMPONENT_LIMIT,
  type ArkUIMigrateSnapshot,
} from './arkui';
// Addon contract (api 1) — types addon authors import from 'homegraph'
// (see the `homegraph addon init` scaffold). Only types: no runtime code is
// pulled into the host by re-exporting them.
export type {
  AddonCommitInput,
  EnrichInput,
  Supplement,
  BuildPromptContext,
  SpecMineAddon,
} from './spec/mine/addon/types';

/**
 * Options for initializing a new HomeGraph project
 */
export interface InitOptions {
  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing HomeGraph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;

  /**
   * Which graph sources to use for lookups (project index and/or OHOS SDK API).
   * Defaults to `HOMEGRAPH_SOURCES` env, then `both`. See Spec 0005.
   */
  sources?: GraphSourcesMode | string;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;

  /** Watcher fast path: reconcile ONLY these project-relative paths (see ExtractionOrchestrator.sync). */
  paths?: string[];
}

/**
 * Main HomeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class HomeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private projectRoot: string;
  // Assigned via wireLayers() from the constructor (and again on reopen) — the
  // `!` tells TS these are definitely set even though the assignment is one
  // method call away from the constructor body.
  private orchestrator!: ExtractionOrchestrator;
  private resolver!: ReferenceResolver;
  private graphManager!: GraphQueryManager;
  private traverser!: GraphTraverser;
  private contextBuilder!: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  private indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  private fileLock: FileLock;

  // File watcher for auto-sync on file changes
  private watcher: FileWatcher | null = null;

  /** Effective graph sources for this instance (Spec 0005). */
  private graphSources: GraphSourcesMode;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    projectRoot: string,
    sources?: GraphSourcesMode
  ) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    this.graphSources = sources ?? 'both';
    bindExtractionContext(projectRoot, queries);
    this.fileLock = new FileLock(
      path.join(getHomeGraphDir(projectRoot), 'homegraph.lock')
    );
    this.wireLayers();
  }

  /**
   * (Re)build the query/extraction/graph layers over the current `this.queries`
   * (which wraps `this.db`). Factored out of the constructor so `reopenIfReplaced`
   * can rebuild them against a fresh connection without duplicating the wiring.
   * The path-based `fileLock` is independent of the DB handle, so it stays put.
   */
  private wireLayers(): void {
    // Down-weight the project name as a query term in search ranking — it names
    // the whole repo, not a symbol, so it has no discriminative value (#720).
    try {
      this.queries.setProjectNameTokens(deriveProjectNameTokens(this.projectRoot));
    } catch {
      // Best-effort: ranking still works without it.
    }
    this.orchestrator = new ExtractionOrchestrator(this.projectRoot, this.queries);
    this.resolver = createResolver(this.projectRoot, this.queries);
    this.graphManager = new GraphQueryManager(this.queries);
    this.traverser = new GraphTraverser(this.queries);
    this.contextBuilder = createContextBuilder(
      this.projectRoot,
      this.queries,
      this.traverser
    );
    const flags = graphSourceFlags(this.graphSources);
    this.queries.setIncludeProjectNodes(flags.project);
    if (flags.sdk) {
      restoreOhosApiDbAttach(this.queries);
      if (!this.queries.getOhosApiDbPath()) {
        // Open path: attach a prebuilt ~/.homegraph/api db only — never build here.
        attachExistingOhosApiDbForProject(this.projectRoot, this.queries);
      }
    } else {
      this.queries.attachOhosApiDb(null);
    }
  }

  /**
   * Heal a stale database handle in place. If `.homegraph/` was removed and
   * recreated at the SAME path while this instance held the DB open — a git
   * worktree removed and re-added, or `rm -rf .homegraph` + `homegraph init` —
   * our open fd points at the now-unlinked inode and can never see the new
   * index, so every query returns the pre-removal snapshot until the process
   * restarts (#925). When that's detected, open the live file at the same path,
   * rebuild the query layers, and swap them IN PLACE, so every holder of this
   * instance (the MCP daemon's default project, cached projectPath connections)
   * heals without a restart. Returns true iff it reopened.
   *
   * POSIX-only in practice: `isReplacedOnDisk` never fires on Windows (an open
   * file can't be unlinked there, and st_ino is unreliable).
   */
  reopenIfReplaced(): boolean {
    if (!this.db.isReplacedOnDisk()) return false;
    const dbPath = this.db.getPath();
    // Open the live file FIRST — if that throws (e.g. mid-recreate), the old
    // handle stays in place and the caller retries on the next query, rather
    // than leaving this instance with no connection at all.
    const fresh = DatabaseConnection.open(dbPath);
    const stale = this.db;
    this.db = fresh;
    this.queries = new QueryBuilder(fresh.getDb());
    this.wireLayers();
    // Releasing the dead handle also frees the leaked db/-wal/-shm fds that were
    // pinning the unlinked inode (#925).
    try { stale.close(); } catch { /* the old inode is gone; closing just frees fds */ }
    return true;
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new HomeGraph project
   *
   * Creates the .HomeGraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new HomeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<HomeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`HomeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new HomeGraph(db, queries, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string): HomeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`HomeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new HomeGraph(db, queries, resolvedRoot);
  }

  /**
   * Open an existing HomeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A HomeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<HomeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);
    const sources = resolveGraphSources(options.sources);
    if (!graphSourceFlags(sources).openProjectDb) {
      throw new Error(
        `Cannot open HomeGraph when graph sources are "${sources}". ` +
          `Use --sources both|project|sdk or unset HOMEGRAPH_SOURCES.`
      );
    }

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`HomeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid HomeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new HomeGraph(db, queries, resolvedRoot, sources);

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Rebuild the project's database from scratch and return a fresh, empty
   * instance — the "same result as a fresh init" semantics that `codegraph
   * index` documents.
   *
   * Unlike `open()` followed by `clear()`, this DISCARDS the existing
   * `.codegraph/codegraph.db` (and its `-wal`/`-shm` sidecars) before
   * re-initializing, instead of opening the old database and DELETE-ing every
   * row. On a large or pre-fix poisoned index — e.g. an old graph that scanned
   * an ignored gitlink corpus (#1065) into ~1.6M nodes with a multi-GB WAL —
   * the per-row `nodes_fts` delete-trigger churn blocks the main thread long
   * enough to trip the #850 liveness watchdog before indexing even starts, so a
   * full re-index could never recover the bad state (#1067). Discarding the
   * files is O(1) regardless of size, reclaims the disk, and sidesteps opening
   * (and running migrations against) the poisoned database entirely.
   */
  static async recreate(projectRoot: string): Promise<HomeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized — recreate REBUILDS an existing project; it is not a
    // first-time `init`.
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`HomeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    const dbPath = getDatabasePath(resolvedRoot);
    try {
      removeDatabaseFiles(dbPath);
    } catch (err) {
      // POSIX unlinks an open file fine; this fires mainly on Windows when a
      // live daemon/MCP server still holds the database. Turn the raw EBUSY into
      // an actionable instruction instead of a generic failure.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not rebuild the index — the database file is in use (${reason}). ` +
          `Stop any running HomeGraph MCP server/daemon for this project and retry, ` +
          `or remove the ${getHomeGraphDir(resolvedRoot)} directory and run "homegraph init".`
      );
    }

    // Re-create an empty, freshly-schema'd database at the same path.
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new HomeGraph(db, queries, resolvedRoot);
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string, options: OpenOptions = {}): HomeGraph {
    const resolvedRoot = path.resolve(projectRoot);
    const sources = resolveGraphSources(options.sources);
    if (!graphSourceFlags(sources).openProjectDb) {
      throw new Error(
        `Cannot open HomeGraph when graph sources are "${sources}". ` +
          `Use --sources both|project|sdk or unset HOMEGRAPH_SOURCES.`
      );
    }

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`HomeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid HomeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new HomeGraph(db, queries, resolvedRoot, sources);
  }

  /**
   * Check if a directory has been initialized as a HomeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Close the HomeGraph instance and release resources
   */
  close(): void {
    this.unwatch();
    // Release file lock if held
    this.fileLock.release();
    this.db.close();
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /** Effective graph sources for this open (`both` | `project` | `sdk`). */
  getGraphSources(): GraphSourcesMode {
    return this.graphSources;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      const freshDb = this.queries.getNodeAndEdgeCount().nodes === 0;
      const fastInit = process.env.HOMEGRAPH_NO_FAST_INIT !== '1' && freshDb;
      if (fastInit) {
        try {
          this.db.getDb().pragma('journal_mode = MEMORY');
          this.db.getDb().pragma('synchronous = OFF');
        } catch { /* keep WAL */ }
      }
      const deferWal = !fastInit && process.env.HOMEGRAPH_NO_WAL_DEFER !== '1' && this.db.getJournalMode() === 'wal';
      let walValve: WalCheckpointValve | null = null;
      let priorAutocheckpoint = 1000;
      let restoreAutocheckpoint = false;
      if (deferWal) {
        priorAutocheckpoint = this.db.getWalAutocheckpoint();
        this.db.setWalAutocheckpoint(0);
        walValve = new WalCheckpointValve(
          this.db,
          resolveWalValveMb(process.env.HOMEGRAPH_WAL_VALVE_MB, this.db.getDbFileSizeBytes()),
          undefined,
          options.verbose ? (m) => console.log(`[wal-valve] ${m}`) : undefined
        );
        walValve.start();
      }
      try {
        const before = this.queries.getNodeAndEdgeCount();
        try { this.queries.setMetadata('index_state', 'indexing'); } catch { /* metadata is advisory */ }
        try { this.queries.clearNameSegmentVocab(); } catch { /* vocab is advisory — never fail an index over it */ }
        this.db.beginBulkNodeLoad();
        if (freshDb) this.db.beginBulkParseLoad();
        let result: IndexResult;
        try {
          result = await this.orchestrator.indexAll(
            options.onProgress,
            options.signal,
            options.verbose,
            walValve ? () => walValve!.backpressure() : undefined,
            freshDb ? { dbPath: this.db.getPath(), fastInit } : null
          );
        } finally {
          if (freshDb) {
            const tIdx = Date.now();
            await this.db.endBulkParseLoad();
            if (process.env.HOMEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] parse-index-rebuild: ${Date.now() - tIdx}ms`);
          }
          const tFts = Date.now();
          this.db.endBulkNodeLoad();
          if (process.env.HOMEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] fts-rebuild: ${Date.now() - tFts}ms`);
        }

        if (walValve) await walValve.foldNow();

        if (result.success && result.filesIndexed > 0) {
          this.resolver.initialize();
          this.resolver.runPostExtract();
        }

        if (result.success && result.filesIndexed > 0) {
          const unresolvedCount = this.queries.getUnresolvedReferencesCount();

          if (fastInit && unresolvedCount >= minRefsForPool()) {
            try {
              this.db.getDb().pragma('synchronous = NORMAL');
              this.db.getDb().pragma('journal_mode = WAL');
              priorAutocheckpoint = this.db.getWalAutocheckpoint();
              this.db.setWalAutocheckpoint(0);
              restoreAutocheckpoint = true;
              walValve = new WalCheckpointValve(
                this.db,
                undefined,
                undefined,
                options.verbose ? (m) => console.log(`[wal-valve] ${m}`) : undefined
              );
              walValve.start();
            } catch { /* keep current mode; resolution still works sequentially */ }
          }

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

          await this.resolveReferencesBatched(
            (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            },
            (done, totalPasses) => {
              options.onProgress?.({
                phase: 'linking',
                current: done,
                total: totalPasses,
              });
            },
            walValve ? () => walValve!.backpressure() : undefined
          );

          await this.resolver.resolveChainedCallsViaConformance();
          await this.resolver.resolveDeferredThisMemberRefs();
        }

        if (result.success && result.filesIndexed > 0) {
          if (walValve) { walValve.stop(); await walValve.drain(); }
          await this.db.runMaintenance();
        }

        if (result.success && result.filesIndexed > 0) {
          const after = this.queries.getNodeAndEdgeCount();
          result.nodesCreated = after.nodes - before.nodes;
          result.edgesCreated = after.edges - before.edges;
        }

        if (result.success && result.filesIndexed > 0) {
          try {
            this.queries.setMetadata('indexed_with_version', HomeGraphPackageVersion);
            this.queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION));
          } catch { /* metadata is advisory — never fail an index over it */ }

          const languages = Object.entries(this.getStats().filesByLanguage)
            .filter(([, count]) => count > 0)
            .map(([lang]) => lang);
          const ohosBinding = await bindOhosApiDbForProject(
            this.projectRoot,
            this.queries,
            languages,
            { build: true, onProgress: options.onProgress }
          );
          if (ohosBinding && 'code' in ohosBinding) {
            result.errors.push({ message: ohosBinding.message, severity: 'warning', code: ohosBinding.code });
          }
        }

        try {
          if (!result.success) {
            this.queries.setMetadata('index_state', 'failed');
          } else {
            const accounted = result.filesIndexed + result.filesSkipped + result.filesErrored;
            const discovered = result.filesDiscovered;
            const shortfall = discovered !== undefined ? discovered - accounted : 0;
            if (discovered !== undefined && shortfall > 0) {
              this.queries.setMetadata('index_state', 'partial');
              this.queries.setMetadata('index_files_discovered', String(discovered));
              this.queries.setMetadata('index_files_accounted', String(accounted));
              result.errors.push({
                message: `Index is missing ${shortfall} of ${discovered} discovered files (indexed ${result.filesIndexed}, skipped ${result.filesSkipped}, errored ${result.filesErrored}). The index is PARTIAL — re-run \`homegraph index\`.`,
                severity: 'warning',
                code: 'index_partial',
              });
            } else {
              this.queries.setMetadata('index_state', 'complete');
              if (discovered !== undefined) {
                this.queries.setMetadata('index_files_discovered', String(discovered));
                this.queries.setMetadata('index_files_accounted', String(accounted));
              }
            }
          }
        } catch { /* metadata is advisory — never fail an index over it */ }

        return result;
      } finally {
        if (walValve) { walValve.stop(); await walValve.drain(); }
        if (deferWal || restoreAutocheckpoint) {
          try { this.db.setWalAutocheckpoint(priorAutocheckpoint); } catch { /* connection may be closing */ }
        }
        if (fastInit) {
          try {
            this.db.getDb().pragma('synchronous = NORMAL');
            this.db.getDb().pragma('journal_mode = WAL');
          } catch { /* connection may be closing */ }
        }
        this.fileLock.release();
      }
    });
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        return this.orchestrator.indexFiles(filePaths);
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      const deferWal = process.env.HOMEGRAPH_NO_WAL_DEFER !== '1' && this.db.getJournalMode() === 'wal';
      let walValve: WalCheckpointValve | null = null;
      let priorAutocheckpoint = 1000;
      if (deferWal) {
        priorAutocheckpoint = this.db.getWalAutocheckpoint();
        this.db.setWalAutocheckpoint(0);
        walValve = new WalCheckpointValve(
          this.db,
          resolveWalValveMb(process.env.HOMEGRAPH_WAL_VALVE_MB, this.db.getDbFileSizeBytes()),
          undefined,
          options.verbose ? (m) => console.log(`[wal-valve] ${m}`) : undefined
        );
        walValve.start();
      }
      try {
        const vocabWasEmpty = (() => {
          try { return this.queries.isNameSegmentVocabEmpty(); } catch { return false; }
        })();

        const result = await this.orchestrator.sync(options.onProgress, options.paths);

        if (walValve) await walValve.foldNow();

        if (result.filesAdded > 0 || result.filesModified > 0) {
          this.resolver.runPostExtract();
        } else if (result.filesRemoved > 0) {
          this.resolver.clearCaches();
        }

        const filesChanged = result.filesAdded > 0 || result.filesModified > 0;
        const backpressure = walValve ? () => walValve!.backpressure() : undefined;
        if (filesChanged) {
          if (result.changedFilePaths) {
            const tRefLoad = Date.now();
            const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);
            if (process.env.HOMEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] sync-ref-load: ${Date.now() - tRefLoad}ms (${unresolvedRefs.length} refs)`);

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedRefs.length,
            });

            this.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });

            const tRetry = Date.now();
            const retryable = this.queries.getRetryableFailedReferences(
              this.queries.getNodeNamesByFiles(result.changedFilePaths)
            );
            if (retryable.length > 0) {
              options.onProgress?.({
                phase: 'resolving',
                current: 0,
                total: retryable.length,
              });
              await this.resolver.resolveAndPersistListYielding(retryable);
              options.onProgress?.({
                phase: 'resolving',
                current: retryable.length,
                total: retryable.length,
              });
            }
            if (process.env.HOMEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] sync-failed-ref-retry: ${Date.now() - tRetry}ms (${retryable.length} refs)`);
          } else {
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            await this.resolveReferencesBatched(
              (current, total) => {
                options.onProgress?.({
                  phase: 'resolving',
                  current,
                  total,
                });
              },
              (done, totalPasses) => {
                options.onProgress?.({
                  phase: 'linking',
                  current: done,
                  total: totalPasses,
                });
              },
              backpressure
            );
          }
        }

        // Re-open resolution edges this sync may have invalidated ELSEWHERE in
        // the repo. Everything above re-resolves references in the changed
        // files; this covers the opposite direction — references in files the
        // sync never touched whose answer depended on a definition that just
        // appeared or disappeared. Without it a synced index never converges
        // to a full rebuild. The resurrected refs are pending rows, so the
        // orphan sweep immediately below is what resolves them — batched,
        // yielding, multi-pass, exactly as a full index resolves.
        //
        // `definitionDelta` is empty for a body-only edit, so the overwhelmingly
        // common sync pays one branch. HOMEGRAPH_NO_REBIND=1 disables it.
        if (result.definitionDelta && process.env.HOMEGRAPH_NO_REBIND !== '1') {
          const tRebind = Date.now();
          const rebound = this.orchestrator.resurrectStaleResolutionEdges(
            result.definitionDelta,
            result.changedFilePaths ?? []
          );
          if (process.env.HOMEGRAPH_SYNTH_TIMINGS) {
            console.error(
              `[phase-timing] sync-rebind: ${Date.now() - tRebind}ms (${result.definitionDelta.length} changed names, ${rebound} edges re-opened)`
            );
          }
        }

        const orphanCount = this.queries.getUnresolvedReferencesCount();
        if (orphanCount > 0) {
          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: orphanCount,
          });

          await this.resolveReferencesBatched(
            (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            },
            (done, totalPasses) => {
              options.onProgress?.({
                phase: 'linking',
                current: done,
                total: totalPasses,
              });
            },
            backpressure
          );
        }

        if (filesChanged || orphanCount > 0) {
          await this.resolver.resolveChainedCallsViaConformance();
          await this.resolver.resolveDeferredThisMemberRefs();
        }

        if (filesChanged || result.filesRemoved > 0 || orphanCount > 0) {
          await this.db.runMaintenance();
        }

        try {
          if (vocabWasEmpty && this.queries.getNodeAndEdgeCount().nodes > 0) {
            await this.rebuildNameSegmentVocab();
          }
        } catch { /* vocab is advisory — never fail a sync over it */ }

        return result;
      } finally {
        if (walValve) { walValve.stop(); await walValve.drain(); }
        if (deferWal) {
          try { this.db.setWalAutocheckpoint(priorAutocheckpoint); } catch { /* connection may be closing */ }
        }
        this.fileLock.release();
      }
    });
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   *
   * @param options - Watch options (debounce delay, callbacks)
   * @returns true if watching started successfully
   */
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      async (paths?: string[]) => {
        const result = await this.sync({ paths });
        // sync() returns this exact zero-shape iff it failed to acquire the
        // file lock (a real empty sync always has filesChecked > 0 because
        // scanDirectory ran). Surface that to the watcher as a typed error
        // so it keeps pendingFiles + reschedules instead of clearing them
        // (#449).
        if (result.filesChecked === 0 && result.durationMs === 0) {
          throw new LockUnavailableError();
        }
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options
    );

    return this.watcher.start();
  }

  /**
   * Stop watching for file changes.
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * Check if the file watcher is active.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * True once live watching has permanently degraded (OS watch-resource
   * exhaustion, or a write lock held past the retry budget) and auto-sync is
   * disabled until the next {@link watch} call. Distinct from `!isWatching()`:
   * a stopped/never-started watcher is inactive but NOT degraded. MCP tools use
   * this to surface a whole-index "results may be stale" notice, since
   * `getPendingFiles()` goes empty once watching stops (#876).
   */
  isWatcherDegraded(): boolean {
    return this.watcher?.isDegraded() ?? false;
  }

  /** The reason live watching degraded, or null if it is healthy (#876). */
  getWatcherDegradedReason(): string | null {
    return this.watcher?.getDegradedReason() ?? null;
  }

  /**
   * Files seen by the file watcher since the last successful sync —
   * the per-file "stale" signal MCP tools attach to responses so an agent
   * can fall back to {@link Read} for just the affected file without
   * waiting for a debounced sync to complete (issue #403).
   *
   * Returns an empty list when the watcher isn't active, or no events have
   * arrived. Each entry includes `firstSeenMs` and `lastSeenMs` (wall-clock
   * `Date.now()` values) so callers can render "edited Nms ago", plus an
   * `indexing` flag indicating whether the in-flight sync (if any) will
   * absorb that file.
   */
  getPendingFiles(): PendingFile[] {
    return this.watcher?.getPendingFiles() ?? [];
  }

  /**
   * Resolves once the file watcher has installed its watch set. Useful for
   * tests that need a deterministic boundary before asserting on
   * `getPendingFiles()`. Resolves immediately when no watcher is active.
   */
  waitUntilWatcherReady(timeoutMs?: number): Promise<void> {
    return this.watcher ? this.watcher.waitUntilReady(timeoutMs) : Promise.resolve();
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Most recent index timestamp (ms since epoch) across all tracked files, or
   * null when nothing is indexed yet. Lets library consumers check index
   * freshness without shelling out to `homegraph status --json`. (#329)
   */
  getLastIndexedAt(): number | null {
    return this.queries.getLastIndexedAt();
  }

  /**
   * Access the underlying query layer. Used by the MCP query-cache layer.
   */
  getQueryBuilder(): QueryBuilder {
    return this.queries;
  }

  /**
   * Completeness of the last full index run. `'complete'` is the only good
   * state. `'indexing'` after the fact means a run was killed mid-index;
   * `'partial'` means the run finished but silently dropped files;
   * `'failed'` means it reported failure. `null` = index predates this marker.
   */
  getIndexState(): 'indexing' | 'complete' | 'partial' | 'failed' | null {
    const raw = this.queries.getMetadata('index_state');
    return raw === 'indexing' || raw === 'complete' || raw === 'partial' || raw === 'failed'
      ? raw
      : null;
  }

  /**
   * Which engine built the current index: the package version + extraction
   * version stamped at the last full `indexAll`. Either field is null for an
   * index built before stamping existed (treated as stale). See
   * `extraction-version.ts` and `isIndexStale()`.
   */
  getIndexBuildInfo(): { version: string | null; extractionVersion: number | null } {
    const version = this.queries.getMetadata('indexed_with_version');
    const ev = this.queries.getMetadata('indexed_with_extraction_version');
    const parsed = ev != null ? parseInt(ev, 10) : NaN;
    return { version, extractionVersion: Number.isFinite(parsed) ? parsed : null };
  }

  /** Bound OHOS API db for this project, if any. */
  getOhosApiBinding(): OhosApiDbBinding | null {
    const version = this.queries.getMetadata(OHOS_API_VERSION_META);
    const dbPath = this.queries.getMetadata(OHOS_API_DB_PATH_META);
    if (!version || !dbPath) return null;
    return {
      version,
      dbPath,
      packageName: ohosApiDbPackageName(version),
      installed: false,
    };
  }

  /**
   * True when the on-disk index was built by an engine whose extraction is
   * older than the one now running — i.e. a re-index would add data a migration
   * can't backfill. False when there's no index yet (nothing to refresh) or the
   * stamp is current. This is the signal behind `homegraph status`'s re-index
   * hint and `homegraph upgrade`'s reminder.
   */
  isIndexStale(): boolean {
    if (this.queries.getLastIndexedAt() == null) return false;
    const { extractionVersion } = this.getIndexBuildInfo();
    return extractionVersion == null || extractionVersion < EXTRACTION_VERSION;
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
  async resolveReferencesBatched(
    onProgress?: (current: number, total: number) => void,
    onSynthesisProgress?: (done: number, total: number) => void,
    backpressure?: () => Promise<void> | null
  ): Promise<ResolutionResult> {
    return this.resolver.resolveAndPersistBatched(onProgress, undefined, onSynthesisProgress, {
      dbPath: this.db.getPath(),
      bulkEdgeLoad: {
        begin: () => this.db.beginBulkEdgeLoad(),
        end: () => this.db.endBulkEdgeLoad(),
      },
      refIndexLoad: {
        begin: () => this.db.beginBulkRefLoad(),
        end: () => this.db.endBulkRefLoad(),
      },
      backpressure,
    });
  }

  /**
   * Get detected frameworks in the project
   */

  /**
   * References extracted but never attempted by a resolution pass. Zero on a
   * healthy index — a completed pass consumes every pending row (resolving it
   * or parking it as failed, #1240). Non-zero at rest means a pass was
   * interrupted mid-run (#1187), so some files' call edges are missing; the
   * next `sync` sweeps them.
   */
  getPendingReferenceCount(): number {
    return this.queries.getUnresolvedReferencesCount();
  }

  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    stats.walSizeBytes = this.db.getWalSizeBytes();
    return stats;
  }

  /**
   * Active SQLite backend (`native` = better-sqlite3, or `wasm` fallback).
   * Surfaced via `homegraph status` / `homegraph_status` with journal mode.
   */
  getBackend(): import('./db').SqliteBackend {
    return this.db.getBackend();
  }

  /**
   * The journal mode actually in effect ('wal', 'delete', …). 'wal' means
   * readers never block on a concurrent writer; anything else means they can,
   * which is the precondition for the "database is locked" failures in issue
   * #238. Surfaced via `homegraph status` and the `homegraph_status` MCP tool.
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Get ALL nodes with an exact name (direct index lookup, not FTS-ranked/capped).
   * Used to enumerate every overload of a heavily-overloaded name so the specific
   * definition the caller wants is never dropped below a search cut.
   */
  getNodesByName(name: string): Node[] {
    return this.queries.getNodesByName(name);
  }

  /**
   * Nodes whose name CONTAINS `substring` (LIKE scan, ASCII-case-insensitive,
   * shortest-first). The camel-infix lookup FTS can't do — `profileInfo`
   * inside `getProfileInfoV2` is one FTS token (#1196).
   */
  getNodesByNameSubstring(
    substring: string,
    options: { kinds?: NodeKind[]; limit?: number; excludePrefix?: boolean } = {}
  ): Node[] {
    return this.queries
      .findNodesByNameSubstring(substring, options)
      .map((r) => r.node);
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  /**
   * Normalized project-name tokens (go.mod / package.json / repo dir) used to
   * down-weight the non-discriminative project name in search ranking (#720).
   * Exposed so explore can exclude it from the PascalCase type-disambiguation
   * bias, which would otherwise pull overloaded tokens toward whichever stack
   * embeds the project name.
   */
  /**
   * Graph-derived prompt matching for the front-load hook's MEDIUM tier:
   * which indexed symbols do these prose words name? "state machine des
   * commandes" → `OrderStateMachine`, in any human language whose technical
   * nouns are Latin script — no keyword list involved.
   *
   * Precision comes from the repo's own naming statistics, not vocabulary:
   * - CO-OCCURRENCE: ≥2 words that are segments of the SAME name ("state" +
   *   "machine" → OrderStateMachine) is strong evidence and always qualifies.
   * - RARITY: a single matched word qualifies only when its segment is
   *   discriminative here (≤ {@link SEGMENT_RARITY_CEILING} distinct names) —
   *   "checkout" in a shop backend yes, "state" in a react app no.
   * Every candidate is re-verified against `nodes` before being returned
   * (vocab rows are proposals; deletions leave orphans by design), so a
   * returned symbol is guaranteed to exist right now.
   */
  getSegmentMatches(words: string[], limit: number = 6): SegmentMatch[] {
    if (words.length === 0) return [];
    // Variant → original word (plural folding), for coverage accounting.
    const variantToWord = new Map<string, string>();
    for (const word of words) {
      for (const variant of segmentLookupVariants(word)) {
        if (!variantToWord.has(variant)) variantToWord.set(variant, word);
      }
    }
    const variants = [...variantToWord.keys()];

    // Tier A: co-occurrence. The SQL folds variants back to their original
    // word (#1146), so minWords=2 means two distinct PROMPT WORDS — a name
    // matching both `service` and `services` can't tie with (or crowd past
    // the LIMIT) a genuine two-word match. The JS re-check below recomputes
    // the fold from live segments as the honesty layer.
    const variantPairs = [...variantToWord.entries()].map(([segment, word]) => ({ segment, word }));
    const candidates: Array<{ name: string; matchedWords: Set<string> }> = [];
    for (const hit of this.queries.getSegmentCoOccurrence(variantPairs, 2, 24)) {
      const matched = this.wordsMatchingName(hit.name, variantToWord);
      if (matched.size >= 2) candidates.push({ name: hit.name, matchedWords: matched });
    }

    // Tier B: single rare word. Only when co-occurrence found nothing — a
    // co-occurring name is categorically stronger evidence — and under
    // stricter rules, because one word is thin: the word must be ≥5 chars
    // (measured FPs: "this", "typo"); the segment must appear in AT LEAST TWO
    // names (a concept the codebase is about clusters across names —
    // CheckoutService/CheckoutController — while a prose coincidence is a
    // singleton: measured FP "deploy to PRODUCTION" → the one name
    // matchesNonProductionDir); and the candidate name must have ≥2 segments
    // (a bare common verb matching a bare function name — "write" → `write` —
    // is prose coincidence, not the user naming a symbol).
    if (candidates.length === 0) {
      const singleWordVariants = variants.filter((v) => variantToWord.get(v)!.length >= 5);
      const counts = this.queries.getSegmentNameCounts(singleWordVariants);
      const rare = [...counts.entries()]
        .filter(([, n]) => n >= 2 && n <= HomeGraph.SEGMENT_RARITY_CEILING)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 2);
      for (const [variant] of rare) {
        const word = variantToWord.get(variant)!;
        for (const name of this.queries.getNamesForSegment(variant, 12)) {
          if (splitIdentifierSegments(name).length < 2) continue;
          candidates.push({ name, matchedWords: new Set([word]) });
        }
      }
    }

    // Verify against nodes (the honesty gate) and pick a representative
    // definition per name. A name whose only nodes are file/import kind has
    // no real definition to point at — surfacing the import statement instead
    // reads as a matched symbol but isn't one (#1144) — so it's skipped, the
    // same way an orphaned vocab row is. (Import names no longer enter the
    // vocab at write time, but rows written before that exclusion persist
    // until the next full index.)
    const out: SegmentMatch[] = [];
    const seen = new Set<string>();
    candidates.sort((a, b) => b.matchedWords.size - a.matchedWords.size || a.name.length - b.name.length);
    for (const candidate of candidates) {
      if (out.length >= limit) break;
      if (seen.has(candidate.name)) continue;
      seen.add(candidate.name);
      const nodes = this.queries.getNodesByName(candidate.name);
      if (nodes.length === 0) continue; // orphaned vocab row — name no longer exists
      const rep = nodes.find((n) => n.kind !== 'file' && n.kind !== 'import');
      if (!rep) continue; // no real definition — don't surface an import/file as one
      out.push({
        name: candidate.name,
        kind: rep.kind,
        filePath: rep.filePath,
        startLine: rep.startLine ?? 0,
        matchedWords: [...candidate.matchedWords].sort(),
      });
    }
    return out;
  }

  /** A single word ("state") can match hundreds of names in a big repo — that
   *  is noise, not signal. Ceiling for the single-word tier; co-occurrence is
   *  exempt because two words on one name is already discriminative. */
  private static readonly SEGMENT_RARITY_CEILING = 25;

  /** Which of the prompt's original words match `name`'s segments (via
   *  variants). Segments are recomputed in JS — a name-keyed vocab lookup
   *  would scan the (segment, name) primary key. */
  private wordsMatchingName(name: string, variantToWord: Map<string, string>): Set<string> {
    const segments = new Set(splitIdentifierSegments(name));
    const matched = new Set<string>();
    for (const [variant, word] of variantToWord) {
      if (segments.has(variant)) matched.add(word);
    }
    return matched;
  }

  /**
   * One-shot upgrade heal for callers that open the graph WITHOUT syncing —
   * concretely the prompt hook, whose MEDIUM tier reads the segment
   * vocabulary: a database migrated from before the vocab table existed
   * starts with it empty, and the only other backfill lives inside `sync()`,
   * which such callers never run (#1142). Returns true when the vocab is
   * usable (already populated — the overwhelmingly common one-SELECT case —
   * or healed here); false when it isn't (empty graph, or another process
   * holds the index lock — that process's own sync heals it).
   */
  async healSegmentVocabIfEmpty(): Promise<boolean> {
    const empty = (() => {
      try { return this.queries.isNameSegmentVocabEmpty(); } catch { return false; }
    })();
    if (!empty) return true;
    if (this.queries.getNodeAndEdgeCount().nodes === 0) return false;
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return false; // an index/sync is running — it backfills the vocab itself
      }
      try {
        if (!this.queries.isNameSegmentVocabEmpty()) return true; // raced: healed meanwhile
        await this.rebuildNameSegmentVocab();
        return true;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Rebuild the segment vocabulary from the current graph, batched and
   * yielding — the upgrade-heal path for indexes built before the vocab table
   * existed. Runs inside the index mutex/lock (sync and
   * healSegmentVocabIfEmpty hold them).
   */
  private async rebuildNameSegmentVocab(): Promise<void> {
    const maybeYield = createYielder();
    const BATCH = 2000;
    for (let offset = 0; ; offset += BATCH) {
      const names = this.queries.getDistinctNodeNames(BATCH, offset);
      if (names.length === 0) break;
      this.queries.insertNameSegmentsBatch(names);
      await maybeYield();
    }
  }

  getProjectNameTokens(): Set<string> {
    return this.queries.getProjectNameTokens();
  }

  /**
   * Find the project's "primary route file" — the file with the densest
   * concentration of framework-emitted `route` nodes (≥3 routes, ≥30%
   * of all non-test routes). Used to inline the routing config in
   * `homegraph_explore` responses on small realworld template repos
   * (rails-realworld, laravel-realworld, drupal-admintoolbar, …) where
   * Glob+Read of `routes.rb`/`urls.py`/etc. otherwise beats homegraph.
   */
  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    return this.queries.getTopRouteFile();
  }

  /**
   * Build a URL → handler routing manifest from the index. Each entry
   * pairs a route node (URL + method) with its handler function/method
   * via the `references` edge that framework resolvers emit. Returns
   * null when fewer than 3 valid (non-test) routes exist.
   */
  getRoutingManifest(limit?: number): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    return this.queries.getRoutingManifest(limit);
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string): Edge[] {
    return this.queries.getOutgoingEdges(nodeId);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(nodeId: string): Edge[] {
    return this.queries.getIncomingEdges(nodeId);
  }

  /**
   * ArkUI migrate / state-semantics snapshot for a scope (spec 0007).
   * Scope: component name, relative file path, or directory prefix.
   */
  getArkUIMigrateSnapshot(scope: string): ArkUIMigrateSnapshot {
    return buildArkUIMigrateSnapshot(
      {
        getNodesByKind: (kind) => this.getNodesByKind(kind),
        getNodesByName: (name) => this.getNodesByName(name),
        getNodesInFile: (filePath) => this.getNodesInFile(filePath),
        getOutgoingEdges: (id) => this.getOutgoingEdges(id),
        getIncomingEdges: (id) => this.getIncomingEdges(id),
        getNode: (id) => this.getNode(id),
        getAllFiles: () => this.getFiles(),
      },
      scope
    );
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    return this.graphManager.getFileDependents(filePath);
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.queries.clear();
    resetArkTSBatch();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove HomeGraph from the project.
   * This closes the database and deletes the .HomeGraph directory.
   *
   * WARNING: This permanently deletes all HomeGraph data for the project.
   */
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

// Default export
export default HomeGraph;
