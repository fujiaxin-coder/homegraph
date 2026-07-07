/**
 * Commit Clusterer — multi-signal graph clustering for the `spec mine` pipeline.
 *
 * Groups commits by structural (AST symbol overlap), file-path, temporal,
 * and commit-message similarity. Pure TypeScript implementation — no native
 * dependencies required.
 *
 * Algorithm: connected-components on an adjacency graph built from
 * multi-signal pairwise similarity scores.
 *
 * @module spec/mine/clusterer
 */

import { CommitChange } from './scanner';
import { logDebug } from '../../errors';

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
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase words (3+ chars). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Jaccard similarity between two sets of strings. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Cosine similarity between two equal-length numeric vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Collect all symbol names across all file changes in a commit. */
function collectSymbolNames(change: CommitChange): string[] {
  const names = new Set<string>();
  for (const fc of change.fileChanges) {
    for (const s of fc.addedSymbols) names.add(s.name);
    for (const s of fc.removedSymbols) names.add(s.name);
    for (const m of fc.modifiedSymbols) {
      names.add(m.old.name);
      names.add(m.new.name);
    }
  }
  return Array.from(names);
}

/** Collect all file paths changed in a commit. */
function collectFilePaths(change: CommitChange): string[] {
  const paths = new Set<string>();
  for (const fc of change.fileChanges) {
    paths.add(fc.filePath);
  }
  return Array.from(paths);
}

/** Extract ticket references (e.g., PROJ-123, #456) from a commit message. */
function extractTicketRefs(message: string): string[] {
  const refs: string[] = [];
  const jiraRe = /[A-Z]+-\d+/g;
  const ghRe = /#\d+/g;
  let m: RegExpExecArray | null;
  while ((m = jiraRe.exec(message)) !== null) refs.push(m[0]);
  while ((m = ghRe.exec(message)) !== null) refs.push(m[0]);
  return Array.from(new Set(refs));
}

// ---------------------------------------------------------------------------
// TF-IDF Vectorizer (message-level)
// ---------------------------------------------------------------------------

class TfidfVectorizer {
  private vocabulary: Map<string, number> = new Map();
  private idf: number[] = [];

  /** Build vocabulary and compute IDF from document corpus. */
  fit(documents: string[][]): void {
    const docFreq = new Map<string, number>();
    const N = documents.length;

    for (const doc of documents) {
      const seen = new Set<string>();
      for (const term of doc) {
        if (!seen.has(term)) {
          seen.add(term);
          docFreq.set(term, (docFreq.get(term) || 0) + 1);
        }
      }
    }

    // Build vocabulary sorted for deterministic output
    const sorted = Array.from(docFreq.keys()).sort();
    this.vocabulary.clear();
    this.idf = [];

    for (let i = 0; i < sorted.length; i++) {
      const term = sorted[i]!;
      this.vocabulary.set(term, i);
      // IDF = log((N + 1) / (df + 1)) + 1  (smooth)
      const df = docFreq.get(term)!;
      this.idf.push(Math.log((N + 1) / (df + 1)) + 1);
    }
  }

  /** Transform a document into a TF-IDF vector. */
  transform(document: string[]): number[] {
    const vec = new Array(this.vocabulary.size).fill(0);
    const tf = new Map<string, number>();
    for (const term of document) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }
    for (const [term, count] of tf) {
      const idx = this.vocabulary.get(term);
      if (idx !== undefined) {
        vec[idx] = (count / document.length) * this.idf[idx]!;
      }
    }
    return vec;
  }
}

// ---------------------------------------------------------------------------
// Similarity Computation
// ---------------------------------------------------------------------------

/**
 * Compute multi-signal similarity between two commits.
 *
 * Weights:
 *   - Symbol overlap (Jaccard): 0.40
 *   - File path overlap (Jaccard): 0.15
 *   - Message TF-IDF cosine: 0.25
 *   - Ticket reference overlap (Jaccard): 0.10
 *   - Temporal proximity: 0.10 (half-life 3 days)
 */
function computeSimilarity(
  a: CommitChange,
  b: CommitChange,
  aSymbols: string[],
  bSymbols: string[],
  aFiles: string[],
  bFiles: string[],
  aTickets: string[],
  bTickets: string[],
  msgTfidfMatrix: number[][],
  aIdx: number,
  bIdx: number,
): number {
  // Symbol overlap — highest weight because AST-level diff is precise
  const symbolSim = jaccard(aSymbols, bSymbols);

  // File path overlap
  const fileSim = jaccard(aFiles, bFiles);

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

  return (
    0.40 * symbolSim +
    0.15 * fileSim +
    0.25 * msgSim +
    0.10 * ticketSim +
    0.10 * timeSim
  );
}

