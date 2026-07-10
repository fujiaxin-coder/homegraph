/**
 * Query pool — runs CPU-heavy read-tool calls on a pool of worker threads so
 * the shared daemon's main event loop stays free for the MCP transport.
 *
 * Why this exists: see {@link ./query-worker}. One daemon, one event loop, one
 * synchronous SQLite connection serializes every concurrent `codegraph_explore`
 * AND starves the transport (a 10-way wave delivered 0 transport heartbeats in
 * 25s — responses can't flush until the whole batch drains, so clients time
 * out). Spreading the dispatch across worker threads (each its own WAL read
 * connection) restores true multi-core parallelism and an idle main loop.
 *
 * Properties:
 *   - lazy growth: **no worker until the first heavy call**, then grows to
 *     `size` on demand. Eager warm-start used to open a second full DB on every
 *     MCP session and balloon RSS (~5GB on ~800MB indexes).
 *   - **default concurrency is 1** — each worker is another V8 + WAL open; on
 *     large indexes two workers routinely doubled working-set into multi-GB.
 *     Override with `CODEGRAPH_QUERY_POOL_SIZE` when you truly need more.
 *   - **admission**: when outstanding work already fills `size` in-flight plus
 *     another `size` waiting, further calls resolve immediately with
 *     success-shaped busy/partial guidance instead of queuing up to die at the
 *     client hard timeout.
 *   - crash recovery: a dead worker is respawned and its in-flight call retried
 *     once; a poison call that keeps crashing fails gracefully (never wedges the
 *     pool). A crash budget trips a circuit breaker (`healthy` → false) so the
 *     caller falls back to in-process dispatch instead of thrashing respawns.
 *   - graceful backstop: a call that can't be served within `softTimeoutMs`
 *     (default 20s, clamped ≤30s — well under typical ~60s MCP client timeouts)
 *     resolves with SUCCESS-shaped static "Partial / busy, retry" guidance —
 *     never `isError`, and never DB/FTS work on the timeout callback (that
 *     can freeze the transport so the client still sees empty `-32001`).
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import type { ToolResult } from './tools';

/** Compiled sibling — `query-worker.js` lives next to this file in `dist/mcp/`. */
const WORKER_FILE = path.join(__dirname, 'query-worker.js');

/**
 * Minimal worker surface the pool drives — satisfied by a real `worker_threads`
 * Worker. Abstracted so tests can inject a fake worker and exercise the pool's
 * queue / growth / crash-recovery / backstop logic without spawning threads or
 * needing a built `dist/`.
 */
