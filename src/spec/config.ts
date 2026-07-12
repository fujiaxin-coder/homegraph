/**
 * Spec configuration module — replaces `commit4spec/utils/config.py`.
 *
 * Loads spec build/evolve configuration from `${SPEC_DATA_DIR}/configs.json`
 * within a repository. Discovery and commitScope sections fall back to code
 * defaults; the `llm` section must be explicitly configured by the user —
 * there are no hard-coded LLM defaults.
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
  provider: 'openai' | 'anthropic';
  apiKey: string;
  apiKeyEnv?: string;
  model: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
  /** Maximum retries on transient errors. Default 3 (4 total attempts). */
  maxRetries: number;
  /** Base delay for exponential backoff in ms. Default 1000. */
  retryBaseDelayMs: number;
  /** Delay ceiling in ms. Default 30000. */
  retryMaxDelayMs: number;
}

export interface SpecConfig {
  discovery: SpecDiscoveryConfig;
  commitScope: CommitScopeConfig;
  llm: LLMConfig | null;
}

export interface MineConfig {
  /** Maximum commits to scan (default: 100). */
  limit: number;
  /** Clustering similarity threshold (0-1, default: 0.5). */
  threshold: number;
  /** Maximum number of clusters to produce (default: 10). */
  maxCluster: number;
  /** Output directory for generated spec files (default: '.spec'). */
  outputDir: string;
  /** Optional path to a spec template markdown file. */
  template?: string;
  /** Skip LLM generation — only output clusters (default: false). */
  skipLlm: boolean;
  /** Include all commit types (default: false — feat-only for conventional commits). */
  allCommits: boolean;
}

/**
 * Build a MineConfig from raw option values (typically from CLI parsing).
 *
 * @param options - Raw option values from the CLI action handler.
 * @param llmConfigured - Whether a valid LLM config was loaded. When false,
 *   skipLlm is forced to true regardless of the option value.
 */
export function createMineConfig(
  options: {
    limit: number;
    threshold: number;
    maxCluster: number;
    outputDir: string;
    template?: string;
    skipLlm: boolean;
    allCommits: boolean;
  },
  llmConfigured: boolean,
): MineConfig {
  return {
    limit: options.limit,
    threshold: options.threshold,
    maxCluster: options.maxCluster,
    outputDir: options.outputDir,
    template: options.template,
    skipLlm: options.skipLlm || !llmConfigured,
    allCommits: options.allCommits,
  };
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
  llm: null,
}) as SpecConfig;

/** Config file path relative to the repo root. */
const CONFIG_FILE = `${SPEC_DATA_DIR}/configs.json`;

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
 * Load spec config from `${SPEC_DATA_DIR}/configs.json` in the given repo path.
 *
 * Discovery and commitScope sections fall back to code defaults when the config
 * file is missing or invalid. The `llm` section has NO defaults — it is `null`
 * unless the user explicitly provides a valid `llm` block in the config file.
 *
 * When `llm.apiKeyEnv` is set, `llm.apiKey` is resolved from `process.env`.
 */
