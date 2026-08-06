/**
 * WASM runtime flags — workaround for the V8 turboshaft WASM Zone OOM.
 *
 * tree-sitter grammars are large WebAssembly modules. On Node >= 22 the V8
 * "turboshaft" optimizing WASM compiler can exhaust its per-compilation Zone
 * arena while compiling these grammars on a background thread, aborting the
 * whole process with `Fatal process out of memory: Zone` — even with tens of
 * GB of system memory free, because the Zone is a V8-internal arena, not the
 * JS heap. The trigger is not mere `Language.load` (lazy compile stays on
 * Liftoff): after a large grammar is hot from repeated parse, turboshaft's
 * background optimizing compile OOMs the Zone. Reproduced on Node 24 and 25+
 * (see test/fixtures/wasm-zone-oom-harness.cjs); mitigated here rather than by
 * blocking majors (see ../bin/node-version-check.ts for the supported floor
 * only). See issues #293 and #298.
 *
 * `--liftoff-only` forces every WASM module to the Liftoff baseline compiler
 * and never runs turboshaft, which eliminates the crash. Parsing stays fully
 * correct; we only forgo the (marginal, and for grammars rarely reached)
 * optimized-tier speedup.
 *
 * This flag MUST be on node's command line — it is read by V8 at engine init,
 * before any of our JS runs. Empirically (Node 24) none of these work:
 *   - `v8.setFlagsFromString('--liftoff-only')` at runtime — too late.
 *   - Worker `execArgv: ['--liftoff-only']` — rejected (ERR_WORKER_INVALID_EXEC_ARGV).
 *   - `NODE_OPTIONS=--liftoff-only` — not on Node's NODE_OPTIONS allowlist.
 * Also empirically, `--no-wasm-tier-up` / `--no-wasm-dynamic-tiering` do NOT
 * prevent the crash — only disabling the optimizing tier entirely does.
 *
 * Delivery: the CLI re-execs itself once with the flag via
 * {@link relaunchWithWasmRuntimeFlagsIfNeeded} when launched without it
 * (running dist directly, from source, npm global, etc.). V8 flags are
 * PROCESS-global, and the parse worker is created with default (inherited)
 * execArgv, so flagging the main process governs the worker's WASM compilation
 * too.
 */
import { spawnSync } from 'child_process';

/**
 * The V8 flag(s) that keep tree-sitter grammar compilation off the turboshaft
 * optimizing tier. Single source of truth: the relaunch guard and the test
 * suite both read this (a test asserts each is a real flag on the running
 * runtime, so a rename can't silently regress the fix).
 */
export const WASM_RUNTIME_FLAGS: readonly string[] = ['--liftoff-only'];

/** Target process RSS ceiling (MB) for ArkTS indexing — not the V8 heap alone. */
export const PROCESS_RSS_CAP_MB = 4096;
/**
 * Headroom below {@link PROCESS_RSS_CAP_MB} reserved for native RSS outside the
 * V8 old-space heap (ArkAnalyzer IR, SQLite, buffers). Empirical on scene_board_ext:
 * `--max-old-space-size=4096` peaked ~4360MB WorkingSet.
 */
const NATIVE_RSS_HEADROOM_MB = 512;

/** Default V8 old-space cap (MB): process RSS target minus native headroom. */
const DEFAULT_MAX_OLD_SPACE_MB = PROCESS_RSS_CAP_MB - NATIVE_RSS_HEADROOM_MB;

/**
 * Env var set on the relaunched child so a detection slip can never cause an
 * infinite re-exec loop. Also lets users force-disable the relaunch.
 */
const RELAUNCH_GUARD_ENV = 'HOMEGRAPH_WASM_RELAUNCHED';

/** Override with `HOMEGRAPH_MAX_OLD_SPACE_MB` (positive integer). Default 3584. */
export function resolveMaxOldSpaceSizeMb(): number {
  const raw = process.env.HOMEGRAPH_MAX_OLD_SPACE_MB?.trim();
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_MAX_OLD_SPACE_MB;
}

