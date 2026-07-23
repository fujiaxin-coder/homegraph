/**
 * Spec truncation utilities and prompt-budget profiles — newline-aware text
 * truncation, unified-diff truncation, subtitles capping, and the scale-based
 * budget tiers used when serialising spec contexts for LLM/CLI output.
 *
 * @module spec/utils/truncate
 */

// =============================================================================
// Interfaces
// =============================================================================

export interface BudgetProfile {
  tier: 'tiny' | 'small' | 'medium' | 'large' | 'vlarge';
  maxFragments: number;
  maxContents: number;
  contentBudget: number;
}

// =============================================================================
// Constants
// =============================================================================

const TRUNCATION_SUFFIX = '  …(truncated)';
const TRUNCATION_SUFFIX_LENGTH = TRUNCATION_SUFFIX.length;

// =============================================================================
// Truncation utilities
// =============================================================================

/**
 * Truncate a unified diff at a sensible boundary.
 *
 * The algorithm prefers semantic boundaries to keep diffs readable:
 *
 * 1. If the diff is shorter than `maxChars` (default 3800), return it unchanged.
 * 2. Try: find the **last** `@@` hunk header in the trailing 50% portion of
 *    the diff and cut right before it.
 * 3. Fallback: find the **last** newline in the trailing 80% portion and cut
 *    after it.
 * 4. Hard fallback: cut exactly at `maxChars`.
 *
 * Always appends `"  …(truncated)"` when truncation occurs.
 *
 * @param diff    - The unified diff text to truncate.
 * @param maxChars - Maximum allowed characters (including suffix). Default 3800.
 * @returns The (possibly truncated) diff text.
 */
export function truncateCodeDiff(diff: string, maxChars: number = 3800): string {
  if (diff.length <= maxChars) {
    return diff;
  }

  const suffix = TRUNCATION_SUFFIX;
  const effectiveMax = maxChars - TRUNCATION_SUFFIX_LENGTH;
  if (effectiveMax <= 0) {
    return diff.slice(0, Math.max(0, maxChars - 1)) + suffix;
  }

  // Step 2: find last "@@" hunk header in trailing 50%
  const halfPoint = Math.floor(diff.length * 0.5);
  // We search for "\n@@" or "@@" at the very start.  Use a regex that
  // matches a line starting with "@@" (after optional leading whitespace in
  // some edge cases, but standard diffs have "@@" at column 0).
  const hunkHeaderRe = /(^|\n)@@/g;
  let lastHunkHeaderPos = -1;
  let match: RegExpExecArray | null;

  // Reset lastIndex and scan from the beginning; we only accept matches whose
  // index is >= halfPoint.
  hunkHeaderRe.lastIndex = 0;
  while ((match = hunkHeaderRe.exec(diff)) !== null) {
    const cap = match[1]; // the newline-or-start anchor
    const pos = match.index + (cap ? cap.length : 0); // position of "@@"
    if (pos >= halfPoint && pos <= effectiveMax) {
      lastHunkHeaderPos = pos;
    }
  }

  if (lastHunkHeaderPos > 0) {
    return diff.slice(0, lastHunkHeaderPos) + suffix;
  }

  // Step 3: find last "\n" in trailing 80%
  const eightyPoint = Math.floor(diff.length * 0.2);
  for (let i = effectiveMax - 1; i >= eightyPoint; i--) {
    if (diff[i] === '\n' && i < effectiveMax) {
      return diff.slice(0, i + 1) + suffix;
    }
  }

  // Step 4: hard cut
  return diff.slice(0, effectiveMax) + suffix;
}

/**
 * Truncate plain text with newline-awareness.
 *
 * When the text is longer than `maxChars`, it is cut at the last newline
 * found before `maxChars` (minus the suffix length). If no suitable newline
 * exists, a hard cut is made.
 *
 * The suffix `"  …(truncated)"` is appended only when truncation occurs.
 *
 * @param text     - The text to truncate.
 * @param maxChars - Maximum allowed characters (including suffix).
 * @returns The (possibly truncated) text.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const suffix = TRUNCATION_SUFFIX;
  const effectiveMax = maxChars - TRUNCATION_SUFFIX_LENGTH;
  if (effectiveMax <= 0) {
    return text.slice(0, Math.max(0, maxChars - 1)) + suffix;
  }

  // Try to find the last newline within the budget
  for (let i = effectiveMax - 1; i >= 0; i--) {
    if (text[i] === '\n') {
      return text.slice(0, i) + suffix;
    }
  }

  // Hard cut
  return text.slice(0, effectiveMax) + suffix;
}

/**
 * Truncate a subtitles array.
 *
 * 1. If the array has more than `maxEntries`, it is sliced to `maxEntries`.
 * 2. Each remaining entry that exceeds `maxChars` is individually truncated
 *    via `truncateText`.
 *
 * Entries that already fit within both limits are left unchanged.
 *
 * @param subtitles  - Array of subtitle strings.
 * @param maxChars   - Maximum characters per entry (including suffix).
 * @param maxEntries - Maximum number of entries to keep.
 * @returns The truncated subtitles array (always a new array).
 */
export function truncateSubtitles(
  subtitles: string[],
  maxChars: number,
  maxEntries: number,
): string[] {
  // Cap entry count
  const capped = subtitles.length > maxEntries ? subtitles.slice(0, maxEntries) : [...subtitles];

  // Truncate each entry
  return capped.map((entry) => truncateText(entry, maxChars));
}

// =============================================================================
// Budget profile
// =============================================================================

/**
 * Compute a budget profile based on spec and optional fragment counts.
 *
 * The profile determines how many fragments, contents, and characters the
 * pipeline should budget when building LLM prompts. Higher counts produce
 * tighter budgets to keep prompts manageable.
 *
 * Thresholds (matching `truncate.py:38-57`):
 *
 * | specCount | tier    | maxFragments | maxContents | contentBudget |
 * |-----------|---------|--------------|-------------|---------------|
 * | ≤ 3       | tiny    | 12           | 16          | 48000         |
 * | ≤ 8       | small   | 10           | 14          | 40000         |
 * | ≤ 15      | medium  | 8            | 12          | 32000         |
 * | ≤ 30      | large   | 6            | 10          | 24000         |
 * | > 30      | vlarge  | 0            | 0           | 16000         |
 *
 * The `vlarge` tier disables fragment/contents inclusion entirely (0 values).
 *
 * @param specCount     - Number of specs in the knowledge graph.
 * @param fragmentCount - (Unused) reserved for future per-fragment weighting.
 * @returns The budget profile for the given scale.
 */
export function computeBudgetProfile(
  specCount: number,
  _fragmentCount?: number,
): BudgetProfile {
  if (specCount <= 3) {
    return { tier: 'tiny', maxFragments: 12, maxContents: 16, contentBudget: 48000 };
  }
  if (specCount <= 8) {
    return { tier: 'small', maxFragments: 10, maxContents: 14, contentBudget: 40000 };
  }
  if (specCount <= 15) {
    return { tier: 'medium', maxFragments: 8, maxContents: 12, contentBudget: 32000 };
  }
  if (specCount <= 30) {
    return { tier: 'large', maxFragments: 6, maxContents: 10, contentBudget: 24000 };
  }
  return { tier: 'vlarge', maxFragments: 0, maxContents: 0, contentBudget: 16000 };
}
