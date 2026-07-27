/**
 * Leiden community detection on a weighted similarity graph — a generic
 * graph-clustering implementation with no dependency on the commit domain.
 *
 * Replaces Louvain and connected-components (single-linkage) to avoid chaining
 * all nodes into one giant cluster and to guarantee well-connected communities
 * via the refinement phase. A resolution parameter γ is auto-tuned via
 * multiplicative search so the output community count stays close to a target.
 *
 * @module spec/mine/clustering/leiden
 */

import { logDebug } from '../../../errors';

/**
 * Weighted adjacency matrix: graph[i][j] = similarity score (0 means no edge).
 * Always symmetric: graph[i][j] === graph[j][i].
 */
export type WeightedGraph = number[][];

/** Compute weighted degree for every node. */
function computeDegrees(graph: WeightedGraph): number[] {
  const n = graph.length;
  const degrees = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      degrees[i] += graph[i]![j]!;
    }
  }
  return degrees;
}

/**
 * Shuffle an array in place (Fisher-Yates). Returns the same array.
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Create an array [0, 1, ..., n-1].
 */
function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Modularity gain from moving node i into community C.
 *
 * Assumes node i has already been *removed* from its current community.
 *
 * @param k_i_in   - Sum of edge weights from node i to community C.
 * @param k_i      - Weighted degree of node i.
 * @param sigmaTotC - Total weighted degree of community C BEFORE adding i.
 * @param m2       - Twice the total edge weight of the graph (2m).
 * @param gamma    - Resolution parameter (higher = more communities).
 */
function modularityGain(
  k_i_in: number,
  k_i: number,
  sigmaTotC: number,
  m2: number,
  gamma: number,
): number {
  if (m2 === 0) return 0;
  return k_i_in - gamma * sigmaTotC * k_i / m2;
}

/**
 * Refinement phase of the Leiden algorithm.
 *
 * For each Phase-1 community, runs a restricted local-moving pass that starts
 * from singleton sub-communities and only allows moves within the same community.
 * This guarantees that sub-communities are internally well-connected before they
 * are aggregated — the key advantage of Leiden over Louvain.
 *
 * @param graph       - Full weighted graph.
 * @param communities - Phase-1 partition (list of node-index arrays).
 * @param degrees     - Pre-computed weighted degrees for every node.
 * @param m2          - Twice the total edge weight of the full graph.
 * @param gamma       - Resolution parameter.
 * @returns Refined partition — flat list of sub-community node-index arrays.
 */
function refine(
  graph: WeightedGraph,
  communities: number[][],
  degrees: number[],
  m2: number,
  gamma: number,
): number[][] {
  const refined: number[][] = [];

  for (const community of communities) {
    if (community.length <= 1) {
      refined.push([...community]);
      continue;
    }

    const nodes = community;
    const nodeCount = nodes.length;

    // Each node starts in its own singleton sub-community.
    const nodeToSub = range(nodeCount);
    const subSigmaTot = nodes.map((n) => degrees[n]!);

    // Local moving restricted to within this community only.
    const MAX_PASSES = 20;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let moved = false;
      const order = shuffle(range(nodeCount));

      for (const localIdx of order) {
        const globalNode = nodes[localIdx]!;
        const currentSub = nodeToSub[localIdx]!;
        const k_i = degrees[globalNode]!;

        // Collect edge weights to neighbor sub-communities (within this community only).
        const neighborSubs = new Map<number, number>();
        for (let j = 0; j < nodeCount; j++) {
          if (j === localIdx) continue;
          const w = graph[globalNode]![nodes[j]!]!;
          if (w > 0) {
            const subJ = nodeToSub[j]!;
            neighborSubs.set(subJ, (neighborSubs.get(subJ) || 0) + w);
          }
        }

        // ΔQ for removing from current sub-community.
        const k_i_in_current = neighborSubs.get(currentSub) || 0;
        const sigmaTotCurrent = subSigmaTot[currentSub]!;
        const sigmaTotCurrentWithout = sigmaTotCurrent - k_i;
        const deltaQRemove = k_i_in_current > 0 || sigmaTotCurrentWithout > 0
          ? -(k_i_in_current - gamma * sigmaTotCurrentWithout * k_i / m2)
          : 0;

        let bestSub = currentSub;
        let bestDeltaQ = 0;

        for (const [subId, k_i_in] of neighborSubs) {
          if (subId === currentSub) continue;
          const sigmaTotTarget = subSigmaTot[subId]!;
          if (sigmaTotTarget === 0) continue;
          const deltaQAdd = modularityGain(k_i_in, k_i, sigmaTotTarget, m2, gamma);
          const totalDelta = deltaQRemove + deltaQAdd;
          if (totalDelta > bestDeltaQ) {
            bestDeltaQ = totalDelta;
            bestSub = subId;
          }
        }

        if (bestSub !== currentSub) {
          nodeToSub[localIdx] = bestSub;
          subSigmaTot[currentSub]! -= k_i;
          subSigmaTot[bestSub]! += k_i;
          moved = true;
        }
      }

      if (!moved) break;
    }

    // Collect non-empty sub-communities from this community.
    const subCommToNodes = new Map<number, number[]>();
    for (let i = 0; i < nodeCount; i++) {
      const subId = nodeToSub[i]!;
      if (!subCommToNodes.has(subId)) {
        subCommToNodes.set(subId, []);
      }
      subCommToNodes.get(subId)!.push(nodes[i]!);
    }
    for (const [, members] of subCommToNodes) {
      refined.push(members);
    }
  }

  return refined;
}