export interface PoolWorker {
  postMessage(msg: unknown): void;
  terminate(): Promise<number> | void;
  on(event: 'message', cb: (m: unknown) => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
}

/**
 * Default soft backstop — must stay **well below** typical MCP client hard
 * timeouts (~60s). Eval / agent configs sometimes set the env to 60000, which
 * races the client and yields empty `-32001`; we clamp to
 * {@link MAX_BUSY_TIMEOUT_MS} regardless. Prefer returning busy/partial early
 * so the agent can retry once instead of waiting out the client hard cut.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 15_000;

/** Hard ceiling — leave headroom under ~30–60s client timeouts (flush / scheduling). */
const MAX_BUSY_TIMEOUT_MS = 20_000;

/**
 * Default concurrent workers when env is unset. Keep at 1: a second connection
 * on a large index is a multi-GB RSS hit. Explicit env overrides still go up to
 * {@link MAX_POOL_SIZE}.
 */
const DEFAULT_POOL_CAP = 1;

/** Hard ceiling on pool size regardless of core count / env. */
const MAX_POOL_SIZE = 16;

/**
 * Total worker deaths before the pool declares itself unhealthy and the caller
 * reverts to in-process dispatch. High enough to ride out a few transient
 * crashes, low enough that a systematically-broken worker (e.g. a platform that
 * can't spawn threads) degrades quickly instead of respawning forever.
 */
const CRASH_BUDGET = 12;

/**
 * Max workers cold-starting at once. A worker's cold start is heavy — full
 * module load (tree-sitter etc.) + opening a large WAL DB — and starting the
 * whole pool simultaneously thrashes CPU/I-O so badly it can stall the daemon's
 * main loop for tens of seconds. Warming a couple at a time keeps each start
 * fast; as one reports ready the next begins, so the pool still reaches full
 * size within a few calls of a burst, just without the thundering herd.
 */
const MAX_CONCURRENT_SPAWN = 2;

/** Shape of a message a worker posts back (ready handshake or a tool result). */
interface WorkerMessage {
  type?: string;
  ok?: boolean;
  id?: number;
  result?: ToolResult;
}

interface Job {
  id: number;
  toolName: string;
  args: Record<string, unknown>;
  resolve: (r: ToolResult) => void;
  retries: number;
  settled: boolean;
  enqueuedAt: number;
  softTimer?: NodeJS.Timeout;
  onSoftTimeout?: () => ToolResult | null | undefined;
}

export interface QueryPoolOptions {
  /** Default project root each worker opens at spawn. */
  root: string;
  /** Max worker threads. Defaults to `clamp(cores-1, 1, DEFAULT_POOL_CAP)`. */
  size?: number;
  /** Linger before a queued/in-flight call gets busy-guidance. Default 20s (≤30s clamp). */
  softTimeoutMs?: number;
  /** Retries for an in-flight call whose worker crashed. Default 1. */
  maxRetries?: number;
  /** Worker factory (tests inject a fake). Defaults to a real `worker_threads` Worker. */
  createWorker?: () => PoolWorker;
}

/**
 * Resolve the pool size from the `CODEGRAPH_QUERY_POOL_SIZE` override and the
 * machine's core count. `0` (or a negative) explicitly disables the pool (the
 * caller serves in-process — today's behavior). Unset → `clamp(cores-1, 1, 1)`:
 * one parallel explore without a second full-DB RSS hit. Explicit overrides still
 * honor up to {@link MAX_POOL_SIZE}.
 */
export function resolvePoolSize(envVal: string | undefined, cpuCount: number): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), MAX_POOL_SIZE);
    // non-numeric / negative → fall through to the default
  }
  return Math.max(1, Math.min(cpuCount - 1, DEFAULT_POOL_CAP));
}

/**
 * Soft / tool deadline. Env `CODEGRAPH_QUERY_BUSY_TIMEOUT_MS` may raise or
 * lower it, but is always clamped into `[1000, MAX_BUSY_TIMEOUT_MS]` so a
 * mistaken `60000` cannot race DevEco/Cursor's ~60s MCP hard timeout.
 */
export function resolveBusyTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_BUSY_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_BUSY_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_BUSY_TIMEOUT_MS);
}

/** Same as {@link resolveBusyTimeoutMs} — used by ToolHandler for all tools. */
export function resolveToolDeadlineMs(): number {
  return resolveBusyTimeoutMs();
}

/** Success-shaped overload guidance (NEVER isError — see the abandonment rule). */
function busyGuidance(waitedMs: number, reason: 'timeout' | 'admission' = 'timeout'): ToolResult {
  const secs = Math.max(1, Math.round(waitedMs / 1000));
  const why = reason === 'admission'
    ? 'too many concurrent HomeGraph queries are already in flight'
    : `this call waited ${secs}s in the queue / on a worker`;
  return {
    content: [{
      type: 'text',
      text:
        `⚠️ **Partial result** — HomeGraph is busy (${why}). This is NOT an error. ` +
        `Retry ONE \`homegraph_explore\` with the concrete symbol/file names from the question — ` +
        `do not fire search+explore or node+callers+callees in parallel, and do not fall back to grep/read ` +
        `for symbols you already named (that duplicates tokens). A single retry usually returns full source.`,
    }],
  };
}

