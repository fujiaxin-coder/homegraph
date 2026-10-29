/**
 * Run local homegraph index/init/sync against a project while sampling the
 * FULL process-tree memory (main node + liftoff re-exec + parse workers).
 *
 * Prints elapsed time, current tree memory, and peak tree memory on an
 * interval. At exit, prints a one-line peak summary. Memory is the OS view
 * of the launched process and all descendants, not the V8 heap alone.
 *
 * With `--profile`, loads `profile-preload.cjs` into the homegraph process tree
 * (arkanalyzer/tests/samples/perf style): inspector CPU + heap sampling, 10ms
 * heap/RSS peaks, GC pauses, Top-N hot functions, plus the OS process-tree
 * memory timeline. Survives the `--liftoff-only` re-exec.
 *
 * Metric by platform (WorkingSet / raw RSS is avoided where a stabler figure
 * exists — under RAM pressure the working set is trimmed and can report tens
 * of MB while the process still holds multi-GB):
 *   win32  — PrivateMemorySize64 (commit), same as index-peak-mem.ps1
 *   linux  — smaps_rollup Private_Clean + Private_Dirty + Swap
 *   darwin — phys_footprint (one `footprint` call for the tree); else RSS
 *
 * Usage:
 *   npm run eval:peak-mem -- --project /path/to/project
 *   npm run eval:peak-mem -- --project /path/to/project --profile --out ./prof
 *   npm run eval:peak-mem -- --project /path/to/project --command init --interval 3 --build
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type CommandName = 'init' | 'index' | 'sync';

interface Options {
  project: string;
  homeGraphRoot: string;
  command: CommandName;
  intervalSec: number;
  build: boolean;
  verbose: boolean;
  /** Enable inspector CPU/heap/GC + process-tree memory timeline. */
  profile: boolean;
  /** Artifact directory for --profile (default: tmp). */
  outDir: string | undefined;
  /** Top-N hot frames to print (default: 20; 0 = skip lists). */
  hotTop: number;
}

interface MemSampleRow {
  tSec: number;
  iso: string;
  bytes: number;
  mb: number;
  peakBytes: number;
  peakMb: number;
  procs: number;
}

interface ProcRow {
  ppid: number;
  rssBytes: number;
}

interface TreeSample {
  bytes: number;
  procCount: number;
}

interface Metric {
  code: string;
  title: string;
  blurb: string;
  sample: (rootPid: number) => TreeSample;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MB = 1024 * 1024;

function printUsage(): void {
  console.log(`Usage: npm run eval:peak-mem -- --project <path> [options]

Run homegraph init|index|sync and sample the full process-tree memory
(main node + liftoff re-exec + parse workers).

Options:
  --project <path>            Project to index (required; positional also accepted)
  --homegraph-root <path>     HomeGraph checkout (default: this package root)
  --command <init|index|sync> Command to run (default: index)
  --interval <seconds>        Memory sample interval (default: 5)
  --build                     npm run build before sampling
  --verbose                   Pass --verbose to homegraph
  --profile                   Collect CPU/alloc hot functions + memory timeline
  --out <dir>                 Artifact directory (implies --profile; default: tmp)
  --hot-top <n>               Top N hot frames to print (default: 20; 0=off)
  -h, --help
`);
}

function parseArgs(argv: string[]): Options {
  let project: string | undefined;
  let homeGraphRoot = PACKAGE_ROOT;
  let command: CommandName = 'index';
  let intervalSec = 5;
  let build = false;
  let verbose = false;
  let profile = false;
  let outDir: string | undefined;
  let hotTop = 20;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--project') {
      project = next();
    } else if (arg === '--homegraph-root') {
      homeGraphRoot = path.resolve(next());
    } else if (arg === '--command') {
      const value = next();
      if (value !== 'init' && value !== 'index' && value !== 'sync') {
        throw new Error(`Invalid --command ${value} (expected init|index|sync)`);
      }
      command = value;
    } else if (arg === '--interval') {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--interval must be an integer >= 1');
      }
      intervalSec = value;
    } else if (arg === '--build') {
      build = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--profile') {
      profile = true;
    } else if (arg === '--out') {
      profile = true;
      outDir = path.resolve(next());
    } else if (arg === '--hot-top') {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--hot-top must be an integer >= 0');
      }
      hotTop = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1 || (project !== undefined && positional.length > 0)) {
    throw new Error(`Unexpected arguments: ${positional.join(' ')}`);
  }
  if (!project && positional.length === 1) project = positional[0];
  if (!project) {
    printUsage();
    throw new Error('Missing --project <path>');
  }

  return {
    project: path.resolve(project),
    homeGraphRoot,
    command,
    intervalSec,
    build,
    verbose,
    profile,
    outDir,
    hotTop,
  };
}

