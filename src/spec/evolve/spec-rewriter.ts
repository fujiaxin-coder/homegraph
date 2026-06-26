/**
 * Spec rewriter — evaluates a commit's impact on a design spec and applies
 * UPDATE / DEPRECATE decisions.
 *
 * Replaces `commit4spec/self_evolve/spec_rewriter.py` (lines 1-231).
 *
 * @module spec/evolve/spec-rewriter
 */
import * as fs from 'fs';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { readFileContent, writeFileContent, truncateText } from '../utils';
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
import { extractSpecMetadata } from '../mining/spec-extractor';
import { LLMClient } from './llm-client';
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
// evaluateSpec
// =============================================================================

/**
 * Ask the LLM whether a commit requires updating, deprecating, or leaving
 * a spec unchanged.
 *
 * @param specId            - The spec identifier (for logging / context).
 * @param specStoragePath   - Root spec storage directory.
 * @param specFilePath      - Absolute path to the plan.md file.
 * @param commitMessage     - First line of the commit message.
 * @param commitDiff        - Full unified diff of the commit.
 * @param scheduleNextSpecs - Remaining spec IDs to be processed (for context).
 * @param client            - Optional LLM client; if absent, returns UNCHANGED.
 */
export async function evaluateSpec(
  specId: string,
  _specStoragePath: string,
  specFilePath: string,
  commitMessage: string,
  commitDiff: string,
  scheduleNextSpecs: string[],
  client?: LLMClient,
): Promise<EvolveDecision> {
  // 1. Read plan content
  const planContent = readFileContent(specFilePath);
  if (planContent === null) {
    logDebug('evaluateSpec: plan file not found, returning UNCHANGED', {
      specId,
      specFilePath,
    });
    return { action: 'UNCHANGED' };
  }

  // 2. Truncate commitDiff to 6000 chars
  const truncatedDiff = truncateText(commitDiff, 6000);

  // 3. Build system prompt (EXACT from spec_rewriter.py:238-245)
  const systemPrompt = `You are a technical documentation maintainer. Your task is to evaluate whether a git commit requires updating a software design specification (plan.md).

Given the current plan content, the commit message, and the code diff, determine:
1. Whether the plan needs to be updated (UPDATE), deprecated (DEPRECATE), or left unchanged (UNCHANGED).
2. If UPDATE: provide the new title, subtitles (as an array of heading-preview strings), and full rewritten plan_content.
3. If DEPRECATE: provide a brief explanation in the plan_content field.

Response format (JSON):
{
  "action": "UPDATE" | "DEPRECATE" | "UNCHANGED",
  "title": "New spec title (for UPDATE)",
  "subtitles": ["heading1 → heading2 - preview", ...],
  "plan_content": "Full rewritten markdown content (for UPDATE) or deprecation reason (for DEPRECATE)"
}`;

  // 4. Build user prompt (EXACT from spec_rewriter.py:247-280)
  const scheduleStr =
    scheduleNextSpecs.length > 0 ? scheduleNextSpecs.join(', ') : 'none';

  const userPrompt = `Current Plan Content:
${planContent}

Commit Message:
${commitMessage}

Code Diff:
${truncatedDiff}

Scheduled specs to be processed next (for context): ${scheduleStr}`;

  // 5. Call LLM
  if (!client) {
    logDebug('evaluateSpec: no LLM client, returning UNCHANGED', { specId });
    return { action: 'UNCHANGED' };
  }

  const result = await client.chatJson(systemPrompt, userPrompt);

  // 6. Validate action
  const rawAction = result.action;
  let action: EvolveDecision['action'] = 'UNCHANGED';
  if (rawAction === 'UPDATE' || rawAction === 'DEPRECATE' || rawAction === 'UNCHANGED') {
    action = rawAction;
  } else {
    logWarn('evaluateSpec: unknown action from LLM, defaulting to UNCHANGED', {
      specId,
      rawAction: String(rawAction),
    });
  }

  // 7. Return EvolveDecision
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
  // We write to a temp file first so the original is preserved until every
  // DB operation succeeds.  If the caller's transaction rolls back, the
  // temp file is harmless garbage — the original plan.md is untouched.
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
    // Clean up the temp file — no DB changes were made.
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
  // Only now — after all DB ops succeeded — do we touch the original disk
  // files.  rename() is atomic on the same filesystem.
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
 *
 * Ported from spec_rewriter.py:181-231.
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
    filePath: '', // Synthetic deprecated node — no on-disk file.
    timestamp: Date.now(),
  });

  // 3. Create EVOLVED_FROM relation
  insertSpecSpecRelation(db, oldSpecId, deprecatedTargetId, 'EVOLVED_FROM');

  // 4. Clean SIMILAR_TO relations
  deleteSimilarToRelations(db, oldSpecId);
}
