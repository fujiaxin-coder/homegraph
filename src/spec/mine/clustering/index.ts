/**
 * Commit Clusterer — multi-signal graph clustering for the `spec mine` pipeline.
 *
 * Groups commits by structural (AST symbol overlap), file-path, temporal,
 * and commit-message similarity. Pure TypeScript implementation — no native
 * dependencies required.
 *
 * Orchestrates the pieces in this directory:
 *   - `text-similarity` — tokenize / Jaccard / cosine / TF-IDF
 *   - `features`        — per-commit feature extraction
 *   - `leiden`          — generic Leiden community detection + tuning
 *
 * @module spec/mine/clustering
 */

import { CommitChange } from '../scanner';
import { logDebug } from '../../../errors';
import { tokenize, jaccard, cosineSimilarity, TfidfVectorizer } from './text-similarity';
import {
  MIN_SYMBOLS_FOR_SOLO_CLUSTER,
  collectSymbolNames,
  collectFilePaths,
  collectDirectoryPrefixes,
  countChangedSymbols,
  computeCohesion,
  extractTicketRefs,
  hasNewNonTestFiles,
} from './features';
import {
  WeightedGraph,
  autoTuneResolution,
  greedyMerge,
  recursiveSubSplit,
} from './leiden';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cluster of semantically-related commits. */
export interface CommitCluster {
  id: number;
  commits: CommitChange[];
  primaryFiles: string[];
  primarySymbols: string[];
  summary: string;
  timeRange: { start: number; end: number };
}

/** Full clustering result including unclustered outliers and stats. */
export interface ClusterResult {
  clusters: CommitCluster[];
  unclustered: CommitChange[];
  stats: {
    totalCommits: number;
    clusteredCommits: number;
    clusterCount: number;
  };
}

// ---------------------------------------------------------------------------
// Similarity Computation
// ---------------------------------------------------------------------------

/**
 * Compute multi-signal similarity between two commits.
 *
 * Weights:
 *   - Symbol overlap (Jaccard):       0.40
 *   - Spatial proximity (Jaccard):    0.15  (max of file-path and dir-prefix)
 *   - Message TF-IDF cosine:          0.25
 *   - Ticket reference overlap:       0.10
 *   - Temporal proximity:             0.10  (half-life 3 days)
 *
 * A cohesion penalty is applied as a multiplier when one commit has low
 * symbol-per-file density (< 2.0), which is characteristic of mechanical
 * refactors that should not bridge unrelated feature clusters.
 */