/** `unref` keeps the sampler from pinning the event loop while the child runs. */
function sleep(ms: number, keepAlive = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!keepAlive) timer.unref();
  });
}

function formatFixed(value: number, width: number, digits: number): string {
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: true,
  });
  return text.padStart(width);
}

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatSample(metric: string, elapsedSec: number, bytes: number, peakBytes: number, procs: number): string {
  return (
    `[${formatClock(new Date())}] +${formatFixed(elapsedSec, 7, 1)}s  ` +
    `${metric}=${formatFixed(bytes / MB, 8, 1)} MB  ` +
    `peak=${formatFixed(peakBytes / MB, 8, 1)} MB  procs=${procs}`
  );
}

/** One `ps` snapshot: pid → parent + resident KB. Cheap stand-in for a full-system WMI walk. */
function readPsTable(): Map<number, ProcRow> {
  const out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,rss='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const table = new Map<number, ProcRow>();
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rssKb)) continue;
    table.set(pid, { ppid, rssBytes: rssKb * 1024 });
  }
  return table;
}

function collectDescendants(rootPid: number, table: Map<number, ProcRow>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, info] of table) {
    const list = children.get(info.ppid);
    if (list) list.push(pid);
    else children.set(info.ppid, [pid]);
  }

  const out: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  let head = 0;
  while (head < queue.length) {
    const id = queue[head];
    head++;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const kids = children.get(id);
    if (kids) {
      for (const kid of kids) queue.push(kid);
    }
  }
  return out;
}

function sampleRss(rootPid: number): TreeSample {
  const table = readPsTable();
  const pids = collectDescendants(rootPid, table);
  let bytes = 0;
  for (const pid of pids) bytes += table.get(pid)?.rssBytes ?? 0;
  return { bytes, procCount: pids.length };
}

/**
 * Linux private resident + swap. Swap is included so a paged-out heap is not
 * reported as "gone" the way a trimmed working set is.
 */
function linuxPrivateBytes(pid: number): number | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  } catch {
    return null;
  }
  let kb = 0;
  let found = false;
  for (const line of text.split('\n')) {
    const match = /^(?:Private_Clean|Private_Dirty|Swap):\s+(\d+)\s+kB\b/.exec(line);
    if (!match?.[1]) continue;
    kb += Number(match[1]);
    found = true;
  }
  return found ? kb * 1024 : null;
}

function sampleLinux(rootPid: number): TreeSample {
  const table = readPsTable();
  const pids = collectDescendants(rootPid, table);
  let bytes = 0;
  for (const pid of pids) {
    const priv = linuxPrivateBytes(pid);
    bytes += priv ?? table.get(pid)?.rssBytes ?? 0;
  }
  return { bytes, procCount: pids.length };
}

function footprintAvailable(): boolean {
  const result = spawnSync('footprint', ['--help'], { stdio: 'ignore' });
  return result.status === 0;
}

