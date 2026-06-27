/**
 * Spec configuration module — replaces `commit4spec/utils/config.py`.
 *
 * Loads spec mining/evolve configuration from `${SPEC_DATA_DIR}/config/spec.json`
 * within a repository, falling back to code defaults for every key. All failure
 * modes degrade gracefully: a missing file, bad JSON, or a malformed value
 * never throws — the caller always receives a complete, usable config.
 *
 * The config file is JSON, e.g.:
 *
 *   {
 *     "discovery": {
 *       "primaryDocCandidates": ["plan.md", "README.md"]
 *     },
 *     "commitScope": {
 *       "scopeRegex": "^(feat|fix)\\((.+)\\)"
 *     },
 *     "llm": {
 *       "provider": "openai",
 *       "apiKeyEnv": "OPENAI_API_KEY",
 *       "model": "gpt-4o"
 *     }
 *   }
 *
 * When `apiKeyEnv` is set in `llm`, the actual key is read from that
 * environment variable at load time (process.env lookup).
 */
import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../errors';
import { SPEC_DATA_DIR } from './utils';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SpecDiscoveryConfig {
  primaryDocCandidates: string[];
  supplementaryGlobs: string[];
  commitInfoCandidates: string[];
}

export interface CommitScopeConfig {
  scopeRegex: string;
  normalize: {
    stripPrefixes: string[];
    lowercase: boolean;
    padSpecNumber: boolean;
  };
}

export interface LLMConfig {
  provider: 'openai' | 'anthropic' | 'mock';
  apiKey: string;
  apiKeyEnv?: string;
  model: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
}

export interface SpecConfig {
  discovery: SpecDiscoveryConfig;
  commitScope: CommitScopeConfig;
  llm: LLMConfig;
}

// ---------------------------------------------------------------------------
// Defaults (match commit4spec/utils/config.py exactly)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: SpecConfig = Object.freeze({
  discovery: Object.freeze({
    primaryDocCandidates: Object.freeze([
      'plan.md',
      'README.md',
      'spec.md',
      'design.md',
      '{spec_dir}.md',
      'spec-{spec_dir}.md',
    ]),
    supplementaryGlobs: Object.freeze(['logic/**/*.md', 'design/**/*.md']),
    commitInfoCandidates: Object.freeze(['commit-info.md']),
  }),
  commitScope: Object.freeze({
    scopeRegex:
      '^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\\((?:review\\/)?(spec\\d+)\\)',
    normalize: Object.freeze({
      stripPrefixes: Object.freeze(['review/']),
      lowercase: true,
      padSpecNumber: true,
    }),
  }),
  llm: Object.freeze({
    provider: 'mock' as const,
    apiKey: '',
    model: 'gpt-4o',
    temperature: 0.2,
    maxTokens: 4096,
  }),
}) as SpecConfig;

/** Config subdirectory relative to the repo root. */
const CONFIG_DIR = `${SPEC_DATA_DIR}/config`;
const CONFIG_FILENAME = 'spec.json';

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/**
 * Recursively merge `source` into `target`, returning a new object. Arrays and
 * primitives from `source` replace `target` wholesale (no array concatenation).
 * Only plain objects are recursed into.
 */
