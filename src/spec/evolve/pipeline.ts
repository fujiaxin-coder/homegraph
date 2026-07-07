/**
 * Self-evolve pipeline orchestrator — evaluates new commits against existing
 * specs and rewrites / deprecates them as needed.
 *
 * Replaces `commit4spec/self_evolve/pipeline.py` (lines 79-289).
 *
 * @module spec/evolve/pipeline
 */
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { LLMConfig, loadSpecConfig } from '../config';
import { readMeta, writeMeta, SPEC_DATA_DIR } from '../utils';
import { initSpecSchema } from '../db/schema';
import { insertSpecNode, findSpecById } from '../db/spec-node';
import { insertCommitNode } from '../db/commit-node';
import { insertCodeFragment } from '../db/fragment-node';
import {
  insertSpecCommitRelation,
  insertCommitFragmentRelation,
} from '../db/relations';
import { getCommitInfo, getCommitDiff, getCommitRange } from '../build/git-scanner';
import { resolveScopeToSpec } from '../build/scope-resolver';
import { extractSpecMetadata, SpecMetadata } from '../build/spec-extractor';
import { analyzeCommitDiff } from '../build/diff-parser';
import { LlmClient, OpenAiLlmClient } from '../llm/client';
import { isLogicChange } from './logic-checker';
import { locateAffectedSpecs } from './impact-locator';
import {
  evaluateSpec,
  applyUpdate,
  applyDeprecate,
  EvolveDecision,
} from './spec-rewriter';
import { logDebug, logWarn } from '../../errors';

// =============================================================================
// Types
// =============================================================================

export interface EvolvedSpec {
  specId: string;
  action: 'UPDATE' | 'DEPRECATE' | 'UNCHANGED';
  newVersion?: number;
  newSpecId?: string;
}

