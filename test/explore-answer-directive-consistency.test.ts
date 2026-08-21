import { describe, expect, it } from 'vitest';
import {
  hasPositiveAnswerNowDirective,
  reconcilePartialAnswerNow,
} from '../src/mcp/tools';

describe('Partial locator / ANSWER NOW consistency', () => {
  it('removes D38-style embedded positive close and its search prohibition', () => {
    const input = [
      '> **Partial locator** — definition anchors below, no call/use trail in the graph.',
      '> These lines are the in-repo call/filter sites. **ANSWER NOW** from them + Source — do not Grep the same member.',
      '> **Compact local explore complete — ANSWER NOW.** Do **not** Read/Grep/`homegraph_search`/`homegraph_explore`/`homegraph_node` for the same symbols.',
    ].join('\n');

    const out = reconcilePartialAnswerNow(input);

    expect(out).toMatch(/Partial locator/i);
    expect(hasPositiveAnswerNowDirective(out)).toBe(false);
    expect(out).not.toMatch(/Do \*\*not\*\* Read\/Grep/);
    expect(out).toMatch(/anchors, not a closed answer/i);
  });

  it('preserves negative and postponed ANSWER NOW cautions', () => {
    const input = [
      '> **Partial locator** — handler files are anchors.',
      '> Do **not** ANSWER NOW as a full map.',
      '> Confirm the missing call sites before ANSWER NOW.',
    ].join('\n');

    expect(reconcilePartialAnswerNow(input)).toBe(input);
    expect(hasPositiveAnswerNowDirective(input)).toBe(false);
  });

  it('removes a positive directive even when another line has a negative mention', () => {
    const input = [
      '> **Partial locator** — handler files are anchors.',
      '> Do **not** ANSWER NOW as a full map.',
      '> **ANSWER NOW** from the incomplete inventory; do not Grep it again.',
    ].join('\n');

    const out = reconcilePartialAnswerNow(input);
    expect(out).toContain('Do **not** ANSWER NOW as a full map.');
    expect(hasPositiveAnswerNowDirective(out)).toBe(false);
  });

  it('does not change a complete output without Partial locator', () => {
    const input = '> **Compact local explore complete — ANSWER NOW.** Do not Grep again.';
    expect(reconcilePartialAnswerNow(input)).toBe(input);
    expect(hasPositiveAnswerNowDirective(input)).toBe(true);
  });
});
