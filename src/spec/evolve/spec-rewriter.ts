/**
 * Spec rewriter — evaluates a commit cluster's impact on a design spec and
 * applies UPDATE / DEPRECATE decisions.
 *
 * @module spec/evolve/spec-rewriter
 */
import * as fs from 'fs';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { readFileContent, writeFileContent } from '../utils';
import {
  insertSpecNode,
  findSpecById,
  deleteSpec,
  updateSpecStatus,
} from '../db/spec-node';
import {
  insertSpecCommitRelation,
  insertSpecSpecRelation,
  transferSpecCommitRelations,
  transferSpecSpecRelations,
  deleteSimilarToRelations,
} from '../db/relations';
import { extractSpecMetadata } from '../build/spec-extractor';
import { LlmClient } from '../llm/client';
import {
  SPEC_EVALUATION_CLUSTER_SYSTEM_PROMPT,
  buildClusterSpecEvaluationUserPrompt,
} from '../llm/prompts';
import { ClusterContext } from './cluster-context';
import { logDebug, logWarn } from '../../errors';

// =============================================================================
// Types
// =============================================================================

export interface EvolveDecision {
  action: 'UPDATE' | 'DEPRECATE' | 'UNCHANGED';
  title?: string;
  subtitles?: string[];
  plan_content?: string;
}

// =============================================================================
// evaluateSpecWithCluster
// =============================================================================

/**
 * Ask the LLM whether a cluster of commits requires updating, deprecating,
 * or leaving a spec unchanged.
 *
 * Accepts a ClusterContext (multiple commits) and uses a cluster-aware
 * prompt template that presents aggregated commit summaries rather than
 * raw concatenated diffs.
 *
 * @param specId         - The spec identifier (for logging / context).
 * @param specFilePath   - Absolute path to the plan.md file.
 * @param clusterContext - Pre-built cluster context (from buildClusterContext).
 * @param client         - LLM client; if absent, returns UNCHANGED.
 */