export interface EvolveResult {
  commitHash: string;
  generateSpecId?: string;
  generateRelationCreated: boolean;
  isLogicChange: boolean;
  logicCheckReason: string;
  affectedSpecCount: number;
  evolvedSpecs: EvolvedSpec[];
  fragmentsCount: number;
  relationsCreated: number;
  persisted: boolean;
  /** True when the commit was skipped because LLM is not available. */
  skipped: boolean;
  /** Human-readable reason for skipping, if skipped is true. */
  skipReason?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Look up a spec from the DB and return its version and filePath.
 * Falls back to constructing a plan.md path when the spec is not found.
 */
function getSpecPathInfo(
  db: SqliteDatabase,
  specStoragePath: string,
  specId: string,
): { version: number; filePath: string } {
  const node = findSpecById(db, specId);
  if (node) {
    return { version: node.version, filePath: node.filePath };
  }
  return { version: 0, filePath: path.join(specStoragePath, specId, 'plan.md') };
}

// =============================================================================
// runEvolvePipeline  (internal — only called by runBatchEvolvePipeline)
// =============================================================================

/**
 * Run the full self-evolve pipeline for a single commit.
 *
 * **Internal.**  Not exported — the public entry point is
 * {@link runBatchEvolvePipeline}, which reads meta.json, initialises the
 * schema, and calls this function for each commit in the range.
 *
 * Flow (ported from pipeline.py:79-289):
 *
 * 1. Load context (commit info, diff, LLM client, config).
 * 2. **Path A (GENERATE):** resolve scope from commit message.
 * 3. **LLM logic check:** determine if the commit is a business-logic change.
 * 4. **Path B (impact + rewrite):** if logic change, find affected active
 *    specs and evaluate each one.
 * 5. If neither Path A nor Path B produced candidates, return early.
 * 6. Persist everything in a single DB transaction.
 *
 * @param repoPath        - Absolute path to the git repository.
 * @param db              - Active SQLite database handle (schema already initialised).
 * @param specStoragePath - Path to the spec storage directory (from meta.json).
 * @param commitHash      - Commit hash to process.
 * @param llmConfig       - Optional LLM config override; falls back to spec config.
 */
async function runEvolvePipeline(
  repoPath: string,
  db: SqliteDatabase,
  specStoragePath: string,
  commitHash?: string,
  llmConfig?: LLMConfig,
): Promise<EvolveResult> {
  // ------------------------------------------------------------------
  // 1. Context loading
  // ------------------------------------------------------------------

  // meta.json and schema already handled by runBatchEvolvePipeline

  // Resolve commit hash
  const resolvedHash =
    commitHash ||
    (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repoPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'] as const,
          windowsHide: true,
        }).trim();
      } catch {
        return '';
      }
    })();
  if (!resolvedHash) {
    throw new Error('No commits found in repository.');
  }

  // Get commit info and diff
  const commitInfo = getCommitInfo(repoPath, resolvedHash);
  if (!commitInfo) {
    throw new Error(`Commit ${resolvedHash} not found in repository.`);
  }

  const diff = getCommitDiff(repoPath, resolvedHash);

  // Parse diff into fragments once — reused for file paths and persistence.
  const diffFragments = analyzeCommitDiff(repoPath, resolvedHash, diff);

  // Load spec config and optionally create LLM client.
  // When LLM is not available we still run Path A (scope-based GENERATE).
  const specConfig = loadSpecConfig(repoPath);
  const resolvedLLMConfig = llmConfig || specConfig.llm;
  const client: LlmClient | undefined = resolvedLLMConfig
    ? new OpenAiLlmClient(resolvedLLMConfig)
    : undefined;

  // ------------------------------------------------------------------
  // 2. Path A (GENERATE) — commit message scope resolution
  // ------------------------------------------------------------------

  const pathASpecId = resolveScopeToSpec(
    commitInfo.message,
    specStoragePath,
    specConfig,
  );
  let pathASpecMetadata: SpecMetadata | null = null;
  if (pathASpecId) {
    pathASpecMetadata = extractSpecMetadata(
      specStoragePath,
      pathASpecId,
      specConfig,
    );
  }

  // ------------------------------------------------------------------
  // 2.5 Early skip: Path A didn't match and no LLM client is available.
  //     Non-Path-A commits cannot be processed without LLM for logic
  //     checking and spec evaluation.
  // ------------------------------------------------------------------
  if (!pathASpecId && !client) {
    logWarn('Skipping commit — no LLM configured and commit does not match Path A', {
      commitHash: resolvedHash.slice(0, 7),
    });
    return {
      commitHash: resolvedHash,
      generateRelationCreated: false,
      isLogicChange: false,
      logicCheckReason: '',
      affectedSpecCount: 0,
      evolvedSpecs: [],
      fragmentsCount: 0,
      relationsCreated: 0,
      persisted: false,
      skipped: true,
      skipReason:
        'LLM not configured — commit message does not contain a spec scope (Path A)',
    };
  }

  // ------------------------------------------------------------------
  // 3. LLM logic check
  // ------------------------------------------------------------------

  let logicResult = { isLogic: false, reason: '' };
  if (client) {
    try {
      logicResult = await isLogicChange(commitInfo.message, diff, client);
    } catch {
      logWarn('LLM logic check failed, treating as non-logic change', {
        commitHash: resolvedHash.slice(0, 7),
      });
      logicResult = { isLogic: false, reason: 'LLM call failed' };
    }
  }

  // ------------------------------------------------------------------
  // 4. Path B (impact + rewrite) — only when the commit is a logic change
  // ------------------------------------------------------------------

  let pathBSpecIds: string[] = [];
  if (logicResult.isLogic) {
    // Extract file paths from diff fragments
    const filePaths = diffFragments.map(f => f.filePath);

    // Locate affected specs
    const affectedSpecIds = locateAffectedSpecs(db, filePaths);

    if (affectedSpecIds.length > 0) {
      // Filter to active specs only
      const placeholders = affectedSpecIds.map(() => '?').join(',');
      const activeRows = db
        .prepare(
          `SELECT id FROM spec_nodes WHERE status = 'active' AND id IN (${placeholders})`,
        )
        .all(...affectedSpecIds) as Array<{ id: string }>;
      pathBSpecIds = activeRows.map((r) => r.id);

      // Remove Path A spec from Path B list (if present)
      if (pathASpecId) {
        pathBSpecIds = pathBSpecIds.filter((id) => id !== pathASpecId);
      }
    }

    logDebug('Path B: affected active specs', {
      count: pathBSpecIds.length,
      specIds: pathBSpecIds,
    });
  }

  // ------------------------------------------------------------------
  // 5. Decide relevance
  // ------------------------------------------------------------------

  const hasPathA = pathASpecId !== null;
  const hasPathB = pathBSpecIds.length > 0;

  if (!hasPathA && !hasPathB) {
    logDebug('runEvolvePipeline: no relevant spec found, returning early', {
      commitHash: resolvedHash.slice(0, 7),
    });
    return {
      commitHash: resolvedHash,
      generateRelationCreated: false,
      isLogicChange: logicResult.isLogic,
      logicCheckReason: logicResult.reason,
      affectedSpecCount: 0,
      evolvedSpecs: [],
      fragmentsCount: 0,
      relationsCreated: 0,
      persisted: false,
      skipped: false,
    };
  }

  // ------------------------------------------------------------------
  // 6. Evaluate all specs BEFORE opening the transaction.  This keeps
  //    async LLM calls (which may take seconds) outside the SQLite
  //    write-lock window, avoiding SQLITE_BUSY for concurrent writers.
  // ------------------------------------------------------------------

  interface PendingDecision {
    specId: string;
    decision: EvolveDecision;
    version: number;
    filePath: string;
  }

  const pendingDecisions: PendingDecision[] = [];

  for (let idx = 0; idx < pathBSpecIds.length; idx++) {
    const specId = pathBSpecIds[idx]!;
    const scheduleNextSpecs = pathBSpecIds.slice(idx + 1);
    const { version, filePath } = getSpecPathInfo(
      db,
      specStoragePath,
      specId,
    );

    const decision: EvolveDecision = await evaluateSpec(
      specId,
      specStoragePath,
      filePath,
      commitInfo.message,
      diff,
      scheduleNextSpecs,
      client,
    );

    pendingDecisions.push({ specId, decision, version, filePath });
  }

  // ------------------------------------------------------------------
  // 7. Persist (atomic via explicit BEGIN/COMMIT/ROLLBACK)
  //    All LLM evaluation is complete; only fast DB writes remain.
  // ------------------------------------------------------------------

  const evolveResult: EvolveResult = {
    commitHash: resolvedHash,
    generateSpecId: pathASpecId ?? undefined,
    generateRelationCreated: false,
    isLogicChange: logicResult.isLogic,
    logicCheckReason: logicResult.reason,
    affectedSpecCount: pathBSpecIds.length,
    evolvedSpecs: [],
    fragmentsCount: 0,
    relationsCreated: 0,
    persisted: true,
    skipped: false,
  };

  db.exec('BEGIN');
  try {
    // ---- Insert CommitNode ----
    insertCommitNode(db, {
      hash: commitInfo.hash,
      message: commitInfo.message,
      author: commitInfo.author,
      timestamp: commitInfo.timestamp,
    });

    // ---- Path A: Insert SpecNode + GENERATE relation ----
    if (pathASpecId && pathASpecMetadata) {
      insertSpecNode(db, {
        id: pathASpecMetadata.specId,
        title: pathASpecMetadata.title,
        subtitles: pathASpecMetadata.subtitles,
        status: 'active',
        version: 1,
        filePath: pathASpecMetadata.filePath,
        timestamp: commitInfo.timestamp,
      });

      insertSpecCommitRelation(
        db,
        pathASpecMetadata.specId,
        commitInfo.hash,
        'GENERATE',
      );
      evolveResult.generateRelationCreated = true;
      evolveResult.relationsCreated++;
    } else if (pathASpecId) {
      logWarn('Path A: specId resolved but no metadata extracted, skipping insert', {
        specId: pathASpecId,
      });
    }

    // ---- Path B: Apply pre-evaluated decisions ----
    const evolvedSpecs: EvolvedSpec[] = [];

    for (const pending of pendingDecisions) {
      const { specId, decision, version, filePath } = pending;

      if (decision.action === 'UPDATE') {
        const updateResult = applyUpdate(
          db,
          specStoragePath,
          specId,
          filePath,
          version,
          decision,
          commitInfo.hash,
        );
        evolvedSpecs.push({
          specId,
          action: 'UPDATE',
          newVersion: updateResult.newVersion,
          newSpecId: updateResult.newSpecId,
        });
        evolveResult.relationsCreated += 2; // EVOLVED_FROM + GENERATE
      } else if (decision.action === 'DEPRECATE') {
        applyDeprecate(db, specId);
        evolvedSpecs.push({
          specId,
          action: 'DEPRECATE',
        });
        // applyDeprecate creates one EVOLVED_FROM relation
        evolveResult.relationsCreated += 1;
      } else {
        // UNCHANGED
        evolvedSpecs.push({
          specId,
          action: 'UNCHANGED',
        });
      }
    }

    evolveResult.evolvedSpecs = evolvedSpecs;

    // ---- Common: Persist pre-parsed fragments and create CONTAINS relations ----
    for (const frag of diffFragments) {
      const inserted = insertCodeFragment(db, {
        id: '',
        changeType: frag.changeType,
        filePath: frag.filePath,
        startLine: frag.startLine,
        endLine: frag.endLine,
        codeDiff: frag.codeDiff,
      });
      evolveResult.fragmentsCount++;
      insertCommitFragmentRelation(db, commitInfo.hash, inserted.id);
      evolveResult.relationsCreated++;
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return evolveResult;
}

// =============================================================================
// BatchEvolveResult
// =============================================================================

export interface BatchEvolveResult {
  /** The last evolved commit hash from meta.json (null if never evolved). */
  fromCommit: string | null;
  /** The commit hash that was just evolved up to (usually HEAD). */
  toCommit: string;
  /** Number of commits in the range (including skipped). */
  commitsProcessed: number;
  /** Per-commit results. */
  perCommitResults: EvolveResult[];
  /** Whether meta.json was updated at the end. */
  metaUpdated: boolean;
  /** Number of commits skipped (no LLM, did not match Path A). */
  skippedCommits: number;
  /** Number of commits that threw an error during evolve. */
  failures: number;
}

// =============================================================================
// runBatchEvolvePipeline
// =============================================================================

/**
 * Run the self-evolve pipeline for all NEW commits since the last evolve.
 *
 * Reads `currentCommitID` from `meta.json` and processes every commit between
 * that hash and `HEAD` in chronological order.  Each commit is independently
 * evolved via `runEvolvePipeline`.  On full success, `meta.json` is refreshed
 * with the new HEAD as `currentCommitID` and `updatedAt` set to now.
 *
 * When `currentCommitID` is missing (first evolve after an older build, or
 * corrupt meta), the function falls back to processing only HEAD.
 *
 * **Partial failure:** If any commit fails, the failing commit is logged but
 * processing continues to the next one. `meta.json` is **only** updated when
 * **all** commits succeed — this preserves the invariant that
 * `currentCommitID` always points to the last *successfully* evolved commit.
 *
 * Edge cases:
 * - `currentCommitID` equals HEAD → 0 new commits, `metaUpdated: false`.
 * - `currentCommitID` is not an ancestor of HEAD (rebase / force-push) →
 *   throws an error asking the user to re-build.
 */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Acquire a file-based advisory lock to prevent concurrent evolve runs.
 * Returns true if the lock was acquired (or the existing lock is stale).
 * Returns false if another evolve instance holds the lock.
 */
function acquireEvolveLock(lockFile: string): boolean {
  try {
    if (fs.existsSync(lockFile)) {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
        // Stale lock — previous process may have crashed
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

export async function runBatchEvolvePipeline(
  repoPath: string,
  db: SqliteDatabase,
  llmConfig?: LLMConfig,
): Promise<BatchEvolveResult> {
  const meta = readMeta(repoPath);
  if (!meta) {
    throw new Error("No meta.json found. Run 'homegraph spec build' first.");
  }

  // Ensure only one evolve instance runs at a time (post-commit hook may
  // fire multiple times in quick succession).
  const lockFile = path.join(repoPath, SPEC_DATA_DIR, 'logs', 'evolve.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (!acquireEvolveLock(lockFile)) {
    logDebug('runBatchEvolvePipeline: another evolve instance is running, skipping');
    return {
      fromCommit: meta.currentCommitID || null,
      toCommit: '',
      commitsProcessed: 0,
      perCommitResults: [],
      metaUpdated: false,
      skippedCommits: 0,
      failures: 0,
    };
  }

  initSpecSchema(db);

  try {
    return await runBatchEvolvePipelineImpl(repoPath, db, meta, llmConfig);
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* may already be deleted */ }
  }
}

/**
 * Inner implementation — split out so the lock clean-up in the outer function
 * only needs one try/finally block.
 */
async function runBatchEvolvePipelineImpl(
  repoPath: string,
  db: SqliteDatabase,
  meta: { specStoragePath: string; currentCommitID?: string },
  llmConfig: LLMConfig | undefined,
): Promise<BatchEvolveResult> {
  // Resolve HEAD
  let headHash: string;
  try {
    headHash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'] as const,
      windowsHide: true,
    }).trim();
  } catch {
    throw new Error('Failed to resolve HEAD. Not a valid git repository?');
  }
  if (!headHash) {
    throw new Error('No commits found in repository.');
  }

  const lastEvolved = meta.currentCommitID || null;

  // Fallback: no currentCommitID → process just HEAD
  if (!lastEvolved) {
    logDebug('runBatchEvolvePipeline: no currentCommitID in meta.json — processing HEAD only', {
      headHash: headHash.slice(0, 7),
    });

    const result = await runEvolvePipeline(repoPath, db, meta.specStoragePath, headHash, llmConfig);

    // Only refresh meta.json when the commit was actually processed (not skipped).
    const metaUpdated = !result.skipped;
    if (metaUpdated) {
      writeMeta(repoPath, meta.specStoragePath, headHash);
    }

    return {
      fromCommit: null,
      toCommit: headHash,
      commitsProcessed: 1,
      perCommitResults: [result],
      metaUpdated,
      skippedCommits: result.skipped ? 1 : 0,
      failures: 0,
    };
  }

  // No new commits
  if (lastEvolved === headHash) {
    logDebug('runBatchEvolvePipeline: no new commits to evolve', {
      currentCommitID: lastEvolved.slice(0, 7),
    });

    return {
      fromCommit: lastEvolved,
      toCommit: headHash,
      commitsProcessed: 0,
      perCommitResults: [],
      metaUpdated: false,
      skippedCommits: 0,
      failures: 0,
    };
  }

  // Validate ancestry: lastEvolved must be an ancestor of HEAD
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', lastEvolved, headHash], {
      cwd: repoPath,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    throw new Error(
      `The last evolved commit (${lastEvolved.slice(0, 7)}) is not an ancestor of ` +
      `HEAD (${headHash.slice(0, 7)}). This usually happens after a rebase ` +
      `or force-push. Please re-run 'homegraph spec build' to rebuild the ` +
      `knowledge graph, then run 'homegraph spec evolve' again.`,
    );
  }

  // Get commit range in chronological order (oldest first)
  const commits = getCommitRange(repoPath, lastEvolved, headHash);
  if (commits.length === 0) {
    logDebug('runBatchEvolvePipeline: range query returned 0 commits', {
      from: lastEvolved.slice(0, 7),
      to: headHash.slice(0, 7),
    });

    return {
      fromCommit: lastEvolved,
      toCommit: headHash,
      commitsProcessed: 0,
      perCommitResults: [],
      metaUpdated: false,
      skippedCommits: 0,
      failures: 0,
    };
  }

  logDebug('runBatchEvolvePipeline: processing commit range', {
    count: commits.length,
    from: lastEvolved.slice(0, 7),
    to: headHash.slice(0, 7),
  });

  // Process each commit independently
  const perCommitResults: EvolveResult[] = [];
  let failures = 0;
  let skippedCount = 0;

  for (const commit of commits) {
    try {
      const result = await runEvolvePipeline(
        repoPath, db, meta.specStoragePath, commit.hash, llmConfig,
      );
      perCommitResults.push(result);
      if (result.skipped) skippedCount++;
    } catch (err) {
      failures++;
      logWarn('runBatchEvolvePipeline: commit evolve failed, continuing', {
        commitHash: commit.hash.slice(0, 7),
        error: err instanceof Error ? err.message : String(err),
      });
      perCommitResults.push({
        commitHash: commit.hash,
        generateRelationCreated: false,
        isLogicChange: false,
        logicCheckReason: `Evolve failed: ${err instanceof Error ? err.message : String(err)}`,
        affectedSpecCount: 0,
        evolvedSpecs: [],
        fragmentsCount: 0,
        relationsCreated: 0,
        persisted: false,
        skipped: false,
      });
    }
  }

  // Refresh meta.json as long as at least one commit was actually
  // processed (neither skipped nor failed).
  const processedCount = commits.length - failures - skippedCount;
  const metaUpdated = processedCount > 0;
  if (metaUpdated) {
    writeMeta(repoPath, meta.specStoragePath, headHash);
  }

  return {
    fromCommit: lastEvolved,
    toCommit: headHash,
    commitsProcessed: commits.length,
    perCommitResults,
    metaUpdated,
    skippedCommits: skippedCount,
    failures,
  };
}