/**
 * Core Leiden algorithm: iterative local-moving + refinement + aggregation.
 *
 * Unlike Louvain (which feeds the Phase-1 partition directly into aggregation),
 * Leiden inserts a refinement step that splits each Phase-1 community into
 * well-connected sub-communities. Only the refined partition is aggregated.
 * This guarantees internally-connected communities and avoids the
 * "disconnected community" defect of Louvain.
 *
 * @param graph  - Weighted undirected similarity graph.
 * @param gamma  - Resolution parameter (default 1.0).
 * @param depth  - Aggregation depth guard (internal use).
 */
export function leiden(
  graph: WeightedGraph,
  gamma: number,
  depth: number = 0,
): number[][] {
  const n = graph.length;
  if (n <= 1) {
    return n === 0 ? [] : [[0]];
  }

  const degrees = computeDegrees(graph);
  const totalWeight = degrees.reduce((a, b) => a + b, 0);
  const m2 = totalWeight; // 2m (sum of all degrees = 2 × sum of edge weights)

  // Each node starts in its own community
  const nodeToComm = range(n);

  // Per-community stats
  // sigmaTot[c] = sum of degrees of all nodes in community c
  const sigmaTot = [...degrees];

  // Phase 1: local moving
  const MAX_PASSES = 20;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;
    const order = shuffle(range(n));

    for (const node of order) {
      const currentComm = nodeToComm[node]!;
      const k_i = degrees[node]!;

      // Collect edge weights to each neighbor community
      const neighborComms = new Map<number, number>(); // commId → k_i_in
      for (let j = 0; j < n; j++) {
        const w = graph[node]![j]!;
        if (w > 0) {
          const cj = nodeToComm[j]!;
          neighborComms.set(cj, (neighborComms.get(cj) || 0) + w);
        }
      }

      // Compute ΔQ for removing node from its current community.
      // k_i_in_current = edges from node to nodes in current community.
      const k_i_in_current = neighborComms.get(currentComm) || 0;
      const sigmaTotCurrent = sigmaTot[currentComm]!;
      // ΔQ of removal (negative of the gain formula applied to current community
      // with sigmaTot excluding self)
      const sigmaTotCurrentWithout = sigmaTotCurrent - k_i;
      const deltaQRemove = k_i_in_current > 0 || sigmaTotCurrentWithout > 0
        ? -(k_i_in_current - gamma * sigmaTotCurrentWithout * k_i / m2)
        : 0;

      // Find best community to move to
      let bestComm = currentComm;
      let bestDeltaQ = 0;

      for (const [commId, k_i_in] of neighborComms) {
        if (commId === currentComm) continue;

        const sigmaTotTarget = sigmaTot[commId]!;
        if (sigmaTotTarget === 0) continue;

        const deltaQAdd = modularityGain(k_i_in, k_i, sigmaTotTarget, m2, gamma);
        const totalDelta = deltaQRemove + deltaQAdd;

        if (totalDelta > bestDeltaQ) {
          bestDeltaQ = totalDelta;
          bestComm = commId;
        }
      }

      if (bestComm !== currentComm) {
        // Move node from currentComm to bestComm
        nodeToComm[node] = bestComm;
        sigmaTot[currentComm]! -= k_i;
        sigmaTot[bestComm]! += k_i;
        moved = true;
      }
    }

    if (!moved) break;
  }

  // Collect non-empty communities from Phase 1
  const commIdToMembers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const cid = nodeToComm[i]!;
    if (!commIdToMembers.has(cid)) {
      commIdToMembers.set(cid, []);
    }
    commIdToMembers.get(cid)!.push(i);
  }
  const communities: number[][] = Array.from(commIdToMembers.values());

  // Refinement: split each Phase-1 community into well-connected sub-communities.
  const refinedCommunities = refine(graph, communities, degrees, m2, gamma);

  // Phase 2: Aggregation using refined partition (Leiden key difference from Louvain).
  const k = refinedCommunities.length;
  if (k < n && k > 1 && depth < 5) {
    const aggGraph = aggregateGraph(graph, refinedCommunities);
    const subCommunities = leiden(aggGraph, gamma, depth + 1);
    return mapBackCommunities(subCommunities, refinedCommunities);
  }

  return refinedCommunities;
}