function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) return target;
  if (typeof source !== 'object' || Array.isArray(source)) return source;

  const out: Record<string, any> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, any>) }
      : {};

  for (const [key, val] of Object.entries(source)) {
    if (val === undefined) continue;
    out[key] = deepMerge(out[key], val);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Load spec config from `${SPEC_DATA_DIR}/config/spec.json` in the given repo path.
 *
 * - Missing file → defaults (no warning; it's the zero-config case).
 * - Unparseable JSON → defaults with a warning.
 * - Top-level value that is not an object → defaults with a warning.
 * - Individual sub-objects that are not plain objects → warn-and-skip that
 *   section (the rest of the config still merges).
 *
 * After merging user values over defaults, if `llm.apiKeyEnv` is set the
 * function resolves `llm.apiKey` from `process.env[apiKeyEnv]`. An unset env
 * var leaves `apiKey` as whatever the file provided (or the default `""`).
 */
export function loadSpecConfig(repoPath: string): SpecConfig {
  const file = path.join(repoPath, CONFIG_DIR, CONFIG_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    // No config file — zero-config default, no warning.
    return cloneDefaults();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(`Ignoring ${CONFIG_DIR}/${CONFIG_FILENAME}: not valid JSON`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return cloneDefaults();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logWarn(
      `Ignoring ${CONFIG_DIR}/${CONFIG_FILENAME}: top-level value must be a JSON object`,
      { file },
    );
    return cloneDefaults();
  }

  // Deep merge user config over defaults
  const merged = deepMerge(DEFAULT_CONFIG, parsed) as SpecConfig;

  // Normalize sub-objects that fail the type guard (e.g. user set "discovery": "nope")
  merged.discovery = normalizeDiscovery(merged.discovery, file);
  merged.commitScope = normalizeCommitScope(merged.commitScope, file);
  merged.llm = normalizeLLM(merged.llm, file);

  // Resolve apiKey from env if apiKeyEnv is set
  if (merged.llm.apiKeyEnv) {
    const envKey = process.env[merged.llm.apiKeyEnv];
    if (envKey !== undefined) {
      merged.llm.apiKey = envKey;
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Normalizers — ensure sub-configs are well-formed after merge
// ---------------------------------------------------------------------------

function normalizeDiscovery(
  val: any,
  file: string,
): SpecDiscoveryConfig {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    logWarn(
      `Ignoring "discovery" in ${CONFIG_DIR}/${CONFIG_FILENAME}: must be an object`,
      { file },
    );
    return { ...DEFAULT_CONFIG.discovery };
  }

  const def = DEFAULT_CONFIG.discovery;
  return {
    primaryDocCandidates: normalizeStringArray(
      val.primaryDocCandidates,
      def.primaryDocCandidates,
      'discovery.primaryDocCandidates',
      file,
    ),
    supplementaryGlobs: normalizeStringArray(
      val.supplementaryGlobs,
      def.supplementaryGlobs,
      'discovery.supplementaryGlobs',
      file,
    ),
    commitInfoCandidates: normalizeStringArray(
      val.commitInfoCandidates,
      def.commitInfoCandidates,
      'discovery.commitInfoCandidates',
      file,
    ),
  };
}

function normalizeCommitScope(
  val: any,
  file: string,
): CommitScopeConfig {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    logWarn(
      `Ignoring "commitScope" in ${CONFIG_DIR}/${CONFIG_FILENAME}: must be an object`,
      { file },
    );
    return { ...DEFAULT_CONFIG.commitScope, normalize: { ...DEFAULT_CONFIG.commitScope.normalize } };
  }

  const def = DEFAULT_CONFIG.commitScope;
  const normalizeRaw: any =
    val.normalize && typeof val.normalize === 'object' && !Array.isArray(val.normalize)
      ? val.normalize
      : {};

  return {
    scopeRegex:
      typeof val.scopeRegex === 'string' && val.scopeRegex.length > 0
        ? val.scopeRegex
        : def.scopeRegex,
    normalize: {
      stripPrefixes: normalizeStringArray(
        normalizeRaw.stripPrefixes,
        def.normalize.stripPrefixes,
        'commitScope.normalize.stripPrefixes',
        file,
      ),
      lowercase:
        typeof normalizeRaw.lowercase === 'boolean'
          ? normalizeRaw.lowercase
          : def.normalize.lowercase,
      padSpecNumber:
        typeof normalizeRaw.padSpecNumber === 'boolean'
          ? normalizeRaw.padSpecNumber
          : def.normalize.padSpecNumber,
    },
  };
}

function normalizeLLM(val: any, file: string): LLMConfig {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    logWarn(
      `Ignoring "llm" in ${CONFIG_DIR}/${CONFIG_FILENAME}: must be an object`,
      { file },
    );
    return { ...DEFAULT_CONFIG.llm };
  }

  const def = DEFAULT_CONFIG.llm;

  const provider = val.provider;
  const validProvider =
    provider === 'openai' || provider === 'anthropic' || provider === 'mock'
      ? (provider as LLMConfig['provider'])
      : def.provider;

  return {
    provider: validProvider,
    apiKey: typeof val.apiKey === 'string' ? val.apiKey : def.apiKey,
    apiKeyEnv: typeof val.apiKeyEnv === 'string' ? val.apiKeyEnv : undefined,
    model: typeof val.model === 'string' && val.model.length > 0 ? val.model : def.model,
    baseUrl: typeof val.baseUrl === 'string' ? val.baseUrl : undefined,
    temperature:
      typeof val.temperature === 'number' && !isNaN(val.temperature)
        ? val.temperature
        : def.temperature,
    maxTokens:
      typeof val.maxTokens === 'number' && Number.isInteger(val.maxTokens) && val.maxTokens > 0
        ? val.maxTokens
        : def.maxTokens,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a user-provided array of strings, falling back to `defaultVal` when
 * the input is not an array. Individual non-string entries are filtered out
 * with a warning.
 */
function normalizeStringArray(
  raw: unknown,
  defaultVal: readonly string[],
  label: string,
  file: string,
): string[] {
  if (!Array.isArray(raw)) return [...defaultVal];

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push(entry);
    } else {
      logWarn(
        `Ignoring "${label}" entry in ${CONFIG_DIR}/${CONFIG_FILENAME}: each value must be a non-empty string`,
        { file, entry: String(entry) },
      );
    }
  }
  return out.length > 0 ? out : [...defaultVal];
}

/**
 * Return a shallow clone of DEFAULT_CONFIG so callers receive a mutable object
 * (the DEFAULT_CONFIG global itself is frozen).
 */
function cloneDefaults(): SpecConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as SpecConfig;
}
