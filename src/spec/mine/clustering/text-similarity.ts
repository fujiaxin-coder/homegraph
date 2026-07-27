/**
 * Text-similarity utilities for commit clustering — tokenisation, Jaccard /
 * cosine similarity, and a minimal TF-IDF vectorizer. Pure functions with no
 * dependency on the commit/cluster domain.
 *
 * @module spec/mine/clustering/text-similarity
 */

/** Tokenize a string into lowercase words (3+ chars). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Jaccard similarity between two sets of strings. */
export function jaccard(a: string[], b: string[]): number {
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
export function cosineSimilarity(a: number[], b: number[]): number {
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

// ---------------------------------------------------------------------------
// TF-IDF Vectorizer (message-level)
// ---------------------------------------------------------------------------

export class TfidfVectorizer {
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