export async function evaluateSpecWithCluster(
  specId: string,
  specFilePath: string,
  clusterContext: ClusterContext,
  client?: LlmClient,
): Promise<EvolveDecision> {
  // 1. Read plan content
  const planContent = readFileContent(specFilePath);
  if (planContent === null) {
    logDebug('evaluateSpecWithCluster: plan file not found, returning UNCHANGED', {
      specId,
      specFilePath,
    });
    return { action: 'UNCHANGED' };
  }

  // 2. Build user prompt from cluster context
  const userPrompt = buildClusterSpecEvaluationUserPrompt(
    planContent,
    clusterContext,
  );

  // 3. Call LLM
  if (!client) {
    logDebug('evaluateSpecWithCluster: no LLM client, returning UNCHANGED', { specId });
    return { action: 'UNCHANGED' };
  }

  let result: Record<string, unknown>;
  try {
    result = await client.chatJson(
      SPEC_EVALUATION_CLUSTER_SYSTEM_PROMPT,
      userPrompt,
    );
  } catch (err) {
    logWarn('evaluateSpecWithCluster: LLM call failed, defaulting to UNCHANGED', {
      specId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { action: 'UNCHANGED' };
  }

  // 4. Validate action
  const rawAction = result.action;
  let action: EvolveDecision['action'] = 'UNCHANGED';
  if (rawAction === 'UPDATE' || rawAction === 'DEPRECATE' || rawAction === 'UNCHANGED') {
    action = rawAction;
  } else {
    logWarn('evaluateSpecWithCluster: unknown action from LLM, defaulting to UNCHANGED', {
      specId,
      rawAction: String(rawAction),
    });
  }

  // 5. Return EvolveDecision
  return {
    action,
    title: typeof result.title === 'string' ? result.title : undefined,
    subtitles: Array.isArray(result.subtitles)
      ? result.subtitles.filter((s: unknown) => typeof s === 'string')
      : undefined,
    plan_content:
      typeof result.plan_content === 'string' ? result.plan_content : undefined,
  };
}

// =============================================================================
// applyUpdate
// =============================================================================

/**
 * Apply an UPDATE decision: backup the old plan, write the new plan, version
 * the spec in the database, and transfer relations.
 *
 * 10-step process (ported from spec_rewriter.py:79-178).
 *
 * @returns The new spec ID (same as old) and bumped version number.
 */
export function applyUpdate(
  db: SqliteDatabase,
  specStoragePath: string,
  oldSpecId: string,
  oldFilePath: string,
  oldVersion: number,
  decision: EvolveDecision,
  commitHash: string,
): { newSpecId: string; newVersion: number } {
  // ---- Step 1: Write new plan content to temp file ----
  const tmpPath = oldFilePath + '.new';
  writeFileContent(tmpPath, decision.plan_content || '');

  // ---- Step 2: Extract new metadata from the temp file ----
  const metadata = extractSpecMetadata(specStoragePath, oldSpecId);
  const metadataTitle = metadata?.title;
  const metadataSubtitles = metadata?.subtitles;

  // ---- Step 3: Read old spec data ----
  const oldSpec = findSpecById(db, oldSpecId);
  if (!oldSpec) {
    logDebug('applyUpdate: old spec not found in DB, returning early', {
      oldSpecId,
    });
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    return { newSpecId: oldSpecId, newVersion: oldVersion + 1 };
  }

  // ---- Step 4: Insert deprecated record ----
  const bakPath = oldFilePath + '.bak';
  const deprecatedId = `${oldSpecId}_v${oldVersion}`;
  insertSpecNode(db, {
    id: deprecatedId,
    title: oldSpec.title,
    subtitles: oldSpec.subtitles,
    status: 'deprecated',
    version: oldVersion,
    filePath: bakPath,
    timestamp: Date.now(),
  });

  // ---- Step 5: Transfer relations from old active to deprecated ----
  transferSpecCommitRelations(db, oldSpecId, deprecatedId);
  transferSpecSpecRelations(db, oldSpecId, deprecatedId);

  // ---- Step 6: Delete old active spec ----
  deleteSpec(db, oldSpecId);

  // ---- Step 7: Insert new active spec ----
  const newVersion = oldVersion + 1;
  insertSpecNode(db, {
    id: oldSpecId,
    title: decision.title || metadataTitle || oldSpecId,
    subtitles: decision.subtitles || metadataSubtitles || [],
    status: 'active',
    version: newVersion,
    filePath: oldFilePath,
    timestamp: Date.now(),
  });

  // ---- Step 8: Create EVOLVED_FROM relation ----
  insertSpecSpecRelation(db, oldSpecId, deprecatedId, 'EVOLVED_FROM');

  // ---- Step 9: Create GENERATE relation ----
  insertSpecCommitRelation(db, oldSpecId, commitHash, 'GENERATE');

  // ---- Step 10: File system finalisation ----
  try {
    fs.renameSync(oldFilePath, bakPath);
  } catch {
    logDebug('applyUpdate: backup rename failed (file may be missing), continuing', {
      oldFilePath,
      bakPath,
    });
  }
  try {
    fs.renameSync(tmpPath, oldFilePath);
  } catch {
    logDebug('applyUpdate: temp rename failed, leaving .new in place', {
      tmpPath,
      oldFilePath,
    });
  }

  return { newSpecId: oldSpecId, newVersion };
}

// =============================================================================
// applyDeprecate
// =============================================================================

/**
 * Apply a DEPRECATE decision: mark the spec as deprecated, create a
 * deprecated target node, create the EVOLVED_FROM relation, and clean
 * SIMILAR_TO relations.
 */
export function applyDeprecate(
  db: SqliteDatabase,
  oldSpecId: string,
): void {
  // 1. Mark the spec as deprecated
  updateSpecStatus(db, oldSpecId, 'deprecated');

  // 2. Create deprecated target node
  const deprecatedTargetId = `${oldSpecId}_deprecated`;
  insertSpecNode(db, {
    id: deprecatedTargetId,
    status: 'deprecated',
    version: 1,
    title: oldSpecId,
    subtitles: [],
    filePath: '',
    timestamp: Date.now(),
  });

  // 3. Create EVOLVED_FROM relation
  insertSpecSpecRelation(db, oldSpecId, deprecatedTargetId, 'EVOLVED_FROM');

  // 4. Clean SIMILAR_TO relations
  deleteSimilarToRelations(db, oldSpecId);
}
