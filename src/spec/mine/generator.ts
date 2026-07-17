/**
 * Reverse Spec Generator — LLM-driven spec document generation from clusters.
 *
 * For each commit cluster, builds a prompt with AST-level change data and
 * calls the LLM (via the existing `OpenAiLlmClient`) to produce a structured
 * markdown specification. Supports custom templates via `{{placeholder}}`
 * syntax.
 *
 * @module spec/mine/generator
 */

import * as fs from 'fs';
import * as path from 'path';
import { CommitCluster } from './clusterer';
import { LLMConfig } from '../config';
import { OpenAiLlmClient } from '../llm/client';
import { writeFileContent } from '../utils';
import { logDebug, logWarn } from '../../errors';
import type { MineProgressCallback } from './progress';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single generated spec document. */
export interface GeneratedSpec {
  specId: string;
  title: string;
  content: string;
  clusterId: number;
  commitHashes: string[];
}

/** Result of the LLM generation phase. */
export interface GenerationResult {
  specs: GeneratedSpec[];
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Default Template
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATE = `# Spec: {{title}}

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

// ---------------------------------------------------------------------------
// Default System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a technical documentation writer specializing in software design specifications. Given a cluster of related Git commits, generate a design specification in markdown format.

Guidelines:
- Focus on WHAT was built, not HOW it was implemented
- Use EARS (Easy Approach to Requirements Syntax) for acceptance criteria
- Be specific — reference real symbols, files, and commit messages
- Keep the spec concise but complete
- Output ONLY the spec document, no preamble or commentary

Output format — fill in the template exactly. Replace {{placeholders}} with real content. Do NOT include the placeholder braces in your output.`;

// ---------------------------------------------------------------------------
// Prompt Building
// ---------------------------------------------------------------------------

/** Maximum characters for the cluster context summary (~12K tokens @ ~0.25 token/char). */
const MAX_CONTEXT_CHARS = 48000;
/** Maximum characters per commit symbol list (~1.5K tokens @ ~0.25 token/char). */
const MAX_SYMBOL_CHARS = 6000;

/**
 * Build the user prompt with commit-level context from a cluster.
 */
function buildClusterPrompt(cluster: CommitCluster, template: string): string {
  const parts: string[] = [];

  parts.push('## Cluster Context');
  parts.push('');
  parts.push(`- ${cluster.commits.length} commits`);
  parts.push(`- Primary files: ${cluster.primaryFiles.join(', ') || '(none)'}`);
  parts.push(`- Primary symbols: ${cluster.primarySymbols.join(', ') || '(none)'}`);
  parts.push('');

  let totalChars = parts.join('\n').length;

  for (const change of cluster.commits) {
    const header = `### ${change.commitHash.slice(0, 7)} — ${change.commitMessage}`;
    if (totalChars + header.length > MAX_CONTEXT_CHARS) break;

    const lines: string[] = [header, ''];

    for (const fc of change.fileChanges) {
      const fileHeader = `**${fc.filePath}** (${fc.language})${fc.isNewFile ? ' [new file]' : ''}`;
      const symbolLines: string[] = [];

      // Format one symbol with kind tag, signature, and visibility.
      // `extra` is an optional suffix appended after the visibility.
      const fmtSym = (
        marker: string,
        sym: { kind: string; name: string; signature?: string; visibility?: string },
        extra?: string,
      ): string => {
        const tag = `[${sym.kind}]`;
        const sig = sym.signature ? ` ${sym.signature}` : '';
        const vis = sym.visibility && sym.visibility !== 'public'
          ? ` (${sym.visibility})` : '';
        const ext = extra ? ` ${extra}` : '';
        return `${marker} ${tag} ${sym.name}${sig}${vis}${ext}`;
      };

      for (const s of fc.addedSymbols) {
        symbolLines.push(fmtSym('+', s));
      }
      for (const s of fc.removedSymbols) {
        symbolLines.push(fmtSym('-', s));
      }
      for (const m of fc.modifiedSymbols) {
        const changes: string[] = [];
        if (m.old.signature !== m.new.signature) changes.push('sig');
        if (m.old.name !== m.new.name) changes.push('name');
        if (m.old.visibility !== m.new.visibility) changes.push('vis');
        const extra = changes.length > 0
          ? `(changed: ${changes.join(', ')})`
          : '(changed)';
        symbolLines.push(fmtSym('~', m.new, extra));
      }

      if (symbolLines.length === 0) continue;

      const symbolStr = symbolLines.join('\n');
      const truncated = symbolStr.length > MAX_SYMBOL_CHARS
        ? symbolStr.slice(0, MAX_SYMBOL_CHARS) + '\n…'
        : symbolStr;

      const block = `${fileHeader}\n${truncated}`;
      if (totalChars + block.length > MAX_CONTEXT_CHARS) break;
      lines.push(block);
    }

    const commitBlock = lines.join('\n');
    if (totalChars + commitBlock.length > MAX_CONTEXT_CHARS) break;
    parts.push(commitBlock);
    parts.push('');
    totalChars += commitBlock.length + 1;
  }

  const context = parts.join('\n');

  // Build the full prompt: cluster context + template
  const prompt = [
    'Use the following commit cluster context to fill in the template below.',
    '',
    context,
    '',
    '---',
    '',
    'Fill in this template:',
    '',
    template,
  ].join('\n');

  return prompt;
}

// ---------------------------------------------------------------------------
// Spec Generation
// ---------------------------------------------------------------------------

/**
 * Extract title from LLM-generated markdown (first `# ` heading).
 */
function extractTitle(content: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match ? match[1]!.trim() : 'Untitled Spec';
}

/**
 * Generate spec documents for a list of commit clusters.
 *
 * @param clusters - Clusters to generate specs for.
 * @param llmConfig - LLM configuration (apiKey, model, etc.).
 * @param outputDir - Directory to write generated spec files.
 * @param templateContent - Optional custom template string.
 * @param onProgress - Optional progress callback (called per cluster).
 * @returns Generation result with generated specs and stats.
 */
export async function generateSpecs(
  clusters: CommitCluster[],
  llmConfig: LLMConfig,
  outputDir: string,
  templateContent?: string,
  onProgress?: MineProgressCallback,
): Promise<GenerationResult> {
  const client = new OpenAiLlmClient(llmConfig);

  // Use custom template if provided, otherwise use default
  const effectiveTemplate = templateContent || DEFAULT_TEMPLATE;

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const specs: GeneratedSpec[] = [];
  let skipped = 0;
  let errors = 0;
  const total = clusters.length;

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci]!;
    const specId = `spec_${cluster.timeRange.end}`;
    const msg = `${specId} (${cluster.commits.length} commits)`;
    onProgress?.({
      phase: 'generating',
      current: ci + 1,
      total,
      message: msg,
    });
    logDebug('Generating spec for cluster', {
      specId,
      commitCount: cluster.commits.length,
    });

    const userPrompt = buildClusterPrompt(cluster, effectiveTemplate);

    let raw: string;
    try {
      raw = await client.chat(SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      logWarn(`LLM call failed for ${specId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
      continue;
    }

    if (!raw || raw.trim().length === 0) {
      logWarn(`LLM returned empty response for ${specId}`);
      skipped++;
      continue;
    }

    const title = extractTitle(raw);
    const commitHashes = cluster.commits.map((c) => c.commitHash);

    const spec: GeneratedSpec = {
      specId,
      title,
      content: raw,
      clusterId: cluster.id,
      commitHashes,
    };

    // Write to output directory
    const fileName = `${specId}.md`;
    const outputPath = path.join(outputDir, fileName);
    try {
      writeFileContent(outputPath, raw);
      logDebug('Wrote spec file', { path: outputPath });
      specs.push(spec);
    } catch (err) {
      logWarn(`Failed to write spec file ${outputPath}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
    }
  }

  return { specs, skipped, errors };
}
