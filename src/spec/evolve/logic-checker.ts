import { LlmClient } from '../llm/client';
import { LOGIC_CHECK_SYSTEM_PROMPT, buildLogicCheckUserPrompt } from '../llm/prompts';
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
  client?: LlmClient,
): Promise<LogicCheckResult> {
  if (!client) {
    return { isLogic: false, reason: 'LLM unavailable' };
  }

  // Truncate diff to 6000 chars for prompt budget
  const truncatedDiff = truncateText(commitDiff, 6000);

  const userPrompt = buildLogicCheckUserPrompt(commitMessage, truncatedDiff);

  const result = await client.chatJson(LOGIC_CHECK_SYSTEM_PROMPT, userPrompt);

  return {
    isLogic: result.is_logic_change === true,
    reason: typeof result.reason === 'string' ? result.reason : '',
  };
}
