/**
 * LLM prompt templates for the spec pipelines — spec self-evolution
 * (cluster evaluation) and spec mining (spec generation from clusters).
 *
 * @module spec/llm/prompts
 */

import { ClusterContext } from '../types';
import { truncateText } from '../utils';

// =============================================================================
// Spec generation prompt + template (mine pipeline)
// =============================================================================

/** Default markdown template for generated spec documents. */
export const DEFAULT_SPEC_TEMPLATE = `# Spec: {{title}}

## Summary
{{summary}}

## Motivation
{{motivation}}

## Specification

### Functional Requirements
{{functional_requirements}}

### Acceptance Criteria (EARS format)
{{acceptance_criteria}}

## Implementation Notes

### Related Commits
{{commit_list}}

### Affected Files
{{file_list}}

### Key Symbols
{{symbol_list}}
`;

/** System prompt for LLM spec generation from a commit cluster. */
export const SPEC_GENERATION_SYSTEM_PROMPT = `You are a technical documentation writer specializing in software design specifications. Given a cluster of related Git commits, generate a design specification in markdown format.

Guidelines:
- Focus on WHAT was built, not HOW it was implemented
- Use EARS (Easy Approach to Requirements Syntax) for acceptance criteria
- Be specific — reference real symbols, files, and commit messages
- Keep the spec concise but complete
- Output ONLY the spec document, no preamble or commentary

Output format — fill in the template exactly. Replace {{placeholders}} with real content. Do NOT include the placeholder braces in your output.`;

// =============================================================================
// Cluster spec evaluation prompt
// =============================================================================

/** Maximum characters for the current spec content in the user prompt
 *  (~16K tokens @ ~0.25 token/char). Exceedingly large spec documents are
 *  truncated to prevent context-window overflow. */
const MAX_SPEC_CONTENT_CHARS = 64000;

export const SPEC_EVALUATION_CLUSTER_SYSTEM_PROMPT = `You are a technical documentation maintainer. Your task is to evaluate whether a GROUP of related git commits requires updating a software design specification.

Given the current content and a summary of multiple commits that affect this spec, determine:
1. Whether the spec needs to be updated (UPDATE), deprecated (DEPRECATE), or left unchanged (UNCHANGED).
2. If UPDATE: provide the new title, subtitles (as an array of heading-preview strings), and full rewritten spec_content that incorporates the changes from all commits.
3. If DEPRECATE: provide a brief explanation in the spec_content field.

Key considerations for batch evaluation:
- Multiple commits may partially overlap in their changes — synthesize the combined impact.
- Some commits may be bug fixes that revert earlier changes — look for the net effect.
- If the combined changes fundamentally alter the spec's scope, prefer DEPRECATE over UPDATE.

Response format (JSON):
{
  "action": "UPDATE" | "DEPRECATE" | "UNCHANGED",
  "title": "New spec title (for UPDATE)",
  "subtitles": ["heading1 → heading2 - preview", ...],
  "spec_content": "Full rewritten markdown content (for UPDATE) or deprecation reason (for DEPRECATE)"
}`;

/**
 * Build the user prompt for cluster-based spec evaluation.
 *
 * Presents:
 * 1. The current spec content.
 * 2. A cluster overview (commit count, primary files).
 * 3. Per-commit summaries (short hash, message, changed files, truncated diff).
 *
 * The prompt is designed to fit within a reasonable token budget for a
 * single LLM call even with 5-10 commits in the cluster.
 *
 * @param specContent    - Full current spec.md content.
 * @param clusterContext - Pre-built cluster context from buildClusterContext.
 * @returns Formatted user prompt string.
 */
export function buildClusterSpecEvaluationUserPrompt(
  specContent: string,
  clusterContext: ClusterContext,
): string {
  const parts: string[] = [];

  // 1. Current spec
  const truncatedSpec = truncateText(specContent, MAX_SPEC_CONTENT_CHARS);
  parts.push('## Current Spec Content');
  parts.push('');
  parts.push(truncatedSpec);
  parts.push('');

  // 2. Cluster overview
  parts.push('## Commit Cluster');
  parts.push('');
  parts.push(`- **Commits**: ${clusterContext.commitCount}`);
  parts.push(
    `- **Primary files**: ${clusterContext.primaryFiles.join(', ') || '(none)'}`,
  );
  parts.push('');

  // 3. Per-commit summaries
  parts.push('## Commit Summaries');
  parts.push('');
  for (const cs of clusterContext.commitSummaries) {
    parts.push(`### ${cs.shortHash} — ${cs.message}`);
    parts.push(`Files: ${cs.changedFiles.join(', ')}`);
    if (cs.truncatedDiff && cs.truncatedDiff.length > 0) {
      parts.push('');
      parts.push('```diff');
      parts.push(cs.truncatedDiff);
      parts.push('```');
    }
    parts.push('');
  }

  return parts.join('\n');
}
