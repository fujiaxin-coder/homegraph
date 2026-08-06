/**
 * Resolver-pool sizing (§7a.1 P1.2): cgroup-honest CPU term + memory-aware
 * cap + the HOMEGRAPH_RESOLVE_WORKERS override. resolvePoolSize is pure —
 * these pin the whole decision matrix, including the two failure modes the
 * measurement round exposed: os.cpus() cpuset-blindness (6 workers inside a
 * 2-CPU container) and memory-blind sizing (six ~1GB workers OOM-killing a
 * 7GB container at true 8-core concurrency).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import { ResolverPool } from '../src/resolution/resolver-pool';
import {
  cgroupMemoryAvailable,
  darwinMemoryAvailable,
  memoryBudgetBytes,
  resolveSynthConcurrency,
  synthMemoryBudgetBytes,
  arktsSoftMemoryBudgetBytes,
} from '../src/resolution/memory-budget';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function size(opts: Partial<Parameters<typeof ResolverPool.resolvePoolSize>[0]>): number | null {
  return ResolverPool.resolvePoolSize({
    availableParallelism: 8,
    memoryBudget: 16 * GB,
    dbSizeBytes: 200 * MB,
    ...opts,
  });
}

describe('ResolverPool.resolvePoolSize', () => {
  it('big dev box: CPU-capped at the long-standing 6', () => {
    expect(size({})).toBe(6);
    expect(size({ availableParallelism: 11 })).toBe(6);
  });

  it('true 2-core box gets NO pool — sequential measured faster there (§7a.1: 853s vs 1150s)', () => {
    expect(size({ availableParallelism: 2, memoryBudget: 6 * GB })).toBeNull();
    expect(size({ availableParallelism: 3, memoryBudget: 6 * GB })).toBe(2);
  });

  it('kernel-scale DB in a 7GB container: memory term shrinks the pool below the OOM line', () => {
    // 4.6GB DB → ~940MB/worker estimate; 5.5GB headroom × 0.7 ≈ 3.85GB → 4 workers.
    const s = size({ availableParallelism: 8, memoryBudget: 5.5 * GB, dbSizeBytes: 4.6 * GB });
    expect(s).toBe(4);
    expect(s!).toBeLessThan(6);
  });

  it('per-worker estimate is floored (small DBs) and capped (huge DBs)', () => {
    // Small DB: floor 256MB/worker — memory cap = 16GB*0.7/256MB = 43 → CPU wins.
    expect(size({ dbSizeBytes: 10 * MB })).toBe(6);
    // Monster DB: cap 1.5GB/worker — 16GB*0.7/1.5GB = 7 → CPU still wins at 6.
    expect(size({ dbSizeBytes: 40 * GB })).toBe(6);
    // Same monster DB, tight memory: 4GB*0.7/1.5GB = 1 → below 2 → no pool.
    expect(size({ dbSizeBytes: 40 * GB, memoryBudget: 4 * GB })).toBeNull();
  });

  it('starved memory disables the pool entirely', () => {
    expect(size({ memoryBudget: 512 * MB, dbSizeBytes: 4 * GB })).toBeNull();
  });

  it('HOMEGRAPH_RESOLVE_WORKERS overrides everything: 0 disables, values clamp at 16', () => {
    expect(size({ explicit: '0' })).toBeNull();
    expect(size({ explicit: '3', memoryBudget: 512 * MB })).toBe(3); // override skips the memory term
    expect(size({ explicit: '64' })).toBe(16);
    expect(size({ explicit: 'nonsense' })).toBe(6); // unparseable → computed path
  });
});

describe('memory budget helpers', () => {
  it('memoryBudgetBytes is positive and finite on every platform', () => {
    const b = memoryBudgetBytes();
    expect(b).toBeGreaterThan(0);
    expect(Number.isFinite(b)).toBe(true);
  });

  it('cgroupMemoryAvailable is null when uncontained (non-Linux) and never throws', () => {
    const v = cgroupMemoryAvailable();
    if (process.platform !== 'linux') {
      expect(v).toBeNull();
    } else {
      // Containerized CI: either uncontained (null) or a sane byte count.
      expect(v === null || (v >= 0 && Number.isFinite(v))).toBe(true);
    }
  });

  it.runIf(process.platform === 'darwin')(
    'darwin: available memory counts reclaimable pages, not just free_count',
    () => {
      const v = darwinMemoryAvailable();
      // vm_stat exists on every macOS; a null here means the parse broke.
      expect(v).not.toBeNull();
      expect(Number.isFinite(v!)).toBe(true);
      // The sum includes the free pages freemem() counts, so it can only be
      // larger (modulo TOCTOU drift between the two reads — allow slack).
      expect(v!).toBeGreaterThanOrEqual(os.freemem() * 0.5);
      // And the budget must ride it (the 2-worker strangulation regression:
      // a mostly-idle Mac read ~1GB free and halved the resolver pool).
      expect(memoryBudgetBytes()).toBeGreaterThanOrEqual(v! * 0.5);
    }
  );

  it.runIf(process.platform !== 'darwin')(
    'darwinMemoryAvailable is null off-macOS and never throws',
    () => {
      expect(darwinMemoryAvailable()).toBeNull();
    }
  );
});

describe('resolveSynthConcurrency', () => {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;

  function synth(opts: Partial<Parameters<typeof resolveSynthConcurrency>[0]>): number {
    return resolveSynthConcurrency({
      memoryBudget: 16 * GB,
      dbSizeBytes: 200 * MB,
      poolWorkers: 6,
      ...opts,
    });
  }

  it('no pool → always serial', () => {
    expect(synth({ poolWorkers: 0, memoryBudget: 64 * GB })).toBe(1);
  });

  it('tight soft budget (~1G Scene cap) collapses toward serial', () => {
    // 1GB * 0.5 / 256MB floor = 2 → with larger DB estimate drops to 1
    expect(synth({ memoryBudget: 1024 * MB, dbSizeBytes: 4.6 * GB, poolWorkers: 6 })).toBe(1);
    expect(synth({ memoryBudget: 512 * MB, dbSizeBytes: 200 * MB, poolWorkers: 6 })).toBe(1);
  });

  it('large budget still parallelizes up to pool size / max', () => {
    expect(synth({ memoryBudget: 16 * GB, dbSizeBytes: 200 * MB, poolWorkers: 6 })).toBe(6);
    expect(synth({ memoryBudget: 16 * GB, dbSizeBytes: 200 * MB, poolWorkers: 4 })).toBe(4);
  });

  it('mid budget yields mid concurrency (not forced to 1)', () => {
    // 4GB * 0.5 / 256MB = 8 → capped by pool 6
    expect(synth({ memoryBudget: 4 * GB, dbSizeBytes: 200 * MB, poolWorkers: 6 })).toBe(6);
    // 2GB * 0.5 / 256MB = 4
    expect(synth({ memoryBudget: 2 * GB, dbSizeBytes: 200 * MB, poolWorkers: 6 })).toBe(4);
  });

  it('HOMEGRAPH_SYNTH_CONCURRENCY override: ≤1 serializes, values clamp', () => {
    expect(synth({ explicit: '0', memoryBudget: 16 * GB, poolWorkers: 6 })).toBe(1);
    expect(synth({ explicit: '1', memoryBudget: 16 * GB, poolWorkers: 6 })).toBe(1);
    expect(synth({ explicit: '3', memoryBudget: 512 * MB, poolWorkers: 6 })).toBe(3);
    expect(synth({ explicit: '64', memoryBudget: 16 * GB, poolWorkers: 6 })).toBe(6); // pool + maxCap
  });
});

describe('synthMemoryBudgetBytes / arkts soft cap', () => {
  const prev = process.env.HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB;

  afterEach(() => {
    if (prev === undefined) delete process.env.HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB;
    else process.env.HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB = prev;
  });

  it('unset soft mem → host budget only', () => {
    delete process.env.HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB;
    expect(arktsSoftMemoryBudgetBytes()).toBeNull();
    // Same path as memoryBudgetBytes(); don't double-call freemem (TOCTOU).
    const b = synthMemoryBudgetBytes();
    expect(b).toBeGreaterThan(0);
    expect(Number.isFinite(b)).toBe(true);
  });

  it('soft mem=0 disables the soft cap', () => {
    process.env.HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB = '0';
    expect(arktsSoftMemoryBudgetBytes()).toBeNull();
  });

  it('soft mem caps the host budget from above', () => {
    process.env.HOMEGRAPH_ARKTS_MEMORY_LIMIT_MB = '1024';
    expect(arktsSoftMemoryBudgetBytes()).toBe(1024 * 1024 * 1024);
    expect(synthMemoryBudgetBytes()).toBeLessThanOrEqual(1024 * 1024 * 1024);
  });
});