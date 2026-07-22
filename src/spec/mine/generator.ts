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
import { CommitCluster } from './clustering';
import { LlmClient } from '../llm/client';
import { DEFAULT_SPEC_TEMPLATE, SPEC_GENERATION_SYSTEM_PROMPT } from '../llm/prompts';
import { extractTitleFromMarkdown } from '../build/spec-extractor';
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
// Markdown Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the markdown spec document from a chat() response.
 *
 * Headless coding agents (and occasionally chat models) wrap the document
 * in prose ("Here is the spec:") or a ```markdown fence — writing that
 * verbatim would pollute the spec file. Since the spec template always
 * starts with a heading, the extraction is:
 * 1. If a fenced block contains a markdown heading, use its content.
 * 2. Else strip any prose before the first heading line.
 * 3. Otherwise return the response trimmed.
 *
 * Provider-agnostic: applies identically to coding-agent and OpenAI paths.
 */
export function extractMarkdown(raw: string): string {
  const text = raw.trim();
  if (!text) return '';

  // Fast path: already a clean markdown document. Also guards against
  // misfiring on code fences INSIDE a document (e.g. a bash comment like
  // "# do something" would otherwise look like a wrapped document).
  if (/^#\s/.test(text)) return text;

  // 1. Whole-document fence wrapper containing a heading
  const fenceMatch = /```(?:markdown|md)?\s*\n([\s\S]*?)```/.exec(text);
  if (fenceMatch && /^#\s/m.test(fenceMatch[1]!)) {
    return fenceMatch[1]!.trim();
  }

  // 2. Prose preamble before the first heading
  const headingMatch = /^#\s.*$/m.exec(text);
  if (headingMatch) {
    return text.slice(headingMatch.index).trim();
  }

  return text;
}

// ---------------------------------------------------------------------------
// Spec Generation
// ---------------------------------------------------------------------------

/**
 * Generate spec documents for a list of commit clusters.
 *
 * @param clusters - Clusters to generate specs for.
 * @param client - Resolved LLM client (coding agent, configured LLM, or
 *   a fallback composite — resolution happens in `llm/factory`).
 * @param outputDir - Directory to write generated spec files.
 * @param templateContent - Optional custom template string.
 * @param onProgress - Optional progress callback (called per cluster).
 * @returns Generation result with generated specs and stats.
 */
export async function generateSpecs(
  clusters: CommitCluster[],
  client: LlmClient,
  outputDir: string,
  templateContent?: string,
  onProgress?: MineProgressCallback,
): Promise<GenerationResult> {
  // Use custom template if provided, otherwise use default
  const effectiveTemplate = templateContent || DEFAULT_SPEC_TEMPLATE;

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
      raw = await client.chat(SPEC_GENERATION_SYSTEM_PROMPT, userPrompt);
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

    // Unwrap fences / strip prose preamble before persisting
    const content = extractMarkdown(raw);
    if (!content) {
      logWarn(`LLM response had no extractable markdown for ${specId}`);
      skipped++;
      continue;
    }

    const title = extractTitleFromMarkdown(content, 'Untitled Spec');
    const commitHashes = cluster.commits.map((c) => c.commitHash);

    const spec: GeneratedSpec = {
      specId,
      title,
      content,
      clusterId: cluster.id,
      commitHashes,
    };

    // Write to output directory
    const fileName = `${specId}.md`;
    const outputPath = path.join(outputDir, fileName);
    try {
      writeFileContent(outputPath, content);
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