export function maxOldSpaceSizeFlag(mb: number = resolveMaxOldSpaceSizeMb()): string {
  return `--max-old-space-size=${mb}`;
}

function execArgvHasMaxOldSpaceSize(execArgv: readonly string[]): boolean {
  return execArgv.some((arg) => arg === '--max-old-space-size' || arg.startsWith('--max-old-space-size='));
}

/**
 * Env var carrying the *host* PID (the relauncher's own parent) across the
 * re-exec. Without `--liftoff-only` the CLI re-execs itself once, inserting an
 * intermediate process between the MCP host and the server. That intermediate
 * stays alive (blocked in spawnSync) even after the host is killed, so the
 * server's PPID watchdog can't detect the host's death by watching its own
 * `process.ppid`. Passing the host PID through lets the watchdog poll it
 * directly. Unset on the no-re-exec path (bundled launcher / flag already
 * present), where the server is already a direct child of the host. See
 * src/mcp/index.ts (#277).
 */
export const HOST_PPID_ENV = 'HOMEGRAPH_HOST_PPID';

/** True when every required WASM runtime flag is already present in `execArgv`. */
export function processHasWasmRuntimeFlags(
  execArgv: readonly string[] = process.execArgv
): boolean {
  return WASM_RUNTIME_FLAGS.every((flag) => execArgv.includes(flag));
}

/** True when WASM flags + a `--max-old-space-size` cap are already present. */
export function processHasRequiredRuntimeFlags(
  execArgv: readonly string[] = process.execArgv
): boolean {
  return processHasWasmRuntimeFlags(execArgv) && execArgvHasMaxOldSpaceSize(execArgv);
}

/**
 * Build the argv for re-execing node with the WASM runtime flags: our flags
 * first, then any node flags already in `execArgv` (deduped), then the script
 * and its args. Pure — exported for unit testing.
 *
 * Also injects `--max-old-space-size=<N>` (default 3584 ≈ 4GB process RSS target
 * minus native headroom; override via HOMEGRAPH_MAX_OLD_SPACE_MB) when missing.
 */
export function buildRelaunchArgv(
  scriptPath: string,
  scriptArgs: readonly string[],
  execArgv: readonly string[] = process.execArgv
): string[] {
  const preserved = execArgv.filter((arg) => !WASM_RUNTIME_FLAGS.includes(arg));
  let sawHeap = false;
  const deduped: string[] = [];
  for (const arg of preserved) {
    const isHeap = arg === '--max-old-space-size' || arg.startsWith('--max-old-space-size=');
    if (isHeap) {
      if (sawHeap) continue;
      sawHeap = true;
    }
    deduped.push(arg);
  }
  const heapFlag = sawHeap ? [] : [maxOldSpaceSizeFlag()];
  return [...WASM_RUNTIME_FLAGS, ...heapFlag, ...deduped, scriptPath, ...scriptArgs];
}

/**
 * If the current process is missing the WASM runtime flags (or a heap cap),
 * re-exec it once with them and exit with the child's status. No-op when the
 * flags are already present (the normal bundled-launcher path), when already
 * relaunched, or when disabled via HOMEGRAPH_NO_RELAUNCH.
 *
 * On spawn failure, returns so the caller runs in-process anyway — risking the
 * OOM is still better than refusing to start.
 */
export function relaunchWithWasmRuntimeFlagsIfNeeded(scriptPath: string): void {
  if (processHasRequiredRuntimeFlags()) return;
  if (process.env[RELAUNCH_GUARD_ENV]) return;
  if (process.env.HOMEGRAPH_NO_RELAUNCH) return;

  const argv = buildRelaunchArgv(scriptPath, process.argv.slice(2));
  const result = spawnSync(process.execPath, argv, {
    stdio: 'inherit',
    env: { ...process.env, [RELAUNCH_GUARD_ENV]: '1', [HOST_PPID_ENV]: String(process.ppid) },
    windowsHide: true,
  });

  if (result.error) {
    // Couldn't relaunch (e.g. execPath unavailable) — fall through and run in
    // this process. Degraded (may OOM on huge repos) but not broken.
    return;
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}
