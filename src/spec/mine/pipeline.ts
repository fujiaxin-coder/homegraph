/**
 * Mine Pipeline — orchestrates the `spec mine` flow.
 *
 * Three-stage pipeline:
 *   1. Scan commits (AST-level diff extraction)
 *   2. Cluster commits (multi-signal graph clustering)
 *   3. Generate specs (LLM-driven spec documents)
 *
 * Integrates with the existing meta.json anchor for incremental runs.
 *
 * @module spec/mine/pipeline
 */

import * as path from 'path';
import { LLMConfig, MineConfig } from '../config';
import { isGitRepo, getHeadHash, isAncestor } from '../git';
import { readMeta, writeMeta } from '../utils';
import { scanCommits } from './scanner';
import { clusterCommits } from './clustering';
import { generateSpecs } from './generator';
import { logDebug, logWarn } from '../../errors';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { persistToGraph } from './persist';
import type { MineProgressCallback } from './progress';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by the mine pipeline. */
export interface MinePipelineResult {
  commitsScanned: number;
  changesFound: number;
  clusters: number;
  specsGenerated: number;
  skippedClusters: number;
  specsWritten: number;
  commitsWritten: number;
  fragmentsWritten: number;
  relationsWritten: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full reverse-spec pipeline.
 *
 * @param repoPath - Path to the git repository.
 * @param config - Reverse pipeline configuration.
 * @param llmConfig - LLM configuration (required unless skipLlm is true).
 * @param db - Optional SQLite database handle for persistence.
 * @param onProgress - Optional progress callback for real-time feedback.
 * @returns Pipeline result with stats.
 */
export async function runMinePipeline(
  repoPath: string,
  config: MineConfig,
  llmConfig: LLMConfig | null,
  db: SqliteDatabase | null = null,
  onProgress?: MineProgressCallback,
): Promise<MinePipelineResult> {
  const errors: string[] = [];

  // 1. Validate git repo
  if (!isGitRepo(repoPath)) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  const headHash = getHeadHash(repoPath);
  if (!headHash) {
    throw new Error(`No HEAD commit found in ${repoPath}`);
  }

  // 2. Resolve commit range from meta.json
  let fromHash = '';
  const meta = readMeta(repoPath);

  if (meta?.currentCommitID) {
    if (isAncestor(repoPath, meta.currentCommitID, headHash)) {
      // Normal incremental case
      fromHash = meta.currentCommitID;
      logDebug('Mine pipeline: incremental range', {
        from: fromHash.slice(0, 7),
        to: headHash.slice(0, 7),
      });
    } else {
      // Rebase detected — full scan
      logWarn(
        'Mine pipeline: meta.json currentCommitID is not an ancestor of HEAD (possible rebase). Falling back to full scan.',
        {
          metaCommit: meta.currentCommitID.slice(0, 7),
          head: headHash.slice(0, 7),
        },
      );
      fromHash = '';
    }
  } else {
    logDebug('Mine pipeline: no meta.json anchor — full scan');
  }

  // 3. Scan commits (AST-level diff)
  onProgress?.({ phase: 'scanning', current: 0, total: 0, message: 'Starting...' });
  const changes = scanCommits(repoPath, fromHash, headHash, config.limit, onProgress);

  if (changes.length === 0) {
    onProgress?.({ phase: 'done', current: 1, total: 1 });
    return {
      commitsScanned: 0,
      changesFound: 0,
      clusters: 0,
      specsGenerated: 0,
      skippedClusters: 0,
      specsWritten: 0,
      commitsWritten: 0,
      fragmentsWritten: 0,
      relationsWritten: 0,
      errors: ['No commits found in range.'],
    };
  }

  const changesWithData = changes.filter((c) => c.fileChanges.length > 0);

  if (changesWithData.length === 0) {
    onProgress?.({ phase: 'done', current: 1, total: 1 });
    return {
      commitsScanned: changes.length,
      changesFound: 0,
      clusters: 0,
      specsGenerated: 0,
      skippedClusters: 0,
      specsWritten: 0,
      commitsWritten: 0,
      fragmentsWritten: 0,
      relationsWritten: 0,
      errors: [`Scanned ${changes.length} commit(s) but none had structural changes.`],
    };
  }

  logDebug('Mine pipeline: scanning complete', {
    totalCommits: changes.length,
    commitsWithChanges: changesWithData.length,
  });

  // 4. Cluster commits (synchronous — one-shot; no per-item counting)
  const clusterResult = clusterCommits(
    changesWithData,
    config.threshold,
    config.maxCluster,
  );
  onProgress?.({
    phase: 'clustering',
    current: 0,
    total: 0,
    message: `${changesWithData.length} commits → ${clusterResult.clusters.length} clusters`,
  });

  logDebug('Mine pipeline: clustering complete', clusterResult.stats);

  // 5. Generate specs (optional)
  let specsGenerated = 0;
  let skippedClusters = 0;
  let specsWritten = 0;
  let commitsWritten = 0;
  let fragmentsWritten = 0;
  let relationsWritten = 0;
  let shouldAdvanceMeta = false;

  if (!config.skipLlm && llmConfig) {
    // Read custom template if provided
    let templateContent: string | undefined;
    if (config.template) {
      try {
        const fs = await import('fs');
        templateContent = fs.readFileSync(
          path.resolve(config.template),
          'utf-8',
        );
      } catch (err) {
        logWarn('Failed to read template file — using built-in template', {
          template: config.template,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const genResult = await generateSpecs(
      clusterResult.clusters,
      llmConfig,
      config.outputDir,
      templateContent,
      onProgress,
    );

    specsGenerated = genResult.specs.length;
    skippedClusters = genResult.skipped + genResult.errors;

    if (genResult.errors > 0) {
      errors.push(`${genResult.errors} LLM generation(s) failed.`);
    }

    // 6. Persist specs to knowledge graph
    let persistFailed = false;
    if (db && genResult.specs.length > 0) {
      try {
        const persistResult = persistToGraph(
          db,
          repoPath,
          genResult.specs,
          clusterResult.clusters,
          config.outputDir,
          onProgress,
        );
        specsWritten = persistResult.specsWritten;
        commitsWritten = persistResult.commitsWritten;
        fragmentsWritten = persistResult.fragmentsWritten;
        relationsWritten = persistResult.relationsWritten;
        logDebug('Mine pipeline: persisted to graph', { ...persistResult });
      } catch (err) {
        persistFailed = true;
        errors.push(
          `Failed to persist specs to graph: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Advance meta.json only when LLM ran, persistence did not fail,
    // and at least one spec document was generated.
    if (!persistFailed && genResult.specs.length > 0) {
      shouldAdvanceMeta = true;
    }
  } else if (!config.skipLlm && !llmConfig) {
    errors.push(
      'LLM generation skipped — no LLM configuration found. Set up llm in configs.json or use --skip-llm.',
    );
  }

  // 7. Update meta.json — only advance when specs were successfully generated
  //    and persisted. With skipLlm or no LLM config, skip advancing so the
  //    same commits are re-scanned when LLM is available.
  if (shouldAdvanceMeta) {
    try {
      writeMeta(repoPath, config.outputDir, headHash);
      logDebug('Mine pipeline: updated meta.json', {
        currentCommitID: headHash.slice(0, 7),
      });
    } catch (err) {
      errors.push(
        `Failed to update meta.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  onProgress?.({ phase: 'done', current: 1, total: 1 });
  return {
    commitsScanned: changes.length,
    changesFound: changesWithData.length,
    clusters: clusterResult.clusters.length,
    specsGenerated,
    skippedClusters,
    specsWritten,
    commitsWritten,
    fragmentsWritten,
    relationsWritten,
    errors,
  };
}
