/**
 * In-process profiler preload for `eval:peak-mem --profile`.
 *
 * Mirrors arkanalyzer/tests/samples/perf/profiler.ts StageProfiler:
 *   - inspector CPU Profiler
 *   - inspector HeapProfiler sampling
 *   - 10ms heap/RSS peak sampler
 *   - GC pause observer (perf_hooks)
 *
 * Loaded via `node --require <this-file> dist/bin/homegraph.js ...`.
 * Survives HomeGraph's `--liftoff-only` re-exec (preserved in execArgv).
 *
 * Only activates in the process that actually runs the CLI body — either the
 * post-relaunch child (`HOMEGRAPH_WASM_RELAUNCHED=1`) or a process that already
 * has `--liftoff-only` (no re-exec). The short-lived relaunch parent is a no-op
 * so its `process.exit(status)` after spawnSync is not intercepted.
 *
 * Env:
 *   HOMEGRAPH_EVAL_PROFILE_DIR   output directory (required)
 *   HOMEGRAPH_EVAL_HOT_TOP       top-N frames (default 20)
 *   HOMEGRAPH_EVAL_HEAP_INTERVAL  heap sampling interval bytes (default 32768)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const inspector = require('node:inspector');
const { performance, PerformanceObserver } = require('node:perf_hooks');

const PROFILE_DIR = process.env.HOMEGRAPH_EVAL_PROFILE_DIR?.trim();
if (!PROFILE_DIR) {
  module.exports = {};
  return;
}

const alreadyHasLiftoff = process.execArgv.includes('--liftoff-only');
const isRelaunchChild = process.env.HOMEGRAPH_WASM_RELAUNCHED === '1';
// Relaunch parent: no liftoff yet, not the child — skip so exit after spawnSync is clean.
if (!alreadyHasLiftoff && !isRelaunchChild) {
  module.exports = {};
  return;
}

const HOT_TOP = Math.max(0, Number.parseInt(process.env.HOMEGRAPH_EVAL_HOT_TOP ?? '20', 10) || 20);
const HEAP_INTERVAL = Math.max(
  1024,
  Number.parseInt(process.env.HOMEGRAPH_EVAL_HEAP_INTERVAL ?? String(32 * 1024), 10) || 32 * 1024,
);

fs.mkdirSync(PROFILE_DIR, { recursive: true });

function getHeapSize() {
  const stats = v8.getHeapStatistics();
  return {
    used: stats.used_heap_size,
    total: stats.total_heap_size,
    limit: stats.heap_size_limit,
  };
}

function toMb(bytes) {
  return bytes / (1024 * 1024);
}

function analyzeCpuHotFunctions(profile, topN) {
  const samples = profile.samples ?? [];
  const timeDeltas = profile.timeDeltas ?? [];
  const nodeMap = new Map();
  for (const node of profile.nodes ?? []) nodeMap.set(node.id, node);

  const selfTimeByNode = new Map();
  const sampleCountByNode = new Map();
  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const deltaUs = timeDeltas[i] ?? 0;
    selfTimeByNode.set(nodeId, (selfTimeByNode.get(nodeId) ?? 0) + deltaUs / 1000);
    sampleCountByNode.set(nodeId, (sampleCountByNode.get(nodeId) ?? 0) + 1);
  }

  const aggregated = new Map();
  for (const [nodeId, selfTimeMs] of selfTimeByNode) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    const frame = node.callFrame;
    if (!frame?.functionName || frame.functionName === '(idle)' || frame.functionName === '(root)') {
      continue;
    }
    const fileName = frame.url ? path.basename(frame.url) : 'unknown';
    const location = `${fileName}:${(frame.lineNumber ?? -1) + 1}`;
    const key = `${frame.functionName}:${location}`;
    const current = aggregated.get(key) ?? {
      name: frame.functionName,
      location,
      selfTimeMs: 0,
      sampleCount: 0,
    };
    current.selfTimeMs += selfTimeMs;
    current.sampleCount += sampleCountByNode.get(nodeId) ?? 0;
    aggregated.set(key, current);
  }

  return [...aggregated.values()].sort((a, b) => b.selfTimeMs - a.selfTimeMs).slice(0, topN);
}

function summarizeAllocationHotFunctions(profile, topN) {
  if (!profile?.head) return [];
  const aggregated = new Map();
  const stack = [profile.head];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const frame = current.callFrame;
    if (frame?.functionName && frame.functionName !== '(idle)' && frame.functionName !== '(root)') {
      const fileName = frame.url ? path.basename(frame.url) : 'unknown';
      const location = `${fileName}:${(frame.lineNumber ?? -1) + 1}`;
      const key = `${frame.functionName}:${location}`;
      const entry = aggregated.get(key) ?? {
        name: frame.functionName,
        location,
        allocatedBytes: 0,
        allocatedMb: 0,
        sampleCount: 0,
      };
      entry.allocatedBytes += current.selfSize ?? 0;
      entry.allocatedMb = toMb(entry.allocatedBytes);
      entry.sampleCount += 1;
      aggregated.set(key, entry);
    }
    for (const child of current.children ?? []) stack.push(child);
  }
  return [...aggregated.values()].sort((a, b) => b.allocatedBytes - a.allocatedBytes).slice(0, topN);
}

function summarizeGcPauses(events) {
  let naturalCount = 0;
  let naturalDurationMs = 0;
  let manualCount = 0;
  let manualDurationMs = 0;
  for (const event of events) {
    if (event.source === 'manual') {
      manualCount += 1;
      manualDurationMs += event.durationMs;
    } else {
      naturalCount += 1;
      naturalDurationMs += event.durationMs;
    }
  }
  return {
    count: events.length,
    totalDurationMs: naturalDurationMs + manualDurationMs,
    naturalCount,
    naturalDurationMs,
    manualCount,
    manualDurationMs,
  };
}

function post(session, method, params) {
  return new Promise((resolve, reject) => {
    const cb = (err, result) => {
      if (err) reject(err);
      else resolve(result ?? {});
    };
    if (params === undefined) session.post(method, cb);
    else session.post(method, params, cb);
  });
}

const stageStartTime = performance.now();
const startedAtIso = new Date().toISOString();
const heapBefore = getHeapSize();
let heapPeakUsedBytes = heapBefore.used;
let rssPeakBytes = process.memoryUsage().rss;
const gcEvents = [];
let manualGcWindowStart = null;
let manualGcWindowEnd = null;
let finalized = false;
let exitScheduled = false;

const session = new inspector.Session();
session.connect();

const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.entryType !== 'gc') continue;
    const timestamp = entry.startTime ?? 0;
    if (timestamp < stageStartTime) continue;
    const kind = entry.detail?.kind;
    const isManual =
      manualGcWindowStart !== null &&
      manualGcWindowEnd !== null &&
      timestamp >= manualGcWindowStart &&
      timestamp <= manualGcWindowEnd;
    gcEvents.push({
      type: kind !== undefined ? String(kind) : 'unknown',
      durationMs: entry.duration ?? 0,
      timestamp,
      source: isManual ? 'manual' : 'natural',
    });
  }
});
gcObserver.observe({ entryTypes: ['gc'], buffered: true });

const memoryPeakSampler = setInterval(() => {
  const used = getHeapSize().used;
  const rss = process.memoryUsage().rss;
  if (used > heapPeakUsedBytes) heapPeakUsedBytes = used;
  if (rss > rssPeakBytes) rssPeakBytes = rss;
}, 10);
memoryPeakSampler.unref();

const startPromise = (async () => {
  await post(session, 'Profiler.enable');
  await post(session, 'Profiler.start');
  await post(session, 'HeapProfiler.enable');
  await post(session, 'HeapProfiler.startSampling', { samplingInterval: HEAP_INTERVAL });
})().catch((err) => {
  process.stderr.write(`[homegraph-eval-profile] start failed: ${err}\n`);
});

async function triggerManualGcIfAvailable() {
  if (typeof global.gc !== 'function') return;
  manualGcWindowStart = performance.now();
  global.gc();
  await new Promise((resolve) => setImmediate(resolve));
  manualGcWindowEnd = performance.now();
}

async function finalize(exitCode) {
  if (finalized) return;
  finalized = true;
  clearInterval(memoryPeakSampler);

  try {
    await startPromise;
  } catch {
    // already logged
  }

  try {
    await triggerManualGcIfAvailable();
  } catch {
    // ignore
  }

  for (const entry of gcObserver.takeRecords()) {
    if (entry.entryType !== 'gc') continue;
    const timestamp = entry.startTime ?? 0;
    if (timestamp < stageStartTime) continue;
    const kind = entry.detail?.kind;
    gcEvents.push({
      type: kind !== undefined ? String(kind) : 'unknown',
      durationMs: entry.duration ?? 0,
      timestamp,
      source: 'natural',
    });
  }
  gcObserver.disconnect();

  let cpuProfile = null;
  let heapProfile = null;
  try {
    const cpuStop = await post(session, 'Profiler.stop');
    cpuProfile = cpuStop.profile ?? null;
    await post(session, 'Profiler.disable');
  } catch (err) {
    process.stderr.write(`[homegraph-eval-profile] CPU stop failed: ${err}\n`);
  }
  try {
    const heapStop = await post(session, 'HeapProfiler.stopSampling');
    heapProfile = heapStop.profile ?? null;
    await post(session, 'HeapProfiler.disable');
  } catch (err) {
    process.stderr.write(`[homegraph-eval-profile] heap stop failed: ${err}\n`);
  }

  try {
    session.disconnect();
  } catch {
    // ignore
  }

  const heapAfter = getHeapSize();
  if (heapAfter.used > heapPeakUsedBytes) heapPeakUsedBytes = heapAfter.used;
  const rssAfter = process.memoryUsage().rss;
  if (rssAfter > rssPeakBytes) rssPeakBytes = rssAfter;

  const durationMs = performance.now() - stageStartTime;
  const cpuHotFunctions = cpuProfile ? analyzeCpuHotFunctions(cpuProfile, HOT_TOP) : [];
  const allocationHotFunctions = heapProfile
    ? summarizeAllocationHotFunctions(heapProfile, HOT_TOP)
    : [];

  const prefix = path.join(PROFILE_DIR, `pid-${process.pid}`);
  if (cpuProfile) {
    fs.writeFileSync(`${prefix}.cpuprofile`, JSON.stringify(cpuProfile));
  }
  if (heapProfile) {
    fs.writeFileSync(`${prefix}.heapprofile`, JSON.stringify(heapProfile));
  }

  const summary = {
    version: 1,
    kind: 'homegraph-eval-profile',
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv.slice(1),
    startedAt: startedAtIso,
    endedAt: new Date().toISOString(),
    exitCode: exitCode ?? 0,
    durationMs,
    heapBefore,
    heapAfter,
    heapGrowthBytes: heapAfter.used - heapBefore.used,
    heapPeakUsedBytes,
    rssPeakBytes,
    rssAfterBytes: rssAfter,
    gcPauses: summarizeGcPauses(gcEvents),
    cpuHotFunctions,
    allocationHotFunctions,
    cpuProfileFile: cpuProfile ? path.basename(`${prefix}.cpuprofile`) : null,
    heapProfileFile: heapProfile ? path.basename(`${prefix}.heapprofile`) : null,
  };
  fs.writeFileSync(`${prefix}-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
}

/**
 * Flush profiles before terminating. Uses a sentinel throw so callers of
 * `process.exit()` cannot fall through (e.g. code after exit in the same tick).
 * Fatal handlers installed later may call process.exit again; that is ignored
 * until finalize completes.
 */