export class QueryPool {
  private idle: PoolWorker[] = [];
  private queue: Job[] = [];
  private inflight = new Map<PoolWorker, Job>();
  private workers = new Set<PoolWorker>();
  // Workers spawned but not yet 'ready'. Growth must count these so a single
  // first call (with the eager worker still starting) doesn't spawn the WHOLE
  // pool at once — N simultaneous cold worker starts (each a full module load +
  // a large DB open) saturate the box and starve the main loop. Grow only when
  // the queue outstrips idle + pending.
  private pendingWorkers = new Set<PoolWorker>();
  private nextId = 1;
  private totalCrashes = 0;
  private destroyed = false;
  private readonly root: string;
  private readonly maxSize: number;
  private readonly softTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly createWorker: () => PoolWorker;

  constructor(opts: QueryPoolOptions) {
    this.root = opts.root;
    this.maxSize = Math.max(1, Math.min(opts.size ?? Math.min(DEFAULT_POOL_CAP, Math.max(1, os.cpus().length - 1)), MAX_POOL_SIZE));
    this.softTimeoutMs = opts.softTimeoutMs ?? resolveBusyTimeoutMs();
    this.maxRetries = opts.maxRetries ?? 1;
    this.createWorker = opts.createWorker ?? (() => new Worker(WORKER_FILE, { workerData: { root: this.root } }));
    // Deliberately no eager spawn — see class doc. First `run()` spawns on demand.
  }

  /** Pool size cap (for logging/status). */
  get size(): number { return this.maxSize; }

  /** Live worker count (for tests/status). */
  get liveWorkers(): number { return this.workers.size; }

  /**
   * False once the crash budget is exhausted (or after destroy). The ToolHandler
   * checks this and falls back to in-process dispatch — a broken worker platform
   * degrades to today's behavior instead of failing tool calls.
   */
  get healthy(): boolean {
    return !this.destroyed && this.totalCrashes < CRASH_BUDGET;
  }

  /** In-flight + unsettled queued jobs (for admission / tests). */
  outstandingCount(): number {
    return this.inflight.size + this.queue.filter((j) => !j.settled).length;
  }

  /**
   * How many unsettled jobs we tolerate before refusing new ones immediately.
   * One full wave running + one full wave waiting — further fan-out gets
   * busy/partial guidance instead of stacking up to the soft timeout.
   */
  private admissionLimit(): number {
    return this.maxSize * 2;
  }

  private spawnOne(): void {
    if (this.destroyed || this.workers.size >= this.maxSize) return;
    let w: PoolWorker;
    try {
      w = this.createWorker();
    } catch {
      this.totalCrashes++; // counts toward the circuit breaker
      return;
    }
    this.workers.add(w);
    this.pendingWorkers.add(w);
    w.on('message', (m) => this.onMessage(w, (m ?? {}) as WorkerMessage));
    w.on('error', () => this.onWorkerGone(w));
    w.on('exit', (code) => { if (code !== 0) this.onWorkerGone(w); });
  }

  private onMessage(w: PoolWorker, m: WorkerMessage): void {
    if (!m) return;
    if (m.type === 'ready') {
      this.pendingWorkers.delete(w);
      if (m.ok === false) this.totalCrashes++; // hard open failure
      this.idle.push(w);
      this.drain();
      return;
    }
    if (m.type === 'result') {
      const job = this.inflight.get(w);
      this.inflight.delete(w);
      this.idle.push(w);
      if (job) this.settle(job, m.result ?? busyGuidance(0));
      this.drain();
    }
  }