/**
 * Build an aggregated graph where each node represents a community from the
 * previous level. Edge weights are summed across community boundaries.
 */
function aggregateGraph(
  graph: WeightedGraph,
  communities: number[][],
): WeightedGraph {
  const k = communities.length;
  const agg: WeightedGraph = Array.from({ length: k }, () =>
    new Array(k).fill(0),
  );

  // Build reverse map: original node → community index
  const nodeToCommIdx = new Map<number, number>();
  for (let ci = 0; ci < k; ci++) {
    for (const node of communities[ci]!) {
      nodeToCommIdx.set(node, ci);
    }
  }

  // Aggregate edge weights
  for (let i = 0; i < graph.length; i++) {
    const ci = nodeToCommIdx.get(i)!;
    for (let j = i + 1; j < graph.length; j++) {
      const w = graph[i]![j]!;
      if (w > 0) {
        const cj = nodeToCommIdx.get(j)!;
        if (ci === cj) {
          // Self-loop: double weight to preserve total degree
          // (each internal edge contributes to degrees of both endpoints).
          agg[ci]![ci]! += 2 * w;
        } else {
          agg[ci]![cj]! += w;
          agg[cj]![ci]! += w;
        }
      }
    }
  }

  return agg;
}

/**
 * Map aggregated-level community indices back to original node indices.
 */
function mapBackCommunities(
  subCommunities: number[][],
  originalCommunities: number[][],
): number[][] {
  return subCommunities.map((aggComm) => {
    const members: number[] = [];
    for (const aggIdx of aggComm) {
      for (const node of originalCommunities[aggIdx]!) {
        members.push(node);
      }
    }
    return members;
  });
}

/**
 * Extract a sub-graph containing only the specified nodes and edges between them.
 *
 * @param graph   - Full weighted graph.
 * @param indices - Node indices to include in the sub-graph.
 * @returns New WeightedGraph with local indexing; subGraph[i][j] == graph[indices[i]][indices[j]].
 */
function extractSubGraph(
  graph: WeightedGraph,
  indices: number[],
): WeightedGraph {
  const m = indices.length;
  const subGraph: WeightedGraph = Array.from({ length: m }, () =>
    new Array(m).fill(0),
  );
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const w = graph[indices[i]!]![indices[j]!]!;
      subGraph[i]![j] = w;
      subGraph[j]![i] = w;
    }
  }
  return subGraph;
}

// ---------------------------------------------------------------------------
// Resolution Auto-Tuning
// ---------------------------------------------------------------------------

/** Maximum iterations for resolution parameter search. */
const MAX_TUNING_ITER = 15;

/** Minimum cluster size to consider for recursive sub-splitting. */
const MIN_SUBSPLIT_SIZE = 4;

/** Maximum recursion depth for sub-splitting. */
const MAX_SUBSPLIT_DEPTH = 3;

/**
 * Recursively split large clusters by running Leiden on their sub-graphs.
 *
 * For each cluster with size > MIN_SUBSPLIT_SIZE, extracts its sub-graph,
 * runs Leiden with auto-tuned γ (targeting up to min(5, floor(size/2))),
 * and recursively splits further if sub-communities still have structure.
 *
 * Stop conditions:
 *   - Cluster size ≤ MIN_SUBSPLIT_SIZE
 *   - Sub-graph Leiden returns 1 community (no further structure)
 *   - Max recursion depth reached (MAX_SUBSPLIT_DEPTH)
 *
 * @param graph       - Full original weighted graph.
 * @param communities - Current partition (list of node-index arrays).
 * @param depth       - Current recursion depth (internal).
 * @returns Flat list of leaf-community node-index arrays.
 */
