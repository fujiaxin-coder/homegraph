/**
 * Spec-mine adapter over the generic addon loader.
 *
 * The generic `src/addons/` layer knows nothing about `enrich`/`buildPrompt`:
 * this module filters loaded addons by export shape and owns the per-cluster
 * enrichment orchestration (parallel calls, timeout, merge, dedupe).
 *
 * Failure policy: an addon that throws or times out contributes nothing and
 * logs a warning — spec generation must never be blocked by an addon.
 *
 * @module spec/mine/addon/adapter
 */

import { logWarn } from '../../../errors';
import { loadAddons } from '../../../addons/loader';
import { LoadedAddon } from '../../../addons/types';
import { CommitCluster } from '../clustering';
import { EnrichInput, Supplement, SpecMineAddon } from './types';

/** Per-addon enrich timeout. */
const ENRICH_TIMEOUT_MS = 15_000;

/** An addon wired to the spec-mine `enrich` hook. */
export interface SpecMineEnricher {
  addon: LoadedAddon;
  enrich: NonNullable<SpecMineAddon['enrich']>;
}

/** The addon surface spec-mine consumes. */
export interface SpecMineAddonSet {
  enrichers: SpecMineEnricher[];
  /** First registered addon exposing `buildPrompt` wins (registry order). */
  buildPrompt?: {
    addon: LoadedAddon;
    fn: NonNullable<SpecMineAddon['buildPrompt']>;
  };
}

/**
 * Load spec-mine addons for a repository: generic `loadAddons` + shape filter.
 */
export async function loadSpecMineAddons(
  repoPath: string,
): Promise<SpecMineAddonSet> {
  const loaded = await loadAddons(repoPath);
  const set: SpecMineAddonSet = { enrichers: [] };

  for (const addon of loaded) {
    const mod = addon.module as Partial<SpecMineAddon>;
    if (typeof mod.enrich === 'function') {
      set.enrichers.push({ addon, enrich: mod.enrich });
    }
    if (typeof mod.buildPrompt === 'function' && !set.buildPrompt) {
      set.buildPrompt = { addon, fn: mod.buildPrompt };
    }
  }
  return set;
}

/**
 * Dedupe supplements by opaque key (fallback: exact text). Cross-addon
 * duplicates are also merged — the same ticket keyed by two addons renders
 * once. Insertion order (registry order) is preserved.
 */
export function dedupeSupplements(supplements: Supplement[]): Supplement[] {
  const seenKeys = new Set<string>();
  const seenTexts = new Set<string>();
  const out: Supplement[] = [];

  for (const supplement of supplements) {
    if (supplement.key !== undefined) {
      const key = String(supplement.key);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    } else {
      if (seenTexts.has(supplement.text)) continue;
      seenTexts.add(supplement.text);
    }
    out.push(supplement);
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

/**
 * Run every enricher for one cluster, in parallel, and return the merged,
 * deduplicated supplements. Failures/timeouts are logged and skipped.
 */
export async function enrichCluster(
  enrichers: SpecMineEnricher[],
  cluster: CommitCluster,
): Promise<Supplement[]> {
  if (enrichers.length === 0) return [];

  const input: EnrichInput = {
    clusterId: cluster.id,
    commits: cluster.commits.map((c) => ({
      commitHash: c.commitHash,
      commitMessage: c.commitMessage,
      author: c.author,
      timestamp: c.timestamp,
    })),
  };

  const results = await Promise.allSettled(
    enrichers.map((enricher) =>
      withTimeout(Promise.resolve(enricher.enrich(input)), ENRICH_TIMEOUT_MS),
    ),
  );

  const all: Supplement[] = [];
  results.forEach((result, i) => {
    const enricher = enrichers[i]!;
    if (result.status === 'fulfilled') {
      if (Array.isArray(result.value)) {
        all.push(...result.value);
      } else {
        logWarn(`Addon ${enricher.addon.name} enrich returned a non-array — ignored`, {
          name: enricher.addon.name,
        });
      }
    } else {
      logWarn(`Addon ${enricher.addon.name} enrich failed — continuing without its supplements`, {
        name: enricher.addon.name,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  });

  return dedupeSupplements(all);
}
