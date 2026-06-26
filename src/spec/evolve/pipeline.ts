/**
 * Self-evolve pipeline orchestrator — evaluates new commits against existing
 * specs and rewrites / deprecates them as needed.
 *
 * Replaces `commit4spec/self_evolve/pipeline.py` (lines 79-289).
 *
 * @module spec/evolve/pipeline
 */
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { LLMConfig, loadSpecConfig } from '../config';
import { readMeta } from '../utils';
import { initSpecSchema } from '../db/schema';
import { insertSpecNode, findSpecById } from '../db/spec-node';
import { insertCommitNode } from '../db/commit-node';
import { insertCodeFragment } from '../db/fragment-node';
import {
  insertSpecCommitRelation,
  insertCommitFragmentRelation,
} from '../db/relations';
import { getCommitInfo, getCommitDiff } from '../mining/git-scanner';
import { resolveScopeToSpec } from '../mining/scope-resolver';
import { extractSpecMetadata, SpecMetadata } from '../mining/spec-extractor';
import { analyzeCommitDiff } from '../mining/diff-parser';
import { LLMClient } from './llm-client';
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
// runEvolvePipeline
// =============================================================================

/**
 * Run the full self-evolve pipeline for a single commit.
 *
 * Flow (ported from pipeline.py:79-289):
 *
 * 1. Load context (meta, schema, commit info, diff, LLM client, config).
 * 2. **Path A (GENERATE):** resolve scope from commit message.
 * 3. **LLM logic check:** determine if the commit is a business-logic change.
 * 4. **Path B (impact + rewrite):** if logic change, find affected active
 *    specs and evaluate each one.
 * 5. If neither Path A nor Path B produced candidates, return early.
 * 6. Persist everything in a single DB transaction.
 *
 * @param repoPath   - Absolute path to the git repository.
 * @param db         - Active SQLite database handle.
 * @param commitHash - Optional commit hash; defaults to HEAD.
 * @param llmConfig  - Optional LLM config override; falls back to spec config.
 */
export async function runEvolvePipeline(
  repoPath: string,
  db: SqliteDatabase,
  commitHash?: string,
  llmConfig?: LLMConfig,
): Promise<EvolveResult> {
  // ------------------------------------------------------------------
  // 1. Context loading
  // ------------------------------------------------------------------

  // Read meta
  const meta = readMeta(repoPath);
  if (!meta) {
    throw new Error("No meta.json found. Run 'homegraph spec mine' first.");
  }

  // Init schema
  initSpecSchema(db);

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

  // Load spec config and create LLM client
  const specConfig = loadSpecConfig(repoPath);
  const resolvedLLMConfig = llmConfig || specConfig.llm;
  const client = new LLMClient(resolvedLLMConfig);

  // ------------------------------------------------------------------
  // 2. Path A (GENERATE) — commit message scope resolution
  // ------------------------------------------------------------------

  const pathASpecId = resolveScopeToSpec(
    commitInfo.message,
    meta.specStoragePath,
    specConfig,
  );
  let pathASpecMetadata: SpecMetadata | null = null;
  if (pathASpecId) {
    pathASpecMetadata = extractSpecMetadata(
      meta.specStoragePath,
      pathASpecId,
      specConfig,
    );
  }

  // ------------------------------------------------------------------
  // 3. LLM logic check
  // ------------------------------------------------------------------

  let logicResult = { isLogic: false, reason: '' };
  try {
    logicResult = await isLogicChange(commitInfo.message, diff, client);
  } catch {
    logWarn('LLM logic check failed, treating as non-logic change', {
      commitHash: resolvedHash.slice(0, 7),
    });
    logicResult = { isLogic: false, reason: 'LLM call failed' };
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
    };
  }

  // ------------------------------------------------------------------
  // 6. Persist (atomic via explicit BEGIN/COMMIT/ROLLBACK)
  //    Uses explicit transaction management because the current
  //    db.transaction() wrapper is synchronous while evaluateSpec is async.
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
      logDebug('Path A: specId resolved but no metadata extracted, skipping insert', {
        specId: pathASpecId,
      });
    }

    // ---- Path B: Evaluate each spec and apply decisions ----
    const evolvedSpecs: EvolvedSpec[] = [];

    for (let idx = 0; idx < pathBSpecIds.length; idx++) {
      const specId = pathBSpecIds[idx]!;
      const scheduleNextSpecs = pathBSpecIds.slice(idx + 1);
      const { version, filePath } = getSpecPathInfo(
        db,
        meta.specStoragePath,
        specId,
      );

      // Evaluate spec against the commit
      const decision: EvolveDecision = await evaluateSpec(
        specId,
        meta.specStoragePath,
        filePath,
        commitInfo.message,
        diff,
        scheduleNextSpecs,
        client,
      );

      if (decision.action === 'UPDATE') {
        const updateResult = applyUpdate(
          db,
          meta.specStoragePath,
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