// ---------------------------------------------------------------------------
// Connected Components (BFS)
// ---------------------------------------------------------------------------

/**
 * Find connected components in an undirected graph represented as an
 * adjacency matrix (boolean[][]).
 */
function findConnectedComponents(
  n: number,
  adjacency: boolean[][],
): number[][] {
  const visited = new Array(n).fill(false);
  const components: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const component: number[] = [];
    const queue = [i];
    visited[i] = true;

    while (queue.length > 0) {
      const v = queue.shift()!;
      component.push(v);
      for (let w = 0; w < n; w++) {
        if (adjacency[v]![w] && !visited[w]) {
          visited[w] = true;
          queue.push(w);
        }
      }
    }

    if (component.length > 1) {
      components.push(component);
    }
  }

  return components;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimum number of changed symbols (added + removed + modified) required
 *  for a single commit to be promoted into its own cluster.  Commits below
 *  this threshold go to `unclustered` — they are too small to warrant a
 *  standalone spec document. */
const MIN_SYMBOLS_FOR_SOLO_CLUSTER = 5;

/** Count total changed symbols across all file changes in a commit. */
function countChangedSymbols(change: CommitChange): number {
  let count = 0;
  for (const fc of change.fileChanges) {
    count += fc.addedSymbols.length;
    count += fc.removedSymbols.length;
    count += fc.modifiedSymbols.length;
  }
  return count;
}

/**
 * Cluster commits using multi-signal graph-based clustering.
 *
 * @param changes - AST change data for each commit.
 * @param threshold - Similarity threshold (0-1) for adding graph edges.
 * @param maxClusters - Maximum number of clusters to produce.
 * @returns Clustered result with stats.
 */
export function clusterCommits(
  changes: CommitChange[],
  threshold: number,
  maxClusters: number,
): ClusterResult {
  const n = changes.length;

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

    if (totalSymbols < MIN_SYMBOLS_FOR_SOLO_CLUSTER) {
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

  // Pre-compute per-commit feature vectors
  const messages: string[][] = [];
  const allSymbols: string[][] = [];
  const allFiles: string[][] = [];
  const allTickets: string[][] = [];

  for (const change of changes) {
    messages.push(tokenize(change.commitMessage));
    allSymbols.push(collectSymbolNames(change));
    allFiles.push(collectFilePaths(change));
    allTickets.push(extractTicketRefs(change.commitMessage));
  }

  // Build TF-IDF vectors for commit messages
  const tfidf = new TfidfVectorizer();
  tfidf.fit(messages);
  const msgTfidfMatrix = messages.map((msg) => tfidf.transform(msg));

  // Build adjacency matrix
  const adjacency: boolean[][] = Array.from({ length: n }, () =>
    new Array(n).fill(false),
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = computeSimilarity(
        changes[i]!, changes[j]!,
        allSymbols[i]!, allSymbols[j]!,
        allFiles[i]!, allFiles[j]!,
        allTickets[i]!, allTickets[j]!,
        msgTfidfMatrix, i, j,
      );
      if (sim >= threshold) {
        adjacency[i]![j] = true;
        adjacency[j]![i] = true;
      }
    }
  }

  // Find connected components (clusters of size >= 2)
  let components = findConnectedComponents(n, adjacency);

  // Sort by size descending
  components.sort((a, b) => b.length - a.length);

  // Limit clusters
  if (components.length > maxClusters) {
    components = components.slice(0, maxClusters);
  }

  // Track which commits are clustered
  const clustered = new Set<number>();
  for (const comp of components) {
    for (const idx of comp) clustered.add(idx);
  }

  // Build cluster objects
  const clusters: CommitCluster[] = [];
  for (let i = 0; i < components.length; i++) {
    const comp = components[i]!;
    const clusterCommits = comp.map((idx) => changes[idx]!);

    // Compute primary files (appear in >50% of cluster commits)
    const fileCounts = new Map<string, number>();
    const symbolCounts = new Map<string, number>();
    const allTimes = clusterCommits.map((c) => c.timestamp).filter((t) => t > 0);

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
    const summary = `${clusterCommits.length} commits ${fileSummary}`.trim();

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

  // Unclustered commits
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