function computeSimilarity(
  a: CommitChange,
  b: CommitChange,
  aSymbols: string[],
  bSymbols: string[],
  aFiles: string[],
  bFiles: string[],
  aDirs: string[],
  bDirs: string[],
  aTickets: string[],
  bTickets: string[],
  msgTfidfMatrix: number[][],
  aIdx: number,
  bIdx: number,
): number {
  // Symbol overlap — highest weight because AST-level diff is precise
  const symbolSim = jaccard(aSymbols, bSymbols);

  // Spatial proximity — max of exact file-path and module-level dir-prefix
  // overlap, so same-file edits get full credit and same-module edits also
  // connect, without double-counting the same spatial dimension.
  const spatialSim = Math.max(
    jaccard(aFiles, bFiles),
    jaccard(aDirs, bDirs),
  );

  // Message TF-IDF cosine
  const msgSim = cosineSimilarity(
    msgTfidfMatrix[aIdx]!,
    msgTfidfMatrix[bIdx]!,
  );

  // Ticket reference overlap
  const ticketSim = jaccard(aTickets, bTickets);

  // Temporal proximity — half-life 3 days (259200 seconds)
  const halfLife = 3 * 24 * 60 * 60 * 1000;
  const maxTimeSpan = Math.abs(a.timestamp - b.timestamp);
  const timeSim = Math.exp(-maxTimeSpan / halfLife);

  // Cohesion penalty: low cohesion (many files, few symbols) = refactor-like.
  // Penalty multiplier: 0.6 at cohesion 0 → 1.0 at cohesion ≥ 2.0
  const minCohesion = Math.min(
    computeCohesion(a),
    computeCohesion(b),
  );
  const cohesionPenalty = minCohesion >= 2.0
    ? 1.0
    : 0.6 + 0.4 * (minCohesion / 2.0);

  const rawScore =
    0.40 * symbolSim +
    0.15 * spatialSim +
    0.25 * msgSim +
    0.10 * ticketSim +
    0.10 * timeSim;

  return rawScore * cohesionPenalty;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cluster commits using Leiden community detection on a multi-signal
 * similarity graph, with recursive sub-splitting for large clusters.
 *
 * The pipeline:
 *   1. Build a weighted similarity graph from AST symbol, file-path,
 *      commit-message TF-IDF, ticket-reference, and temporal signals.
 *   2. Run Leiden community detection with auto-tuned resolution γ.
 *   3. Greedy-merge if still too many communities.
 *   4. Recursively split large clusters (≥ 4 commits) by running
 *      Leiden on their sub-graphs.
 *
 * Replaces the previous Louvain (no refinement) and connected-components
 * (single-linkage chaining) approaches.
 *
 * @param changes     - AST change data for each commit.
 * @param threshold   - Minimum similarity (0-1) for considering an edge.
 * @param maxClusters - Desired maximum number of top-level clusters.
 *                      The resolution parameter γ is auto-tuned to approach
 *                      this target. Recursive splitting may produce more
 *                      clusters at finer granularities.
 * @returns Clustered result with stats.
 */
export function clusterCommits(
  changes: CommitChange[],
  threshold: number,
  maxClusters: number,
): ClusterResult {
  const n = changes.length;

  // Edge cases: 0 or 1 commit — avoid Leiden overhead.
  if (n === 0) {
    return {
      clusters: [],
      unclustered: [],
      stats: { totalCommits: 0, clusteredCommits: 0, clusterCount: 0 },
    };
  }

  if (n === 1) {
    const c = changes[0]!;
    const totalSymbols = countChangedSymbols(c);

    if (totalSymbols < MIN_SYMBOLS_FOR_SOLO_CLUSTER && !hasNewNonTestFiles(c)) {
      logDebug('Clusterer: single commit below quality threshold', {
        hash: c.commitHash.slice(0, 7),
        changedSymbols: totalSymbols,
        minRequired: MIN_SYMBOLS_FOR_SOLO_CLUSTER,
      });
      return {
        clusters: [],
        unclustered: [c],
        stats: { totalCommits: 1, clusteredCommits: 0, clusterCount: 0 },
      };
    }

    const syms = collectSymbolNames(c);
    const files = collectFilePaths(c);
    return {
      clusters: [
        {
          id: 0,
          commits: [c],
          primaryFiles: files,
          primarySymbols: syms,
          summary: `1 commit: ${c.commitMessage}`,
          timeRange: { start: c.timestamp, end: c.timestamp },
        },
      ],
      unclustered: [],
      stats: { totalCommits: 1, clusteredCommits: 1, clusterCount: 1 },
    };
  }

  // n >= 2: full pipeline from here.

  // --- Pre-compute per-commit feature vectors ---
  const messages: string[][] = [];
  const allSymbols: string[][] = [];
  const allFiles: string[][] = [];
  const allDirs: string[][] = [];
  const allTickets: string[][] = [];

  for (const change of changes) {
    messages.push(tokenize(change.commitMessage));
    allSymbols.push(collectSymbolNames(change));
    allFiles.push(collectFilePaths(change));
    allDirs.push(collectDirectoryPrefixes(change));
    allTickets.push(extractTicketRefs(change.commitMessage));
  }

  // --- Build TF-IDF vectors for commit messages ---
  const tfidf = new TfidfVectorizer();
  tfidf.fit(messages);
  const msgTfidfMatrix = messages.map((msg) => tfidf.transform(msg));

  // --- Build weighted similarity graph ---
  const graph: WeightedGraph = Array.from({ length: n }, () =>
    new Array(n).fill(0),
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = computeSimilarity(
        changes[i]!, changes[j]!,
        allSymbols[i]!, allSymbols[j]!,
        allFiles[i]!, allFiles[j]!,
        allDirs[i]!, allDirs[j]!,
        allTickets[i]!, allTickets[j]!,
        msgTfidfMatrix, i, j,
      );
      if (sim >= threshold) {
        graph[i]![j] = sim;
        graph[j]![i] = sim;
      }
    }
  }

  // --- Leiden community detection with auto-tuned resolution ---
  let components = autoTuneResolution(graph, maxClusters);

  // --- Greedy merge if still too many communities ---
  if (components.length > maxClusters) {
    logDebug('Clusterer: post-Leiden greedy merge', {
      beforeMerge: components.length,
      maxClusters,
    });
    components = greedyMerge(graph, components, maxClusters);
  }

  // --- Recursive sub-splitting for large clusters ---
  components = recursiveSubSplit(graph, components);

  // --- Sort by size descending for deterministic output ---
  components.sort((a, b) => b.length - a.length);

  // --- Filter: size-1 communities go to unclustered if < MIN_SYMBOLS ---
  const validComponents: number[][] = [];
  const unclusteredIndices: number[] = [];

  for (const comp of components) {
    if (comp.length === 1) {
      const idx = comp[0]!;
      const c = changes[idx]!;
      if (countChangedSymbols(c) < MIN_SYMBOLS_FOR_SOLO_CLUSTER && !hasNewNonTestFiles(c)) {
        unclusteredIndices.push(idx);
        continue;
      }
    }
    validComponents.push(comp);
  }

  // --- Build cluster objects ---
  const clustered = new Set<number>();
  const clusters: CommitCluster[] = [];

  for (let i = 0; i < validComponents.length; i++) {
    const comp = validComponents[i]!;
    const clusterCommits = comp.map((idx) => {
      clustered.add(idx);
      return changes[idx]!;
    });

    // Compute primary files (appear in >50% of cluster commits)
    const fileCounts = new Map<string, number>();
    const symbolCounts = new Map<string, number>();
    const allTimes = clusterCommits
      .map((c) => c.timestamp)
      .filter((t) => t > 0);

    for (const c of clusterCommits) {
      for (const fp of collectFilePaths(c)) {
        fileCounts.set(fp, (fileCounts.get(fp) || 0) + 1);
      }
      for (const s of collectSymbolNames(c)) {
        symbolCounts.set(s, (symbolCounts.get(s) || 0) + 1);
      }
    }

    const half = clusterCommits.length / 2;
    const primaryFiles = Array.from(fileCounts.entries())
      .filter(([, count]) => count >= half)
      .sort((a, b) => b[1] - a[1])
      .map(([fp]) => fp);
    const primarySymbols = Array.from(symbolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([s]) => s);

    // Build summary
    const fileSummary =
      primaryFiles.length > 0
        ? `changing ${primaryFiles.slice(0, 3).join(', ')}`
        : '';
    const summary =
      `${clusterCommits.length} commits ${fileSummary}`.trim();

    clusters.push({
      id: i,
      commits: clusterCommits,
      primaryFiles,
      primarySymbols,
      summary,
      timeRange: {
        start: allTimes.length > 0 ? Math.min(...allTimes) : 0,
        end: allTimes.length > 0 ? Math.max(...allTimes) : 0,
      },
    });
  }

  // --- Unclustered commits ---
  const unclustered = changes.filter((_, i) => !clustered.has(i));

  logDebug('Clusterer result', {
    totalCommits: n,
    clusterCount: clusters.length,
    clusteredCommits: n - unclustered.length,
    unclustered: unclustered.length,
  });

  return {
    clusters,
    unclustered,
    stats: {
      totalCommits: n,
      clusteredCommits: n - unclustered.length,
      clusterCount: clusters.length,
    },
  };
}
