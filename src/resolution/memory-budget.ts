/**
 * Memory headroom for worker-pool sizing — cgroup-honest on Linux,
 * reclaim-honest on macOS.
 *
 * `os.freemem()` reads /proc/meminfo, which inside a container reports the
 * HOST's (or VM's) memory, not the cgroup's — the same blindness os.cpus()
 * has for cpusets. A resolver pool sized by cores alone OOM-killed a
 * kernel-scale index in a 7GB-capped container (migration plan §7a.1:
 * oom_kill=5, six ~1GB workers at true 8-core concurrency), so pool sizing
 * combines a CPU term with the memory headroom this module reports.
 *
 * On macOS `os.freemem()` has the OPPOSITE failure: it counts only
 * `free_count` pages, and macOS deliberately keeps RAM full of reclaimable
 * cache — a mostly-idle 64GB machine reads ~1GB "free", so the memory term
 * capped the resolver pool at 2 workers where the CPU term allowed 6
 * (measured on the dubbo warm-wall bench: resolution settle 3.0s at 2
 * workers vs 1.9s at 6, ~1.5–2s of init wall). `darwinMemoryAvailable`
 * reports what Activity Monitor calls available — free + inactive +
 * speculative + purgeable pages — the same reclaimable-inclusive convention
 * the Linux branch uses by crediting `inactive_file` back.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

/** Parse a cgroup value file: numeric bytes, or null for absent/'max'. */
function readCgroupBytes(path: string): number | null {
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    if (raw === 'max') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** `inactive_file` from a cgroup memory.stat file — reclaimable page cache. */
function readInactiveFile(statPath: string): number {
  try {
    const m = /^inactive_file (\d+)$/m.exec(fs.readFileSync(statPath, 'utf8'));
    return m ? Number.parseInt(m[1]!, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Available headroom under the cgroup memory limit (v2 then v1), or null
 * when uncontained (no limit, non-Linux, or unreadable). Never throws.
 *
 * Reclaimable page cache (`inactive_file`) is credited back: `memory.current`
 * counts it as usage, but the kernel reclaims it on demand — after a bulk
 * parse the cache is stuffed with the DB's own pages, and the naive
 * `max − current` read 57MB of headroom on a 6GB container and silently
 * disabled the resolver pool (§7a.1 diagnostic run). This is the same
 * working-set convention `docker stats` uses.
 */
export function cgroupMemoryAvailable(): number | null {
  if (process.platform !== 'linux') return null;
  // v2 unified hierarchy
  const v2Max = readCgroupBytes('/sys/fs/cgroup/memory.max');
  if (v2Max !== null) {
    const current = readCgroupBytes('/sys/fs/cgroup/memory.current') ?? 0;
    const reclaimable = readInactiveFile('/sys/fs/cgroup/memory.stat');
    return Math.max(0, v2Max - Math.max(0, current - reclaimable));
  }
  // v1
  const v1Limit = readCgroupBytes('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  // v1 reports "no limit" as a huge sentinel (~PAGE_COUNTER_MAX); treat
  // anything at or beyond half the address-space-ish range as uncontained.
  if (v1Limit !== null && v1Limit < 2 ** 60) {
    const usage = readCgroupBytes('/sys/fs/cgroup/memory/memory.usage_in_bytes') ?? 0;
    const reclaimable = readInactiveFile('/sys/fs/cgroup/memory/memory.stat');
    return Math.max(0, v1Limit - Math.max(0, usage - reclaimable));
  }
  return null;
}

/**
 * Reclaimable-inclusive available memory on macOS, or null elsewhere / on
 * any parse failure (→ callers fall back to `os.freemem()`). Reads
 * `/usr/bin/vm_stat` — the stable public interface over host_statistics64 —
 * once per call (pool sizing runs it once per init; a few ms). Never throws.
 */
export function darwinMemoryAvailable(): number | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 });
    const pageMatch = /page size of (\d+) bytes/.exec(out);
    const pageSize = pageMatch ? Number.parseInt(pageMatch[1]!, 10) : 16384;
    const count = (label: string): number => {
      const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(out);
      return m ? Number.parseInt(m[1]!, 10) : 0;
    };
    const pages =
      count('Pages free') +
      count('Pages inactive') +
      count('Pages speculative') +
      count('Pages purgeable');
    const bytes = pages * pageSize;
    return bytes > 0 && Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * The budget pool sizing divides: the smaller of system free memory and the
 * cgroup headroom (when contained), with the macOS reclaimable-inclusive
 * reading replacing the too-small darwin `freemem`. Conservative by
 * construction — every number shrinks as the process itself grows.
 */
export function memoryBudgetBytes(): number {
  const free = os.freemem();
  const cgroup = cgroupMemoryAvailable();
  if (cgroup !== null) return Math.min(free, cgroup);
  // darwinAvailable ⊇ free by construction (the sum includes free pages);
  // max() guards a hypothetical undercounting parse.
  const darwin = darwinMemoryAvailable();
  return darwin === null ? free : Math.max(free, darwin);
}

/**
 * Soft Scene/process ceiling from `HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB`, or null
 * when unset / disabled (`0`). Used as an *upper bound* on the host budget for
 * synthesis concurrency — large soft limits still allow parallelism; tight
 * ones collapse toward serial. Never throws.
 */
export function arktsSoftMemoryBudgetBytes(): number | null {
  const raw = process.env.HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB?.trim();
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n) * 1024 * 1024;
}

/**
 * Effective budget for dynamic-edge synthesis fan-out: host (cgroup) headroom,
 * optionally capped by the ArkTS soft mem env when the user set one.
 */
export function synthMemoryBudgetBytes(): number {
  const host = memoryBudgetBytes();
  const soft = arktsSoftMemoryBudgetBytes();
  return soft === null ? host : Math.min(host, soft);
}

/**
 * How many synthesis passes may run concurrently on the resolver pool.
 * Pure — every input injected — so the matrix is unit-testable.
 *
 * Same per-pass cost model as {@link ResolverPool.resolvePoolSize}'s
 * per-worker estimate, but keeps a larger main-thread reserve (50% vs 30%):
 * linking overlaps residual Scene / resolver caches, so the observed peak is
 * main + N workers, not N alone. Soft `--mem` / `HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB`
 * feeds in via `memoryBudget` (caller uses {@link synthMemoryBudgetBytes});
 * a large budget still yields concurrency > 1.
 *
 * Returns 1 when there is no pool (main-thread-only path). Debug override:
 * `HOMEGRAPH_SYNTH_CONCURRENCY` (0/1 → serial; capped at 16).
 */
export function resolveSynthConcurrency(opts: {
  explicit?: string;
  memoryBudget: number;
  dbSizeBytes: number;
  poolWorkers: number;
  maxConcurrency?: number;
}): number {
  const maxCap = opts.maxConcurrency ?? 6;
  if (opts.explicit !== undefined && opts.explicit !== '') {
    const n = Number.parseInt(opts.explicit, 10);
    if (Number.isFinite(n)) {
      if (n <= 1) return 1;
      const poolCap = opts.poolWorkers > 0 ? opts.poolWorkers : n;
      return Math.min(n, 16, poolCap, maxCap);
    }
  }
  if (opts.poolWorkers <= 0) return 1;
  const perPass = Math.min(
    Math.max(opts.dbSizeBytes * 0.2, 256 * 1024 * 1024),
    1.5 * 1024 * 1024 * 1024
  );
  const memCap = Math.floor((opts.memoryBudget * 0.5) / perPass);
  return Math.max(1, Math.min(opts.poolWorkers, memCap, maxCap));
}