  // A worker died (crash hook, OOM, segfault, exit≠0). Respawn a replacement and
  // retry its in-flight job once; a job that keeps crashing workers fails
  // gracefully so it can't loop the pool forever.
  private onWorkerGone(w: PoolWorker): void {
    if (!this.workers.has(w)) return; // already handled (error+exit both fire)
    this.workers.delete(w);
    this.pendingWorkers.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
    this.totalCrashes++;
    const job = this.inflight.get(w);
    this.inflight.delete(w);
    try { void w.terminate(); } catch { /* already gone */ }
    if (this.healthy) this.spawnOne(); // keep capacity
    if (job) {
      if (job.retries < this.maxRetries && this.healthy) {
        job.retries++;
        this.queue.unshift(job); // head of line — retry promptly
      } else {
        this.settle(job, { isError: true, content: [{ type: 'text', text: 'codegraph worker crashed; please retry the call.' }] });
      }
    }
    this.drain();
  }

  private drain(): void {
    // Grow toward maxSize while queued work outstrips workers that are idle OR
    // already on their way up (pending) — so we never spawn the whole pool for a
    // single call whose eager worker just hasn't reported ready yet.
    while (
      this.queue.length > this.idle.length + this.pendingWorkers.size &&
      this.workers.size < this.maxSize &&
      this.pendingWorkers.size < MAX_CONCURRENT_SPAWN &&
      this.healthy
    ) {
      this.spawnOne();
    }
    while (this.idle.length && this.queue.length) {
      // Skip jobs the backstop already answered.
      let job: Job | undefined;
      while (this.queue.length && (job = this.queue.shift()) && job.settled) job = undefined;
      if (!job || job.settled) break;
      const w = this.idle.pop()!;
      this.inflight.set(w, job);
      w.postMessage({ type: 'call', id: job.id, toolName: job.toolName, args: job.args });
    }
  }

  private settle(job: Job, result: ToolResult): void {
    if (job.settled) return; // already answered (by backstop or worker)
    job.settled = true;
    if (job.softTimer) clearTimeout(job.softTimer);
    job.resolve(result);
  }

  private settleBusyOrPartial(job: Job, reason: 'timeout' | 'admission'): void {
    if (job.settled) return;
    const partial = job.onSoftTimeout?.();
    if (partial) {
      this.settle(job, partial);
      return;
    }
    this.settle(job, busyGuidance(Date.now() - job.enqueuedAt, reason));
  }

  /** Run a read tool on the pool. Always resolves (never rejects). */
  run(
    toolName: string,
    args: Record<string, unknown>,
    opts?: { onSoftTimeout?: () => ToolResult | null | undefined },
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const job: Job = {
        id: this.nextId++, toolName, args, resolve,
        retries: 0, settled: false, enqueuedAt: Date.now(),
        onSoftTimeout: opts?.onSoftTimeout,
      };

      // Hard admission: refuse to stack another wave that would sit until soft
      // timeout / client hard timeout. Caller gets partial/busy NOW.
      if (this.outstandingCount() >= this.admissionLimit()) {
        this.settleBusyOrPartial(job, 'admission');
        return;
      }

      // Don't let the caller wait past softTimeoutMs. The worker may still be
      // busy (we can't cancel synchronous CPU), but the CLIENT gets a prompt,
      // success-shaped "retry"/partial instead of a hard timeout.
      job.softTimer = setTimeout(() => {
        this.settleBusyOrPartial(job, 'timeout');
      }, this.softTimeoutMs);
      job.softTimer.unref?.();
      this.queue.push(job);
      this.drain();
    });
  }

  /** Terminate all workers and answer any outstanding calls gracefully. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const ws = [...this.workers];
    this.workers.clear();
    this.pendingWorkers.clear();
    this.idle = [];
    for (const job of [...this.inflight.values(), ...this.queue]) {
      this.settle(job, { isError: true, content: [{ type: 'text', text: 'codegraph is shutting down; retry shortly.' }] });
    }
    this.inflight.clear();
    this.queue = [];
    await Promise.all(ws.map((w) => Promise.resolve(w.terminate()).catch(() => { /* already gone */ })));
  }
}
