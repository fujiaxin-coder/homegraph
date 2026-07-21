/**
 * Batch spec evolve pipeline — replaces the old per-commit approach with
 * a unified batch pipeline optimised for the post-commit hook's cumulative
 * commit threshold trigger.
 *
 * Flow:
 *   0. Prep (meta, lock, schema, discover specs)
 *   1a. Batch analysis (scope + metadata + diff, no DB writes)
 *   1b. Per-commit persistence (independent transactions)
 *   2. Impact location (find old specs affected by new commits)
 *   3. LLM evaluation per spec cluster (only if LLM configured)
 *   ↓ or: mine-style fallback (if phase 1 produced zero matches)
 *   4. Advance meta.json to last phase-1 success
 *
 * @module spec/evolve/pipeline
 */
import * as path from 'path';
import * as fs from 'fs';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { createMineConfig, LLMConfig, SpecConfig } from '../config';
import { readMeta, writeMeta, SPEC_DATA_DIR } from '../utils';
import { initSpecSchema } from '../db/schema';
import { findSpecById } from '../db/spec-node';
import {
  getCommitRange,
  getCommitDiff,
  getCommitInfo,
  getHeadHash,
  isAncestor,
  CommitInfo,
} from '../git';
import { OpenAiLlmClient } from '../llm/client';
import { analyzeIncrementalCommits, CommitSpecAnalysis } from './commit-spec-analyzer';
import { persistCommitSpecGraph, PersistResult } from './commit-spec-persister';
import { locateAffectedSpecsWithCommits, AffectedSpecEntry } from './impact-locator';
import { buildClusterContext, CommitContextInput } from './cluster-context';
import {
  evaluateSpecWithCluster,
  applyUpdate,
  applyDeprecate,
  EvolveDecision,
} from './spec-rewriter';
import { runMinePipeline } from '../mine/pipeline';
import { logDebug, logWarn } from '../../errors';
import { truncateText } from '../utils';

// =============================================================================
// Types
// =============================================================================

interface EvolvedSpec {
  specId: string;
  action: 'UPDATE' | 'DEPRECATE' | 'UNCHANGED';
  newVersion?: number;
  newSpecId?: string;
}

interface EvolveResult {
  commitHash: string;
  /** Whether phase 1 analysis matched a spec. */
  matched: boolean;
  /** Matched spec ID (only when matched). */
  matchedSpecId?: string;
  /** Whether phase 1 persistence was skipped. */
  phaseOneSkipped: boolean;
  /** Reason for skipping (only when phaseOneSkipped). */
  phaseOneSkipReason?: string;
  /** Spec evolution decisions from phase 3 (may be empty). */
  evolvedSpecs: EvolvedSpec[];
  /** Counts from phase 1 persistence. */
  fragmentsInserted: number;
  relationsCreated: number;
}