export function loadSpecConfig(repoPath: string): SpecConfig {
  const file = path.join(repoPath, CONFIG_FILE);

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    // No config file — return defaults for discovery/commitScope, null for llm.
    return cloneDefaults();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(`Ignoring ${CONFIG_FILE}: not valid JSON`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return cloneDefaults();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logWarn(
      `Ignoring ${CONFIG_FILE}: top-level value must be a JSON object`,
      { file },
    );
    return cloneDefaults();
  }

  // Deep merge user config over defaults (discovery and commitScope have defaults;
  // llm is null in the default — it must come from the user file.)
  const merged = deepMerge(DEFAULT_CONFIG, parsed) as SpecConfig;

  // Normalize sub-objects that fail the type guard
  merged.discovery = normalizeDiscovery(merged.discovery, file);
  merged.commitScope = normalizeCommitScope(merged.commitScope, file);

  // Validate LLM section. No defaults — user must provide provider, model, apiKey.
  merged.llm = validateLLM((parsed as Record<string, unknown>).llm, file);

  // Resolve apiKey from env if apiKeyEnv is set
  if (merged.llm?.apiKeyEnv) {
    const envKey = process.env[merged.llm.apiKeyEnv];
    if (envKey !== undefined) {
      merged.llm.apiKey = envKey;
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Normalizers / Validators — ensure sub-configs are well-formed after merge
// ---------------------------------------------------------------------------

function normalizeDiscovery(
  val: any,
  file: string,
): SpecDiscoveryConfig {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    logWarn(
      `Ignoring "discovery" in ${CONFIG_FILE}: must be an object`,
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
  };
}

function normalizeCommitScope(
  val: any,
  file: string,
): CommitScopeConfig {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    logWarn(
      `Ignoring "commitScope" in ${CONFIG_FILE}: must be an object`,
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

const LLM_CONFIG_EXAMPLE = [
  '',
  'Example minimal llm config:',
  '{',
  '  "llm": {',
  '    "provider": "openai",',
  '    "apiKeyEnv": "OPENAI_API_KEY",',
  '    "model": "gpt-4o"',
  '  }',
  '}',
].join('\n');

/**
 * Validate an `llm` section from the user config file.
 *
 * Required fields (no defaults — user must provide them):
 * - `provider`: must be `"openai"` or `"anthropic"`
 * - `model`: non-empty string
 * - `apiKey` or `apiKeyEnv`: at least one must be set (env var is resolved later)
 *
 * Optional fields with defaults:
 * - `temperature`: defaults to 0.2
 * - `maxTokens`: defaults to 20000
 *
 * Returns a valid LLMConfig, or `null` if the user did not provide an `llm`
 * section at all (no error in that case — callers decide how to handle it).
 */
function validateLLM(val: any, file: string): LLMConfig | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    // No llm section provided — null, not an error.
    return null;
  }

  // --- provider ---
  const provider = val.provider;
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(
      `Invalid llm.provider in ${file}: must be "openai" or "anthropic", ` +
      `got ${JSON.stringify(provider)}.${LLM_CONFIG_EXAMPLE}`,
    );
  }

  // --- model ---
  if (typeof val.model !== 'string' || val.model.length === 0) {
    throw new Error(
      `Missing llm.model in ${file}. Specify a model name, e.g. "gpt-4o".${LLM_CONFIG_EXAMPLE}`,
    );
  }

  // --- apiKey / apiKeyEnv ---
  const directKey = typeof val.apiKey === 'string' ? val.apiKey : '';
  const apiKeyEnv = typeof val.apiKeyEnv === 'string' ? val.apiKeyEnv : undefined;
  if (!directKey && !apiKeyEnv) {
    throw new Error(
      `Missing llm.apiKey or llm.apiKeyEnv in ${file}. ` +
      `Set "apiKey" directly or use "apiKeyEnv" to reference an environment variable.${LLM_CONFIG_EXAMPLE}`,
    );
  }

  return {
    provider: provider as LLMConfig['provider'],
    apiKey: directKey,
    apiKeyEnv,
    model: val.model,
    baseUrl: typeof val.baseUrl === 'string' ? val.baseUrl : undefined,
    temperature:
      typeof val.temperature === 'number' && !isNaN(val.temperature)
        ? val.temperature
        : 0.2,
    maxTokens:
      typeof val.maxTokens === 'number' && Number.isInteger(val.maxTokens) && val.maxTokens > 0
        ? val.maxTokens
        : 20000,
    maxRetries:
      typeof val.maxRetries === 'number' && Number.isInteger(val.maxRetries) && val.maxRetries >= 0
        ? val.maxRetries
        : 3,
    retryBaseDelayMs:
      typeof val.retryBaseDelayMs === 'number' && val.retryBaseDelayMs > 0
        ? val.retryBaseDelayMs
        : 1000,
    retryMaxDelayMs:
      typeof val.retryMaxDelayMs === 'number' && val.retryMaxDelayMs > 0
        ? val.retryMaxDelayMs
        : 30000,
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
        `Ignoring "${label}" entry in ${CONFIG_FILE}: each value must be a non-empty string`,
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