const EXIT_SENTINEL = Symbol.for('homegraph.eval.profile.exit');
const realExit = process.exit.bind(process);

function scheduleExit(code) {
  const exitCode = typeof code === 'number' ? code : 0;
  if (exitScheduled) return exitCode;
  exitScheduled = true;
  finalize(exitCode)
    .catch((err) => {
      process.stderr.write(`[homegraph-eval-profile] finalize failed: ${err}\n`);
    })
    .finally(() => {
      realExit(exitCode);
    });
  return exitCode;
}

process.exit = (code) => {
  if (finalized) {
    realExit(typeof code === 'number' ? code : 0);
    return;
  }
  const exitCode = scheduleExit(code);
  const err = new Error('homegraph-eval-profile: flushing profiles');
  err[EXIT_SENTINEL] = true;
  err.exitCode = exitCode;
  throw err;
};

// Must be first-ish: if HomeGraph's fatal handler also listens, it will call
 // process.exit(1) which our hook treats as already-scheduled (no second throw
 // once finalized path uses realExit). While finalize runs, fatal's exit hits
 // exitScheduled && !finalized — return without throw to avoid re-entry.
const hookedExit = process.exit;
process.exit = (code) => {
  if (finalized) {
    realExit(typeof code === 'number' ? code : 0);
    return;
  }
  if (exitScheduled) {
    // Another exit during flush (e.g. fatal handler) — wait for finalize.
    return;
  }
  return hookedExit(code);
};

process.on('uncaughtException', (err) => {
  if (err && err[EXIT_SENTINEL]) return;
  process.stderr.write(
    `[homegraph-eval-profile] uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : err}\n`,
  );
  if (!exitScheduled) scheduleExit(1);
});

process.on('beforeExit', (code) => {
  if (exitScheduled || finalized) return;
  scheduleExit(code);
});

process.on('SIGINT', () => {
  scheduleExit(130);
});
process.on('SIGTERM', () => {
  scheduleExit(143);
});

module.exports = {};