export interface BatchEvolveResult {
  /** Last evolved commit from meta.json (null if never evolved). */
  fromCommit: string | null;
  /** Last successfully processed commit, or HEAD. */
  toCommit: string;
  /** Total commits in the range. */
  commitsScanned: number;
  /** Commits where phase 1 analysis matched a spec. */
  phaseOneMatched: number;
  /** Commits where phase 1 analysis did NOT match a spec. */
  phaseOneSkipped: number;
  /** Commits where phase 1 persistence failed. */
  phaseOneFailures: number;
  /** Number of historical specs evaluated in phase 3. */
  historicalSpecsEvaluated: number;
  /** Phase 3 action counts. */
  specsUpdated: number;
  specsDeprecated: number;
  specsUnchanged: number;
  /** Per-commit results, for detailed CLI output. */
  perCommitResults: EvolveResult[];
  /** Whether meta.json was updated. */
  metaUpdated: boolean;
  /** True when the entire run performed no useful work. */
  skipped: boolean;
  /** Reason when skipped = true. */
  skipReason?: string;
  /** True when mine pipeline was invoked as a fallback. */
  mineFallback: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Helpers
// =============================================================================

/** Resolve HEAD hash (throws when it cannot be resolved). */
function resolveHead(repoPath: string): string {
  const head = getHeadHash(repoPath);
  if (!head) {
    throw new Error('Failed to resolve HEAD. Not a valid git repository?');
  }
  return head;
}

/** Validate that lastEvolved is an ancestor of HEAD (detect rebase). */
function validateAncestry(repoPath: string, lastEvolved: string, headHash: string): void {
  if (!isAncestor(repoPath, lastEvolved, headHash)) {
    throw new Error(
      `The last evolved commit (${lastEvolved.slice(0, 7)}) is not an ancestor of ` +
      `HEAD (${headHash.slice(0, 7)}). This usually happens after a rebase ` +
      `or force-push. Please re-run 'homegraph spec build' to rebuild the ` +
      `knowledge graph, then run evolve again.`,
    );
  }
}

/** Acquire a file-based advisory lock. */
function acquireEvolveLock(lockFile: string): boolean {
  try {
    if (fs.existsSync(lockFile)) {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
        fs.unlinkSync(lockFile);
      } else {
        return false;
      }
    }
    fs.writeFileSync(lockFile, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

/** Build an empty BatchEvolveResult for no-op runs. */
function emptyBatchResult(
  fromCommit: string | null,
  toCommit: string,
  commitsScanned: number,
): BatchEvolveResult {
  return {
    fromCommit,
    toCommit,
    commitsScanned,
    phaseOneMatched: 0,
    phaseOneSkipped: 0,
    phaseOneFailures: 0,
    historicalSpecsEvaluated: 0,
    specsUpdated: 0,
    specsDeprecated: 0,
    specsUnchanged: 0,
    perCommitResults: [],
    metaUpdated: false,
    skipped: false,
    mineFallback: false,
  };
}

// =============================================================================
// runPhaseOne — shared phase 1a (analysis) + 1b (persistence) logic
// =============================================================================

interface PhaseOneResult {
  phaseOneResults: Map<string, PersistResult | { skipped: true; reason: string }>;
  phaseOneSpecIds: Set<string>;
  commitFilePaths: Map<string, string[]>;
  lastPhaseOneSuccess: string | null;
  analyses: CommitSpecAnalysis[];
}

function runPhaseOne(
  repoPath: string,
  db: SqliteDatabase,
  specStoragePath: string,
  commits: CommitInfo[],
  config: SpecConfig,
): PhaseOneResult {
  // ---- Stage 1a: Batch analysis ----
  const analyses = analyzeIncrementalCommits(repoPath, specStoragePath, commits, config);

  // ---- Stage 1b: Per-commit persistence ----
  const phaseOneResults = new Map<string, PersistResult | { skipped: true; reason: string }>();
  const phaseOneSpecIds = new Set<string>();
  const commitFilePaths = new Map<string, string[]>();
  let lastPhaseOneSuccess: string | null = null;

  for (const analysis of analyses) {
    if (!analysis.matched) {
      phaseOneResults.set(analysis.commit.hash, {
        skipped: true,
        reason: analysis.skipReason ?? 'Scope not matched',
      });
      continue;
    }

    try {
      const result = persistCommitSpecGraph(
        db,
        analysis as CommitSpecAnalysis & { matched: true },
      );
      phaseOneResults.set(analysis.commit.hash, result);
      phaseOneSpecIds.add(result.specId);
      commitFilePaths.set(analysis.commit.hash, result.filePaths);
      lastPhaseOneSuccess = analysis.commit.hash;
    } catch {
      // Persistence failed — stop advancing but don't roll back prior commits
      phaseOneResults.set(analysis.commit.hash, {
        skipped: true,
        reason: 'Persistence transaction failed',
      });
      break;
    }
  }

  return { phaseOneResults, phaseOneSpecIds, commitFilePaths, lastPhaseOneSuccess, analyses };
}

// =============================================================================
// processSingleCommit — fallback for first-ever evolve (no meta.json anchor)
// =============================================================================

async function processSingleCommit(
  repoPath: string,
  db: SqliteDatabase,
  specStoragePath: string,
  headHash: string,
  config: SpecConfig,
): Promise<BatchEvolveResult> {
  logDebug('runEvolvePipeline: no currentCommitID in meta.json — processing HEAD only', {
    headHash: headHash.slice(0, 7),
  });

  const info = getCommitInfo(repoPath, headHash);
  if (!info) {
    throw new Error(`Commit ${headHash.slice(0, 7)} not found.`);
  }

  const { phaseOneResults, phaseOneSpecIds, commitFilePaths,
    lastPhaseOneSuccess, analyses } = runPhaseOne(
    repoPath, db, specStoragePath, [info], config,
  );

  const metaUpdated = !!(lastPhaseOneSuccess);
  if (metaUpdated) {
    writeMeta(repoPath, specStoragePath, lastPhaseOneSuccess!);
  }

  // Phase 2 — only if phase 1 matched something
  let affectedEntries: AffectedSpecEntry[] = [];
  if (phaseOneSpecIds.size > 0) {
    affectedEntries = locateAffectedSpecsWithCommits(db, commitFilePaths, phaseOneSpecIds);
  }

  // Phase 3
  const client = config.llm ? new OpenAiLlmClient(config.llm) : undefined;
  const evolvedSpecsByCommit = await evaluateAndApply(
    db, repoPath, affectedEntries, phaseOneResults, client,
  );

  return buildBatchResult({
    fromCommit: null,
    toCommit: headHash,
    commitsScanned: 1,
    analyses,
    phaseOneResults,
    affectedEntries,
    evolvedSpecs: evolvedSpecsByCommit,
    metaUpdated,
    mineFallback: false,
  });
}

// =============================================================================
// evaluateAndApply — phase 3: evaluate each affected spec + apply decisions
// =============================================================================

async function evaluateAndApply(
  db: SqliteDatabase,
  repoPath: string,
  affectedEntries: AffectedSpecEntry[],
  phaseOneResults: Map<string, PersistResult | { skipped: true; reason: string }>,
  client?: OpenAiLlmClient,
): Promise<Map<string, EvolvedSpec[]>> {
  const evolvedSpecsByCommit = new Map<string, EvolvedSpec[]>();

  if (!client || affectedEntries.length === 0) {
    return evolvedSpecsByCommit;
  }

  for (const entry of affectedEntries) {
    // Get spec info from DB
    const specNode = findSpecById(db, entry.specId);
    if (!specNode) continue;

    // Collect affecting PersistResults
    const affectingResults = entry.affectingCommits
      .map((h) => phaseOneResults.get(h))
      .filter((r): r is PersistResult => r !== undefined && 'filePaths' in r);

    if (affectingResults.length === 0) continue;

    // Build CommitContextInput list
    const commitInputs: CommitContextInput[] = [];
    for (const pr of affectingResults) {
      let message = pr.commitHash.slice(0, 7);
      try {
        const info = getCommitInfo(repoPath, pr.commitHash);
        if (info) message = info.message;
      } catch { /* use short hash */ }
      commitInputs.push({
        commitHash: pr.commitHash,
        message,
        filePaths: pr.filePaths,
      });
    }

    // Build cluster context
    const clusterCtx = buildClusterContext(commitInputs);

    // Populate actual diffs into cluster context
    for (const cs of clusterCtx.commitSummaries) {
      try {
        const diff = getCommitDiff(repoPath, cs.fullHash);
        cs.truncatedDiff = truncateText(diff, 16000);
      } catch {
        cs.truncatedDiff = '(diff unavailable)';
      }
    }

    // LLM evaluation (outside transaction)
    let decision: EvolveDecision;
    try {
      decision = await evaluateSpecWithCluster(
        entry.specId, specNode.filePath, clusterCtx, client,
      );
    } catch {
      decision = { action: 'UNCHANGED' };
    }

    // The last commit in affectingCommits is the one that triggered this evaluation.
    const lastAffectingCommit = entry.affectingCommits[entry.affectingCommits.length - 1]!;

    // Apply decision (inside transaction)
    db.exec('BEGIN');
    try {
      if (decision.action === 'UPDATE') {
        const result = applyUpdate(
          db, entry.specId, specNode.filePath,
          specNode.version, decision,
          lastAffectingCommit,
        );
        const evolved: EvolvedSpec = {
          specId: entry.specId, action: 'UPDATE',
          newVersion: result.newVersion, newSpecId: result.newSpecId,
        };
        if (!evolvedSpecsByCommit.has(lastAffectingCommit)) {
          evolvedSpecsByCommit.set(lastAffectingCommit, []);
        }
        evolvedSpecsByCommit.get(lastAffectingCommit)!.push(evolved);
      } else if (decision.action === 'DEPRECATE') {
        applyDeprecate(db, entry.specId);
        const evolved: EvolvedSpec = { specId: entry.specId, action: 'DEPRECATE' };
        if (!evolvedSpecsByCommit.has(lastAffectingCommit)) {
          evolvedSpecsByCommit.set(lastAffectingCommit, []);
        }
        evolvedSpecsByCommit.get(lastAffectingCommit)!.push(evolved);
      } else {
        const evolved: EvolvedSpec = { specId: entry.specId, action: 'UNCHANGED' };
        if (!evolvedSpecsByCommit.has(lastAffectingCommit)) {
          evolvedSpecsByCommit.set(lastAffectingCommit, []);
        }
        evolvedSpecsByCommit.get(lastAffectingCommit)!.push(evolved);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      logWarn('evaluateAndApply: apply failed', {
        specId: entry.specId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return evolvedSpecsByCommit;
}

// =============================================================================
// mineStyleFallback
// =============================================================================

async function mineStyleFallback(
  repoPath: string,
  db: SqliteDatabase,
  specStoragePath: string,
  newCommits: { hash: string }[],
  lastEvolved: string | null,
  headHash: string,
  llmConfig: LLMConfig | undefined,
): Promise<BatchEvolveResult> {
  if (!llmConfig) {
    logWarn(
      'Phase 1 produced no spec matches and no LLM is configured. ' +
      'No evolution can be performed. ' +
      'Consider running "homegraph spec build/mine" first, ' +
      'or configure an LLM in .homegraph/commit4spec/configs.json.',
    );
    return {
      ...emptyBatchResult(lastEvolved, headHash, newCommits.length),
      phaseOneSkipped: newCommits.length,
      skipped: true,
      skipReason: 'Phase 1 produced no matches and no LLM configured',
    };
  }

  // Invoke mine pipeline for the unmatched commit range
  logWarn(
    'Phase 1 produced no spec matches. Falling back to mine-style spec generation ' +
    `for ${newCommits.length} commit(s).`,
  );

  try {
    const mineConfig = createMineConfig({
      limit: 200,
      threshold: 0.25,
      maxCluster: 10,
      outputDir: specStoragePath,
      skipLlm: false,
    }, true);

    const mineResult = await runMinePipeline(repoPath, mineConfig, llmConfig, db);

    // runMinePipeline already writes to meta.json and the same DB
    logDebug('mineStyleFallback: mine pipeline completed', { ...mineResult });

    const hadResults = mineResult.specsGenerated > 0 || mineResult.specsWritten > 0;

    return {
      ...emptyBatchResult(lastEvolved, headHash, newCommits.length),
      phaseOneSkipped: newCommits.length,
      metaUpdated: hadResults,
      skipped: !hadResults,
      skipReason: hadResults ? undefined : 'Mine pipeline produced no specs',
      mineFallback: true,
    };
  } catch (err) {
    logWarn('mineStyleFallback: mine pipeline failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...emptyBatchResult(lastEvolved, headHash, newCommits.length),
      phaseOneSkipped: newCommits.length,
      skipped: true,
      skipReason: `Mine pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
      mineFallback: true,
    };
  }
}

// =============================================================================
// buildBatchResult — assemble the final BatchEvolveResult
// =============================================================================

function buildBatchResult(params: {
  fromCommit: string | null;
  toCommit: string;
  commitsScanned: number;
  analyses: CommitSpecAnalysis[];
  phaseOneResults: Map<string, PersistResult | { skipped: true; reason: string }>;
  affectedEntries: AffectedSpecEntry[];
  evolvedSpecs: Map<string, EvolvedSpec[]>;
  metaUpdated: boolean;
  mineFallback: boolean;
}): BatchEvolveResult {
  const { fromCommit, toCommit, commitsScanned, analyses, phaseOneResults,
    affectedEntries, evolvedSpecs, metaUpdated, mineFallback } = params;

  let phaseOneMatched = 0;
  let phaseOneSkipped = 0;
  let phaseOneFailures = 0;

  const perCommitResults: EvolveResult[] = [];

  for (const analysis of analyses) {
    const pr = phaseOneResults.get(analysis.commit.hash);
    if (!pr) {
      // Should not happen, but defensive
      perCommitResults.push({
        commitHash: analysis.commit.hash,
        matched: false,
        phaseOneSkipped: true,
        phaseOneSkipReason: 'Result not found',
        evolvedSpecs: [],
        fragmentsInserted: 0,
        relationsCreated: 0,
      });
      phaseOneSkipped++;
      continue;
    }

    if ('skipped' in pr) {
      perCommitResults.push({
        commitHash: analysis.commit.hash,
        matched: false,
        phaseOneSkipped: true,
        phaseOneSkipReason: pr.reason,
        evolvedSpecs: [],
        fragmentsInserted: 0,
        relationsCreated: 0,
      });
      analysis.matched ? phaseOneFailures++ : phaseOneSkipped++;
    } else {
      perCommitResults.push({
        commitHash: analysis.commit.hash,
        matched: true,
        matchedSpecId: pr.specId,
        phaseOneSkipped: false,
        evolvedSpecs: evolvedSpecs.get(analysis.commit.hash) || [],
        fragmentsInserted: pr.stats.fragmentsInserted,
        relationsCreated: pr.stats.relationsCreated,
      });
      phaseOneMatched++;
    }
  }

  // Count phase 3 results
  let specsUpdated = 0;
  let specsDeprecated = 0;
  let specsUnchanged = 0;
  for (const [, specs] of evolvedSpecs) {
    for (const es of specs) {
      if (es.action === 'UPDATE') specsUpdated++;
      else if (es.action === 'DEPRECATE') specsDeprecated++;
      else specsUnchanged++;
    }
  }

  return {
    fromCommit,
    toCommit,
    commitsScanned,
    phaseOneMatched,
    phaseOneSkipped,
    phaseOneFailures,
    historicalSpecsEvaluated: affectedEntries.length,
    specsUpdated,
    specsDeprecated,
    specsUnchanged,
    perCommitResults,
    metaUpdated,
    skipped: !metaUpdated && !mineFallback && phaseOneMatched === 0,
    skipReason: !metaUpdated && !mineFallback && phaseOneMatched === 0
      ? 'All phase-1 persistence failed'
      : undefined,
    mineFallback,
  };
}

// =============================================================================
// Public API — runEvolvePipeline
// =============================================================================

/**
 * Run the spec self-evolve pipeline for all new commits since the last evolve.
 *
 * This is the ONLY public entry point.  It replaces both the old
 * ``runEvolvePipeline`` (per-commit) and ``runBatchEvolvePipeline`` (batch
 * wrapper) with a unified batch pipeline that aligns with the post-commit
 * hook's cumulative commit threshold trigger.
 *
 * Flow:
 *   0. Prep: meta.json → lock → schema → resolve HEAD + range.
 *   1a. Batch analysis of all incremental commits (no DB writes).
 *   1b. Per-commit persistence with independent transactions.
 *   2. Impact location: find old specs affected by new commits.
 *   3. LLM evaluation per spec cluster (only if LLM configured).
 *   ↓ or: mine-style fallback (if phase 1 produced zero matches + LLM).
 *   4. Advance meta.json to last phase-1 success.
 *
 * @param repoPath  - Absolute path to the git repository.
 * @param db        - Active SQLite database handle.
 * @param config     - Spec configuration (loaded from configs.json); when config.llm is absent, phase 3 is skipped
 *                     (phase 1 graph construction still runs).
 */
export async function runEvolvePipeline(
  repoPath: string,
  db: SqliteDatabase,
  config: SpecConfig,
): Promise<BatchEvolveResult> {
  // ---- Stage 0: Preparation ----
  const meta = readMeta(repoPath);
  if (!meta) {
    throw new Error("No meta.json found. Run 'homegraph spec build' first.");
  }

  // File lock
  const lockFile = path.join(repoPath, SPEC_DATA_DIR, 'logs', 'evolve.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (!acquireEvolveLock(lockFile)) {
    logDebug('runEvolvePipeline: another instance is running, skipping');
    return emptyBatchResult(meta.currentCommitID || null, '', 0);
  }

  initSpecSchema(db);

  try {
    // Resolve HEAD and commit range
    const headHash = resolveHead(repoPath);
    const lastEvolved = meta.currentCommitID || null;

    // No currentCommitID → process HEAD only
    if (!lastEvolved) {
      return await processSingleCommit(
        repoPath, db, meta.specStoragePath, headHash, config,
      );
    }

    // No new commits
    if (lastEvolved === headHash) {
      logDebug('runEvolvePipeline: no new commits to evolve', {
        currentCommitID: lastEvolved.slice(0, 7),
      });
      return emptyBatchResult(lastEvolved, headHash, 0);
    }

    // Rebase detection
    validateAncestry(repoPath, lastEvolved, headHash);

    // Get commit range in chronological order
    const newCommits = getCommitRange(repoPath, lastEvolved, headHash);
    if (newCommits.length === 0) {
      return emptyBatchResult(lastEvolved, headHash, 0);
    }

    logDebug('runEvolvePipeline: processing commit range', {
      count: newCommits.length,
      from: lastEvolved.slice(0, 7),
      to: headHash.slice(0, 7),
    });

    // ---- Stage 1a + 1b: Batch analysis + per-commit persistence ----

    logDebug('runEvolvePipeline: phase 1 — batch analysis + persistence', {
      commitCount: newCommits.length,
    });

    const { phaseOneResults, phaseOneSpecIds, commitFilePaths,
      lastPhaseOneSuccess, analyses } = runPhaseOne(
      repoPath, db, meta.specStoragePath, newCommits, config,
    );

    // ---- Decision: phase 1 produced matches? ----
    if (phaseOneSpecIds.size === 0) {
      return await mineStyleFallback(
        repoPath, db, meta.specStoragePath, newCommits,
        lastEvolved, headHash, config.llm ?? undefined,
      );
    }

    // ---- Stage 2: Impact location ----
    const affectedEntries = locateAffectedSpecsWithCommits(
      db, commitFilePaths, phaseOneSpecIds,
    );

    logDebug('runEvolvePipeline: phase 2 — impact location', {
      affectedSpecs: affectedEntries.length,
    });

    // ---- Stage 3: LLM evaluation + apply ----
    const client = config.llm ? new OpenAiLlmClient(config.llm) : undefined;
    const evolvedSpecsByCommit = await evaluateAndApply(
      db, repoPath,
      affectedEntries, phaseOneResults, client,
    );

    // ---- Stage 4: Advance meta.json ----
    const metaUpdated = lastPhaseOneSuccess !== null;
    if (metaUpdated) {
      writeMeta(repoPath, meta.specStoragePath, lastPhaseOneSuccess!);
    }

    const result = buildBatchResult({
      fromCommit: lastEvolved,
      toCommit: lastPhaseOneSuccess || headHash,
      commitsScanned: newCommits.length,
      analyses,
      phaseOneResults,
      affectedEntries,
      evolvedSpecs: evolvedSpecsByCommit,
      metaUpdated,
      mineFallback: false,
    });

    return result;
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* may already be deleted */ }
  }
}