export function recursiveSubSplit(
  graph: WeightedGraph,
  communities: number[][],
  depth: number = 0,
): number[][] {
  if (depth >= MAX_SUBSPLIT_DEPTH) return communities;

  const result: number[][] = [];

  for (const community of communities) {
    if (community.length <= MIN_SUBSPLIT_SIZE) {
      result.push(community);
      continue;
    }

    // Extract sub-graph and run Leiden with independent γ tuning.
    const subGraph = extractSubGraph(graph, community);
    const targetClusters = Math.min(5, Math.floor(community.length / 2));
    const subComms = autoTuneResolution(subGraph, targetClusters);

    if (subComms.length <= 1) {
      // No further structure found — keep as-is.
      result.push(community);
      continue;
    }

    // Map sub-community local indices back to original graph indices.
    const mappedSubComms = subComms.map((subComm) =>
      subComm.map((localIdx) => community[localIdx]!),
    );

    // Recurse into sub-communities.
    const splitResult = recursiveSubSplit(graph, mappedSubComms, depth + 1);
    result.push(...splitResult);
  }

  return result;
}

/**
 * Adjust the resolution parameter γ so that Leiden produces approximately
 * `targetClusters` communities.
 *
 * Uses multiplicative search: higher γ → more communities, lower γ → fewer.
 */
export function autoTuneResolution(
  graph: WeightedGraph,
  maxClusters: number,
): number[][] {
  const n = graph.length;
  if (n <= maxClusters) {
    // Can't have more communities than nodes. Run once with default gamma
    // and let post-processing handle it.
    return leiden(graph, 1.0);
  }

  let gamma = 1.0;
  let communities = leiden(graph, gamma);
  let count = communities.length;

  // If already in range (±30% tolerance with upper cap at maxClusters), accept.
  if (count >= Math.ceil(maxClusters * 0.5) && count <= maxClusters) {
    return communities;
  }

  // Multiplicative search: keep adjusting gamma until we bracket the target.
  let lowGamma = 0.05;
  let highGamma = 50.0;
  let lowCommunities: number[][] | null = null;
  let highCommunities: number[][] | null = null;

  for (let iter = 0; iter < MAX_TUNING_ITER; iter++) {
    // Run Leiden at current gamma
    communities = leiden(graph, gamma);
    count = communities.length;

    logDebug('Clusterer: resolution tuning', {
      iteration: iter,
      gamma: Math.round(gamma * 1000) / 1000,
      communities: count,
      target: maxClusters,
    });

    if (count >= Math.ceil(maxClusters * 0.5) && count <= maxClusters) {
      // In range — accept.
      return communities;
    }

    if (count > maxClusters) {
      // Too many communities → need lower gamma
      highGamma = gamma;
      highCommunities = communities;
      gamma = Math.max(lowGamma, gamma * 0.65);
    } else {
      // Too few communities → need higher gamma
      lowGamma = gamma;
      lowCommunities = communities;
      gamma = Math.min(highGamma, gamma * 1.55);
    }

    // If search range collapsed, exit
    if (highGamma - lowGamma < 0.01) break;
  }

  // Prefer the result with count closest to (but not exceeding) maxClusters.
  // If both exceed, use the one with fewer communities.
  if (lowCommunities && highCommunities) {
    const lowCount = lowCommunities.length;
    const highCount = highCommunities.length;

    if (lowCount <= maxClusters && highCount > maxClusters) {
      return lowCommunities;
    }
    if (lowCount > maxClusters && highCount > maxClusters) {
      return lowCount <= highCount ? lowCommunities : highCommunities;
    }
    // Both <= maxClusters: prefer the one closer to target
    const lowDist = maxClusters - lowCount;
    const highDist = maxClusters - highCount;
    return lowDist <= highDist ? lowCommunities : highCommunities;
  }

  return communities;
}

// ---------------------------------------------------------------------------
// Greedy Merge (fallback when too many communities)
// ---------------------------------------------------------------------------

/**
 * Greedily merge communities until count ≤ maxClusters, by repeatedly
 * merging the pair with the highest average inter-community similarity.
 */
export function greedyMerge(
  graph: WeightedGraph,
  communities: number[][],
  maxClusters: number,
): number[][] {
  if (communities.length <= maxClusters) return communities;

  let current = communities.map((c) => [...c]);

  while (current.length > maxClusters) {
    let bestPair: [number, number] | null = null;
    let bestSim = -Infinity;

    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        let sum = 0;
        let count = 0;
        for (const a of current[i]!) {
          for (const b of current[j]!) {
            sum += graph[a]![b]!;
            count++;
          }
        }
        const avgSim = count > 0 ? sum / count : 0;
        if (avgSim > bestSim) {
          bestSim = avgSim;
          bestPair = [i, j];
        }
      }
    }

    if (!bestPair) break;

    const [a, b] = bestPair;
    current[a] = [...current[a]!, ...current[b]!];
    current.splice(b, 1);
  }

  return current;
}
