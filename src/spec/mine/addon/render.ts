/**
 * Supplement section rendering for cluster prompts.
 *
 * Rendered BEFORE `## Cluster Context` and counted into the same total
 * character budget. Each entry is hard-truncated; when the section exceeds
 * the remaining budget, later entries are dropped first.
 *
 * @module spec/mine/addon/render
 */

import { truncateText } from '../../utils/truncate';
import { Supplement } from './types';

/**
 * Render the `## Supplement` section.
 *
 * @param supplements - Deduplicated supplements (registry order).
 * @param maxPerEntryChars - Hard cap per entry text.
 * @param maxTotalChars - Hard cap for the whole section.
 * @returns The rendered section, or `''` when nothing fit / nothing to render.
 */
export function renderSupplementSection(
  supplements: Supplement[],
  maxPerEntryChars: number,
  maxTotalChars: number,
): string {
  if (supplements.length === 0) return '';

  const lines: string[] = ['## Supplement', ''];
  let used = lines.join('\n').length;

  for (const supplement of supplements) {
    const text = truncateText(supplement.text, maxPerEntryChars);
    const key = supplement.key !== undefined ? `**[${supplement.key}]** ` : '';
    const source = supplement.commitHash
      ? ` (commit ${supplement.commitHash.slice(0, 7)})`
      : '';
    const line = `- ${key}${text}${source}`;
    if (used + line.length + 1 > maxTotalChars) break; // drop later entries first
    lines.push(line);
    used += line.length + 1;
  }

  return lines.length > 2 ? lines.join('\n') : '';
}
