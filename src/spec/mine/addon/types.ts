/**
 * Spec-mine addon contract (api 1).
 *
 * The public surface an addon author implements. HomeGraph knows NO ticket
 * format: it passes every commit it already has (hash, message, author,
 * timestamp) at cluster granularity, and the addon decides how to map them
 * to detailed requirement context. Parsing, fetching, and efficiency are
 * the addon's job; dedup, budgeting, and assembly are HomeGraph's.
 *
 * @module spec/mine/addon/types
 */

/** One commit as seen by the mine pipeline (data HomeGraph already holds). */
export interface AddonCommitInput {
  commitHash: string;
  /** Full commit message (may span multiple lines — subject + body). */
  commitMessage: string;
  author: string;
  timestamp: number;
}

/** Per-cluster input to `enrich` — one call per cluster, mirroring the per-cluster LLM call. */
export interface EnrichInput {
  clusterId: number;
  /** Every commit in the cluster, unfiltered. */
  commits: AddonCommitInput[];
}

/**
 * Detailed requirement context for a commit. `key` is an opaque dedupe id
 * (usually a ticket key) — HomeGraph only groups by it, never parses it.
 * Without `key`, exact-text dedup is used.
 */
export interface Supplement {
  key?: string;
  /** User-assembled requirement description (title/URL/body all fine). */
  text: string;
  /** Optional — surfaced in the rendered section for traceability. */
  commitHash?: string;
}

/** Context passed to an addon that takes over prompt assembly (`buildPrompt`). */
export interface BuildPromptContext {
  cluster: {
    id: number;
    commits: AddonCommitInput[];
    primaryFiles: string[];
    primarySymbols: string[];
  };
  /** Already deduplicated by HomeGraph. */
  supplements: Supplement[];
  /** The output template (default or user `--template`). */
  template: string;
  /**
   * Soft contract — the addon is expected to honor these. HomeGraph does not
   * truncate `buildPrompt` output beyond a last-resort length guard.
   */
  limits: { maxContextChars: number; maxSupplementChars: number };
}

/**
 * The addon interface. Implement at least one hook:
 * - `enrich` — the default path: data in, supplements out, assembly by HomeGraph.
 * - `buildPrompt` — optional escape hatch: takes over the whole prompt.
 */
export interface SpecMineAddon {
  name: string;
  version: string;
  enrich?(input: EnrichInput): Promise<Supplement[]>;
  buildPrompt?(ctx: BuildPromptContext): Promise<string>;
}