/** Sum phys_footprint for the whole tree in one call. Returns null if unusable. */
function readPhysFootprint(pids: number[]): number | null {
  const args = ['--format', 'bytes', '--noCategories'];
  for (const pid of pids) args.push('-p', String(pid));
  const result = spawnSync('footprint', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || !result.stdout) return null;
  let bytes = 0;
  let matched = 0;
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*phys_footprint:\s+(\d+)\s+B\s*$/.exec(line);
    if (!match?.[1]) continue;
    bytes += Number(match[1]);
    matched++;
  }
  return matched > 0 ? bytes : null;
}

function sampleDarwin(rootPid: number): TreeSample {
  const table = readPsTable();
  const pids = collectDescendants(rootPid, table);
  const bytes = pids.length > 0 ? readPhysFootprint(pids) : 0;
  if (bytes === null) {
    throw new Error('footprint returned no phys_footprint samples');
  }
  return { bytes, procCount: pids.length };
}

/**
 * Filtered ParentProcessId queries only — a full-system Win32_Process scan
 * stalls for minutes under a multi-GB index and drops samples mid-run.
 */
function sampleWindows(rootPid: number): TreeSample {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { bytes: 0, procCount: 0 };
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$q = New-Object System.Collections.Generic.Queue[int]
$q.Enqueue(${rootPid})
$seen = @{}
$sum = [int64]0
$count = 0
while ($q.Count -gt 0) {
  $id = $q.Dequeue()
  if ($seen.ContainsKey($id)) { continue }
  $seen[$id] = $true
  $count++
  try {
    $proc = Get-Process -Id $id -ErrorAction Stop
    $sum += [int64]$proc.PrivateMemorySize64
  } catch {}
  try {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -Property ProcessId -ErrorAction SilentlyContinue |
      ForEach-Object { $q.Enqueue([int]$_.ProcessId) }
  } catch {}
}
Write-Output ("{0} {1}" -f $sum, $count)
`.trim();
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  const line = out.trim().split(/\r?\n/).filter((row) => row.length > 0).at(-1) ?? '';
  const [bytesText, countText] = line.split(/\s+/);
  const bytes = Number(bytesText);
  const procCount = Number(countText);
  if (!Number.isFinite(bytes) || !Number.isFinite(procCount)) {
    throw new Error(`unexpected powershell sample output: ${line}`);
  }
  return { bytes, procCount };
}

function selectMetric(): Metric {
  if (process.platform === 'win32') {
    return {
      code: 'PRIV',
      title: 'process tree PrivateMemory',
      blurb: 'tree PrivateMemory (commit) of homegraph + descendants',
      sample: sampleWindows,
    };
  }
  if (process.platform === 'linux') {
    return {
      code: 'PRIV',
      title: 'process tree private memory',
      blurb: 'tree private memory (smaps Private_* + Swap) of homegraph + descendants',
      sample: sampleLinux,
    };
  }
  if (process.platform === 'darwin' && footprintAvailable()) {
    return {
      code: 'PHYS',
      title: 'process tree phys_footprint',
      blurb: 'tree phys_footprint of homegraph + descendants',
      sample: sampleDarwin,
    };
  }
  return {
    code: 'RSS',
    title: 'process tree RSS',
    blurb: 'tree RSS of homegraph + descendants',
    sample: sampleRss,
  };
}

function runBuild(homeGraphRoot: string): void {
  console.log('==> npm run build');
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: homeGraphRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`build failed (exit ${result.status ?? 1})`);
  }
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    const finish = (code: number) => resolve(code);
    child.once('error', () => finish(1));
    child.once('exit', (code) => finish(code ?? 1));
    if (child.exitCode !== null) finish(child.exitCode);
    else if (child.signalCode !== null) finish(1);
  });
}

function stampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const PRELOAD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'profile-preload.cjs',
);

function resolveOutDir(options: Options): string {
  if (options.outDir) return options.outDir;
  return path.join(os.tmpdir(), `homegraph-profile-${stampSlug()}`);
}

function buildNodeExecArgs(profileDir: string | undefined): string[] {
  if (!profileDir) return [];
  if (!existsSync(PRELOAD_PATH)) {
    throw new Error(`profile preload missing: ${PRELOAD_PATH}`);
  }
  return [`--require=${PRELOAD_PATH}`, '--expose-gc'];
}

interface ProcessProfileSummary {
  version?: number;
  kind?: string;
  pid: number;
  ppid?: number;
  argv?: string[];
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  durationMs: number;
  heapBefore?: { used: number; total: number; limit: number };
  heapAfter?: { used: number; total: number; limit: number };
  heapGrowthBytes: number;
  heapPeakUsedBytes: number;
  rssPeakBytes: number;
  rssAfterBytes?: number;
  gcPauses: {
    count: number;
    totalDurationMs: number;
    naturalCount: number;
    naturalDurationMs: number;
    manualCount: number;
    manualDurationMs: number;
  };
  cpuHotFunctions: Array<{
    name: string;
    location: string;
    selfTimeMs: number;
    sampleCount: number;
  }>;
  allocationHotFunctions: Array<{
    name: string;
    location: string;
    allocatedBytes: number;
    allocatedMb: number;
    sampleCount?: number;
  }>;
  cpuProfileFile?: string | null;
  heapProfileFile?: string | null;
}

function listProcessSummaries(profileDir: string, sinceMs: number): ProcessProfileSummary[] {
  if (!existsSync(profileDir)) return [];
  const out: ProcessProfileSummary[] = [];
  for (const name of readdirSync(profileDir)) {
    if (!name.endsWith('-summary.json') || !name.startsWith('pid-')) continue;
    const full = path.join(profileDir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs + 2000 < sinceMs) continue;
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as ProcessProfileSummary;
      if (parsed.kind !== 'homegraph-eval-profile') continue;
      out.push(parsed);
    } catch {
      // ignore partial writes
    }
  }
  return out.sort((a, b) => b.durationMs - a.durationMs);
}

/** Mirror arkanalyzer round_worker printStageSummary. */
function printProcessProfileSummary(summary: ProcessProfileSummary, hotTop: number): void {
  const label = `pid ${summary.pid}`;
  console.log('');
  console.log(`[${label}]`);
  console.log(`  Duration      : ${summary.durationMs.toFixed(2)} ms`);
  console.log(`  Heap Growth   : ${(summary.heapGrowthBytes / MB).toFixed(2)} MB`);
  console.log(`  Heap Peak     : ${(summary.heapPeakUsedBytes / MB).toFixed(2)} MB`);
  if (summary.heapAfter) {
    console.log(`  Heap Used End : ${(summary.heapAfter.used / MB).toFixed(2)} MB`);
  }
  console.log(`  RSS Peak      : ${(summary.rssPeakBytes / MB).toFixed(2)} MB`);
  if (summary.rssAfterBytes !== undefined) {
    console.log(`  RSS End       : ${(summary.rssAfterBytes / MB).toFixed(2)} MB`);
  }
  console.log(
    `  GC Pauses     : ${summary.gcPauses.count} (${summary.gcPauses.totalDurationMs.toFixed(2)} ms)`,
  );
  const cpu = summary.cpuHotFunctions.slice(0, hotTop);
  console.log(`  CPU Hot Functions : ${cpu.length}`);
  if (cpu[0]) {
    console.log(`    Top: ${cpu[0].name} (${cpu[0].selfTimeMs.toFixed(2)} ms)`);
  }
  for (const row of cpu.slice(0, Math.min(10, hotTop))) {
    console.log(
      `    ${formatFixed(row.selfTimeMs, 8, 1)}ms  ${row.name}  ${row.location}`,
    );
  }
  const alloc = summary.allocationHotFunctions.slice(0, hotTop);
  console.log(`  Allocation Hot Functions : ${alloc.length}`);
  if (alloc[0]) {
    console.log(`    Top: ${alloc[0].name} (${alloc[0].allocatedMb.toFixed(2)} MB)`);
  }
  for (const row of alloc.slice(0, Math.min(10, hotTop))) {
    console.log(
      `    ${formatFixed(row.allocatedMb, 8, 2)} MB  ${row.name}  ${row.location}`,
    );
  }
}

function writeMemTimeline(file: string, payload: unknown): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function run(options: Options): Promise<number> {
  if (!existsSync(options.project)) {
    throw new Error(`Project path not found: ${options.project}`);
  }
  if (options.build) runBuild(options.homeGraphRoot);

  const hgJs = path.join(options.homeGraphRoot, 'dist', 'bin', 'homegraph.js');
  if (!existsSync(hgJs)) {
    throw new Error(
      `homegraph binary missing — run npm run build in ${options.homeGraphRoot} first (or pass --build)`,
    );
  }

  const outDir = options.profile ? resolveOutDir(options) : undefined;
  const memOutPath = outDir ? path.join(outDir, 'mem-timeline.json') : undefined;
  if (outDir) mkdirSync(outDir, { recursive: true });

  const metric = selectMetric();
  const nodeFlags = buildNodeExecArgs(outDir);
  const args = [...nodeFlags, hgJs, options.command, options.project];
  if (options.verbose) args.push('--verbose');

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (outDir) {
    childEnv.HOMEGRAPH_EVAL_PROFILE_DIR = outDir;
    childEnv.HOMEGRAPH_EVAL_HOT_TOP = String(options.hotTop);
    childEnv.HOMEGRAPH_EVAL_HEAP_INTERVAL = String(32 * 1024);
  }

  console.log(`==> node ${args.join(' ')}`);
  console.log(`==> sampling every ${options.intervalSec}s — ${metric.blurb}`);
  if (outDir) {
    console.log(`==> profile (CPU/heap/RSS/GC + mem timeline) → ${outDir}`);
  }
  console.log('');

  const child = spawn(process.execPath, args, {
    cwd: options.homeGraphRoot,
    stdio: 'inherit',
    env: childEnv,
  });
  if (child.pid === undefined) {
    throw new Error('failed to spawn node');
  }
  const rootPid = child.pid;
  const exitPromise = waitForExit(child);

  const t0 = Date.now();
  let peakBytes = 0;
  let peakAt = t0;
  let sampleN = 0;
  const memSamples: MemSampleRow[] = [];

  const recordSample = (sample: TreeSample, atMs: number): void => {
    if (sample.bytes > peakBytes) {
      peakBytes = sample.bytes;
      peakAt = atMs;
    }
    sampleN++;
    const elapsed = (atMs - t0) / 1000;
    console.log(formatSample(metric.code, elapsed, sample.bytes, peakBytes, sample.procCount));
    if (memOutPath) {
      memSamples.push({
        tSec: Number(elapsed.toFixed(3)),
        iso: new Date(atMs).toISOString(),
        bytes: sample.bytes,
        mb: Number((sample.bytes / MB).toFixed(3)),
        peakBytes,
        peakMb: Number((peakBytes / MB).toFixed(3)),
        procs: sample.procCount,
      });
    }
  };

  while (child.exitCode === null && child.signalCode === null) {
    const woke = await Promise.race([
      sleep(options.intervalSec * 1000).then(() => 'tick' as const),
      exitPromise.then(() => 'exit' as const),
    ]);
    if (woke === 'exit' || child.exitCode !== null || child.signalCode !== null) break;

    let sample: TreeSample;
    try {
      sample = metric.sample(rootPid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`sample failed: ${message}`);
      continue;
    }
    recordSample(sample, Date.now());
  }

  const exitCode = await exitPromise;

  try {
    const finalSample = metric.sample(rootPid);
    const at = Date.now();
    if (finalSample.bytes > peakBytes) {
      peakBytes = finalSample.bytes;
      peakAt = at;
    }
    if (memOutPath && (finalSample.bytes > 0 || finalSample.procCount > 0)) {
      const elapsed = (at - t0) / 1000;
      memSamples.push({
        tSec: Number(elapsed.toFixed(3)),
        iso: new Date(at).toISOString(),
        bytes: finalSample.bytes,
        mb: Number((finalSample.bytes / MB).toFixed(3)),
        peakBytes,
        peakMb: Number((peakBytes / MB).toFixed(3)),
        procs: finalSample.procCount,
      });
    }
  } catch {
    // process tree already gone
  }

  const totalSec = (Date.now() - t0) / 1000;
  const peakSec = (peakAt - t0) / 1000;
  const title = `======== peak memory (${metric.title}) ========`;
  console.log('');
  console.log(title);
  console.log(`  project : ${options.project}`);
  console.log(`  command : homegraph ${options.command}`);
  console.log(`  exit    : ${exitCode}`);
  console.log(`  elapsed : ${totalSec.toFixed(1)}s`);
  console.log(`  samples : ${sampleN}`);
  console.log(
    `  PEAK ${metric.code}: ${formatFixed(peakBytes / MB, 0, 1)} MB  (at +${peakSec.toFixed(1)}s)`,
  );
  if (outDir) {
    console.log(`  out      : ${outDir}`);
  }
  console.log('='.repeat(Math.max(title.length, 60)));

  if (outDir && memOutPath) {
    writeMemTimeline(memOutPath, {
      version: 1,
      project: options.project,
      homeGraphRoot: options.homeGraphRoot,
      command: options.command,
      metric: metric.code,
      metricTitle: metric.title,
      sampleIntervalSec: options.intervalSec,
      startedAt: new Date(t0).toISOString(),
      endedAt: new Date().toISOString(),
      elapsedSec: Number(totalSec.toFixed(3)),
      exitCode,
      peakBytes,
      peakMb: Number((peakBytes / MB).toFixed(3)),
      peakAtSec: Number(peakSec.toFixed(3)),
      sampleCount: memSamples.length,
      samples: memSamples,
    });

    // Preload finalizes inside process.exit(); allow a brief flush window.
    await sleep(600, true);
    const processSummaries = listProcessSummaries(outDir, t0);
    console.log('');
    console.log('======== process profiles (inspector) ========');
    console.log(`  dir       : ${outDir}`);
    console.log(`  processes : ${processSummaries.length}`);
    if (processSummaries.length === 0) {
      console.log('  (no pid-*-summary.json — process may have been SIGKILL/OOM)');
    } else {
      for (const summary of processSummaries) {
        printProcessProfileSummary(summary, options.hotTop);
      }
    }
    const combinedPath = path.join(outDir, 'summary.json');
    writeMemTimeline(combinedPath, {
      version: 1,
      kind: 'homegraph-eval-peak-mem',
      project: options.project,
      homeGraphRoot: options.homeGraphRoot,
      command: options.command,
      exitCode,
      elapsedSec: Number(totalSec.toFixed(3)),
      treeMemory: {
        metric: metric.code,
        metricTitle: metric.title,
        peakBytes,
        peakMb: Number((peakBytes / MB).toFixed(3)),
        peakAtSec: Number(peakSec.toFixed(3)),
        sampleIntervalSec: options.intervalSec,
        samples: memSamples,
      },
      processes: processSummaries,
    });
    console.log('');
    console.log(`==> wrote mem timeline → ${memOutPath}`);
    console.log(`==> wrote combined summary → ${combinedPath}`);
    console.log('================================================');
  }

  return exitCode;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const base = path.basename(entry);
  return base === 'index-peak-mem.ts' || base === 'index-peak-mem.js';
}

if (isDirectRun()) {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  run(options)
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
