/**
 * MCP query cache — stores serialized tool responses in homegraph.db.
 *
 * Invalidated wholesale when the index stamp or cache format version changes.
 * Per-call staleness/worktree notices are applied AFTER cache lookup so hits
 * stay fresh.
 */

import { createHash } from 'node:crypto';
import type { QueryBuilder } from '../db/queries';
import type { ToolResult } from './tools';

/** Mirrors `getExploreOutputBudget` tier breakpoints — cache-key only. */
function defaultExploreMaxFiles(fileCount: number): number {
  if (fileCount < 150) return 4;
  if (fileCount < 500) return 5;
  return 8;
}

/** Bump when cache-key normalization or cached payload shape changes. */
export const QUERY_CACHE_FORMAT_VERSION = 1;

const METADATA_INDEX_STAMP = 'query_cache_index_stamp';
const METADATA_FORMAT_VERSION = 'query_cache_format_version';

/** Tools that must stay live — never cached. */
const NON_CACHEABLE_TOOLS = new Set(['homegraph_status', 'homegraph_spec_match']);

export function isMcpQueryCacheEnabled(): boolean {
  const raw = process.env.HOMEGRAPH_MCP_CACHE;
  return raw === '1' || raw === 'true';
}

export function isCacheableMcpTool(toolName: string): boolean {
  return !NON_CACHEABLE_TOOLS.has(toolName);
}

/**
 * Tokenize a natural-language explore query into a stable, order-independent
 * symbol bag for cache keys — different phrasing, same symbols → same key.
 */
export function normalizeExploreQueryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[\s,;:()]+/)
    .flatMap((token) => token.split(/[./\\]/))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return [...new Set(terms)].sort();
}

function exploreEnvFingerprint(): string {
  const linums = process.env.HOMEGRAPH_EXPLORE_LINENUMS === '0' ? '0' : '1';
  const adaptive =
    process.env.HOMEGRAPH_ADAPTIVE_EXPLORE === '0' ||
    process.env.HOMEGRAPH_ADAPTIVE_EXPLORE === 'false'
      ? '0'
      : '1';
  const rankMultiterm = process.env.HOMEGRAPH_RANK_NO_MULTITERM === '1' ? '0' : '1';
  return `linums:${linums}|adaptive:${adaptive}|rankMultiterm:${rankMultiterm}`;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function intParam(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(Math.floor(n)) : fallback;
}

/** Build the pre-hash fingerprint string for a tool + args pair. */
export function buildMcpQueryCacheFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  fileCount?: number,
): string {
  const parts: string[] = [toolName.replace(/^homegraph_/, '')];

  switch (toolName) {
    case 'homegraph_explore': {
      const query = normalizeString(args.query) ?? '';
      parts.push(`terms:${normalizeExploreQueryTerms(query).join(',')}`);
      if (args.maxFiles != null) {
        parts.push(`maxFiles:${intParam(args.maxFiles, 12)}`);
      } else if (fileCount != null) {
        parts.push(`maxFiles:default:${defaultExploreMaxFiles(fileCount)}`);
      } else {
        parts.push('maxFiles:default');
      }
      parts.push(exploreEnvFingerprint());
      break;
    }

    case 'homegraph_search': {
      parts.push(`query:${(normalizeString(args.query) ?? '').toLowerCase()}`);
      if (args.kind != null) {
        const kind = args.kind === 'type' ? 'type_alias' : String(args.kind);
        parts.push(`kind:${kind}`);
      }
      parts.push(`limit:${intParam(args.limit, 10)}`);
      break;
    }

    case 'homegraph_callers':
    case 'homegraph_callees': {
      parts.push(`symbol:${(normalizeString(args.symbol) ?? '').toLowerCase()}`);
      parts.push(`limit:${intParam(args.limit, 20)}`);
      if (args.file != null) parts.push(`file:${normalizeString(args.file) ?? ''}`);
      break;
    }

    case 'homegraph_impact': {
      parts.push(`symbol:${(normalizeString(args.symbol) ?? '').toLowerCase()}`);
      parts.push(`depth:${intParam(args.depth, 2)}`);
      if (args.file != null) parts.push(`file:${normalizeString(args.file) ?? ''}`);
      break;
    }

    case 'homegraph_node': {
      if (args.symbol != null) parts.push(`symbol:${(normalizeString(args.symbol) ?? '').toLowerCase()}`);
      if (args.file != null) parts.push(`file:${normalizeString(args.file) ?? ''}`);
      parts.push(`includeCode:${args.includeCode === true ? '1' : '0'}`);
      if (args.line != null) parts.push(`line:${intParam(args.line, 0)}`);
      if (args.offset != null) parts.push(`offset:${intParam(args.offset, 0)}`);
      if (args.limit != null) parts.push(`limit:${intParam(args.limit, 0)}`);
      parts.push(`symbolsOnly:${args.symbolsOnly === true ? '1' : '0'}`);
      break;
    }

    case 'homegraph_files': {
      if (args.path != null) parts.push(`path:${normalizeString(args.path) ?? ''}`);
      if (args.pattern != null) parts.push(`pattern:${normalizeString(args.pattern) ?? ''}`);
      parts.push(`format:${normalizeString(args.format as string) ?? 'tree'}`);
      parts.push(`includeMetadata:${args.includeMetadata === false ? '0' : '1'}`);
      if (args.maxDepth != null) parts.push(`maxDepth:${intParam(args.maxDepth, 1)}`);
      break;
    }

    default:
      parts.push(`args:${stableJson(args)}`);
      break;
  }

  return parts.join('|');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

export function buildMcpQueryCacheKey(
  toolName: string,
  args: Record<string, unknown>,
  fileCount?: number,
): string {
  const fingerprint = buildMcpQueryCacheFingerprint(toolName, args, fileCount);
  return createHash('sha256').update(fingerprint, 'utf8').digest('hex');
}

export function ensureMcpQueryCacheValid(
  queries: QueryBuilder,
  getIndexStamp: () => number | null,
): void {
  const currentStamp = String(getIndexStamp() ?? 0);
  const storedStamp = queries.getMetadata(METADATA_INDEX_STAMP);
  const storedFormat = queries.getMetadata(METADATA_FORMAT_VERSION);
  const currentFormat = String(QUERY_CACHE_FORMAT_VERSION);

  if (storedStamp === currentStamp && storedFormat === currentFormat) {
    return;
  }

  queries.clearMcpQueryCache();
  queries.setMetadata(METADATA_INDEX_STAMP, currentStamp);
  queries.setMetadata(METADATA_FORMAT_VERSION, currentFormat);
}

export function getMcpQueryCacheEntry(
  queries: QueryBuilder,
  cacheKey: string,
): ToolResult | null {
  const row = queries.getMcpQueryCache(cacheKey);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.response) as ToolResult;
    if (!parsed || !Array.isArray(parsed.content)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setMcpQueryCacheEntry(
  queries: QueryBuilder,
  cacheKey: string,
  toolName: string,
  result: ToolResult,
): void {
  const shortTool = toolName.replace(/^homegraph_/, '');
  queries.setMcpQueryCache(cacheKey, shortTool, JSON.stringify(result), Date.now());
}
