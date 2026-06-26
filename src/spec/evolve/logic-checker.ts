import { LLMClient } from './llm-client';
import { truncateText } from '../utils';

export interface LogicCheckResult {
  isLogic: boolean;
  reason: string;
}

/**
 * Determine if a commit represents a business-logic change.
 * Uses LLM to analyze the commit message and diff.
 * If no LLM client is available, returns false.
 */
export async function isLogicChange(
  commitMessage: string,
  commitDiff: string,
  client?: LLMClient,
): Promise<LogicCheckResult> {
  if (!client) {
    return { isLogic: false, reason: 'LLM unavailable' };
  }

  // Truncate diff to 6000 chars for prompt budget
  const truncatedDiff = truncateText(commitDiff, 6000);

  const systemPrompt = `You are a code review assistant. Your task is to determine whether a git commit represents a business-logic change (as opposed to purely cosmetic, formatting, comment-only, or test-only changes).

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

  const userPrompt = `Analyze this commit:

Commit Message: ${commitMessage}

Diff:
${truncatedDiff}`;

  const result = await client.chatJson(systemPrompt, userPrompt);

  return {
    isLogic: result.is_logic_change === true,
    reason: typeof result.reason === 'string' ? result.reason : '',
  };
}
