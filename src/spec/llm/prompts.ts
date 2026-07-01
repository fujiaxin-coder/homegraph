/**
 * LLM prompt templates for spec self-evolution.
 *
 * Extracted from logic-checker.ts and spec-rewriter.ts so evolve modules
 * don't contain prompt strings directly.
 *
 * @module spec/llm/prompts
 */

// =============================================================================
// Logic check prompt
// =============================================================================

export const LOGIC_CHECK_SYSTEM_PROMPT = `You are a code review assistant. Your task is to determine whether a git commit represents a business-logic change (as opposed to purely cosmetic, formatting, comment-only, or test-only changes).

A business-logic change includes:
- Changes to algorithms, data structures, or control flow
- Changes to business rules, validation logic, or domain behavior
- Adding or removing functionality
- Bug fixes that change behavior

NOT business-logic changes:
- Whitespace, formatting, or code style changes
- Comment-only changes
- Test-only changes (adding tests without changing production code)
- Configuration changes that don't alter behavior
- Package/dependency version bumps

Respond with a JSON object:
{
  "is_logic_change": true/false,
  "reason": "Brief explanation of why this is or is not a logic change"
}`;

export function buildLogicCheckUserPrompt(
  commitMessage: string,
  truncatedDiff: string,
): string {
  return `Analyze this commit:

Commit Message: ${commitMessage}

Diff:
${truncatedDiff}`;
}

// =============================================================================
// Spec evaluation prompt
// =============================================================================

export const SPEC_EVALUATION_SYSTEM_PROMPT = `You are a technical documentation maintainer. Your task is to evaluate whether a git commit requires updating a software design specification (plan.md).

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

export function buildSpecEvaluationUserPrompt(
  planContent: string,
  commitMessage: string,
  truncatedDiff: string,
  scheduleNextSpecs: string[],
): string {
  const scheduleStr =
    scheduleNextSpecs.length > 0 ? scheduleNextSpecs.join(', ') : 'none';

  return `Current Plan Content:
${planContent}

Commit Message:
${commitMessage}

Code Diff:
${truncatedDiff}

Scheduled specs to be processed next (for context): ${scheduleStr}`;
}
