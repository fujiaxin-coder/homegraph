/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the HomeGraph MCP server.
 */

import type HomeGraph from '../index';
import type { QueryPool } from './query-pool';
import { resolveToolDeadlineMs } from './query-pool';
import { isOverRssBudget, rssBudgetPartialResult, shouldSkipCatchUpSync } from './memory-budget';
import { findNearestHomeGraphRoot } from '../directory';
// Lazy-load the heavy HomeGraph chain off the MCP startup path — see the same
// helper in engine.ts. ToolHandler must load to answer tools/list (static
// schemas), but it must NOT drag in sqlite/query layers before the daemon binds;
// HomeGraph is pulled in only when a tool actually opens a project. require() is
// sync + cached (CommonJS build).
const loadHomeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;
import {
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from '../sync/worktree';
import type { PendingFile } from '../sync';
import type { Node, Edge, SearchResult, Subgraph, NodeKind } from '../types';
import { isTestFile, normalizeNameToken, extractFileBasenamesFromQuery, extractKitModuleNamesFromQuery, extractKitSubmoduleNamesFromQuery, extractMemberAccessFromQuery, extractImportSearchTerms, extractDependencySymbolsFromQuery, extractApiUsageTokens, hasImportInventoryFilter, shouldBuildCallerInventory, shouldBuildInheritanceSurvey, shouldBuildKitModuleUsageSurvey, shouldBuildHoverHandlerSurvey, queryShouldPreferExploreOverSearch, queryAsNamedComponentAction, queryHasNamedMemberFocus, isMemberLikeIdentifier, shouldBuildMemberSurvey, shouldBuildConfigSection, shouldBuildDomainFileSurvey, shouldBuildApiUsageSurvey, shouldCompactImportListing, shouldOmitSourceBodies, shouldLimitToQueryNamedFile, shouldFocusOnNamedTypeFile, shouldFocusOnQueryNamedDefs, shouldTryFastInventoryExplore, shouldTryLightMechanismExplore, shouldUseCompactExploreBudget, queryAsLocalSymbolDetail, extractLocalDetailAnchors, queryNamesMultipleExploreAnchors, extractTypeNamesFromQuery, extractDomainSearchTerms, extractCallerSurveySymbols, queryAsMechanismSurvey, queryAsCrossModuleFlowSurvey, queryAsDataSourceSurvey, queryAsInterpretationSurvey, queryAsTestOnlyInterpretation, extractMechanismEntrySeeds, isImplementationEntrySymbol, fileMatchesQueryBasename, resolveImportLineFromNode, queryIsTypeNameFocus, queryAsInheritanceSurvey, queryAsCallerOrMethodSurvey, queryHasFocusedNamedAnchors, queryNeedsCoNamedUseBridge, queryShouldDeferToBuiltinTools, homegraphDeferGuidance, queryAsComponentSurfaceSurvey, queryAsFocusedUiCluster, queryLooksLikeUiComponentType, isFrameworkUiDecoratorName, queryAsTypeLifecycleSurvey, extractFieldLikeSymbolsFromQuery, GENERIC_VERB_ANCHOR_NOISE,   queryAsDeclarationSiteSurvey, queryAsInRepoSystemCapabilityHowto, queryAsReturnValueConsumerSurvey, queryAsModuleExportSurvey, queryAsModuleDependencySurvey, queryAsFieldUsageSurvey, extractListedTypeMethodsFromQuery, queryAsDtsWrapSurvey, extractPathSegmentsFromQuery, queryAsNativeRenderThreadSurvey, queryAsNamedControlStateSyncSurvey, queryAsAssignedFlagImpactSurvey, queryAsksKitInstallDeps } from '../search/query-utils';

import {
  existsSync,
  readFileSync,
} from 'fs';
import { clamp, validatePathWithinRoot, validateProjectPath, isConfigLeafNode, CONFIG_LEAF_LANGUAGES } from '../utils';
import { isGeneratedFile } from '../extraction/generated-detection';
import { isOhosApiFilePath, OHOS_API_FILE_PREFIX } from '../extraction/languages/arkts';
import { scanDynamicDispatch } from './dynamic-boundaries';
import {
  buildMcpQueryCacheKey,
  getMcpQueryCacheIndex,
  isCacheableMcpTool,
  isMcpQueryCacheEnabled,
} from './query-cache';
import {
  resolveDiffImpactHunks,
  buildDiffImpactPack,
  DIFF_IMPACT_LIMITS,
} from './diff-impact';

/** ViewTree structural `references` vias — not UI event bindings. */
const VIEWTREE_STRUCTURE_VIAS = new Set([
  'child-component',
  'state-binding',
  'Prop',
  'Link',
  'builder',
  'builder-param',
]);

// Spec knowledge-graph tooling — loaded lazily so the MCP startup path
// doesn't pull in SQLite / spec-graph layers before the daemon binds.
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { WASM_FALLBACK_FIX_RECIPE } from '../db/sqlite-adapter';

/**
 * An expected, recoverable "homegraph can't serve this" condition — most
 * importantly a project with no index. The dispatch catch converts these to
 * SUCCESS-shaped responses (guidance text, NO isError): an `isError: true`
 * early in a session teaches the agent the toolset is broken and it stops
 * calling homegraph entirely (observed repeatedly), which is exactly wrong
 * for conditions the agent can simply work around (use built-in tools for
 * that codebase / pass projectPath). isError is reserved for "stop trying"
 * cases: security refusals ({@link PathRefusalError}) and genuine
 * malfunctions.
 */
export class NotIndexedError extends Error {}

/**
 * A security refusal (sensitive system path). Stays `isError: true` WITHOUT
 * retry guidance — abandoning this path is the desired agent reaction.
 */
export class PathRefusalError extends Error {}
import { resolve as resolvePath } from 'path';

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15000;

/**
 * Maximum length for free-form string inputs (query, task, symbol).
 * Bounds memory and CPU when a buggy or hostile MCP client sends a
 * huge payload — without this an attacker could ship a 100MB string
 * and force a full FTS5 scan / OOM the server. 10 000 characters is
 * far beyond any realistic legitimate query.
 */
const MAX_INPUT_LENGTH = 10_000;

/** Example values for success-shaped bad-arg guidance (keyed by arg name). */
const BAD_ARG_EXAMPLES: Record<string, unknown> = {
  query: 'authenticate login',
  symbol: 'authenticate',
  filePath: 'src/auth.ts',
  file: 'src/auth.ts',
  path: 'src/components',
  pattern: '*.ets',
  projectPath: '/absolute/path/to/your/project',
  repoPath: '/absolute/path/to/your/project',
  diff: 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,3 +10,4 @@\n+export function authenticate() {}\n',
};

/**
 * Maximum length for path-like string inputs (projectPath, path
 * filter, glob pattern). Paths beyond a few thousand chars are
 * never legitimate and signal abuse or a bug upstream.
 */
const MAX_PATH_LENGTH = 4_096;

/**
 * Rust path roots that have no file-system equivalent — `crate` is the
 * current crate, `super` is the parent module, `self` is the current
 * module. Used by `matchesSymbol` to strip these before file-path
 * matching so `crate::configurator::stage_apply::run` resolves the
 * same as `configurator::stage_apply::run`.
 */
const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/**
 * Node kinds that contain other symbols. For these, `homegraph_node` with
 * `includeCode=true` returns a structural outline (member names + signatures
 * + line numbers) instead of the full body, which for a large class is a
 * multi-thousand-character wall of source that bloats the agent's context.
 */
const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Page/Dialog surface digests — methods that answer "which UI children / how
 * does preview load" without dumping the whole struct. Lifecycle alone is not
 * enough: agents re-Read for PageMap / preview helpers when those are trimmed.
 */
function isUiSurfaceDigestMethod(name: string, includePreviewHelpers: boolean): boolean {
  if (/^(build|aboutToAppear|aboutToDisappear|PageMap)$/i.test(name)) return true;
  if (!includePreviewHelpers) return false;
  return /preview|pixelmap|loadimage|getimage|decodeimage/i.test(name);
}

/** Prefer build/PageMap/preview over aboutToAppear when budget is tight. */
function surfaceMethodPriority(name: string): number {
  if (/^(build|PageMap)$/i.test(name)) return 0;
  if (/preview|pixelmap|loadimage|getimage/i.test(name)) return 1;
  return 2;
}

/**
 * Structured UI/nav bullets extracted from surface method bodies so agents can
 * ANSWER NOW without re-Reading for child Types / PageMap routes.
 */
function extractUiSurfaceInventory(fileLines: string[], methods: Node[]): string {
  const FRAMEWORK_TAG = new Set([
    'Column', 'Row', 'Stack', 'Flex', 'Grid', 'List', 'ListItem', 'Scroll', 'Tabs', 'TabContent',
    'Text', 'Image', 'Button', 'Blank', 'Divider', 'ForEach', 'LazyForEach', 'If', 'Else',
    'RelativeContainer', 'Swiper', 'WaterFlow', 'GridItem', 'Span', 'SymbolGlyph',
  ]);
  const comps = new Set<string>();
  const nav = new Set<string>();
  const media: string[] = [];
  for (const m of methods) {
    const from = Math.max(1, m.startLine);
    const to = Math.min(fileLines.length, Math.max(m.endLine, m.startLine));
    for (let i = from; i <= to; i++) {
      const line = fileLines[i - 1] ?? '';
      for (const mm of line.matchAll(/\b([A-Z][A-Za-z0-9_]{2,})\s*\(/g)) {
        const id = mm[1]!;
        if (FRAMEWORK_TAG.has(id) || isFrameworkUiDecoratorName(id)) continue;
        if (/^(Promise|Array|Map|Set|Date|Error|JSON|Object|Math|Number|String|Boolean)$/.test(id)) continue;
        comps.add(id);
      }
      if (/PageMap|pushUrl|replaceUrl|pushPath|replacePath|router\./i.test(line)) {
        const clipped = line.trim().replace(/\s+/g, ' ').slice(0, 120);
        if (clipped) nav.add(clipped);
      }
      for (const mm of line.matchAll(/\bConstants\.[A-Z][A-Z0-9_]+\b/g)) {
        nav.add(mm[0]!);
      }
      // Preview / Image load origin — $r vs file URI vs network.
      if (
        /\$r\s*\(|Image\s*\(|PixelMap|createPixelMap|decode|tempFileUri|http|download|fileUri|getPreview|previewPixelMap|loadImage/i.test(
          line,
        )
      ) {
        const clipped = line.trim().replace(/\s+/g, ' ').slice(0, 140);
        if (clipped && media.length < 14) {
          media.push(`L${i} (\`${m.name}\`): \`${clipped}\``);
        }
      }
    }
  }
  if (comps.size === 0 && nav.size === 0 && media.length === 0) return '';
  const out: string[] = ['**UI surface inventory (from build / PageMap / preview methods)**', ''];
  if (comps.size > 0) {
    out.push('UI / child Types:');
    for (const c of [...comps].sort().slice(0, 24)) out.push(`- \`${c}\``);
    if (comps.size > 24) out.push(`- … and ${comps.size - 24} more`);
    out.push('');
  }
  if (nav.size > 0) {
    out.push('Navigation / PageMap / route constants:');
    for (const n of [...nav].slice(0, 16)) out.push(`- ${n.startsWith('Constants.') ? `\`${n}\`` : n}`);
    if (nav.size > 16) out.push(`- … and ${nav.size - 16} more`);
    out.push('');
  }
  if (media.length > 0) {
    out.push('Image / preview load sites ($r / file / network cues):');
    for (const row of media) out.push(`- ${row}`);
    out.push('');
  }
  out.push(
    '> **ANSWER NOW** from this inventory + method digests below — do not Read/Grep for the same Page UI children, routes, or preview-load origin.',
  );
  out.push('');
  return out.join('\n');
}

/** C++ `class Foo : public Bar` vs private `: Bar` — prefer public is-a for subtype lists. */
function cppExtendsLooksPublic(declLine: string, baseName: string): boolean | null {
  const esc = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`:\\s*public\\s+(?:virtual\\s+)?${esc}\\b`).test(declLine)) return true;
  if (new RegExp(`:\\s*protected\\s+(?:virtual\\s+)?${esc}\\b`).test(declLine)) return false;
  if (new RegExp(`:\\s*private\\s+(?:virtual\\s+)?${esc}\\b`).test(declLine)) return false;
  // `class Cluster : Rectangle` (no access) defaults to private for class.
  if (new RegExp(`:\\s*${esc}\\b`).test(declLine) && /\bclass\b/.test(declLine)) return false;
  if (new RegExp(`:\\s*${esc}\\b`).test(declLine) && /\bstruct\b/.test(declLine)) return true;
  return null;
}

/**
 * Normalize Erlang-native symbol spellings in an explore query into the shapes
 * the rest of the pipeline already understands. Agents working Erlang code
 * name symbols the way the language spells them — `mod:fn/3`, `init/2` — and
 * those tokens previously died in both consumers: the flow-builder's token
 * filter rejects `:` and `/arity` outright, and the search-side field parser
 * eats `mod:fn` as an unknown `field:value`.
 *
 *   - `fn/3` → `fn` (arity tail after an identifier)
 *   - `mod:fn` → `mod.fn` (exactly one colon between identifiers)
 *
 * Safe cross-language: Lua's `t:m` spelling maps to the same `t.m` its
 * qualified names use.
 */
export function normalizeQuerySpelling(query: string): string {
  return query
    .replace(/\b([A-Za-z_][\w@]*)\/(\d{1,3})(?=$|[\s,()[\]/])/g, '$1')
    .replace(
      /(^|[\s,()[\]])(?!(?:kind|lang|language|path|name):)([a-z_][\w@]*):([A-Za-z_][\w@]*)(?=$|[\s,()[\]])/g,
      '$1$2.$3'
    );
}

/**
 * Calculate the recommended number of homegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

/**
 * Adaptive output budget for `homegraph_explore`, scaled to project size.
 *
 * Smaller codebases get a tighter total cap, fewer default files, smaller
 * per-file cap, and tighter clustering — so a focused query on a 100-file
 * project doesn't dump a whole file's worth of source into the agent's
 * context. Larger codebases keep the generous defaults because the
 * agent's native discovery cost (grep + find + many Reads) genuinely
 * dwarfs a fat explore call at that scale.
 *
 * Meta-text (relationships map, "additional relevant files" list,
 * completeness signal, budget note) is gated off for tiny projects
 * where one rich call is the whole story and the extra prose is just
 * overhead.
 *
 * Tier breakpoints mirror `getExploreBudget` so a project sits in the
 * same tier across both knobs.
 */
export interface ExploreOutputBudget {
  /** Hard cap on total output characters. */
  maxOutputChars: number;
  /** Default `maxFiles` when the caller didn't specify one. */
  defaultMaxFiles: number;
  /** Cap on contiguous source returned per file (across all its clusters). */
  maxCharsPerFile: number;
  /** Cluster gap threshold in lines — tighter clustering on small projects. */
  gapThreshold: number;
  /** Max symbols listed in the per-file header (``**`path`** — sym(kind), ...``). */
  maxSymbolsInFileHeader: number;
  /** Max edges shown per relationship kind in the Relationships section. */
  maxEdgesPerRelationshipKind: number;
  /** Include the "Relationships" section. */
  includeRelationships: boolean;
  /** Include the "Additional relevant files (not shown)" trailing list. */
  includeAdditionalFiles: boolean;
  /** Include the "Complete source code is included above…" reminder. */
  includeCompletenessSignal: boolean;
  /** Include the explore-budget reminder at the end. */
  includeBudgetNote: boolean;
  /**
   * Hard-drop test/spec/icon/i18n files from the relevant-file set unless
   * the query itself mentions tests. Today they're only deprioritized in
   * the sort, which on tiny repos still lets one slip into the top N (e.g.
   * cobra's `command_test.go` displaced `args.go` and contributed ~10KB of
   * pure noise to "How does cobra parse commands?"). Off by default; on
   * for the very-tiny tier where one slip dominates the budget.
   */
  excludeLowValueFiles: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  // Tiered budget, scaled to project size. The budget is a CEILING (relevance
  // still gates WHAT is included), and it MUST stay under the agent's INLINE
  // tool-result cap (~25K chars). Above that, the host externalizes the result
  // to a file the agent then Reads back — re-introducing a read AND the
  // cache-write cost — which is exactly what a 35K vscode explore did in the
  // n=4 README A/B. So even large repos cap at ~24K: the answer is the handful
  // of ~100-line flow windows the agent would have grep-located and read (it
  // natively reads ~6–9 files, median 100-line ranges), NOT a sprawl of 12
  // files. Concentration onto the flow emerges from this cap + the named-file-
  // first sort dropping peripheral files. Invariant: a larger tier must never
  // get a smaller `maxCharsPerFile` than a smaller tier.
  if (fileCount < 150) {
    return {
      // ITER3: revert iter2's aggressive body shrink (forced Read fallback —
      // the per-file 2.5K cap pushed the agent to Read instead of node).
      // Back to the iter1 shape (13K/4/3.8K) but keep the test-file
      // hard-exclude. The cost lever for this tier lives in steering the
      // agent to stop after 1-2 calls, not in this budget.
      maxOutputChars: 13000,
      defaultMaxFiles: 4,
      maxCharsPerFile: 3800,
      gapThreshold: 7,
      maxSymbolsInFileHeader: 5,
      maxEdgesPerRelationshipKind: 4,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 500) {
    return {
      // ITER3: same revert/keep-filter pattern as <150.
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 5000) {
    return {
      // ~150-line per-file window (the native read unit) × ~6 files, capped at
      // the ~24K inline ceiling so the response is never externalized. Per-file
      // stays ≥ the <500 tier (3800) — monotonic.
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 6500,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  // Large + very-large repos: SAME ~24K inline ceiling (a bigger response just
  // externalizes — see vscode). More files indexed → more CALLS via
  // getExploreBudget, not a bigger single response. Per-file 7000 (≥ smaller
  // tiers) gives the central file a ~180-line orientation window.
  if (fileCount < 15000) {
    return {
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  return {
    maxOutputChars: 24000,
    defaultMaxFiles: 8,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
    excludeLowValueFiles: false,
  };
}

/**
 * Shrink explore ceilings for local-detail / no-flow named-symbol questions.
 * Large repos otherwise dump ~24K related source that the agent then still
 * greps/reads — the main token regression vs without-homegraph.
 *
 * Mechanism / cross-module flows also get a tighter ceiling: full 24K + a
 * second explore/node/Read stack is what blows session tokens on "how is X
 * implemented" questions even when the first answer was already enough.
 */
export function tightenExploreBudgetForQuery(
  budget: ExploreOutputBudget,
  query: string,
  opts?: { hasFlowPath?: boolean },
): ExploreOutputBudget {
  const hasFlow = opts?.hasFlowPath === true;
  if (hasFlow && (queryAsMechanismSurvey(query) || queryAsCrossModuleFlowSurvey(query))) {
    return {
      ...budget,
      maxOutputChars: Math.min(budget.maxOutputChars, 12000),
      defaultMaxFiles: Math.min(budget.defaultMaxFiles, 4),
      maxCharsPerFile: Math.min(budget.maxCharsPerFile, 4500),
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
    };
  }
  const local = queryAsLocalSymbolDetail(query);
  const compact = shouldUseCompactExploreBudget(query);
  if (!local && !compact && hasFlow) return budget;
  if (!local && !compact && hasFlow === false) {
    // Generic no-flow explore: still trim meta + file count a bit.
    return {
      ...budget,
      maxOutputChars: Math.min(budget.maxOutputChars, 14000),
      defaultMaxFiles: Math.min(budget.defaultMaxFiles, 3),
      maxCharsPerFile: Math.min(budget.maxCharsPerFile, 5000),
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
    };
  }
  if (!local && !compact) return budget;
  const lean =
    queryAsAssignedFlagImpactSurvey(query)
    || queryAsFocusedUiCluster(query)
    || queryAsTypeLifecycleSurvey(query);
  return {
    ...budget,
    maxOutputChars: Math.min(budget.maxOutputChars, lean ? 4800 : local ? 7000 : 9000),
    defaultMaxFiles: Math.min(budget.defaultMaxFiles, lean ? 2 : local ? 2 : 3),
    maxCharsPerFile: Math.min(budget.maxCharsPerFile, lean ? 2200 : local ? 3500 : 4000),
    includeRelationships: false,
    includeAdditionalFiles: false,
    includeCompletenessSignal: false,
    includeBudgetNote: false,
  };
}

/**
 * Whether `homegraph_explore` should prefix source lines with their line
 * numbers (cat -n style: `<num>\t<code>`).
 *
 * Line numbers let the agent cite `file:line` straight from the explore
 * payload instead of re-Reading the file just to find a line number — the
 * dominant residual cost on precise-tracing questions (#185 follow-up).
 *
 * Defaults ON. Set `HOMEGRAPH_EXPLORE_LINENUMS=0` to disable (used by the
 * A/B harness to measure the payload-cost vs. read-savings tradeoff).
 */
function exploreLineNumbersEnabled(): boolean {
  return process.env.HOMEGRAPH_EXPLORE_LINENUMS !== '0';
}

/**
 * Adaptive explore sizing (default ON). `homegraph_explore` skeletonizes OFF-SPINE
 * polymorphic-sibling files — a file whose class is one of ≥3 interchangeable
 * implementations of a shared interface (e.g. OkHttp's `: Interceptor` classes) —
 * to class + member signatures (bodies elided), keeping the on-spine exemplar full.
 * This sizes the response to the answer instead of the budget cap on sibling-heavy
 * flows (OkHttp interceptor-chain explore 28.5k→16.6k, ~28% cheaper than native
 * search, reads flat). It is PROVABLY INERT elsewhere: distinct pipeline steps (no
 * ≥3-implementer supertype, e.g. Excalidraw's `renderStaticScene`) and on-spine
 * files keep full source — output is byte-identical to shipped on excalidraw /
 * tokio / django / vscode / gin. Set `HOMEGRAPH_ADAPTIVE_EXPLORE=0` to disable.
 */
function adaptiveExploreEnabled(): boolean {
  return process.env.HOMEGRAPH_ADAPTIVE_EXPLORE !== '0' && process.env.HOMEGRAPH_ADAPTIVE_EXPLORE !== 'false';
}

/**
 * How long the FIRST tool call waits on the post-open catch-up reconcile before
 * giving up and serving anyway (issue #905). On a normal repo the reconcile
 * finishes in well under this, so the gate is fully honored and nothing changes.
 * On a very large repo (~100k files) the reconcile takes minutes — blocking the
 * first call on all of it presents as a multi-minute hang — so we wait briefly
 * for a clean answer, then serve and let the reconcile finish in the background
 * (it yields to the event loop, so a concurrent read still runs).
 *
 * `HOMEGRAPH_CATCHUP_GATE_TIMEOUT_MS` overrides the default; `0` restores the
 * old unbounded-wait behavior (always block until the reconcile completes).
 */
const DEFAULT_CATCHUP_GATE_TIMEOUT_MS = 3000;
function resolveCatchUpGateTimeoutMs(): number {
  const raw = process.env.HOMEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_CATCHUP_GATE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CATCHUP_GATE_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Prefix each line of a source slice with its 1-based line number, matching
 * the Read tool's `cat -n` convention (number + tab) so the agent treats it
 * the same way it treats Read output.
 *
 * @param slice  contiguous source text (already extracted from the file)
 * @param firstLineNumber  the 1-based line number of the slice's first line
 */
function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/** Primary signature line (first line when overloads are stored newline-separated). */
function primarySignatureLine(signature: string): string {
  return signature.split('\n')[0]?.trim() ?? signature.trim();
}

/** Render a stored signature (single line or newline-separated overloads) for MCP output. */
function formatNodeSignatureBlock(signature: string): string[] {
  const lines = signature.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) {
    return lines.length ? [`**Signature:** \`${lines[0]}\``] : [];
  }
  return [
    '**Signature:**',
    `- \`${lines[0]}\` (primary)`,
    ...lines.slice(1).map((l) => `- \`${l}\` (overload)`),
  ];
}

function formatInlineSignature(signature: string): string {
  const primary = primarySignatureLine(signature);
  const overloadCount = signature.split('\n').filter((l) => l.trim()).length - 1;
  if (overloadCount <= 0) return primary;
  return `${primary} (+${overloadCount} overload${overloadCount === 1 ? '' : 's'})`;
}

/**
 * Unique line-prefix for a per-file source section in homegraph_explore output.
 * Issue #778: tool results dropped ATX headings (`####`, `##`, `###`) for bold
 * labels so Markdown-rendering MCP clients (e.g. the Claude Code VSCode
 * extension) stop blowing every header up to H1–H4. The path is bold + a code
 * span so it still reads as a header, and the leading ``**` `` stays a UNIQUE,
 * greppable marker — no other explore line begins with it — that the explore
 * truncation boundary (`handleExplore`) and the offload chunker
 * (`reasoning/reasoner.ts`) both key off to cut on whole file sections.
 */
const FILE_SECTION_PREFIX = '**`';
// Placeholder for codegraph_explore's "Found N symbols across M files." line.
// The honest N/M can only be known after the final truncation drops trailing
// sections (#1046), so the header is emitted as this sentinel and substituted
// at the very end. This bracketed token never occurs in rendered source or a
// file path, so the final string-replace can't collide.
const SUMMARY_SENTINEL = '[[codegraph-explore-summary]]';
function fileSectionHeader(filePath: string, suffix: string): string {
  return suffix
    ? `${FILE_SECTION_PREFIX}${filePath}\`** — ${suffix}`
    : `${FILE_SECTION_PREFIX}${filePath}\`**`;
}

/**
 * Per-file staleness banner emitted at the top of a tool response when the
 * file watcher has pending events for files referenced by the response.
 * The agent uses this to fall back to Read for those specific files
 * without waiting for the debounced sync (issue #403).
 */
export function formatStaleBanner(
  stale: PendingFile[],
  opts?: { catchUpDeferred?: boolean },
): string {
  const now = Date.now();
  const lines = stale.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  // On large indexes catch-up is skipped for RSS — "Read them" teaches the agent
  // to abandon homegraph after every save and burn tokens on whole-file Reads.
  const guidance = opts?.catchUpDeferred
    ? 'Callers / defs / explore locations above are still usable for structural answers. ' +
      'Read a listed file only if you need byte-exact content that may have changed mid-session — ' +
      'do not re-read the whole file just because of this notice.'
    : 'For accurate content of those specific files, Read them directly. ' +
      'The rest of this response is fresh.';
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their homegraph entries may be stale:\n' +
    lines.join('\n') +
    '\n' +
    guidance
  );
}

/**
 * Compact footer listing pending files that are NOT referenced in this
 * response. Gives the agent a complete project-wide freshness picture
 * without bloating the main banner.
 */
export function formatStaleFooter(stale: PendingFile[]): string {
  const MAX = 5;
  const now = Date.now();
  const shown = stale.slice(0, MAX);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = stale.length > MAX ? `\n  - …and ${stale.length - MAX} more` : '';
  return (
    `(Note: ${stale.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

/**
 * Whole-index degradation banner (issue #876). Emitted at the top of a read
 * tool response when live watching has permanently stopped — at which point
 * `getPendingFiles()` is empty, so the per-file banner above can't fire even
 * though the index is now FROZEN and silently drifting stale. Leads with the
 * agent-actionable instruction (Read directly) and carries the reason, which
 * already names the operator remedy (`homegraph sync` / git hooks).
 */
export function formatDegradedBanner(reason: string | null): string {
  return (
    '⚠️ HomeGraph auto-sync is DISABLED — live file watching stopped, so the index is ' +
    'frozen and any file edited since then is stale here. Read files directly to confirm ' +
    'current content before relying on it.' +
    (reason ? `\n  Reason: ${reason}` : '')
  );
}

/**
 * MCP Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
  /** Behavioral hints for clients (see {@link ToolAnnotations}). */
  annotations?: ToolAnnotations;
}

/**
 * MCP ToolAnnotations — behavioral hints a client MAY use to decide how, or
 * whether, to run a tool (introduced in the 2025-03-26 spec, carried in
 * 2025-06-18). They are advisory and never to be trusted for security, but
 * clients gate on them: Cursor's Ask mode, for one, refuses any MCP tool that
 * doesn't advertise `readOnlyHint: true` (issue #1018).
 *
 * The field is purely additive — a client that predates annotations ignores it
 * — so codegraph advertises these even though `initialize` still negotiates the
 * 2024-11-05 protocol version.
 *
 * https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations
 */
export interface ToolAnnotations {
  /** Human-readable title for the tool. */
  title?: string;
  /** If true, the tool does not modify its environment. Default (unset): false. */
  readOnlyHint?: boolean;
  /** Meaningful only when NOT read-only: may the tool perform destructive updates? */
  destructiveHint?: boolean;
  /** If true, repeat calls with the same arguments have no additional effect. */
  idempotentHint?: boolean;
  /** If true, the tool interacts with an open world of external entities. */
  openWorldHint?: boolean;
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
  items?: PropertySchema | {
    type: string;
    properties?: Record<string, PropertySchema>;
    description?: string;
  };
}

/**
 * Tool execution result
 */
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * Common projectPath property for cross-project queries
 */
const projectPathProperty: PropertySchema = {
  type: 'string',
  description: 'Absolute path to the project to query (or any directory inside it) — homegraph uses the nearest .homegraph/ index at or above that path. Omit to use this session\'s default project. Pass it to query a second codebase, or when the server root has no index of its own (e.g. a monorepo where only sub-projects are indexed, so there is no default project).',
};

/**
 * EVERY homegraph tool is query-only: it reads the pre-built index and never
 * mutates the workspace (indexing is the user's explicit CLI call, never the
 * agent's). Advertising this read-only contract lets clients that gate on it run
 * the tools where a possibly-mutating tool would be blocked — most concretely,
 * Cursor's Ask mode, which rejects any MCP tool lacking `readOnlyHint: true`
 * (issue #1018). `idempotentHint`: a repeated query has no additional effect.
 * `openWorldHint: false`: the domain is the closed local index, not an open
 * external world. Shared so the contract is declared once; a hypothetical
 * mutating tool would simply not reference it.
 */
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * All HomeGraph MCP tools
 *
 * Prefer the smallest tool that answers: callers/node for one named symbol,
 * explore for multi-file flows. Skip HomeGraph entirely for topic file-lists,
 * concept compares, SDK catalogs, and literal greps.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export const tools: ToolDefinition[] = [
  {
    name: 'homegraph_search',
    description:
      'LAST RESORT spelling lookup — locations only, no source. Required: `query` (e.g. "signIn"). ' +
      'Prefer explore/callers/node when names are known. ' +
      'DO NOT call for topic file-lists, concept compares, or SDK/@kit feature catalogs (those return Skip guidance). ' +
      'Also skip literal string/pattern greps — use Grep instead. ' +
      'Bare-name search may return a compact explore result instead of locations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Required. Symbol name or partial name (e.g. "auth", "signIn", "UserService").',
        },
        kind: {
          type: 'string',
          description: 'Optional filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_callers',
    description:
      'Compact caller list for one NAMED in-repo symbol (no bodies). Required: `symbol` (e.g. "authenticate"). ' +
      'Cheaper than explore when you only need who-calls-X. For multi-file flows use homegraph_explore. ' +
      'DO NOT call for SDK catalogs, topic file-lists, concept compares, or hypothetics.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Required. Exact function/method/class name (e.g. "authenticate", "AuthService.login").',
        },
        file: {
          type: 'string',
          description: 'Optional. Narrow to the definition in this file (path or suffix) when same-named symbols collide.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_callees',
    description:
      'Compact callee list for one NAMED in-repo symbol (no bodies). Required: `symbol` (e.g. "authenticate"). ' +
      'Cheaper than explore when you only need what-X-calls. For multi-file flows use homegraph_explore. ' +
      'DO NOT use for out-of-repo SDK catalogs or counterfactual analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Required. Exact function/method/class name (e.g. "authenticate", "AuthService.login").',
        },
        file: {
          type: 'string',
          description: 'Optional. Narrow to the definition in this file (path or suffix) when same-named symbols collide.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_impact',
    description:
      'Blast radius for one NAMED in-repo symbol before a refactor. Required: `symbol` (e.g. "authenticate"). ' +
      'Not for SDK docs, permission judgments, or hypothetical failure effects — those need Read/Grep. ' +
      'For PR/diff review use homegraph_diff_impact instead.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Required. Exact symbol name to analyze (e.g. "authenticate", "CartRepository").',
        },
        file: {
          type: 'string',
          description: 'Optional. Narrow to the definition in this file (path or suffix) when same-named symbols collide.',
        },
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_diff_impact',
    description:
      'PR / code-review evidence pack from a unified diff (or explicit hunks). ' +
      'Required: `diff` (unified diff text) OR `hunks` [{ path, startLine, endLine }]. ' +
      'Intersects NEW-side changed lines with indexed symbol spans — does NOT dump every symbol in touched files. ' +
      'Returns changedSymbols + capped callers + impactSummary + UI edges (viewtree/arkui-*); optional relatedSpecs. ' +
      'Index should match the post-change tree. Does not write review text or judge Specs.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description:
            'Unified diff text (preferred). New-side @@ +line ranges are used to find changed symbols. ' +
            'Example: output of `git diff` / PR patch for the files under review.',
        },
        hunks: {
          type: 'array',
          description:
            'Alternative to `diff`: explicit changed ranges. Each item: { path, startLine, endLine } (1-based, inclusive, new-file lines).',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Project-relative file path' },
              startLine: { type: 'number', description: '1-based start line (new file)' },
              endLine: { type: 'number', description: '1-based end line (new file)' },
            },
          },
        },
        depth: {
          type: 'number',
          description: 'Impact / caller traversal depth (default: 2, max: 5)',
          default: 2,
        },
        includeSpecs: {
          type: 'boolean',
          description:
            'If true, attach related Commit4Spec hits for changed files/symbols (needs commit4spec.db). Default: false.',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: [],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_node',
    description:
      'Depth on ONE known in-repo symbol or indexed file — not a survey tool. ' +
      'Required: pass `symbol` (symbol mode) OR `file` alone (file mode). ' +
      'Cheaper than explore when you already know the name and only need one body. ' +
      'FILE: `file` only → line-numbered source + dependents. ' +
      'SYMBOL: body via includeCode + short trail; overloads return every body. ' +
      'DO NOT call after explore already returned that symbol/file (multiplies tokens). ' +
      'DO NOT crawl a feature with repeated node calls (prefer one explore for flows). ' +
      'Treat returned source as already Read.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol mode (required unless `file` alone). Exact name (e.g. "authenticate").',
        },
        includeCode: {
          type: 'boolean',
          description: 'Symbol mode: include the symbol\'s full body (default: false). Ignored in file mode, which always returns source unless `symbolsOnly` is set.',
          default: false,
        },
        file: {
          type: 'string',
          description:
            'File mode: pass ALONE (no symbol) to read like Read — e.g. "src/auth/session.ts". ' +
            'Or with `symbol` to disambiguate an overloaded name to that file.',
        },
        offset: {
          type: 'number',
          description: 'File mode: 1-based line to start reading from, exactly like Read\'s offset. Defaults to the start of the file.',
        },
        limit: {
          type: 'number',
          description: 'File mode: maximum number of lines to return, exactly like Read\'s limit. Defaults to the whole file (capped at 2000 lines, like Read).',
        },
        symbolsOnly: {
          type: 'boolean',
          description: 'File mode: return just the file\'s symbol map + dependents (a cheap structural overview) instead of its source.',
          default: false,
        },
        line: {
          type: 'number',
          description: 'Symbol mode only: disambiguate to the definition at/around this line (use with the file:line a trail showed you).',
        },
        projectPath: projectPathProperty,
      },
      required: [],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_explore',
    description:
      'In-repo multi-file / mechanism tool (call paths + compact line-numbered source). Required: `query`. ' +
      'CALL FIRST for how/wired questions — pass the question or domain keywords; PascalCase names optional. ' +
      'Also CALL FIRST (alone, no parallel Grep) for named Type/Component/Page/Dialog, Type.member, click→handler, inheritance/subtypes, ' +
      'declaration/attribute sites, ALL_CAPS constant / field-mutex usages, path-module NAPI/exports or inter-deps, ' +
      'and in-repo @kit/@ohos *usages/dependencies* (which files import a named export — not the SDK feature catalog). ' +
      'On the first turn call explore alone (no parallel Grep). Prefer callers/node when one named symbol is already enough. ' +
      'DO NOT call for topic file-lists, concept/UI-behavior with no named anchors, literal copy hunts, or SDK/@kit *feature catalogs* — those return Skip guidance. ' +
      'Literal string/pattern hunts → Grep. ' +
      'One explore; answer from Source + trail; treat as already Read — do not re-grep/node/read the same symbols. Busy/partial → retry same explore once.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Required. Prefer the user question or domain keywords for how/mechanism. ' +
            'For named flows, include Type / Type.member / component names. For @kit, ask usages (depend/import sites), not SDK catalogs.',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_status',
    description: 'Index health check (files / nodes / edges). No required args when a default project is loaded. Skip unless debugging.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_files',
    description:
      'Indexed directory tree (paths and symbol counts only — NO source). ' +
      'Only for coarse folder layout when explore cannot help. For where/what/how code questions use homegraph_explore.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional directory prefix filter (e.g. "src/components"). Omit to list all indexed files.',
        },
        pattern: {
          type: 'string',
          description: 'Optional glob filter (e.g. "*.tsx", "**/*.ets").',
        },
        format: {
          type: 'string',
          description: 'Output format: "tree" (hierarchical, default), "flat" (simple list), "grouped" (by language)',
          enum: ['tree', 'flat', 'grouped'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include file metadata like language and symbol count (default: true)',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth to show (default: unlimited)',
        },
        projectPath: projectPathProperty,
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_spec_match',
    description:
      'Match a new feature/spec description against the Commit4Spec knowledge graph (FTS5). ' +
      'Required: `query` (title + description text). Returns similar historical specs with commits/fragments. ' +
      'Needs `.homegraph/commit4spec/commit4spec.db` (from `homegraph spec build` / `mine`).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Required. Spec text (title + description) to match against historical specs.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional repository root (default: cwd). Spec DB lives under `.homegraph/commit4spec/`.',
        },
        topK: {
          type: 'number',
          description: 'Maximum number of similar specs to return (default: 5).',
          default: 5,
        },
        includeFragments: {
          type: 'boolean',
          description: 'Whether to include full code diffs per commit (default: true).',
          default: true,
        },
      },
      required: ['query'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_spec_find',
    description:
      'Find which Commit4Spec specs touch a file path. Required: `filePath` (e.g. "src/auth.ts"). ' +
      'Needs `.homegraph/commit4spec/commit4spec.db`.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Required. File path substring to match (e.g. "src/auth.ts" or "src/auth").',
        },
        repoPath: {
          type: 'string',
          description: 'Optional repository root (default: cwd). Spec DB lives under `.homegraph/commit4spec/`.',
        },
      },
      required: ['filePath'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'homegraph_spec_trace',
    description:
      'Trace one code symbol back to related design Specs (Commit4Spec). Required: `symbol` (e.g. "authenticate"). ' +
      'Optional `file`/`line` to disambiguate. Needs code index + `.homegraph/commit4spec/commit4spec.db`.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Required. Symbol name (bare or qualified). E.g. "authenticate", "AuthService.login".',
        },
        file: {
          type: 'string',
          description: 'Optional file path for disambiguation when multiple symbols share the same name.',
        },
        line: {
          type: 'number',
          description: 'Optional line number for disambiguation.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional repository root (default: cwd).',
        },
        topK: {
          type: 'number',
          description: 'Maximum number of matching Specs to return (default: 10).',
          default: 10,
        },
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
];

/**
 * Return `defs` with `projectPath` marked `required` in each tool's inputSchema.
 *
 * Used for the NO-DEFAULT-PROJECT tool surface (issue #993): when the MCP server
 * has no default project to fall back to — a gateway server started outside any
 * repo, or a monorepo root whose `.codegraph/` indexes live only in sub-projects
 * — every call MUST carry an explicit `projectPath`, so the schema should say so.
 * A `required` field is a HIGH-salience channel (MCP clients surface and often
 * validate it), unlike the instructions text the reporter found too weak to stop
 * the agent omitting the param. When a default project IS open, callers leave
 * projectPath optional and never call this.
 *
 * Pure: clones each tool's schema rather than mutating the shared module-level
 * `tools` array (reused by every session and the static surface). A tool that
 * doesn't expose projectPath, or already requires it, is returned untouched;
 * explore's `['query']` becomes `['query', 'projectPath']`, and a tool with no
 * `required` list (status/files) gains `['projectPath']`.
 */
function withRequiredProjectPath(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.map((tool) => {
    if (!tool.inputSchema.properties.projectPath) return tool;
    const required = tool.inputSchema.required ?? [];
    if (required.includes('projectPath')) return tool;
    return {
      ...tool,
      inputSchema: { ...tool.inputSchema, required: [...required, 'projectPath'] },
    };
  });
}

/**
 * Allowlist-filtered tool definitions WITHOUT an engine — the static surface the
 * proxy answers `tools/list` with before any project is open. Mirrors
 * `ToolHandler.getTools()` in the no-HomeGraph case (the dynamic per-repo budget
 * note in a description only adds once `cg` is loaded; the schemas are static).
 */
export function getStaticTools(): ToolDefinition[] {
  const raw = process.env.HOMEGRAPH_MCP_TOOLS ?? process.env.HOMEGRAPH_MCP_TOOLS;
  if (!raw || !raw.trim()) {
    return tools;
  }
  const allow = new Set(raw.split(',').map(s => s.trim().replace(/^homegraph_/, '').replace(/^homegraph_/, '')).filter(Boolean));
  return allow.size ? tools.filter(t => allow.has(t.name.replace(/^homegraph_/, ''))) : tools;
}

/**
 * Tool handler that executes tools against a HomeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  // Cache of opened HomeGraph instances for cross-project queries
  private projectCache: Map<string, HomeGraph> = new Map();
  // The directory the server last searched for a default project. Surfaced in
  // the "not initialized" error so users can see why detection missed.
  private defaultProjectHint: string | null = null;
  // Per-start-path cache of the git worktree/index mismatch (issue #155). The
  // mismatch is a fixed property of (where the request came from → which
  // .homegraph/ it resolves to), so the up-to-two `git rev-parse` spawns run
  // once and every later tool call reuses the result — never shelling out to
  // git on the hot path. `undefined` = not computed yet; `null` = no mismatch.
  private worktreeMismatchCache: Map<string, WorktreeIndexMismatch | null> = new Map();
  // Gate that the MCP engine pokes after `cg.open()` so the first tool call
  // blocks on the post-open filesystem reconcile (catch-up sync). Without
  // this, a tool call that races past `catchUpSync()` serves rows for files
  // that were deleted (or edited) while no MCP server was running — and the
  // per-file staleness banner can't help, because `getPendingFiles()` is
  // populated by the watcher, not by catch-up. The wait is time-boxed
  // (see {@link resolveCatchUpGateTimeoutMs}) so a minutes-long reconcile on a
  // huge repo can't hang the first call (#905); cleared on first await so
  // subsequent calls don't pay any cost.
  private catchUpGate: Promise<void> | null = null;
  // Optional worker-thread pool for off-loop read-tool dispatch (daemon mode).
  // When set + healthy, the heavy read tools run on a worker so the daemon's
  // main loop stays free for the MCP transport under concurrent load. Null in
  // direct/in-process mode (one client, no concurrency to parallelize).
  private queryPool: QueryPool | null = null;

  constructor(private cg: HomeGraph | null) {}

  /**
   * Engine-only: attach (or detach with null) the worker-thread query pool. The
   * shared daemon sets this once its default project is open; the workers each
   * hold their own WAL read connection and run {@link executeReadTool}. A
   * worker's own ToolHandler never has a pool, so there is no nested off-loading.
   */
  setQueryPool(pool: QueryPool | null): void {
    this.queryPool = pool;
  }

  /**
   * Update the default HomeGraph instance (e.g. after lazy initialization)
   */
  setDefaultHomeGraph(cg: HomeGraph): void {
    this.cg = cg;
  }

  /**
   * Engine-only: register the catch-up sync promise so the next `execute()`
   * call awaits it before serving. The handler swallows rejections (the
   * engine logs them) so a sync failure never propagates as a tool error;
   * we still want to serve a best-effort result over the same potentially-
   * stale data, which is what would have happened without the gate.
   */
  setCatchUpGate(p: Promise<void> | null): void {
    this.catchUpGate = p;
  }

  /**
   * Await the catch-up gate, but no longer than the configured timeout (#905).
   * If the reconcile settles first, we got the fully-reconciled answer. If the
   * timeout wins, we serve the call now and let the reconcile finish in the
   * background — it yields to the event loop (see SYNC_RECONCILE_YIELD_INTERVAL),
   * so a concurrent read still runs against the same connection. Never throws:
   * a failed reconcile is logged by the engine, and we serve best-effort over
   * the same potentially-stale data the un-gated path would have.
   */
  private async awaitCatchUpGate(gate: Promise<void>): Promise<void> {
    const timeoutMs = resolveCatchUpGateTimeoutMs();
    if (timeoutMs <= 0) {
      // 0 = opt back into the original unbounded wait.
      try { await gate; } catch { /* engine already logged */ }
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        gate.then(() => 'done' as const, () => 'done' as const),
        timedOut,
      ]);
      if (outcome === 'timeout') {
        process.stderr.write(
          `[HomeGraph MCP] Catch-up reconcile still running after ${timeoutMs}ms; serving this tool call now and finishing the reconcile in the background (#905). ` +
          `Set HOMEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0 to always wait for it.\n`
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
  }

  /**
   * Whether a default HomeGraph instance is available
   */
  hasDefaultHomeGraph(): boolean {
    return this.cg !== null;
  }

  /**
   * Optional allowlist of exposed tools, parsed from the HOMEGRAPH_MCP_TOOLS
   * env var (comma-separated short names, e.g. "explore,search,node").
   * Unset/empty → every tool is exposed. Set → only the listed tools are
   * exposed. Lets an operator (or an A/B harness) trim the tool surface
   * without rebuilding the client config; the ablated tool is then truly
   * absent from ListTools rather than merely denied on call.
   * Matching is on the short form, so "node" and "homegraph_node" both work.
   */
  private toolAllowlist(): Set<string> | null {
    const raw = process.env.HOMEGRAPH_MCP_TOOLS ?? process.env.HOMEGRAPH_MCP_TOOLS;
    if (!raw || !raw.trim()) return null;
    const short = (s: string) => s.trim().replace(/^homegraph_/, '');
    const set = new Set(raw.split(',').map(short).filter(Boolean));
    return set.size ? set : null;
  }

  /** Whether a tool name passes the HOMEGRAPH_MCP_TOOLS allowlist (if any). */
  private isToolAllowed(name: string): boolean {
    const allow = this.toolAllowlist();
    return !allow || allow.has(name.replace(/^homegraph_/, ''));
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   * The homegraph_explore tool description includes a budget recommendation
   * scaled to the number of indexed files. Honors the HOMEGRAPH_MCP_TOOLS
   * allowlist so a trimmed surface is reflected in ListTools.
   */
  getTools(): ToolDefinition[] {
    const allow = this.toolAllowlist();
    // No explicit allowlist → expose every defined tool. An allowlist trims
    // the surface to only the listed short names.
    let visible = allow
      ? tools.filter(t => allow.has(t.name.replace(/^homegraph_/, '')))
      : tools;
    // No default project loaded → no-root-index case (#993): a gateway server
    // started outside any repo, or a monorepo root whose indexes live in
    // sub-projects. With nothing to fall back to, EVERY call needs an explicit
    // projectPath, so mark it required in the schema — a high-salience nudge the
    // agent acts on, where SERVER_INSTRUCTIONS_NO_ROOT_INDEX's prose alone
    // wasn't enough (the reporter had to add an AGENTS.md note). `this.cg` is
    // settled by `retryInitIfNeeded()` before `handleToolsList` calls us, so a
    // null here means "genuinely no default", not a startup race. When a default
    // IS open we leave projectPath optional (below): a bare call falls back to
    // it, exactly as in the common single-project launch.
    if (!this.cg) return withRequiredProjectPath(visible);

    try {
      const stats = this.cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      // Tiny-repo tool gating: on projects under TINY_REPO_FILE_THRESHOLD
      // files, only expose the core trio (search, node, explore) — one
      // below even the 4-tool default: at this scale callers, too, reduces
      // to one grep. (Historical note: the audit below ran when context and
      // trace still existed; its "5 core tools" are today's trio.)
      //
      // n=2 audits ruled out cutting below 5 tools:
      // - 3-tool gate (search + context + trace): cost regressed on
      //   cobra/ky/sinatra. The agent fell back to raw Reads to cover
      //   what homegraph_node + homegraph_explore would have answered.
      // - 1-tool gate (search only): catastrophic regression — express
      //   went from -43% WIN to +107% LOSS. With only search, the agent
      //   can't navigate the call graph structurally and reads everything.
      //
      // 5 is the empirical lower bound. Tools beyond search/context/
      // node/explore/trace pay overhead that the agent doesn't recoup
      // on tiny-repo flow questions.
      // ITER4: raise threshold 150 → 500 so single-file frameworks
      // (sinatra at 159, slim_framework around 200) also get the
      // 5-tool surface. The empirical 5-tool floor was set on <150
      // probes; iter3 measurement showed sinatra is structurally the
      // SAME problem as cobra (single-file WITHOUT-arm Read wins),
      // so it deserves the same gating.
      const TINY_REPO_FILE_THRESHOLD = 500;
      const TINY_REPO_CORE_TOOLS = new Set([
        'homegraph_explore',
        'homegraph_search',
        'homegraph_node',
        'homegraph_diff_impact',
      ]);
      if (stats.fileCount < TINY_REPO_FILE_THRESHOLD) {
        visible = visible.filter(t => TINY_REPO_CORE_TOOLS.has(t.name));
      }

      return visible.map(tool => {
        if (tool.name === 'homegraph_explore') {
          return {
            ...tool,
            description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
          };
        }
        return tool;
      });
    } catch {
      return visible;
    }
  }

  /**
   * Get HomeGraph instance for a project
   *
   * If projectPath is provided, opens that project's HomeGraph (cached).
   * Otherwise returns the default HomeGraph instance.
   *
   * Walks up parent directories to find the nearest .homegraph/ folder,
   * similar to how git finds .git/ directories.
   */
  private getHomeGraph(projectPath?: string): HomeGraph {
    if (!projectPath) {
      if (!this.cg) {
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new NotIndexedError(
          'No HomeGraph project is loaded for this session.\n' +
          `Searched for a .homegraph/ directory starting from: ${searched}\n` +
          'Either the server root has no index of its own (e.g. a monorepo where only ' +
          "sub-projects are indexed), or the MCP client launched the server outside your " +
          'project without reporting the workspace root. Either way, target the project ' +
          'explicitly:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project" ' +
          '(any project that has a .homegraph/ — including a sub-project of a monorepo)\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "mcp", "--path", "/absolute/path/to/your/project"]\n' +
          'If a project simply has no index, use your built-in tools (Read/Grep/Glob) for THAT ' +
          "project (the user can run 'homegraph init' there to enable it) — you can still query " +
          'other indexed projects by projectPath in the same session.'
        );
      }
      return this.freshen(this.cg);
    }

    // Reject sensitive system directories before opening. Only validate a
    // path that actually exists — a nested or not-yet-created sub-path of a
    // real project must still be allowed to resolve UP to its .homegraph/
    // root below (issue #238), so we don't run the existence-checking
    // validator on paths that are meant to walk up.
    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new PathRefusalError(pathError);
      }
    }

    // Always RE-RESOLVE the nearest .homegraph/ from the input path. The walk
    // is cheap (a few existsSync up the tree) and is the only thing that
    // notices a path whose index root CHANGED since it was first seen — most
    // importantly a git worktree that gained its own .homegraph/ after the
    // (long-lived) server first resolved it up to the parent checkout. We used
    // to short-circuit on a `projectCache[projectPath]` entry before resolving,
    // which pinned that first resolution for the server's whole lifetime, so a
    // worktree kept being served the parent checkout's index until restart
    // (#926). The DB connection itself is still cached (by resolved root,
    // below), so re-resolving costs only the stat walk, never a reopen.
    const resolvedRoot = findNearestHomeGraphRoot(projectPath);

    if (!resolvedRoot) {
      throw new NotIndexedError(
        `The project at ${projectPath} isn't indexed with homegraph (no .homegraph/ directory found ` +
        'walking up from it), so homegraph cannot query it. Use your built-in tools (Read/Grep/Glob) ' +
        "for that codebase instead, and don't call homegraph for it again this session. " +
        "Indexing is the user's decision — they can run 'homegraph init' in that project to enable it."
      );
    }

    // If the path resolves to the default project, reuse the already-open
    // default instance rather than opening a SECOND connection to the same DB.
    // A duplicate connection serializes reads against the watcher's auto-sync
    // writes; when WAL isn't in effect (e.g. a filesystem without shared-memory
    // support) that surfaces as intermittent
    // "database is locked" on concurrent tool calls. See issue #238. The
    // default instance is owned/closed by the server, so it's never cached.
    if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
      return this.freshen(this.cg);
    }

    // Cache the open DB connection by RESOLVED ROOT only — never by the input
    // path. One key per instance means closeAll() closes each exactly once, and
    // a changed resolution maps to a different entry instead of a stale hit.
    const cached = this.projectCache.get(resolvedRoot);
    if (cached) return this.freshen(cached);

    const cg = loadHomeGraph().openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    return cg;
  }

  /**
   * Heal a long-lived connection whose `.homegraph/` was removed and recreated
   * at the same path (a worktree recreated, or `rm -rf .homegraph` + re-init)
   * before handing it to a tool. Otherwise the daemon keeps serving the
   * pre-removal snapshot from its now-unlinked file handle until restart — and
   * because the daemon registry is keyed by path, a same-path recreate routes
   * new clients straight back to this same stale daemon (#925). The check is one
   * stat() and a no-op unless the inode actually changed; it never throws into a
   * tool call.
   */
  private freshen(cg: HomeGraph): HomeGraph {
    try {
      if (cg.reopenIfReplaced()) {
        getMcpQueryCacheIndex(cg.getProjectRoot()).reset();
        process.stderr.write(
          '[HomeGraph MCP] The index was replaced on disk (e.g. a git worktree ' +
          'recreated at the same path); reopened the live database in place.\n'
        );
      }
    } catch {
      // Best-effort self-heal — a failed reopen must never break the tool call;
      // the (still stale) handle keeps serving and the next call retries.
    }
    return cg;
  }

  /**
   * Close all cached project connections
   */
  closeAll(): void {
    for (const cg of this.projectCache.values()) {
      cg.close();
    }
    this.projectCache.clear();
    this.worktreeMismatchCache.clear();
  }

  /**
   * Validate that a value is a non-empty string within length bounds.
   *
   * Bad / oversize args return SUCCESS-shaped guidance (no `isError`) with a
   * retry example — same policy as {@link NotIndexedError}: early `isError`
   * teaches agents to abandon the whole toolset. The length cap still blocks
   * DoS before FTS/work runs.
   */
  private validateString(
    value: unknown,
    name: string,
    maxLength: number = MAX_INPUT_LENGTH
  ): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      const got =
        value === undefined || value === null
          ? 'it was missing'
          : typeof value !== 'string'
            ? `got ${typeof value}`
            : 'got an empty string';
      return this.badArgResult(
        `\`${name}\` must be a non-empty string (${got}).`,
        name,
      );
    }
    if (value.length > maxLength) {
      return this.badArgResult(
        `\`${name}\` exceeds maximum length of ${maxLength} characters (got ${value.length}). ` +
          'Shorten it — pass a concrete symbol/file name, not a pasted dump.',
        name,
      );
    }
    return value;
  }

  /**
   * Validate an optional path-like string input. Returns the value if
   * valid (or undefined), or SUCCESS-shaped guidance when the value is present
   * but invalid (wrong type / oversize).
   */
  private validateOptionalPath(
    value: unknown,
    name: string
  ): string | undefined | ToolResult {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      return this.badArgResult(
        `\`${name}\` must be a string when provided (got ${typeof value}).`,
        name,
      );
    }
    if (value.length > MAX_PATH_LENGTH) {
      return this.badArgResult(
        `\`${name}\` exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length}). ` +
          'Pass a normal project-relative or absolute path.',
        name,
      );
    }
    return value;
  }

  /**
   * Cached git worktree/index mismatch for a tool call's effective project.
   *
   * The "effective project" is what the request targets: an explicit
   * `projectPath` arg, else the directory the server resolved its default
   * project from (`defaultProjectHint`), else cwd. Memoized per start path —
   * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
   * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
   * broken by this check.
   */
  private worktreeMismatchFor(projectPath?: string): WorktreeIndexMismatch | null {
    const startPath = projectPath ?? this.defaultProjectHint ?? process.cwd();

    // The verdict depends on BOTH the start path AND the index root it resolves
    // to, so the cache must be keyed on the pair. Resolve the index root first
    // (cheap — getHomeGraph re-walks to the nearest .homegraph/, no git), then
    // key on `(startPath, indexRoot)`. The moment that root changes — most
    // importantly when a git worktree gains its own index and the walk-up stops
    // there instead of at the parent checkout — the key changes and the verdict
    // is recomputed, instead of serving the stale "borrowed the parent's index"
    // warning for the server's whole lifetime. Keying on startPath alone pinned
    // that first verdict until restart (#926).
    let indexRoot: string;
    try {
      indexRoot = this.getHomeGraph(projectPath).getProjectRoot();
    } catch {
      // No resolvable project (or any other resolution error) → nothing to warn.
      return null;
    }

    const cacheKey = `${startPath}\u0000${indexRoot}`;
    const cached = this.worktreeMismatchCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const mismatch = detectWorktreeIndexMismatch(startPath, indexRoot);
    this.worktreeMismatchCache.set(cacheKey, mismatch);
    return mismatch;
  }

  /**
   * Prefix a successful read-tool result with a compact worktree-mismatch
   * notice when the resolved index belongs to a different git working tree than
   * the caller's (issue #155). Without this, an agent in a nested worktree
   * silently trusts main-branch results. No-op on error results and when there
   * is no mismatch. `homegraph_status` is excluded — it embeds its own verbose
   * warning — so it stays out of this path.
   */
  private withWorktreeNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;
    const mismatch = this.worktreeMismatchFor(projectPath);
    if (!mismatch) return result;

    const notice = worktreeMismatchNotice(mismatch);
    const [first, ...rest] = result.content;
    if (first && first.type === 'text') {
      return { ...result, content: [{ type: 'text', text: `${notice}\n\n${first.text}` }, ...rest] };
    }
    return result;
  }

  /**
   * Annotate a successful read-tool result with per-file staleness — the
   * non-blocking answer to issue #403. The file watcher tracks every event
   * it sees per path; here we intersect "files referenced in this response"
   * against that pending set and prepend a compact banner so the agent can
   * fall back to Read for those *specific* files without waiting for the
   * debounced sync to fire. Other pending files in the project (not
   * referenced by this response) get a small footer so the agent has a
   * complete picture without bloating the banner.
   *
   * Cost when nothing is pending — the common case — is one boolean check.
   * No I/O, no parsing of markdown beyond a per-pending-file substring scan.
   */
  private withStalenessNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;

    let cg: HomeGraph;
    try {
      cg = this.getHomeGraph(projectPath);
    } catch {
      return result; // no default project — leave as is
    }

    // Cross-project `projectPath` calls open a cached HomeGraph WITHOUT a
    // watcher (watchers are only attached to the default session project).
    // When the cross-project path happens to be the same project as the
    // default cg, the cached instance is the wrong one — its pendingFiles is
    // permanently empty. Detect the equal-path case and prefer the default
    // cg so the staleness signal still fires when an agent passes the
    // explicit projectPath form of its own project.
    if (this.cg && cg !== this.cg) {
      try {
        const sameProject =
          resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot());
        if (sameProject) cg = this.cg;
      } catch {
        /* getProjectRoot may throw on a closed instance — leave cg as is */
      }
    }

    // Whole-index degradation (#876): once live watching has permanently
    // stopped, getPendingFiles() is empty so the per-file banner below can't
    // fire — but the index is now FROZEN and silently drifting stale. Surface
    // one global notice instead, so the agent Reads for current content rather
    // than trusting a response off a no-longer-updating index. (Cross-project
    // calls open a watcher-less HomeGraph, so this is false there — correct: we
    // only know degraded state for the default session project.)
    let degraded = false;
    try {
      degraded = cg.isWatcherDegraded?.() ?? false;
    } catch {
      degraded = false;
    }
    if (degraded) {
      const [head, ...tail] = result.content;
      if (!head || head.type !== 'text') return result;
      let reason: string | null = null;
      try {
        reason = cg.getWatcherDegradedReason?.() ?? null;
      } catch {
        reason = null;
      }
      const composed = `${formatDegradedBanner(reason)}\n\n${head.text}`;
      return { ...result, content: [{ type: 'text', text: composed }, ...tail] };
    }

    // Defensive: some test fakes inject a partial HomeGraph stub without the
    // newer pending-files API. Treat missing/throwing as "no pending files."
    let pending: PendingFile[] = [];
    try {
      pending = cg.getPendingFiles?.() ?? [];
    } catch {
      return result;
    }
    if (pending.length === 0) return result;

    const [first, ...rest] = result.content;
    if (!first || first.type !== 'text') return result;

    const text = first.text;
    const inResponse: PendingFile[] = [];
    const elsewhere: PendingFile[] = [];
    for (const p of pending) {
      // Substring match against the project-relative POSIX path — that's
      // exactly the format both the watcher and every homegraph response
      // emit, so a plain includes() is sufficient and avoids regex pitfalls.
      if (text.includes(p.path)) inResponse.push(p);
      else elsewhere.push(p);
    }

    let banner = '';
    if (inResponse.length > 0) {
      let dbPath: string | null = null;
      try {
        // Large indexes skip catch-up — soft banner so agents don't abandon HG for Read.
        const root = cg.getProjectRoot();
        dbPath = resolvePath(root, '.homegraph', 'homegraph.db');
      } catch {
        dbPath = null;
      }
      banner = formatStaleBanner(inResponse, {
        catchUpDeferred: shouldSkipCatchUpSync(dbPath),
      });
    }
    let footer = '';
    if (elsewhere.length > 0) {
      footer = formatStaleFooter(elsewhere);
    }
    if (!banner && !footer) return result;

    const composed = [banner, text, footer].filter(Boolean).join('\n\n');
    return { ...result, content: [{ type: 'text', text: composed }, ...rest] };
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // Block the first tool call on the engine's post-open reconcile so we
      // never serve rows for files deleted/edited while no MCP server was
      // running. The wait is time-boxed (#905): a huge-repo reconcile takes
      // minutes, and blocking the first call on all of it reads as a hang, so
      // we wait briefly then serve and let it finish in the background. The
      // gate is cleared after first await — subsequent calls pay nothing.
      // Catch-up failures are logged by the engine; we proceed regardless so a
      // transient sync error never breaks tools.
      if (this.catchUpGate) {
        const gate = this.catchUpGate;
        this.catchUpGate = null;
        await this.awaitCatchUpGate(gate);
      }
      // Hard process RSS ceiling — any tool/path that already pushed us over must
      // stop with success-shaped Partial (never OOM / multi-GB growth).
      if (isOverRssBudget()) {
        return rssBudgetPartialResult(toolName);
      }
      // Honor the optional tool allowlist (HOMEGRAPH_MCP_TOOLS): a trimmed
      // surface rejects ablated tools defensively even if a client cached them.
      if (!this.isToolAllowed(toolName)) {
        return this.errorResult(`Tool ${toolName} is disabled via HOMEGRAPH_MCP_TOOLS`);
      }
      // Cross-cutting input validation. All tools accept an optional
      // `projectPath` and most accept either `query`, `task`, or
      // `symbol` — bound their lengths centrally so individual handlers
      // can stay focused on tool-specific logic.
      const pathCheck = this.validateOptionalPath(args.projectPath, 'projectPath');
      if (typeof pathCheck === 'object' && pathCheck !== undefined) {
        return pathCheck;
      }
      // The `path` and `pattern` properties used by homegraph_files are
      // also path-shaped — apply the same cap.
      if (args.path !== undefined) {
        const check = this.validateOptionalPath(args.path, 'path');
        if (typeof check === 'object' && check !== undefined) return check;
      }
      if (args.pattern !== undefined) {
        const check = this.validateOptionalPath(args.pattern, 'pattern');
        if (typeof check === 'object' && check !== undefined) return check;
      }

      const projectPath = args.projectPath as string | undefined;

      // Wrong question shapes → short Skip (before cache / graph work).
      if (toolName === 'homegraph_explore' || toolName === 'homegraph_search') {
        const qEarly = typeof args.query === 'string' ? args.query : '';
        if (qEarly) {
          const deferKind = queryShouldDeferToBuiltinTools(qEarly);
          if (deferKind) {
            return this.textResult(homegraphDeferGuidance(deferKind, qEarly));
          }
        }
      }

      const cacheEnabled = isMcpQueryCacheEnabled() && isCacheableMcpTool(toolName);
      let cacheKey: string | undefined;
      let cacheQueries: ReturnType<HomeGraph['getQueryBuilder']> | undefined;
      let cacheIndex: ReturnType<typeof getMcpQueryCacheIndex> | undefined;

      if (cacheEnabled) {
        try {
          const cacheCg = this.getHomeGraph(projectPath);
          cacheQueries = cacheCg.getQueryBuilder();
          cacheIndex = getMcpQueryCacheIndex(cacheCg.getProjectRoot());
          cacheIndex.ensureValid(cacheQueries, () => cacheCg.getLastIndexedAt());
          let fileCount: number | undefined;
          try {
            fileCount = cacheCg.getStats().fileCount;
          } catch {
            fileCount = undefined;
          }
          cacheKey = buildMcpQueryCacheKey(toolName, args, fileCount);
          const cached = cacheIndex.getEntry(cacheQueries, cacheKey);
          if (cached) {
            const withWorktree = this.withWorktreeNotice(cached, projectPath);
            return this.withStalenessNotice(withWorktree, projectPath);
          }
        } catch {
          // No indexed project — fall through; handler returns guidance.
        }
      }

      // homegraph_status reports watcher state (pending files, degraded mode,
      // worktree warning) and embeds its own sections — it must run on the MAIN
      // thread against the watched default instance, so it is NEVER off-loaded to
      // a worker (whose read connection has no watcher). It also skips the
      // auto-banner wrapper to avoid duplicating its own pending-files section.
      if (toolName === 'homegraph_status') {
        return await this.handleStatus(args);
      }

      // Every read tool races a deadline ≪ MCP client ~60s hard timeout and
      // Named-member / local-compact questions finish in tens of ms on the warm
      // main connection. Serving them here — before the query-pool offload —
      // avoids cold-worker / wedged-daemon paths that otherwise surface as empty
      // MCP client `-32001` (the handler itself is fine; the transport times out).
      if (toolName === 'homegraph_explore' || toolName === 'homegraph_search') {
        const q = typeof args.query === 'string' ? args.query : '';
        if (q) {
          try {
            const cgFast = this.getHomeGraph(projectPath);
            const rootFast = cgFast.getProjectRoot();
            const fast =
              (toolName === 'homegraph_explore' || toolName === 'homegraph_search'
                ? this.tryFastInventoryExplore(cgFast, q, rootFast)
                : null)
              ?? (toolName === 'homegraph_explore' || toolName === 'homegraph_search'
                ? this.tryLightMechanismExplore(cgFast, q, rootFast)
                : null)
              ?? this.tryCompactLocalSymbolExplore(cgFast, q, rootFast);
            if (fast) {
              if (cacheEnabled && cacheKey && cacheQueries && cacheIndex && !fast.isError) {
                cacheIndex.setEntry(cacheQueries, cacheKey, toolName, fast);
              }
              const withWorktree = this.withWorktreeNotice(fast, projectPath);
              return this.withStalenessNotice(withWorktree, projectPath);
            }
          } catch {
            // Not indexed / path issue — fall through to normal dispatch.
          }
        }
      }

      // prefers the query pool so sync SQLite/CPU cannot freeze the transport
      // (a frozen main loop prevents setTimeout deadlines from firing → empty
      // `-32001`). Fast-path surveys run inside the worker via executeReadTool.
      const result = await this.runReadToolWithDeadline(toolName, args);
      if (cacheEnabled && cacheKey && cacheQueries && cacheIndex && !result.isError) {
        cacheIndex.setEntry(cacheQueries, cacheKey, toolName, result);
      }
      const withWorktree = this.withWorktreeNotice(result, projectPath);
      return this.withStalenessNotice(withWorktree, projectPath);
    } catch (err) {
      // Expected condition, not a malfunction: answer as a SUCCESS so the
      // agent keeps trusting the toolset for projects that ARE indexed.
      // (An isError here teaches session-long abandonment — see NotIndexedError.)
      if (err instanceof NotIndexedError) {
        return this.textResult(err.message);
      }
      // Security refusal: a clean error, no retry encouragement.
      if (err instanceof PathRefusalError) {
        return this.errorResult(err.message);
      }
      return this.errorResult(
        `Tool execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'This is an internal homegraph error — retry the call once; if it persists, ' +
        'continue without homegraph for this task.'
      );
    }
  }

  /**
   * Dispatch a read tool with a hard deadline under the typical ~60s MCP client
   * timeout.
   *
   * - **Heavy** tools (explore/impact) → query pool (keeps transport free).
   * - **Light** tools (search/node/callers/…) → warm main connection (pool cold
   *   open of a large WAL index routinely outruns the client; search used to
   *   finish in <1s on the already-open main DB).
   *
   * Soft/deadline replies are **static busy text only** — never FTS / explore
   * on the main thread. A previous path called `searchNodes` from the timeout
   * callback with the full natural-language query, freezing the event loop so
   * the success-shaped reply never flushed → empty client `-32001`.
   */
  private async runReadToolWithDeadline(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const deadlineMs = resolveToolDeadlineMs();
    const light =
      toolName === 'homegraph_search'
      || toolName === 'homegraph_node'
      || toolName === 'homegraph_callers'
      || toolName === 'homegraph_callees'
      || toolName === 'homegraph_files';

    const work = (): Promise<ToolResult> => {
      if (!light && this.queryPool && this.queryPool.healthy) {
        return this.queryPool.run(toolName, args, {
          // Static Partial only — never DB/FTS on the soft-timeout callback
          // (any sync work here can freeze the MCP transport → empty -32001).
          onSoftTimeout: () => this.deadlineBusyResult(deadlineMs),
        });
      }
      return (async () => {
        await new Promise<void>((r) => setImmediate(r));
        return this.executeReadTool(toolName, args);
      })();
    };

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ToolResult>((resolve) => {
      // Keep this timer ref'd so a blocked sync stretch still flushes Partial
      // once the event loop runs again — do not call wrapPartialBusyResult here.
      timer = setTimeout(() => {
        resolve(this.deadlineBusyResult(deadlineMs));
      }, deadlineMs);
    });

    try {
      return await Promise.race([work(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Success-shaped busy note — no DB, never blocks the transport. */
  private deadlineBusyResult(deadlineMs: number): ToolResult {
    const secs = Math.max(1, Math.round(deadlineMs / 1000));
    return this.textResult(
      `⚠️ **Partial result** — HomeGraph hit its ${secs}s response deadline / is busy ` +
      `(MCP clients typically kill the call at ~60s with an empty timeout). ` +
      `This is NOT an error. Retry ONE \`homegraph_explore\` with concrete symbol/file names from the question — ` +
      `do not fire search+explore or node+callers+callees in parallel, and do not grep/read symbols you already named.`,
    );
  }

  /**
   * Run a single read tool to completion and return its raw {@link ToolResult},
   * classifying expected failures the same way {@link execute}'s catch does so
   * the SHAPE is identical whether dispatch runs in-process or on a worker:
   * NotIndexed → success-shaped guidance, PathRefusal → clean error, anything
   * else → internal-error-with-retry. Never throws.
   *
   * This is the worker thread's entry point (see {@link ./query-worker}) and the
   * in-process fallback for {@link execute}. It deliberately does NOT run the
   * catch-up gate or the staleness/worktree notices — those need the daemon's
   * watched main instance and stay on the main thread. Cross-cutting allowlist +
   * path validation already ran in {@link execute} before routing here.
   */
  async executeReadTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // Compact inventory / one-symbol surveys — safe on the worker (keeps the
      // daemon main loop free). Never run these unprotected on the MCP transport
      // thread: they can block long enough for the client to emit empty `-32001`.
      const fastPath = this.tryFastPathResult(toolName, args);
      if (fastPath) return fastPath;
      return await this.dispatchTool(toolName, args);
    } catch (err) {
      if (err instanceof NotIndexedError) {
        return this.textResult(err.message);
      }
      if (err instanceof PathRefusalError) {
        return this.errorResult(err.message);
      }
      return this.errorResult(
        `Tool execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'This is an internal homegraph error — retry the call once; if it persists, ' +
        'continue without homegraph for this task.'
      );
    }
  }

  /**
   * Pure dispatch over the read tools — the switch, with no gate, no notices, no
   * allowlist/validation (the caller owns those). `homegraph_status` is handled
   * on the main thread in {@link execute} and never reaches here. May throw
   * NotIndexed/PathRefusal, which {@link executeReadTool} classifies.
   */
  private async dispatchTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case 'homegraph_search': return await this.handleSearch(args);
      case 'homegraph_callers': return await this.handleCallers(args);
      case 'homegraph_callees': return await this.handleCallees(args);
      case 'homegraph_impact': return await this.handleImpact(args);
      case 'homegraph_diff_impact': return await this.handleDiffImpact(args);
      case 'homegraph_explore': return await this.handleExplore(args);
      case 'homegraph_node': return await this.handleNode(args);
      case 'homegraph_files': return await this.handleFiles(args);
      case 'homegraph_spec_match': return await this.handleSpecMatch(args);
      case 'homegraph_spec_find': return await this.handleSpecFind(args);
      case 'homegraph_spec_trace': return await this.handleSpecTrace(args);
      default: return this.errorResult(`Unknown tool: ${toolName}`);
    }
  }

  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const deferKind = queryShouldDeferToBuiltinTools(query);
    if (deferKind) {
      return this.textResult(homegraphDeferGuidance(deferKind, query));
    }

    const cg = this.getHomeGraph(args.projectPath as string | undefined);
    // Explore redirect is best-effort — incomplete/faked graphs (or missing
    // getProjectRoot) must fall through to FTS search rather than error.
    try {
      const projectRoot = cg.getProjectRoot();
      if (queryShouldPreferExploreOverSearch(query)) {
        const exploreRedirect = this.tryFastInventoryExplore(cg, query, projectRoot)
          ?? this.tryLightMechanismExplore(cg, query, projectRoot)
          ?? this.tryCompactLocalSymbolExplore(cg, query, projectRoot);
        if (exploreRedirect) return exploreRedirect;
      }

      const exploreRedirect = this.tryFastInventoryExplore(cg, query, projectRoot)
        ?? this.tryLightMechanismExplore(cg, query, projectRoot)
        ?? this.tryCompactLocalSymbolExplore(cg, query, projectRoot);
      if (exploreRedirect) return exploreRedirect;
    } catch {
      // Fall through to FTS search.
    }

    const rawKind = args.kind as string | undefined;
    // The schema enum says 'type' (what agents naturally reach for); the
    // NodeKind is 'type_alias'. Without the mapping, kind: "type" silently
    // matched nothing — a filter value we advertise must work.
    const kind = rawKind === 'type' ? 'type_alias' : rawKind;
    const rawLimit = Number(args.limit);
    const limit = clamp(isNaN(rawLimit) ? 10 : rawLimit, 1, 100);

    const results = cg.searchNodes(query, {
      limit,
      kinds: kind ? [kind as NodeKind] : undefined,
    });

    if (results.length === 0) {
      return this.textResult(`No results found for "${query}"`);
    }

    // Down-rank generated files within the FTS-returned set so a search
    // for "Send" surfaces the hand-written keeper before .pb.go stubs
    // that share the name. Stable: only reorders generated vs. not.
    const ranked = [...results].sort((a, b) => {
      const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
      return aGen - bGen;
    });

    const formatted = this.formatSearchResults(ranked);
    const steer =
      '\n\n> Locations only. For source / callers / how it works, call `homegraph_explore` ' +
      'with these symbol names next — do not re-search or grep the same names.';
    return this.textResult(this.truncateOutput(formatted + steer));
  }

  /**
   * Group symbol matches into DISTINCT DEFINITIONS — one group per
   * (filePath, qualifiedName), so same-file overloads stay together while
   * unrelated same-named classes across a monorepo's apps (#764: one
   * `UserService` per NestJS app) are kept apart. Optionally narrowed by a
   * `file` path/suffix first.
   */
  private groupDefinitions(
    nodes: Node[],
    fileFilter: string | undefined
  ): { groups: Node[][]; filteredOut: boolean } {
    let pool = nodes;
    let filteredOut = false;
    if (fileFilter) {
      const wanted = fileFilter.replace(/^\.\//, '');
      const narrowed = pool.filter(
        (n) => n.filePath === wanted || n.filePath.endsWith(wanted) || n.filePath.endsWith(`/${wanted}`)
      );
      if (narrowed.length > 0) {
        pool = narrowed;
      } else {
        filteredOut = true;
      }
    }
    const byDef = new Map<string, Node[]>();
    for (const n of pool) {
      const key = `${n.filePath}|${n.qualifiedName}`;
      const group = byDef.get(key);
      if (group) group.push(n);
      else byDef.set(key, [n]);
    }
    return { groups: [...byDef.values()], filteredOut };
  }

  /** Section heading for one distinct definition in grouped output. */
  private definitionHeading(group: Node[]): string {
    const head = group[0]!;
    const line = head.startLine ? `:${head.startLine}` : '';
    return `**${head.qualifiedName}** (${head.kind}) — ${head.filePath}${line}`;
  }

  /**
   * Handle homegraph_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getHomeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const collect = (defNodes: Node[]) => {
      const seen = new Set<string>();
      const callers: Node[] = [];
      const labels = new Map<string, string>();
      for (const node of defNodes) {
        if (isOverRssBudget()) break;
        for (const c of cg.getCallers(node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            callers.push(c.node);
            const label = this.edgeLabel(c.edge);
            if (label) labels.set(c.node.id, label);
          }
          if (callers.length >= limit) return { callers, labels };
        }
      }
      return { callers, labels };
    };

    // Single definition (or same-file overloads): the familiar flat list.
    if (groups.length === 1) {
      const { callers, labels } = collect(groups[0]!);
      if (callers.length === 0) {
        // Empty callers often means registration/callback wiring (OnSurfaceChangedCB)
        // — a one-line "no callers" teaches Grep/node thrash. Prefer compact body +
        // text-usage sites when the symbol is a local anchor.
        try {
          const root = cg.getProjectRoot();
          const compact = this.tryCompactLocalSymbolExplore(cg, symbol, root);
          if (compact) return compact;
        } catch { /* fall through */ }
        return this.textResult(`No callers found for "${symbol}"${allMatches.note}${filterNote}`);
      }
      // A successful `file` narrowing makes the multi-symbol aggregation note
      // stale — suppress it.
      const note = fileFilter && !filteredOut ? '' : allMatches.note;
      const includeBlock = this.formatCallerIncludeVisibility(cg, callers.slice(0, limit));
      const formatted = this.formatNodeList(callers.slice(0, limit), `Callers of ${symbol}`, labels)
        + includeBlock
        + '\n\n> Caller listing complete — answer from this list'
        + (includeBlock ? ' + include/import visibility' : '')
        + '; no read/grep needed.'
        + '\n> If another type\'s visibility matters, pass **both** names to `homegraph_explore` (not callers alone).'
        + note + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // Multiple DISTINCT definitions (#764): one section per definition so an
    // agent never mistakes one app's callers for another's. Narrow with
    // `file` to focus a single definition.
    const lines: string[] = [
      `**Callers of ${symbol} — ${groups.length} distinct definitions (narrow with \`file\`)**`,
    ];
    for (const group of groups) {
      const { callers, labels } = collect(group);
      lines.push('', this.definitionHeading(group));
      if (callers.length === 0) {
        lines.push('- (no callers)');
        continue;
      }
      for (const node of callers.slice(0, limit)) {
        const location = node.startLine ? `:${node.startLine}` : '';
        const label = labels.get(node.id);
        lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`);
      }
    }
    return this.textResult(this.truncateOutput(
      lines.join('\n') + filterNote + '\n\n> Caller listing complete — answer from this list; no read/grep needed.',
    ));
  }

  /**
   * Handle homegraph_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getHomeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const collect = (defNodes: Node[]) => {
      const seen = new Set<string>();
      const callees: Node[] = [];
      const labels = new Map<string, string>();
      const defPaths = defNodes.map((n) => n.filePath);
      const affinity = (fp: string): boolean =>
        defPaths.some((dp) => {
          const a = dp.replace(/\\/g, '/').split('/');
          const b = fp.replace(/\\/g, '/').split('/');
          return a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[1] === b[1];
        });
      for (const node of defNodes) {
        for (const c of cg.getCallees(node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            callees.push(c.node);
            const label = this.edgeLabel(c.edge);
            if (label) labels.set(c.node.id, label);
          }
        }
      }
      // Prefer same-package callees when present — cross-package logError/logInfo
      // homonyms poison upstream/downstream answers.
      const near = callees.filter((n) => affinity(n.filePath));
      return { callees: near.length > 0 ? near : callees, labels };
    };

    if (groups.length === 1) {
      const { callees, labels } = collect(groups[0]!);
      if (callees.length === 0) {
        return this.textResult(`No callees found for "${symbol}"${allMatches.note}${filterNote}`);
      }
      // A successful `file` narrowing makes the multi-symbol aggregation note
      // stale — suppress it.
      const note = fileFilter && !filteredOut ? '' : allMatches.note;
      const formatted = this.formatNodeList(callees.slice(0, limit), `Callees of ${symbol}`, labels) + note + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // Multiple DISTINCT definitions (#764): per-definition sections.
    const lines: string[] = [
      `**Callees of ${symbol} — ${groups.length} distinct definitions (narrow with \`file\`)**`,
    ];
    for (const group of groups) {
      const { callees, labels } = collect(group);
      lines.push('', this.definitionHeading(group));
      if (callees.length === 0) {
        lines.push('- (no callees)');
        continue;
      }
      for (const node of callees.slice(0, limit)) {
        const location = node.startLine ? `:${node.startLine}` : '';
        const label = labels.get(node.id);
        lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`);
      }
    }
    return this.textResult(this.truncateOutput(lines.join('\n') + filterNote));
  }

  /**
   * Handle homegraph_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getHomeGraph(args.projectPath as string | undefined);
    const depth = clamp((args.depth as number) || 2, 1, 10);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const impactOf = (defNodes: Node[]) => {
      const mergedNodes = new Map<string, Node>();
      const mergedEdges: Edge[] = [];
      const seenEdges = new Set<string>();
      for (const node of defNodes) {
        const impact = cg.getImpactRadius(node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, n);
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            mergedEdges.push(e);
          }
        }
      }
      return { nodes: mergedNodes, edges: mergedEdges, roots: defNodes.map((n) => n.id) };
    };

    // Single definition (or same-file overloads): the familiar merged report.
    if (groups.length === 1) {
      const formatted = this.formatImpact(symbol, impactOf(groups[0]!)) + (fileFilter && !filteredOut ? "" : allMatches.note) + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // Multiple DISTINCT definitions (#764): a blast radius PER definition —
    // merging unrelated same-named classes (one UserService per monorepo app)
    // overstated impact and confused agents. Narrow with `file`.
    const sections: string[] = [
      `**Impact of ${symbol} — ${groups.length} distinct definitions (each with its own blast radius; narrow with \`file\`)**`,
    ];
    for (const group of groups) {
      const head = group[0]!;
      const line = head.startLine ? `:${head.startLine}` : '';
      sections.push(
        '',
        this.formatImpact(`${head.qualifiedName} (${head.filePath}${line})`, impactOf(group))
      );
    }
    return this.textResult(this.truncateOutput(sections.join('\n') + filterNote));
  }

  /**
   * Handle homegraph_diff_impact — diff line ranges ∩ symbol spans → evidence pack.
   */
  private async handleDiffImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const resolved = resolveDiffImpactHunks({
      diff: args.diff,
      hunks: args.hunks,
    });
    if (resolved.error) {
      return this.badArgResult(resolved.error, 'diff');
    }
    if (resolved.hunks.length === 0) {
      return this.badArgResult(
        'No file hunks found. Pass a unified `diff` with `+++` / `@@` headers, or `hunks: [{ path, startLine, endLine }]`.',
        'diff',
      );
    }

    const cg = this.getHomeGraph(args.projectPath as string | undefined);
    const depthRaw = Number(args.depth);
    const depth = Number.isFinite(depthRaw) ? depthRaw : 2;
    const includeSpecs = args.includeSpecs === true;

    const pack = buildDiffImpactPack(cg, resolved.hunks, {
      depth,
      notes: resolved.notes,
    });

    type RelatedSpec = {
      specId: string;
      title: string;
      via: 'file' | 'symbol';
      symbol?: string;
      filePath?: string;
      score?: number;
    };
    const relatedSpecs: RelatedSpec[] = [];

    if (includeSpecs) {
      const { resolveDbPath } = require('../spec/utils') as typeof import('../spec/utils');
      const { createDatabase } = require('../db/sqlite-adapter') as typeof import('../db/sqlite-adapter');
      const {
        findSpecsByFilePath,
        findSpecsByCodeSymbol,
      } = require('../spec/graph/queries') as typeof import('../spec/graph/queries');

      const projectRoot = (() => {
        try {
          return cg.getProjectRoot();
        } catch {
          return (args.projectPath as string | undefined) || process.cwd();
        }
      })();
      const dbPath = resolveDbPath(projectRoot);
      let db: SqliteDatabase | null = null;
      try {
        db = createDatabase(dbPath).db;
      } catch {
        pack.notes.push(
          `includeSpecs was true but Commit4Spec DB is unavailable at ${dbPath} (run \`homegraph spec build\` / \`mine\` first).`,
        );
      }

      if (db) {
        try {
          const seenFileSpecs = new Set<string>();
          for (const filePath of pack.changedFiles) {
            try {
              const found = findSpecsByFilePath(db, filePath);
              for (const r of found.results ?? []) {
                if (!r.id || seenFileSpecs.has(r.id)) continue;
                seenFileSpecs.add(r.id);
                relatedSpecs.push({
                  specId: r.id,
                  title: r.title,
                  via: 'file',
                  filePath,
                });
              }
            } catch {
              /* ignore per-file */
            }
          }

          const forTrace = pack.changedSymbols.slice(0, DIFF_IMPACT_LIMITS.maxSpecSymbols);
          if (pack.changedSymbols.length > forTrace.length) {
            pack.notes.push(
              `Spec symbol-trace limited to ${DIFF_IMPACT_LIMITS.maxSpecSymbols} of ${pack.changedSymbols.length} changed symbols.`,
            );
          }
          const seenSymKeys = new Set<string>();
          for (const sym of forTrace) {
            try {
              const traced = findSpecsByCodeSymbol(
                db,
                {
                  name: sym.name,
                  qualifiedName: sym.name,
                  kind: sym.kind,
                  filePath: sym.filePath,
                  startLine: sym.startLine,
                  endLine: sym.endLine,
                },
                5,
              );
              for (const m of traced.matches ?? []) {
                const id = m.spec?.id;
                if (!id) continue;
                const key = `${id}::${sym.name}`;
                if (seenSymKeys.has(key)) continue;
                seenSymKeys.add(key);
                relatedSpecs.push({
                  specId: id,
                  title: m.spec.title,
                  via: 'symbol',
                  symbol: sym.name,
                  score: typeof m.score === 'number' ? m.score : undefined,
                });
              }
            } catch {
              /* ignore per-symbol */
            }
          }
        } finally {
          try {
            db.close();
          } catch {
            /* ignore */
          }
        }
      }
    }

    const response = {
      ...pack,
      // Drop raw hunk ranges from default agent payload noise — keep changedFiles + symbols.
      hunks: pack.hunks.map((h) => ({
        path: h.path,
        ranges: h.ranges,
      })),
      relatedSpecs: includeSpecs ? relatedSpecs : undefined,
    };

    const json = JSON.stringify(response, null, 2);
    if (json.length <= MAX_OUTPUT_LENGTH) {
      return this.textResult(json);
    }
    const slim = {
      ...response,
      callers: response.callers.slice(0, 20),
      impactSummary: response.impactSummary.map((s) => ({
        ...s,
        sampleNames: s.sampleNames.slice(0, 3),
      })),
      uiEdges: response.uiEdges.slice(0, 15),
      relatedSpecs: response.relatedSpecs?.slice(0, 15),
      notes: [
        ...response.notes,
        'Output trimmed to fit MCP size limit — re-run with a smaller diff if you need full lists.',
      ],
    };
    return this.textResult(this.truncateOutput(JSON.stringify(slim, null, 2)));
  }

  /** Whether a graph edge may be traversed by homegraph_explore's main Flow BFS. */
  private isExploreFlowEdge(edge: Edge): boolean {
    if (edge.kind === 'calls') return true;
    if (edge.kind !== 'references' || edge.provenance !== 'heuristic') return false;
    const m = edge.metadata as Record<string, unknown> | undefined;
    if (m?.synthesizedBy !== 'viewtree') return false;
    const via = typeof m.via === 'string' ? m.via : '';
    return via.length > 0 && !VIEWTREE_STRUCTURE_VIAS.has(via);
  }

  /**
   * Describe a synthesized (dynamic-dispatch) edge for human output: how the
   * callback was wired up — the bridge static parsing can't see. Returns null
   * for ordinary static edges. Used by trace + the node trail so a synthesized
   * hop reads as "registered via onUpdate at App.tsx:3148", not a bare arrow.
   */
  private synthEdgeNote(edge: Edge | null): { label: string; compact: string; registeredAt?: string } | null {
    if (!edge || edge.provenance !== 'heuristic') return null;
    const m = edge.metadata as Record<string, unknown> | undefined;
    const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
    const at = registeredAt ? ` @${registeredAt}` : '';
    if (m?.synthesizedBy === 'callback') {
      const via = m.via ? `\`${String(m.via)}\`` : 'a registrar';
      const field = m.field ? ` on .${String(m.field)}` : '';
      return {
        label: `callback — registered via ${via}${field} (dynamic dispatch)`,
        compact: `dynamic: callback via ${via}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'event-emitter') {
      const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
      return {
        label: `event ${ev} — emit → handler (dynamic dispatch)`,
        compact: `dynamic: event ${ev}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'react-render') {
      return {
        label: `React re-render — \`setState\` re-runs render() (dynamic dispatch)`,
        compact: `dynamic: React re-render via setState${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'jsx-render') {
      const child = m.via ? `<${String(m.via)}>` : 'a child component';
      return {
        label: `renders ${child} (JSX child — dynamic dispatch)`,
        compact: `dynamic: renders ${child}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'vue-handler') {
      const ev = m.event ? `@${String(m.event)}` : 'a template event';
      return {
        label: `Vue template handler — bound to ${ev} (dynamic dispatch)`,
        compact: `dynamic: Vue ${ev} handler`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'viewtree') {
      const via = typeof m.via === 'string' ? m.via : '';
      if (via === 'Prop') {
        return {
          label: `@Prop one-way state transfer (parent → child)`,
          compact: `state: @Prop one-way${at}`,
          registeredAt,
        };
      }
      if (via === 'Link') {
        return {
          label: `@Link two-way state transfer (parent ↔ child)`,
          compact: `state: @Link two-way${at}`,
          registeredAt,
        };
      }
      if (via && !VIEWTREE_STRUCTURE_VIAS.has(via)) {
        return {
          label: `ArkUI event \`.${via}\` — bound handler (dynamic dispatch)`,
          compact: `dynamic: ArkUI .${via}${at}`,
          registeredAt,
        };
      }
    }
    if (m?.synthesizedBy === 'interface-impl') {
      return {
        label: `interface/abstract dispatch — runs the implementation override (dynamic dispatch)`,
        compact: `dynamic: interface → impl${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'closure-collection') {
      const field = m.field ? `\`${String(m.field)}\`` : 'a collection';
      return {
        label: `closure collection — runs handlers appended to ${field} (dynamic dispatch)`,
        compact: `dynamic: runs ${field} handlers${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'fn-pointer-dispatch') {
      const via = m.via ? `\`${String(m.via)}\`` : 'a function pointer';
      return {
        label: `function-pointer dispatch via ${via} (dynamic dispatch)`,
        compact: `dynamic: fn-pointer ${m.via ? String(m.via) : ''}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'goframe-route') {
      const route = m.route ? `\`${String(m.route)}\`` : 'a route';
      return {
        label: `GoFrame route ${route} — reflective Bind → controller method (dynamic dispatch)`,
        compact: `dynamic: GoFrame route ${m.route ? String(m.route) : ''}${at}`,
        registeredAt,
      };
    }
    // Generic fallback for any other synthesizer (redux-thunk, gin-middleware-chain,
    // flutter-build, …): a synthesized hop must never read as a bare static `calls`.
    // It's a dynamic-dispatch bridge — label it as one and keep its wiring site.
    if (typeof m?.synthesizedBy === 'string') {
      const kind = m.synthesizedBy.replace(/-/g, ' ');
      return { label: `${kind} (dynamic dispatch)`, compact: `dynamic: ${kind}${at}`, registeredAt };
    }
    return null;
  }

  /**
   * Flow-from-named-symbols: an agent's homegraph_explore query is a bag of
   * symbol names that usually spans the flow it's investigating (e.g.
   * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
   * Surface the longest call chain AMONG those named symbols — scoped to what the
   * agent explicitly named, so (unlike a fuzzy relevance set) there's no
   * wrong-feature wandering. Rides synthesized edges, so controller→service-
   * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
   *
   * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
   * CO-NAMING: the agent names the class too, so we keep only `list` candidates
   * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
   * dropping unrelated `OmsOrderService::list`.
   */
  private buildFlowFromNamedSymbols(cg: HomeGraph, query: string): { text: string; pathNodeIds: Set<string>; namedNodeIds: Set<string>; uniqueNamedNodeIds: Set<string>; spineCallSites: Map<string, number> } {
    // spineCallSites: for each spine node, the line where it CALLS the next hop —
    // lets the source assembler window an oversize spine method (e.g. n8n's 962-line
    // processRunExecutionData) to the call site instead of dumping the whole body.
    const EMPTY = { text: '', pathNodeIds: new Set<string>(), namedNodeIds: new Set<string>(), uniqueNamedNodeIds: new Set<string>(), spineCallSites: new Map<string, number>() };
    try {
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      // Strip only a REAL file extension (Create.cs → Create); KEEP qualified
      // names (Class.method / Class::method) — the agent's most precise input,
      // resolved exactly by findAllSymbols. (The old strip mangled Class.method
      // into Class, throwing the method away.)
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro)$/i;
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
      )].slice(0, 16);
      if (tokens.length < 2) return EMPTY;
      // Pool of name SEGMENTS (Class + method from every token) used to
      // disambiguate an ambiguous SIMPLE name: keep a candidate only if its
      // CONTAINER class is itself named in the query.
      const segPool = new Set<string>();
      for (const t of tokens) for (const s of t.toLowerCase().split(/::|\./)) if (s) segPool.add(s);
      const named = new Map<string, Node>();
      // Nodes whose token is SPECIFIC — a (near-)unique callable name (<=3 defs in
      // the whole graph). These are safe to SPARE a file on: the agent named THIS
      // method (`getResponseWithInterceptorChain`, 1 def). A hyper-polymorphic name
      // (`as_sql`, 110 defs across every Expression/Compiler subclass) is NOT here,
      // so naming it doesn't keep every backend variant full and flood the budget.
      const uniqueNamedNodeIds = new Set<string>();
      // token → resolved node ids: drives the token-coverage check that gates
      // the dynamic-boundary scan (a token is covered when ANY of its nodes
      // lands on the main chain — overloads off the chain don't count against).
      const tokenNodes = new Map<string, string[]>();
      // token → its full same-name callable family (before the container filter).
      // A LARGE family that fails to connect on the chain is a polymorphic
      // interface/registry dispatch — surfaced by buildPolymorphicBoundaries below.
      const tokenFamily = new Map<string, Node[]>();
      // Non-callable endpoints (CONSTANT/VARIABLE/FIELD) connected by a SYNTHESIZED
      // edge. RTK thunks are `const X = createAsyncThunk(...)`, so a thunk→thunk hop
      // is constant→constant — the CALLABLE-only `named` set can't hold it, and
      // without this the hop is invisible to the Flow path at every tier (the
      // Relationships section catches it only on repos ≥500 files). Kept SEPARATE
      // from `named` (which drives the call-chain + source sizing, callable-only);
      // fed only to the dynamic-dispatch-links scan below.
      const dynNamed = new Map<string, Node>();
      const DYN_KINDS = new Set(['constant', 'variable', 'field', 'property']);
      const hasHeuristicEdge = (id: string): boolean =>
        [...cg.getCallers(id), ...cg.getCallees(id)].some(({ edge }) => edge.provenance === 'heuristic');
      for (const t of tokens) {
        const hits = this.findAllSymbols(cg, t).nodes;
        const cands = hits.filter((n) => CALLABLE.has(n.kind));
        tokenFamily.set(t, cands);
        // Prefer in-repo callables over attached OHOS SDK stubs (`ohos-sdk:…`).
        // Lifecycle names like `aboutToAppear` / `build` collide with dozens of
        // API defs; counting those as ambiguity empties co-naming and drops the
        // project method the agent actually meant (ArkTS explore Flow regression).
        // Do NOT fall back to the full pool when co-naming empties — that would
        // pin a polymorphic name like `execute` (9+ impls) onto the Flow spine
        // and silence the Interface-dispatch announcement.
        const projectCands = cands.filter((n) => !isOhosApiFilePath(n.filePath));
        const pool = projectCands.length > 0 ? projectCands : cands;
        // A qualified or otherwise-specific name (<=3 hits) keeps all; an
        // ambiguous simple name keeps only candidates whose container is named.
        const specific = pool.length <= 3;
        const pick = specific
          ? pool
          : pool.filter((n) => {
              const segs = (n.qualifiedName || '').toLowerCase().split(/::|\./).filter(Boolean);
              const container = segs.length >= 2 ? segs[segs.length - 2] : '';
              return !!container && segPool.has(container);
            });
        const kept = pick.slice(0, 6);
        tokenNodes.set(t, kept.map((n) => n.id));
        for (const n of kept) {
          named.set(n.id, n);
          if (specific) uniqueNamedNodeIds.add(n.id);
        }
        // Same token, non-callable synth endpoints (capped, precision-gated on an
        // actual heuristic edge so plain config constants never qualify).
        if (dynNamed.size < 12) {
          for (const n of hits) {
            if (CALLABLE.has(n.kind) || !DYN_KINDS.has(n.kind) || dynNamed.has(n.id)) continue;
            if (hasHeuristicEdge(n.id)) dynNamed.set(n.id, n);
            if (dynNamed.size >= 12) break;
          }
        }
        if (named.size > 40) break;
      }
      // Surface synthesized (heuristic) edges incident to a named symbol — INCLUDING
      // the non-callable CONSTANT endpoints in `dynNamed`. `skipInChain` drops a hop
      // already shown in the rendered main chain (a 2-node chain renders nothing, so a
      // direct named→named synth hop still surfaces — #687).
      const collectSynthLinks = (skipInChain: ((e: Edge) => boolean) | null): string[] => {
        const synthLines: string[] = [];
        const synthSeen = new Set<string>();
        for (const n of [...named.values(), ...dynNamed.values()]) {
          if (synthLines.length >= 6) break;
          for (const { node: other, edge } of [...cg.getCallers(n.id), ...cg.getCallees(n.id)]) {
            if (synthLines.length >= 6) break;
            if (edge.provenance !== 'heuristic' || other.id === n.id) continue;
            if (skipInChain && skipInChain(edge)) continue;
            const src = edge.source === n.id ? n : other;
            const tgt = edge.source === n.id ? other : n;
            const key = `${src.name}>${tgt.name}`;
            if (synthSeen.has(key)) continue;
            synthSeen.add(key);
            const note = this.synthEdgeNote(edge);
            synthLines.push(`- ${src.name} → ${tgt.name}   [${note ? note.compact : edge.kind}]`);
          }
        }
        return synthLines;
      };
      if (named.size < 2) {
        // <2 CALLABLES resolved. Two recoveries before giving up: (1) synthesized
        // edges among named CONSTANT/VARIABLE endpoints — RTK thunk→thunk is
        // constant→constant, so `named` can be empty while `dynNamed` holds the
        // whole chain; (2) the one resolved callable's body may hold the
        // dynamic-dispatch site that EXPLAINS a half-connected flow.
        const synthLines = collectSynthLinks(null);
        const boundaries = named.size === 0 ? '' : (this.buildDynamicBoundaries(cg, [...named.values()], named) || '');
        if (synthLines.length === 0 && !boundaries) return EMPTY;
        const out: string[] = [];
        if (synthLines.length) out.push(
          '**Dynamic-dispatch links among your symbols**',
          '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
          '', ...synthLines, '');
        if (boundaries) out.push(boundaries);
        out.push('> Full source for these symbols is below.\n');
        return { text: out.join('\n'), pathNodeIds: new Set(), namedNodeIds: new Set<string>([...named.keys(), ...dynNamed.keys()]), uniqueNamedNodeIds, spineCallSites: new Map<string, number>() };
      }
      const MAX_HOPS = 7;
      let best: Array<{ node: Node; edge: Edge | null }> | null = null;
      // BFS the full call graph (incl. synth edges) from each named seed, but
      // only ACCEPT a sink that is also named — both ends anchored to symbols the
      // agent named, so the chain stays on-topic while bridging intermediates
      // (e.g. the exact interface overload) that the token resolution missed.
      for (const seed of [...named.values()].slice(0, 8)) {
        const parent = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
        parent.set(seed.id, { prev: null, edge: null, node: seed });
        const q: Array<{ id: string; depth: number; streak: number }> = [{ id: seed.id, depth: 0, streak: 0 }];
        let deep: string | null = null, deepDepth = 0;
        const MAX_BRIDGE = 1; // ≤1 consecutive UNNAMED hop: bridge one missing intermediate, never wander a god-function's fan-out
        for (let h = 0; h < q.length && parent.size < 1500; h++) {
          const { id, depth, streak } = q[h]!;
          if (id !== seed.id && named.has(id) && depth > deepDepth) { deep = id; deepDepth = depth; }
          if (depth >= MAX_HOPS - 1) continue;
          for (const c of cg.getCallees(id)) {
            if (!this.isExploreFlowEdge(c.edge) || parent.has(c.node.id)) continue;
            const newStreak = named.has(c.node.id) ? 0 : streak + 1;
            if (newStreak > MAX_BRIDGE) continue;
            parent.set(c.node.id, { prev: id, edge: c.edge, node: c.node });
            q.push({ id: c.node.id, depth: depth + 1, streak: newStreak });
          }
        }
        if (!deep) continue;
        const chain: Array<{ node: Node; edge: Edge | null }> = [];
        let cur: string | null = deep;
        while (cur) { const p = parent.get(cur); if (!p) break; chain.push({ node: p.node, edge: p.edge }); cur = p.prev; }
        chain.reverse();
        if (!best || chain.length > best.length) best = chain;
      }
      const hasMain = !!best && best.length >= 3;
      const pathIds = new Set((best ?? []).map((s) => s.node.id));
      // Where each spine node calls the NEXT hop (best[i+1].edge is the edge from
      // best[i] → best[i+1]; its line is the call site inside best[i]'s body). Lets
      // the assembler window an oversize spine method to the call instead of dumping it.
      const spineCallSites = new Map<string, number>();
      if (best) for (let i = 0; i < best.length - 1; i++) {
        const ln = best[i + 1]?.edge?.line;
        if (ln && ln > 0 && !spineCallSites.has(best[i]!.node.id)) spineCallSites.set(best[i]!.node.id, ln);
      }

      // Dynamic-boundary scan (#687) — fires ONLY when the flow the agent
      // asked about did not fully connect: some token resolved to nodes but
      // none of them sit on the main chain (or there is no chain at all). A
      // healthy flow skips this entirely. Scan order: the chain's dead end
      // first (where the partial flow stops), then the disconnected symbols,
      // agent-specific (unique-named) ones first.
      let boundaryText = '';
      {
        const uncovered: Node[] = [];
        if (!hasMain) {
          // No rendered chain — but a 2-node chain still CONNECTS its two
          // endpoints (e.g. via one synthesized hop, surfaced below as a
          // dynamic-dispatch link). Only nodes off that short chain are
          // unexplained breaks worth scanning.
          for (const n of named.values()) if (!pathIds.has(n.id)) uncovered.push(n);
        } else {
          for (const ids of tokenNodes.values()) {
            if (ids.length === 0 || ids.some((id) => pathIds.has(id))) continue;
            for (const id of ids) { const n = named.get(id); if (n) uncovered.push(n); }
          }
        }
        if (uncovered.length > 0) {
          const scanList: Node[] = [];
          if (hasMain) scanList.push(best![best!.length - 1]!.node);
          scanList.push(...uncovered.sort((a, b) =>
            (uniqueNamedNodeIds.has(b.id) ? 1 : 0) - (uniqueNamedNodeIds.has(a.id) ? 1 : 0)));
          boundaryText = this.buildDynamicBoundaries(cg, scanList, named);
        }
      }

      // Interface/registry-dispatch announcement (extends #687 to GRAPH-visible
      // polymorphism). A method the agent NAMED that resolves to a large same-name
      // family AND did not land on the main chain is almost always a runtime
      // dispatch (plugin/strategy/handler interface): the concrete target is chosen
      // at runtime from N implementations, so no single static edge is the answer.
      // The body-scan above can't see this — `nodeType.execute()` is textually an
      // ordinary call; the polymorphism lives in the graph (implements edges), so
      // detect it there. Fires ONLY for an uncovered named token; a connected flow
      // stays silent.
      let polyText = '';
      {
        const POLY_MIN_FAMILY = 8; // smaller families are overload sets, not dispatch
        const polyCands: Array<{ token: string; family: Node[] }> = [];
        for (const [t, fam] of tokenFamily) {
          if (fam.length < POLY_MIN_FAMILY) continue;
          const ids = tokenNodes.get(t) || [];
          if (ids.some((id) => pathIds.has(id))) continue; // covered by the flow — silent
          polyCands.push({ token: t, family: fam });
        }
        if (polyCands.length) polyText = this.buildPolymorphicBoundaries(cg, polyCands, named);
      }

      // Supplementary: dynamic-dispatch (synthesized) edges incident to a named
      // symbol (incl. the non-callable CONSTANT endpoints in `dynNamed`) — the
      // indirect hops an agent would otherwise grep/Read to reconstruct ("where do
      // the appended `validators` actually run?"). Surfaced even when the OTHER end
      // wasn't named. The skip drops a hop already in the rendered main chain; a
      // 2-node chain renders nothing (hasMain false) so a direct named→named synth
      // hop still surfaces — too short for Flow, but #687-visible here.
      const synthLines = collectSynthLinks(
        hasMain ? (e: Edge) => pathIds.has(e.source) && pathIds.has(e.target) : null
      );

      if (!hasMain && synthLines.length === 0 && !boundaryText && !polyText) return EMPTY;
      const out: string[] = [];
      if (hasMain) {
        out.push('**Flow (call path among the symbols you queried)**', '');
        for (let i = 0; i < best!.length; i++) {
          const step = best![i]!;
          if (step.edge) { const sy = this.synthEdgeNote(step.edge); out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}`); }
          out.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine})`);
        }
        out.push('');
      }
      if (synthLines.length) {
        out.push(
          '**Dynamic-dispatch links among your symbols**',
          '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
          '',
          ...synthLines,
          ''
        );
      }
      if (boundaryText) out.push(boundaryText);
      if (polyText) out.push(polyText);
      out.push('> Full source for these symbols is below — the call flow among them, followed by their bodies.', '');
      // namedNodeIds = every callable the agent explicitly named (a superset of
      // the spine). A file holding one is something the agent asked to SEE, so it
      // must keep full source even if it's an off-spine polymorphic sibling — the
      // agent named `getResponseWithInterceptorChain` / `SQLCompiler.execute_sql`
      // as the mechanism, not as an interchangeable leaf. See the skeleton gate.
      return { text: out.join('\n'), pathNodeIds: pathIds, namedNodeIds: new Set<string>([...named.keys(), ...dynNamed.keys()]), uniqueNamedNodeIds, spineCallSites };
    } catch {
      return EMPTY;
    }
  }

  /**
   * Dynamic-boundary surfacing (#687): when the flow among the agent's named
   * symbols does not fully connect, scan the disconnected symbols' bodies for
   * dynamic-dispatch sites (computed member calls, getattr, reflection, typed
   * message buses, runtime-keyed emits) and ANNOUNCE the boundary — the exact
   * site, the form, and (when a key is statically visible) candidate targets —
   * instead of guessing edges. The answer to "how does A reach B" when no
   * static path exists IS the dispatch site: that's where the flow continues
   * at runtime. Query-time, deterministic, zero graph mutation; a fully
   * connected flow never reaches this method.
   */
  private buildDynamicBoundaries(cg: HomeGraph, scanList: Node[], named: Map<string, Node>): string {
    const MAX_NOTES = 4;       // boundary bullets per explore
    const MAX_SCAN = 8;        // bodies scanned
    const MAX_TOTAL_CHARS = 200_000;
    let projectRoot: string;
    try { projectRoot = cg.getProjectRoot(); } catch { return ''; }
    const notes: string[] = [];
    const seenNode = new Set<string>();
    const seenSite = new Set<string>();
    let scanned = 0, charsScanned = 0;
    for (const node of scanList) {
      if (notes.length >= MAX_NOTES || scanned >= MAX_SCAN || charsScanned > MAX_TOTAL_CHARS) break;
      if (seenNode.has(node.id) || !node.startLine || !node.endLine) continue;
      seenNode.add(node.id);
      const absPath = validatePathWithinRoot(projectRoot, node.filePath);
      if (!absPath || !existsSync(absPath)) continue;
      let content: string;
      try { content = readFileSync(absPath, 'utf-8'); } catch { continue; }
      const body = content.split('\n').slice(node.startLine - 1, node.endLine).join('\n');
      scanned++;
      charsScanned += body.length;
      for (const m of scanDynamicDispatch(body, node.language || '', node.startLine)) {
        if (notes.length >= MAX_NOTES) break;
        const siteKey = `${node.filePath}:${m.line}:${m.form}`;
        if (seenSite.has(siteKey)) continue;
        seenSite.add(siteKey);
        const more = m.moreSites ? ` (+${m.moreSites} more such site${m.moreSites > 1 ? 's' : ''} in this body)` : '';
        notes.push(`- \`${node.name}\` (${node.filePath}:${m.line}) — ${m.label}: \`${m.snippet}\`${more}`);
        if (m.key) {
          const cand = this.boundaryCandidates(cg, m.key, !!m.keyIsType, named, node.id);
          if (cand) notes.push(`  ${cand}`);
        }
      }
    }
    if (notes.length === 0) return '';
    return [
      '**Dynamic boundaries (the static path ends at runtime dispatch)**',
      '',
      ...notes,
      '',
      '> These sites choose their call target at runtime (registry / bus / reflection) — the site shown IS where the flow continues. To follow it, run homegraph_explore or homegraph_node on a candidate; source for the sites above is included below.',
      '',
    ].join('\n');
  }

  /**
   * Interface/registry-dispatch announcement — #687 extended to GRAPH-visible
   * polymorphism (the body-scan can't see it: `nodeType.execute()` is textually
   * an ordinary call; the polymorphism lives in the `implements`/`extends` edges).
   *
   * A method the agent named that resolves to a large same-name family whose
   * definers overwhelmingly implement/extend ONE supertype is a runtime dispatch:
   * the concrete target is chosen at runtime from N implementations, so no single
   * static edge is "the answer" — the implementations ARE the continuations. We
   * announce the supertype, its TRUE implementer count, and a few concrete targets,
   * then steer to homegraph_explore. Graph-only, query-time, zero mutation; the
   * caller fires it ONLY for an UNCOVERED named token, so a connected flow is silent.
   *
   * Robust to FTS sampling bias: the same-name family is a capped FTS sample that
   * over-represents whatever FTS ranks first (n8n: DB `TableOperation.execute`
   * outnumbered `INodeType.execute` in the sample 7:6 even though INodeType has
   * 611 implementers vs a handful). So candidate supertypes are ranked by their
   * TRUE graph-wide implementer count, NOT their frequency in the sample.
   */
  private buildPolymorphicBoundaries(cg: HomeGraph, candidates: Array<{ token: string; family: Node[] }>, named: Map<string, Node>): string {
    const CLASSY = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'abstract']);
    const MIN_IMPL = 8;     // a supertype needs >= this many implementers to count as "polymorphic"
    const MIN_SUPPORT = 2;  // >= this many sampled definers must share the supertype (ties it to the token)
    const SAMPLE = 40;      // family members inspected per token
    const MAX_NOTES = 3;
    const rel = (p: string) => p.replace(/\\/g, '/');
    const containerOf = (m: Node): Node | null => {
      try { const ce = cg.getIncomingEdges(m.id).find((e) => e.kind === 'contains'); return ce ? cg.getNode(ce.source) : null; }
      catch { return null; }
    };
    const notes: string[] = [];
    const seenSuper = new Set<string>();
    for (const { token, family } of candidates) {
      if (notes.length >= MAX_NOTES) break;
      // supertype id → how many sampled definers share it + a few example definers
      const supers = new Map<string, { node: Node; count: number; targets: Node[] }>();
      for (const m of family.slice(0, SAMPLE)) {
        const container = containerOf(m);
        if (!container || !CLASSY.has(container.kind)) continue;
        let sups: Node[] = [];
        try {
          sups = cg.getOutgoingEdges(container.id)
            .filter((e) => e.kind === 'implements' || e.kind === 'extends')
            .map((e) => { try { return cg.getNode(e.target); } catch { return null; } })
            .filter((n): n is Node => !!n && CLASSY.has(n.kind) && (n.name?.length || 0) >= 3);
        } catch { /* no supertypes — free function or unresolved */ }
        for (const s of sups) {
          const e = supers.get(s.id) || { node: s, count: 0, targets: [] };
          e.count++;
          if (e.targets.length < 6) e.targets.push(m);
          supers.set(s.id, e);
        }
      }
      // Pick the supertype with the most TRUE implementers (graph-wide), among
      // those genuinely shared by the token's definers.
      let best: { node: Node; impl: number; targets: Node[] } | null = null;
      for (const { node, count, targets } of supers.values()) {
        if (count < MIN_SUPPORT) continue;
        let impl = 0;
        try { impl = cg.getIncomingEdges(node.id).filter((e) => e.kind === 'implements' || e.kind === 'extends').length; }
        catch { /* leave 0 — gated out below */ }
        if (impl < MIN_IMPL) continue;
        if (!best || impl > best.impl) best = { node, impl, targets };
      }
      if (!best || seenSuper.has(best.node.id)) continue;
      seenSuper.add(best.node.id);
      const namedNames = new Set([...named.values()].map((n) => n.name));
      const eg = best.targets.slice(0, 4).map((m) => {
        const cont = containerOf(m);
        const disp = cont ? `${cont.name}.${m.name}` : (m.qualifiedName || m.name);
        const mark = cont && namedNames.has(cont.name) ? ' ← you named this' : '';
        return `\`${disp}\` (${rel(m.filePath)}:${m.startLine})${mark}`;
      });
      const more = best.impl > eg.length ? ` +${best.impl - eg.length} more` : '';
      notes.push(`- \`${token}\` → runtime dispatch to **${best.impl}** types implementing \`${best.node.name}\` — the static path ends here, the target is chosen at runtime. e.g. ${eg.join(', ')}${more}`);
    }
    if (notes.length === 0) return '';
    return [
      '**Interface dispatch (a named method has many implementations)**',
      '',
      ...notes,
      '',
      '> The method above is dispatched at runtime to one of the listed implementations (a registry / plugin / strategy interface) — there is no single static caller→callee edge; the implementations ARE the continuations. To follow one, run homegraph_explore on a listed target.',
      '',
    ].join('\n');
  }

  /**
   * Shortlist candidate runtime targets for a dispatch key surfaced by
   * {@link buildDynamicBoundaries}. Exact conventional names first (`save` →
   * `onSave`/`handleSave`; `CreateCmd` → `CreateCmdHandler`), then FTS, with a
   * normalized-containment post-filter (FTS camel-splitting is fuzzier than a
   * candidate list should be). Symbols the agent already named sort first and
   * are marked — that's the "you were right, here's the wiring" case.
   */
  private boundaryCandidates(cg: HomeGraph, key: string, keyIsType: boolean, named: Map<string, Node>, selfId: string): string {
    const CALLABLE = new Set(['method', 'function', 'component', 'constructor', 'class']);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keyNorm = norm(key);
    if (keyNorm.length < 3) return '';
    const cands = new Map<string, Node>();
    const consider = (n: Node | undefined | null) => {
      if (!n || n.id === selfId || !CALLABLE.has(n.kind) || cands.has(n.id)) return;
      const nameNorm = norm(n.name || '');
      if (nameNorm.length < 3) return;
      if (!nameNorm.includes(keyNorm) && !keyNorm.includes(nameNorm)) return;
      cands.set(n.id, n);
    };
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    const probes = keyIsType
      ? [`${key}Handler`, key]
      : [key, `on${cap}`, `handle${cap}`, `${key}Handler`, `handle_${key}`];
    for (const p of probes) {
      try { for (const n of cg.getNodesByName(p)) consider(n); } catch { /* exact probe miss is fine */ }
    }
    let raw = 0;
    try {
      const results = cg.searchNodes(key, { limit: 12 });
      raw = results.length;
      for (const r of results) consider(r.node);
    } catch { /* FTS syntax edge — exact probes already ran */ }
    if (cands.size === 0) {
      return raw >= 12 && key.length < 5 ? `key \`${key}\` is too generic to shortlist (${raw}+ matches)` : '';
    }
    // A constructor candidate duplicates its class: extractors emit ctors as
    // METHOD nodes named like the class (C#/Java `Foo::Foo`) — keep the class.
    const all = [...cands.values()];
    const classKey = new Set(all.filter((n) => n.kind === 'class').map((n) => `${n.name}|${n.filePath}`));
    const namedNames = new Set([...named.values()].map((n) => n.name));
    const isNamed = (n: Node) => named.has(n.id) || namedNames.has(n.name); // the flow's named set holds callables only — transfer the mark to the class
    const list = all
      .filter((n) => !(n.kind !== 'class' && classKey.has(`${n.name}|${n.filePath}`)))
      .sort((a, b) => (isNamed(b) ? 1 : 0) - (isNamed(a) ? 1 : 0))
      .slice(0, 4)
      .map((n) => {
        // Typed-bus convention: the runtime target is the candidate class's
        // Handle/Execute/Consume method — name the exact node, not just the class.
        let display = n.qualifiedName || n.name;
        let at = `${n.filePath}:${n.startLine}`;
        if (keyIsType && n.kind === 'class') {
          try {
            const HANDLER_METHODS = /^(handle|handleAsync|execute|executeAsync|consume|consumeAsync|run|__invoke)$/i;
            const method = cg.getOutgoingEdges(n.id)
              .filter((e) => e.kind === 'contains')
              .map((e) => { try { return cg.getNode(e.target); } catch { return null; } })
              .find((c): c is Node => !!c && c.kind === 'method' && HANDLER_METHODS.test(c.name));
            if (method) { display = `${n.name}.${method.name}`; at = `${method.filePath}:${method.startLine}`; }
          } catch { /* class without resolvable members — show the class itself */ }
        }
        return `\`${display}\` (${at})${isNamed(n) ? ' ← you named this' : ''}`;
      });
    return `candidates for key \`${key}\`: ${list.join(', ')}`;
  }

  /**
   * Import sites for @kit.* / *Kit module names — surfaces full `import { … } from '@kit.X'`
   * lines. When the query also names an export/API token, only matching imports are listed.
   */
  private buildImportSitesSection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; siteCount: number; compactListing: boolean } {
    const kitTerms = extractKitModuleNamesFromQuery(query);
    const depSymbols = extractDependencySymbolsFromQuery(query).filter(
      (s) => !isMemberLikeIdentifier(s) && !GENERIC_VERB_ANCHOR_NOISE.has(s.toLowerCase()),
    );
    const focusExports = [
      ...new Set([
        ...extractKitSubmoduleNamesFromQuery(query),
        ...depSymbols.filter((s) => s.length >= 4),
      ]),
    ];
    const kitSearchTerms = extractImportSearchTerms(query);
    // Named export/API + kit (or usage-survey intent) → return the full matching list.
    const completeInventory =
      focusExports.length > 0
      && (kitTerms.length > 0 || shouldBuildKitModuleUsageSurvey(query) || shouldBuildApiUsageSurvey(query));

    const seen = new Set<string>();
    const sites: Array<{ file: string; line: number; lineText: string }> = [];

    const tryAdd = (node: Node, lineText: string): void => {
      if (isOhosApiFilePath(node.filePath)) return;
      const lineLc = lineText.toLowerCase();
      const focus = focusExports.length > 0 ? focusExports : depSymbols;
      if (focus.length > 0 && !focus.some((s) => lineLc.includes(s.toLowerCase()))) return;
      // When a @kit module is named, require that kit — or @ohos.<focus> module path.
      if (kitTerms.length > 0) {
        const matchesKit = kitTerms.some((k) => lineLc.includes(`@kit.${k.toLowerCase()}`));
        const matchesOhosModule = focusExports.some((s) => lineLc.includes(`@ohos.${s.toLowerCase()}`));
        if (!matchesKit && !matchesOhosModule) return;
      }
      const key = `${node.filePath}:${node.startLine}`;
      if (seen.has(key)) return;
      seen.add(key);
      sites.push({ file: node.filePath, line: node.startLine, lineText });
    };

    const resolveImportLine = (node: Node): string => resolveImportLineFromNode(node, projectRoot);

    const importLimit = completeInventory ? 200 : focusExports.length > 0 || depSymbols.length > 0 ? 60 : 20;
    const searchSyms = focusExports.length > 0 ? focusExports : depSymbols;

    // Symbol-first search: named export hits `import { foo } from '@kit.X'`.
    for (const sym of searchSyms) {
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(sym, { kinds: ['import'], limit: importLimit });
      } catch {
        continue;
      }
      for (const r of hits) {
        tryAdd(r.node, resolveImportLine(r.node));
      }
    }

    // Kit-module search (when no symbol filter, or to catch re-exports).
    if (sites.length === 0 || searchSyms.length === 0) {
      for (const term of kitSearchTerms) {
        const termLc = term.toLowerCase().replace(/^@kit\./, '');
        let hits: SearchResult[] = [];
        try {
          hits = cg.searchNodes(term, { kinds: ['import'], limit: importLimit });
        } catch {
          continue;
        }
        for (const r of hits) {
          const lineText = resolveImportLine(r.node);
          if (!lineText.toLowerCase().includes(termLc)) continue;
          if (searchSyms.length > 0) {
            const matchesSym = searchSyms.some((s) => lineText.toLowerCase().includes(s.toLowerCase()));
            if (!matchesSym) continue;
          }
          tryAdd(r.node, lineText);
        }
      }
    }

    if (sites.length === 0) {
      return { section: '', siteCount: 0, compactListing: false };
    }

    sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

    const importInventoryFilter = hasImportInventoryFilter(query);
    const compactListing = completeInventory || shouldCompactImportListing(sites.length, importInventoryFilter);
    const cap = completeInventory ? sites.length : compactListing ? 40 : 15;
    const focusLabel = focusExports.length > 0 ? focusExports.map((s) => `\`${s}\``).join(', ') : 'queried symbol(s)';
    const lines = compactListing
      ? ['**Dependency list**', '', `Files importing ${focusLabel} (${sites.length} total):`, '']
      : ['**Import sites**', ''];

    for (const s of sites.slice(0, cap)) {
      if (compactListing) {
        lines.push(`- \`${s.file}\` (line ${s.line})`);
      } else {
        lines.push(`- \`${s.file}:${s.line}\` — \`${s.lineText}\``);
      }
    }
    if (sites.length > cap) {
      lines.push(`- … and ${sites.length - cap} more`);
    }
    if (compactListing) {
      lines.push('');
      lines.push(
        `> **ANSWER NOW.** Complete list of **${sites.length}** matching import site(s) for ${focusLabel}. ` +
        'Do **not** Grep/Read the same `@kit`/`@ohos` import pattern.',
      );
    }
    lines.push('');
    return { section: lines.join('\n'), siteCount: sites.length, compactListing };
  }

  /**
   * External-caller inventory for a named class — methods → who calls them (paths only).
   */
  private buildCallerListingSection(cg: HomeGraph, query: string, projectRoot?: string): string {
    const typeNames = extractCallerSurveySymbols(query);
    if (typeNames.length === 0) return '';

    const rel = (p: string) => p.replace(/\\/g, '/');
    // Only filter to other files when the user asked for "external" callers.
    // Applying this to every caller-survey query wiped same-file call sites
    // (common in C++/ARK .cpp units) and fell through to a fat full explore.
    const externalOnly = /\bexternal\b/i.test(query) || /外部/.test(query);
    const listedMethods = new Set(extractListedTypeMethodsFromQuery(query));
    const typeNameSet = new Set(extractTypeNamesFromQuery(query));
    const lines: string[] = ['**Caller inventory**', ''];
    let substantive = 0;

    // Function / method symbols named directly (e.g. SortWidgets).
    // When Type + listed methods (BinaryGrid Set/Test/Fill), keep defs near the
    // owning Type's files (template methods often lack reliable contains edges).
    const ownerDirs = new Set<string>();
    if (listedMethods.size > 0 && typeNameSet.size > 0) {
      for (const t of typeNameSet) {
        for (const n of cg.getNodesByName(t)) {
          if (n.kind === 'class' || n.kind === 'struct' || n.kind === 'component') {
            const fp = rel(n.filePath);
            ownerDirs.add(fp.split('/').slice(0, -1).join('/'));
          }
        }
      }
    }
    for (const sym of typeNames.slice(0, 6)) {
      let funcs = cg.getNodesByName(sym).filter(
        (n) => (n.kind === 'function' || n.kind === 'method') && !isTestFile(n.filePath),
      );
      if (listedMethods.has(sym) && ownerDirs.size > 0) {
        const near = funcs.filter((n) => {
          const dir = rel(n.filePath).split('/').slice(0, -1).join('/');
          return ownerDirs.has(dir);
        });
        if (near.length > 0) funcs = near;
      }
      for (const fn of funcs.slice(0, 3)) {
        let callers: Array<{ node: Node }> = [];
        try { callers = cg.getCallers(fn.id) as Array<{ node: Node }>; } catch { continue; }
        const uniq = new Map<string, Node>();
        for (const c of callers) {
          if (!c?.node) continue;
          if (externalOnly && c.node.filePath === fn.filePath) continue;
          if (isTestFile(c.node.filePath)) continue;
          uniq.set(c.node.id, c.node);
        }
        if (uniq.size === 0) continue;
        const callerList = [...uniq.values()].slice(0, 12)
          .map((n) => `\`${rel(n.filePath)}:${n.startLine}\` (\`${n.name}\`)`)
          .join(', ');
        const more = uniq.size > 12 ? ` +${uniq.size - 12} more` : '';
        lines.push(`- \`${fn.name}\` (\`${rel(fn.filePath)}:${fn.startLine}\`) ← ${callerList}${more}`);
        substantive++;
      }
    }

    for (const typeName of typeNames.slice(0, 3)) {
      if (!typeNameSet.has(typeName) && listedMethods.size > 0) continue;
      const classes = cg.getNodesByName(typeName)
        .filter((n) => (n.kind === 'class' || n.kind === 'struct' || n.kind === 'component') && !isTestFile(n.filePath));
      for (const cls of classes.slice(0, 2)) {
        const methods: Node[] = [];
        for (const e of cg.getOutgoingEdges(cls.id)) {
          if (e.kind !== 'contains') continue;
          const m = cg.getNode(e.target);
          if (m && (m.kind === 'method' || m.kind === 'function')) methods.push(m);
        }
        if (methods.length === 0) {
          for (const n of cg.getNodesByName(typeName)) {
            if (n.filePath === cls.filePath && (n.kind === 'method' || n.kind === 'function')) {
              methods.push(n);
            }
          }
        }
        const focusMethods = listedMethods.size > 0
          ? methods.filter((m) => listedMethods.has(m.name))
          : methods;
        const methodLines: string[] = [];
        for (const method of (focusMethods.length > 0 ? focusMethods : methods).slice(0, 25)) {
          let callers: Array<{ node: Node }> = [];
          try { callers = cg.getCallers(method.id) as Array<{ node: Node }>; } catch { continue; }
          const uniq = new Map<string, Node>();
          for (const c of callers) {
            if (!c?.node) continue;
            if (externalOnly && c.node.filePath === cls.filePath) continue;
            if (isTestFile(c.node.filePath)) continue;
            uniq.set(c.node.id, c.node);
          }
          if (uniq.size === 0) continue;
          const callerList = [...uniq.values()].slice(0, 8)
            .map((n) => `\`${rel(n.filePath)}:${n.startLine}\` (\`${n.name}\`)`)
            .join(', ');
          const more = uniq.size > 8 ? ` +${uniq.size - 8} more` : '';
          methodLines.push(`- \`${method.name}\` ← ${callerList}${more}`);
          substantive++;
        }
        if (methodLines.length === 0) continue;
        lines.push(`### \`${cls.name}\` (\`${rel(cls.filePath)}\`)`);
        lines.push(...methodLines);
        lines.push('');
      }
    }

    // Text call-site fallback for return-value / member consumers when the graph
    // has no edges onto SDK/.d.ts methods (common for getConnectionState).
    if (substantive === 0 && queryAsReturnValueConsumerSurvey(query)) {
      const root = projectRoot || '';
      for (const sym of typeNames.slice(0, 3)) {
        if (!/^(?:get|is|has|create|on)[A-Z]/.test(sym) && !isMemberLikeIdentifier(sym)) continue;
        let scanHits: SearchResult[] = [];
        try { scanHits = cg.searchNodes(sym, { limit: 40 }); } catch { continue; }
        const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const callRe = new RegExp(`\\.${esc}\\s*\\(`);
        const bareRe = new RegExp(`\\b${esc}\\s*\\(`);
        const seen = new Set<string>();
        const bullets: string[] = [];
        for (const r of scanHits) {
          if (isTestFile(r.node.filePath)) continue;
          if (/\.d\.ts$/i.test(r.node.filePath) || isOhosApiFilePath(r.node.filePath)) continue;
          const abs = root
            ? validatePathWithinRoot(root, r.node.filePath)
            : (existsSync(r.node.filePath) ? r.node.filePath : null);
          if (!abs) continue;
          let fileLines: string[] = [];
          try { fileLines = readFileSync(abs, 'utf-8').split('\n'); } catch { continue; }
          for (let i = 0; i < fileLines.length; i++) {
            const lineText = fileLines[i] ?? '';
            if (!callRe.test(lineText) && !bareRe.test(lineText)) continue;
            const key = `${rel(r.node.filePath)}:${i + 1}`;
            if (seen.has(key)) continue;
            seen.add(key);
            bullets.push(`- \`${sym}\` ← \`${key}\`  \`${lineText.trim().slice(0, 120)}\``);
            if (bullets.length >= 12) break;
          }
          if (bullets.length >= 12) break;
        }
        if (bullets.length > 0) {
          lines.push(`### \`${sym}\` (text call sites)`);
          lines.push(...bullets);
          lines.push('');
          substantive += bullets.length;
        }
      }
    }

    if (substantive === 0) {
      if (queryAsReturnValueConsumerSurvey(query)) {
        return [
          '**Caller inventory**',
          '',
          '> No in-repo callers of the return-value member in the graph/index. **ANSWER NOW** — do not open SDK `.d.ts` stubs; Grep once for `.member(` only if needed.',
          '',
        ].join('\n');
      }
      return '';
    }
    // Unique caller files — answers "哪些文件调用了 Type::methods" without Grep.
    if (listedMethods.size > 0 && substantive > 0) {
      const callerFiles = new Set<string>();
      for (const line of lines) {
        const idx = line.indexOf('←');
        if (idx < 0) continue;
        for (const m of line.slice(idx).matchAll(/`([^`]+?):(\d+)`/g)) {
          callerFiles.add(m[1]!);
        }
      }
      if (callerFiles.size > 0) {
        lines.push('');
        lines.push('**Unique caller files**');
        for (const fp of [...callerFiles].sort()) {
          lines.push(`- \`${fp}\``);
        }
      }
    }
    lines.push('> Caller inventory complete — answer from this section.');
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Multi-module / circular dependency survey — lean cycle list, not an import flood.
   */
  private buildModuleDependencySurveySection(
    cg: HomeGraph,
    query: string,
  ): { section: string; hitCount: number } {
    // Prefer leaf module tokens (`launchercommon`) over shared parents (`staticcommon`)
    // — parent matches flood unrelated windowscene cycles.
    const leafModules = new Set<string>();
    for (const p of (query.match(
      /\b[A-Za-z][\w]*(?:common|service|component|constants)\b/gi,
    ) ?? [])) {
      const low = p.toLowerCase();
      if (!/^(?:static|feature|product|base|common)$/i.test(low)) leafModules.add(low);
    }
    for (const seg of query.match(/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+/g) ?? []) {
      const leaf = seg.split(/[/\\]/).pop()?.toLowerCase();
      if (leaf && leaf.length >= 4 && /common|service|component|constants/i.test(leaf)) {
        leafModules.add(leaf);
      }
    }
    if (leafModules.size === 0) return { section: '', hitCount: 0 };

    const rel = (p: string) => p.replace(/\\/g, '/');
    const hitLeaf = (fp: string): string | null => {
      const low = fp.toLowerCase().replace(/\\/g, '/');
      for (const n of leafModules) {
        if (low.includes(`/${n}/`) || low.includes(`/${n}.`) || low.endsWith(`/${n}`)) return n;
      }
      return null;
    };

    let cycles: string[][] = [];
    try { cycles = cg.findCircularDependencies(); } catch { cycles = []; }
    const matchedCycles = cycles
      .map((c) => {
        const touched = new Set<string>();
        const kept: string[] = [];
        for (const p of c) {
          const leaf = hitLeaf(p);
          if (leaf) {
            touched.add(leaf);
            kept.push(p);
          }
        }
        return touched.size >= 2 ? kept : [];
      })
      .filter((c) => c.length >= 2)
      .slice(0, 8);

    const lines = [
      '**Module dependency / cycle survey**',
      '',
      `> Focused on leaf modules \`${[...leafModules].slice(0, 8).join('`, `')}\`. **ANSWER NOW** — do not glob every \`oh-package.json5\`.`,
      '',
    ];
    if (matchedCycles.length === 0) {
      lines.push(
        `- No **circular** import cycle spanning **two or more** of the named leaf modules.`,
      );
      lines.push(
        '- (Cycles only inside an unrelated sibling under the same parent path are omitted.)',
      );
      lines.push('');
      return { section: lines.join('\n'), hitCount: 1 };
    }
    lines.push(`Found **${matchedCycles.length}** cycle(s) spanning named leaf modules:`);
    for (const c of matchedCycles) {
      lines.push(`- ${c.map((p) => `\`${rel(p)}\``).join(' → ')}`);
    }
    lines.push('');
    return { section: lines.join('\n'), hitCount: matchedCycles.length };
  }

  /**
   * Path-module / named-Type NAPI export surface — not a 50-file domain dump.
   */
  private buildModuleExportSurveySection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; hitCount: number } {
    const paths = extractPathSegmentsFromQuery(query);
    const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
    const needles = [
      ...paths.map((p) => p.replace(/\\/g, '/').toLowerCase()),
      ...types.map((t) => t.toLowerCase()),
    ].filter((n) => n.length >= 4);
    if (needles.length === 0) return { section: '', hitCount: 0 };

    const rel = (p: string) => p.replace(/\\/g, '/');
    const inScope = (fp: string): boolean => {
      const low = rel(fp).toLowerCase();
      return needles.some((n) => low.includes(n));
    };

    const exports: Array<{ name: string; file: string; line: number; snippet: string }> = [];
    const seen = new Set<string>();
    const seedNames = [
      'Export', 'NapiInit', 'napi_init', 'Init', 'napi_module_register',
      ...types.slice(0, 3),
    ];
    for (const seed of seedNames) {
      let hits: SearchResult[] = [];
      try { hits = cg.searchNodes(seed, { limit: 30 }); } catch { continue; }
      for (const r of hits) {
        if (!inScope(r.node.filePath) || isTestFile(r.node.filePath)) continue;
        if (!/\.(cpp|cc|cxx|h|hpp)$/i.test(r.node.filePath) && !/napi/i.test(r.node.filePath)) {
          continue;
        }
        const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
        if (!abs) continue;
        let content = '';
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        const fileLines = content.split('\n');
        for (let i = 0; i < fileLines.length; i++) {
          const line = fileLines[i] ?? '';
          // napi_define_function / exports / Descriptor { "foo", … }
          const m =
            line.match(/napi_define_(?:function|property)\s*\([^,]+,\s*["']([\w]+)["']/i)
            || line.match(/\{\s*["']([\w]+)["']\s*,\s*(?:nullptr|NULL)?\s*,\s*\w+/i)
            || line.match(/\.?(?:exports|export)\s*[:=].*["']([\w]+)["']/i);
          if (!m?.[1] || m[1].length < 2) continue;
          const key = `${m[1]}:${rel(r.node.filePath)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          exports.push({
            name: m[1],
            file: rel(r.node.filePath),
            line: i + 1,
            snippet: line.trim().slice(0, 100),
          });
        }
        // Also list Export / Init method nodes in-scope.
        if (/^(?:Export|Init|NapiInit)$/i.test(r.node.name)) {
          const key = `fn:${r.node.name}:${rel(r.node.filePath)}`;
          if (!seen.has(key)) {
            seen.add(key);
            exports.push({
              name: r.node.name,
              file: rel(r.node.filePath),
              line: r.node.startLine,
              snippet: (r.node.signature || r.node.name).slice(0, 100),
            });
          }
        }
      }
    }

    const lines = [
      '**NAPI / native export survey**',
      '',
      `> In-repo NAPI surface for \`${needles.slice(0, 4).join('`, `')}\`. **ANSWER NOW** — do not Grep \`napi_define\` again.`,
      '',
    ];
    if (exports.length === 0) {
      lines.push('- No `napi_define_*` / Export descriptors found under the named path/Type.');
      lines.push('');
      return { section: lines.join('\n'), hitCount: 0 };
    }
    for (const e of exports.slice(0, 30)) {
      lines.push(`- \`${e.name}\` — \`${e.file}:${e.line}\`  \`${e.snippet}\``);
    }
    if (exports.length > 30) lines.push(`- … and ${exports.length - 30} more`);
    lines.push('');
    return { section: lines.join('\n'), hitCount: Math.min(exports.length, 30) };
  }

  /**
   * Named `.d.ts` wrap — where the basename is imported / called in-repo.
   */
  private buildDtsWrapSurveySection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; hitCount: number } {
    const bases = extractFileBasenamesFromQuery(query)
      .map((b) => b.replace(/\.d\.ts$/i, ''))
      .filter((b) => b.length >= 3);
    if (bases.length === 0 && /\.d\.ts\b/i.test(query)) {
      for (const m of query.matchAll(/\b([A-Za-z][\w]*)\.d\.ts\b/g)) {
        if (m[1]) bases.push(m[1]);
      }
    }
    if (bases.length === 0) return { section: '', hitCount: 0 };

    const rel = (p: string) => p.replace(/\\/g, '/');
    const hits = new Map<string, { lines: number[]; snippet: string }>();
    for (const base of bases.slice(0, 3)) {
      let nodes: SearchResult[] = [];
      try { nodes = cg.searchNodes(base, { limit: 40 }); } catch { continue; }
      const re = new RegExp(
        `(?:from\\s+['"].*${base}['"]|import\\s+.*\\b${base}\\b|\\b${base}\\.\\w+)`,
        'i',
      );
      const seen = new Set<string>();
      for (const r of nodes) {
        if (isTestFile(r.node.filePath)) continue;
        const fp = rel(r.node.filePath);
        if (/\.d\.ts$/i.test(fp)) continue;
        if (seen.has(fp)) continue;
        seen.add(fp);
        const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
        if (!abs) continue;
        let content = '';
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        const fileLines = content.split('\n');
        for (let i = 0; i < fileLines.length; i++) {
          const line = fileLines[i] ?? '';
          if (!re.test(line) && !line.includes(base)) continue;
          if (!new RegExp(`\\b${base}\\b`, 'i').test(line)) continue;
          const prev = hits.get(fp) ?? { lines: [], snippet: '' };
          if (!prev.lines.includes(i + 1)) prev.lines.push(i + 1);
          if (!prev.snippet) prev.snippet = line.trim().slice(0, 100);
          hits.set(fp, prev);
        }
      }
    }

    const lines = [
      '**`.d.ts` wrap / call sites**',
      '',
      `> In-repo imports/uses of \`${bases.join('`, `')}\` (stub file itself omitted). **ANSWER NOW.**`,
      '',
    ];
    if (hits.size === 0) {
      lines.push('- No in-repo import/call sites indexed for this wrap.');
      lines.push('');
      return { section: lines.join('\n'), hitCount: 0 };
    }
    for (const [fp, info] of [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 28)) {
      const ls = info.lines.slice(0, 4).map((l) => `L${l}`).join(', ');
      lines.push(
        info.snippet
          ? `- \`${fp}\` (${ls})  \`${info.snippet}\``
          : `- \`${fp}\` (${ls})`,
      );
    }
    lines.push('');
    return { section: lines.join('\n'), hitCount: hits.size };
  }

  /**
   * Named Toggle/control state-sync — which files/modules mention the control
   * (Type may be missing from FTS; seed stems + text scan).
   */
  private buildNamedControlStateSyncSection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; hitCount: number } {
    const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
    if (types.length === 0) return { section: '', hitCount: 0 };
    const stems = new Set<string>();
    for (const t of types) {
      stems.add(t);
      for (const m of t.matchAll(/[A-Z][a-z]+/g)) {
        if (m[0] && m[0].length >= 4) stems.add(m[0]);
      }
    }
    const rel = (p: string) => p.replace(/\\/g, '/');
    const hits = new Map<string, { lines: number[]; snippet: string; score: number }>();
    for (const stem of [...stems].slice(0, 6)) {
      let nodes: SearchResult[] = [];
      try { nodes = cg.searchNodes(stem, { limit: 35 }); } catch { continue; }
      const re = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const seen = new Set<string>();
      for (const r of nodes) {
        if (isTestFile(r.node.filePath)) continue;
        const fp = rel(r.node.filePath);
        if (seen.has(fp)) continue;
        seen.add(fp);
        const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
        if (!abs) continue;
        let content = '';
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        const fileLines = content.split('\n');
        let matched = false;
        for (let i = 0; i < fileLines.length; i++) {
          const line = fileLines[i] ?? '';
          if (!re.test(line) && !line.includes(stem)) continue;
          const prev = hits.get(fp) ?? { lines: [], snippet: '', score: 0 };
          if (!prev.lines.includes(i + 1)) prev.lines.push(i + 1);
          if (!prev.snippet) prev.snippet = line.trim().slice(0, 100);
          if (/Manager|Service|Store|Controller|Provider/i.test(fp) || /Manager|Service|Store/.test(line)) {
            prev.score += 5;
          }
          prev.score += 1;
          hits.set(fp, prev);
          matched = true;
        }
        if (!matched && /Toggle|Switch|Hotspot|Manager/i.test(r.node.name)) {
          hits.set(fp, {
            lines: [r.node.startLine],
            snippet: (r.node.signature || r.node.name).slice(0, 100),
            score: 2,
          });
        }
      }
    }
    const ranked = [...hits.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    const lines = [
      '**Control / Toggle state-sync sites**',
      '',
      `> In-repo references to \`${types.join('`, `')}\` (and stems). Prefer Manager/Service files for \"which module guarantees consistency\". **ANSWER NOW.**`,
      '',
    ];
    if (ranked.length === 0) {
      lines.push('- No indexed sites for the named control; answer from domain knowledge only if sure.');
      lines.push('');
      return { section: lines.join('\n'), hitCount: 0 };
    }
    for (const [fp, info] of ranked.slice(0, 24)) {
      const ls = info.lines.slice(0, 3).map((l) => `L${l}`).join(', ');
      lines.push(
        info.snippet
          ? `- \`${fp}\` (${ls})  \`${info.snippet}\``
          : `- \`${fp}\` (${ls})`,
      );
    }
    lines.push('');
    return { section: lines.join('\n'), hitCount: Math.min(ranked.length, 24) };
  }

  private buildDataSourceSection(cg: HomeGraph, query: string): { section: string; edgeCount: number } {
    const anchors = extractTypeNamesFromQuery(query).filter((n) =>
      /Manager|Service|Handler|Store|Provider|Controller/i.test(n));
    if (anchors.length === 0) return { section: '', edgeCount: 0 };

    const rel = (p: string) => p.replace(/\\/g, '/');
    // Prefer system/SDK / service APIs — not local UI helpers (getBadgeOffsetX).
    const SERVICE_RE =
      /notification|@ohos|ans|subscribe|publish|bundle|ability|vibrator|telephony|NumBadge|notificationManager|badgeManager|wantAgent|distributed/i;
    const lines = ['**Data sources / upstream services**', ''];
    let edgeCount = 0;

    type Up = { name: string; file: string; line: number; via: string; rank: number };
    const addEdge = (
      bucket: Map<string, Up>,
      node: Node,
      via: string,
      rank: number,
      opts?: { importAlways?: boolean },
    ): void => {
      if (isTestFile(node.filePath)) return;
      const sig = `${node.name} ${node.filePath} ${node.signature || ''}`;
      // Same-file @ohos/@kit imports are always data-source candidates (BadgeManager
      // → notificationManager), even when the import local name fails SERVICE_RE.
      if (!opts?.importAlways && !SERVICE_RE.test(sig)) return;
      if (opts?.importAlways && !/@ohos\.|@kit\.|ohos\./i.test(sig)) return;
      const prev = bucket.get(node.id);
      if (!prev || rank < prev.rank) {
        bucket.set(node.id, { name: node.name, file: rel(node.filePath), line: node.startLine, via, rank });
        if (!prev) edgeCount++;
      }
    };

    for (const name of anchors.slice(0, 3)) {
      const classes = cg.getNodesByName(name).filter(
        (n) => (n.kind === 'class' || n.kind === 'struct' || n.kind === 'component') && !isTestFile(n.filePath),
      );
      for (const cls of classes.slice(0, 2)) {
        const upstream = new Map<string, Up>();
        const methods: Node[] = [];
        for (const e of cg.getOutgoingEdges(cls.id)) {
          if (e.kind !== 'contains') continue;
          const m = cg.getNode(e.target);
          if (m && (m.kind === 'method' || m.kind === 'function')) methods.push(m);
        }
        if (methods.length === 0) {
          for (const n of cg.getNodesByName(name)) {
            if (n.filePath === cls.filePath && (n.kind === 'method' || n.kind === 'function')) methods.push(n);
          }
        }
        // 1) Same-file @ohos / kit imports — the usual system-service surface.
        try {
          for (const r of cg.searchNodes('@ohos', { kinds: ['import'], limit: 40 })) {
            if (r.node.filePath !== cls.filePath) continue;
            addEdge(upstream, r.node, 'import', 0, { importAlways: true });
          }
          for (const r of cg.searchNodes('@kit', { kinds: ['import'], limit: 40 })) {
            if (r.node.filePath !== cls.filePath) continue;
            addEdge(upstream, r.node, 'import', 0, { importAlways: true });
          }
          for (const term of ['notification', 'badge', 'NumBadge', 'subscribe', 'bundle', 'ability']) {
            for (const r of cg.searchNodes(term, { kinds: ['import'], limit: 30 })) {
              if (r.node.filePath !== cls.filePath) continue;
              addEdge(upstream, r.node, 'import', 1, { importAlways: true });
            }
          }
        } catch { /* */ }
        // 2) Callees that look like services/APIs.
        for (const method of methods.slice(0, 25)) {
          let callees: Array<{ node: Node }> = [];
          try { callees = cg.getCallees(method.id) as Array<{ node: Node }>; } catch { continue; }
          for (const c of callees) {
            if (c?.node) addEdge(upstream, c.node, method.name, 2);
          }
        }
        if (upstream.size === 0) continue;
        lines.push(`### \`${cls.name}\` (\`${rel(cls.filePath)}\`)`);
        const ranked = [...upstream.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
        for (const u of ranked.slice(0, 15)) {
          lines.push(`- \`${u.name}\` at \`${u.file}:${u.line}\` (via \`${u.via}\`)`);
        }
        if (ranked.length > 15) lines.push(`- … and ${ranked.length - 15} more upstream symbol(s)`);
        lines.push('');
        lines.push(
          '> Prefer `@ohos.*` / notification / bundle imports as the system-service answer; local helpers are secondary.',
        );
        lines.push('');
      }
    }
    if (edgeCount === 0) return { section: '', edgeCount: 0 };
    lines.push(
      '> Data-source survey — **ANSWER NOW** from upstream symbols above (system `@ohos`/`@kit` imports first). ' +
      'Do not Grep/search/callers the same Manager for the service name.',
    );
    lines.push('');
    return { section: lines.join('\n'), edgeCount };
  }

  /**
   * Main-thread fast path for inventory surveys — skips the worker queue.
   */
  private tryFastPathResult(toolName: string, args: Record<string, unknown>): ToolResult | null {
    const query = args.query;
    if (typeof query !== 'string') return null;
    const deferKind = queryShouldDeferToBuiltinTools(query);
    if (deferKind) {
      return this.textResult(homegraphDeferGuidance(deferKind, query));
    }
    try {
      const cg = this.getHomeGraph(args.projectPath as string | undefined);
      const projectRoot = cg.getProjectRoot();
      if (toolName === 'homegraph_explore') {
        return this.tryFastInventoryExplore(cg, query, projectRoot)
          ?? this.tryLightMechanismExplore(cg, query, projectRoot)
          ?? this.tryCompactLocalSymbolExplore(cg, query, projectRoot);
      }
      if (toolName === 'homegraph_search') {
        return this.tryFastInventoryExplore(cg, query, projectRoot)
          ?? this.tryLightMechanismExplore(cg, query, projectRoot)
          ?? this.tryCompactLocalSymbolExplore(cg, query, projectRoot);
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Fast inventory-only explore — skips findRelevantContext for survey/caller/dependency queries.
   */
  private tryFastInventoryExplore(cg: HomeGraph, query: string, projectRoot: string): ToolResult | null {
    if (!shouldTryFastInventoryExplore(query)) return null;

    const lines: string[] = [`**Exploration: ${query}**`, '', ''];
    const summaryLineIdx = 2;

    const inheritanceOnly = shouldBuildInheritanceSurvey(query);
    const typeSurface =
      inheritanceOnly
      || shouldBuildCallerInventory(query)
      || queryIsTypeNameFocus(query);

    // Type / hierarchy / method-caller surveys: return inventory first — never a
    // definition dump or full-graph explore. Agent already named the type.
    // Exception: caller + co-named "definition visible" needs bodies (compact path).
    if (typeSurface && !queryNeedsCoNamedUseBridge(query)) {
      const inheritanceSection = this.buildInheritanceSurveySection(cg, query);
      const callerSection = shouldBuildCallerInventory(query)
        ? this.buildCallerListingSection(cg, query, projectRoot)
        : '';
      const inheritanceListed = inheritanceSection
        ? inheritanceSection.split('\n').filter((l) => l.startsWith('- `')).length > 0
        : false;
      const callerBulletCount = callerSection
        ? callerSection.split('\n').filter((l) => l.startsWith('- ') && l.includes(' ← ')).length
        : 0;
      if (inheritanceListed || callerBulletCount > 0) {
        const parts = [
          `**Exploration: ${query}**`,
          '',
          inheritanceListed && callerBulletCount > 0
            ? 'Type surface: inheritance + method caller inventory below — **ANSWER NOW**; do not grep `extends` and do not `homegraph_callers` each method.'
            : inheritanceListed
              ? 'Inheritance survey above lists all direct subtypes found. **ANSWER NOW** — do not Grep `extends`.'
              : 'Caller inventory lists method→caller sites — **ANSWER NOW**; do not fan out `homegraph_callers` per method.',
        ];
        if (inheritanceSection) parts.push(inheritanceSection);
        if (callerSection) parts.push(callerSection);
        return this.textResult(parts.join('\n'));
      }
      // Empty inheritance graph: stop only for *explicit* subclass intent
      // (子类/extends/subclass). Bare `search("IntGrid")` must fall through to
      // compact definition — an empty subtype ANSWER NOW blocked visibility/use
      // questions that reuse a type name after callers().
      if (queryAsInheritanceSurvey(query)) {
        return this.textResult(
          [
            `**Exploration: ${query}**`,
            '',
            'No direct subtypes / inheritance edges indexed for the named type(s). **ANSWER NOW** — do not Grep `extends` unless you need a second opinion.',
            '',
          ].join('\n'),
        );
      }
      // Bare type-name focus with no subtypes — fall through to compact / other
      // inventory (definition + usage), not a fat full explore.
    }

    const importResult = (
      inheritanceOnly
      || queryIsTypeNameFocus(query)
      || queryAsInheritanceSurvey(query)
      || queryAsDataSourceSurvey(query)
      || shouldBuildApiUsageSurvey(query)
      || queryAsInRepoSystemCapabilityHowto(query)
      || queryAsReturnValueConsumerSurvey(query)
      || queryAsDeclarationSiteSurvey(query)
      || queryAsModuleExportSurvey(query)
      || queryAsModuleDependencySurvey(query)
      // Kit install-deps needs oh-package lines — skip bare import inventory.
      || queryAsksKitInstallDeps(query)
    )
      ? { section: '', siteCount: 0, compactListing: false }
      : this.buildImportSitesSection(cg, query, projectRoot);
    if (importResult.section) lines.push(importResult.section);

    // Kit usage section is redundant when a focused import inventory already listed
    // every matching `@kit`/`export` site (avoids a second dump + Grep temptation).
    // Install-deps questions always take the kit survey (oh-package + imports).
    const kitUsageResult =
      shouldBuildKitModuleUsageSurvey(query)
      && (
        queryAsksKitInstallDeps(query)
        || !(importResult.compactListing && importResult.siteCount > 0)
      )
        ? this.buildKitModuleUsageSection(cg, query, projectRoot)
        : { section: '', symbolCount: 0 };
    if (kitUsageResult.section) lines.push(kitUsageResult.section);

    const domainFileResult = shouldBuildDomainFileSurvey(query) && !queryAsDataSourceSurvey(query)
      && !queryAsInRepoSystemCapabilityHowto(query)
      && !queryAsModuleDependencySurvey(query)
      && !queryAsModuleExportSurvey(query)
      && !queryAsDtsWrapSurvey(query)
      && !queryAsDeclarationSiteSurvey(query)
      ? this.buildDomainFileSurveySection(cg, query)
      : { section: '', fileCount: 0 };
    if (domainFileResult.section) lines.push(domainFileResult.section);

    const systemCapResult = queryAsInRepoSystemCapabilityHowto(query)
      ? this.buildSystemCapabilityHowtoSection(cg, query, projectRoot)
      : { section: '', hitCount: 0 };
    if (systemCapResult.section) lines.push(systemCapResult.section);

    const declarationResult = queryAsDeclarationSiteSurvey(query)
      ? this.buildDeclarationSiteSurveySection(cg, query, projectRoot)
      : { section: '', hitCount: 0, attempted: false };
    if (declarationResult.section) lines.push(declarationResult.section);

    const apiUsageResult = shouldBuildApiUsageSurvey(query) && !queryAsDeclarationSiteSurvey(query)
      ? this.buildApiUsageSection(cg, query, projectRoot)
      : { section: '', fileCount: 0 };
    if (apiUsageResult.section) lines.push(apiUsageResult.section);

    const moduleDepResult = queryAsModuleDependencySurvey(query)
      ? this.buildModuleDependencySurveySection(cg, query)
      : { section: '', hitCount: 0 };
    if (moduleDepResult.section) lines.push(moduleDepResult.section);

    const moduleExportResult = queryAsModuleExportSurvey(query)
      ? this.buildModuleExportSurveySection(cg, query, projectRoot)
      : { section: '', hitCount: 0 };
    if (moduleExportResult.section) lines.push(moduleExportResult.section);

    const dtsWrapResult = queryAsDtsWrapSurvey(query)
      ? this.buildDtsWrapSurveySection(cg, query, projectRoot)
      : { section: '', hitCount: 0 };
    if (dtsWrapResult.section) lines.push(dtsWrapResult.section);

    const controlSyncResult = queryAsNamedControlStateSyncSurvey(query)
      ? this.buildNamedControlStateSyncSection(cg, query, projectRoot)
      : { section: '', hitCount: 0 };
    if (controlSyncResult.section) lines.push(controlSyncResult.section);

    const dataSourceResult = queryAsDataSourceSurvey(query)
      ? this.buildDataSourceSection(cg, query)
      : { section: '', edgeCount: 0 };
    if (dataSourceResult.section) lines.push(dataSourceResult.section);

    const hoverResult = shouldBuildHoverHandlerSurvey(query)
      ? this.buildHoverHandlerSurveySection(cg, query, projectRoot)
      : { section: '', hitCount: 0 };
    if (hoverResult.section) lines.push(hoverResult.section);

    const importInventoryFilter = hasImportInventoryFilter(query);
    const multiAnchor = queryNamesMultipleExploreAnchors(query);
    // Type / caller surveys: skip expensive named-symbol flow synthesize —
    // it wanders unrelated dynamic edges and burns tokens.
    const skipFlow = typeSurface || queryAsCallerOrMethodSurvey(query)
      || queryAsDeclarationSiteSurvey(query)
      || queryAsInRepoSystemCapabilityHowto(query)
      || queryAsReturnValueConsumerSurvey(query);
    const flow = skipFlow
      ? { pathNodeIds: new Set<string>(), text: '' }
      : this.buildFlowFromNamedSymbols(cg, query);
    const hasFlowPath = flow.pathNodeIds.size > 0;

    const inheritanceSection = !hasFlowPath && !multiAnchor
      ? this.buildInheritanceSurveySection(cg, query) : '';
    const listedTypeMethods = extractListedTypeMethodsFromQuery(query).length > 0;
    // Type + listed methods (BinaryGrid Set/Test/Fill) must keep caller inventory even
    // when multi-anchor would otherwise skip it into a fat source dump.
    const callerSection = !hasFlowPath && (!multiAnchor || listedTypeMethods) && shouldBuildCallerInventory(query)
      ? this.buildCallerListingSection(cg, query, projectRoot) : '';
    // Field new/delete inventories already list text sites — skip redundant member scan.
    const memberSection = !hasFlowPath && !multiAnchor && shouldBuildMemberSurvey(query)
      && !(queryAsFieldUsageSurvey(query) && apiUsageResult.fileCount > 0)
      ? this.buildMemberSurveySection(cg, query, projectRoot) : '';
    const configSection = shouldBuildConfigSection(query)
      ? this.buildConfigFileSection(cg, query, projectRoot) : '';

    if (inheritanceSection) lines.push(inheritanceSection);
    if (callerSection) lines.push(callerSection);
    if (memberSection) lines.push(memberSection);
    if (configSection) lines.push(configSection);

    const finishCompact = (summary: string): ToolResult => {
      lines[summaryLineIdx] = summary;
      return this.textResult(lines.join('\n'));
    };

    const memberFileCount = memberSection
      ? memberSection.split('\n').filter((l) => l.startsWith('- ')).length
      : 0;
    const callerBulletCount = callerSection
      ? callerSection.split('\n').filter((l) => l.startsWith('- ') && l.includes(' ← ')).length
      : 0;
    const inheritanceListed = inheritanceSection
      ? inheritanceSection.split('\n').filter((l) => l.startsWith('- `')).length > 0
      : false;

    const hasAnySection = importResult.section || kitUsageResult.section || domainFileResult.section
      || apiUsageResult.section || dataSourceResult.section || hoverResult.section || inheritanceSection
      || callerSection || memberSection || configSection
      || systemCapResult.section || declarationResult.section || moduleDepResult.section
      || moduleExportResult.section || dtsWrapResult.section || controlSyncResult.section;
    if (!hasAnySection) return null;

    // Data-source / API usage inventories are complete without source dumps —
    // stop here so agents do not also get a fat import list + follow-up Read.
    if (systemCapResult.hitCount > 0) {
      return finishCompact(
        `System-capability howto — **${systemCapResult.hitCount}** in-repo site(s). **ANSWER NOW** from \`@ohos\`/\`System\` call sites above.`,
      );
    }
    // Declaration intent must NOT fall through to a fat explore / include dump when empty.
    if (declarationResult.attempted) {
      return finishCompact(
        declarationResult.hitCount > 0
          ? `Declaration-site survey — **${declarationResult.hitCount}** site(s). **ANSWER NOW** from ids + bindings above; do not Grep the same Type.`
          : 'Declaration-site survey complete (0 sites). **ANSWER NOW** from the note above.',
      );
    }
    if (controlSyncResult.section) {
      return finishCompact(
        `Control/Toggle state-sync survey — **${controlSyncResult.hitCount}** file(s). **ANSWER NOW** from Manager/Service sites above.`,
      );
    }
    if (kitUsageResult.section && queryAsksKitInstallDeps(query)) {
      return finishCompact(
        `Kit install/deps survey — **ANSWER NOW** from imports + oh-package lines above; do not Grep oh-package again.`,
      );
    }
    if (moduleExportResult.section) {
      return finishCompact(
        `NAPI / native export survey — **${moduleExportResult.hitCount}** export(s). **ANSWER NOW**; do not Grep napi_define again.`,
      );
    }
    if (dtsWrapResult.section) {
      return finishCompact(
        `\`.d.ts\` wrap call sites — **${dtsWrapResult.hitCount}** file(s). **ANSWER NOW**; do not Grep the wrap basename again.`,
      );
    }
    if (moduleDepResult.hitCount > 0 || (queryAsModuleDependencySurvey(query) && moduleDepResult.section)) {
      return finishCompact(
        `Module dependency / cycle survey — **ANSWER NOW** from the edges above; do not glob every oh-package.`,
      );
    }
    if (dataSourceResult.edgeCount > 0 && !apiUsageResult.section) {
      return finishCompact(
        `Data-source survey — **${dataSourceResult.edgeCount}** upstream symbol(s). **ANSWER NOW** from system \`@ohos\`/\`@kit\` imports first.`,
      );
    }
    if (apiUsageResult.fileCount > 0 && !dataSourceResult.section) {
      return finishCompact(
        `API usage survey — **${apiUsageResult.fileCount}** file(s). **ANSWER NOW** from the list above.`,
      );
    }
    if (queryAsReturnValueConsumerSurvey(query) && callerBulletCount > 0) {
      return finishCompact(
        `Return-value consumers — **${callerBulletCount}** caller site(s). **ANSWER NOW** from the caller inventory; do not Grep the same member.`,
      );
    }
    // Return-value intent with empty graph callers — stop before SDK .d.ts dumps.
    if (queryAsReturnValueConsumerSurvey(query) && callerSection) {
      return finishCompact(
        'Return-value consumer survey complete. **ANSWER NOW** from the inventory above; do not open SDK `.d.ts` stubs.',
      );
    }
    // Type + listed methods (Set/Test/Fill) — multi-anchor would block omit-source; stop here.
    if (listedTypeMethods && callerBulletCount > 0) {
      return finishCompact(
        `Caller inventory — **${callerBulletCount}** site(s) for listed methods. **ANSWER NOW**; do not fan out callers per method.`,
      );
    }

    const omitSource = shouldOmitSourceBodies({
      importSiteCount: importResult.siteCount,
      hasFilteredImports: importInventoryFilter && importResult.siteCount > 0,
      callerBulletCount,
      memberFileCount,
      apiUsageFileCount: apiUsageResult.fileCount,
      configRendered: !!configSection,
      kitModuleSurveyRendered: !!kitUsageResult.section,
      inheritanceListed,
      domainFileCount: domainFileResult.fileCount,
      dataSourceEdgeCount: dataSourceResult.edgeCount,
    }, hasFlowPath, multiAnchor) || hoverResult.hitCount > 0;

    if (!omitSource) return null;

    if (configSection) return finishCompact('Config/manifest content above — answer from it directly. **ANSWER NOW.**');
    if (hoverResult.section) {
      return finishCompact(
        `Hover/pointer handler survey — **${hoverResult.hitCount}** site(s). **ANSWER NOW** from the list + snippets; do not Grep \`onHover\` again.`,
      );
    }
    if (kitUsageResult.section) {
      return finishCompact(
        `Kit module **in-repo usage** survey — **${kitUsageResult.symbolCount}** imported symbol(s). ` +
        'This is not an SDK catalog. **ANSWER NOW** from the usage list; do not Grep the same `@kit` path.',
      );
    }
    if (domainFileResult.fileCount > 0) {
      return finishCompact(
        `Domain file survey — **${domainFileResult.fileCount}** related file(s) listed above. ` +
        'This is the exhaustive related-file inventory; **ANSWER NOW** — no glob/search needed.',
      );
    }
    if (apiUsageResult.fileCount > 0) {
      return finishCompact(
        `API usage survey — **${apiUsageResult.fileCount}** file(s). **ANSWER NOW** from the list above.`,
      );
    }
    if (dataSourceResult.edgeCount > 0) {
      return finishCompact(
        `Data-source survey — **${dataSourceResult.edgeCount}** upstream symbol(s). **ANSWER NOW.**`,
      );
    }
    if (inheritanceListed) {
      return finishCompact(
        'Inheritance survey above lists all direct subtypes found. **ANSWER NOW** — do not grep `extends`.',
      );
    }
    if (importResult.compactListing) {
      return finishCompact(
        `Listed **${importResult.siteCount}** import site(s). **ANSWER NOW** from the dependency list.`,
      );
    }
    if (callerBulletCount >= 1) {
      return finishCompact(
        `Caller inventory lists **${callerBulletCount}** call site(s). **ANSWER NOW** from the section above.`,
      );
    }
    if (memberFileCount >= 2) {
      return finishCompact(
        `Member/pattern usage in **${memberFileCount}** file(s). **ANSWER NOW** from the inventory above.`,
      );
    }
    return finishCompact('Inventory sections above are complete for this query. **ANSWER NOW.**');
  }

  /**
   * Render a compact symbol-bounded slice of one file (lightweight mechanism path).
   */
  private renderLightMechanismSource(
    projectRoot: string,
    filePath: string,
    nodes: Node[],
    maxChars: number,
  ): string | null {
    const absPath = validatePathWithinRoot(projectRoot, filePath);
    if (!absPath || !existsSync(absPath)) return null;
    const relevant = nodes.filter((n) => n.startLine > 0 && n.kind !== 'import' && n.kind !== 'export');
    if (relevant.length === 0) return null;
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      return null;
    }
    const fileLines = content.split('\n');
    const start = Math.max(1, Math.min(...relevant.map((n) => n.startLine)) - 8);
    const end = Math.min(
      fileLines.length,
      Math.max(...relevant.map((n) => n.endLine ?? n.startLine)) + 8,
    );
    const lang = relevant[0]?.language || '';
    const names = [...new Set(relevant.map((n) => n.name))].slice(0, 4).join(', ');
    const out: string[] = [fileSectionHeader(filePath, names), '', '```' + lang];
    for (let i = start; i <= end; i++) {
      out.push(`${i}\t${fileLines[i - 1] ?? ''}`);
    }
    out.push('```', '');
    let text = out.join('\n');
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n... (section trimmed — another explore with a specific symbol is cheaper than grep/read)\n\`\`\`\n`;
    }
    return text;
  }

  /**
   * Lightweight mechanism explore — seed entry symbols + flow spine, skip
   * findRelevantContext. Fast enough for MCP budget; complete enough to avoid
   * agent grep/read loops (token savings).
   */
  private tryLightMechanismExplore(cg: HomeGraph, query: string, projectRoot: string): ToolResult | null {
    if (!shouldTryLightMechanismExplore(query)) return null;

    const STRUCTURE_KINDS = new Set(['class', 'struct', 'interface', 'component', 'method', 'function']);
    const isTestPath = (p: string) => /(^|\/)(tests?|spec)\//i.test(p) || /\.(test|spec)\./i.test(p);
    const fileNodes = new Map<string, Node[]>();
    const seedIds = new Set<string>();

    const addNode = (n: Node): void => {
      if (isOhosApiFilePath(n.filePath)) return;
      if (isTestPath(n.filePath)) return;
      if (n.kind !== 'import' && !STRUCTURE_KINDS.has(n.kind)) return;
      seedIds.add(n.id);
      const list = fileNodes.get(n.filePath) ?? [];
      if (!list.some((x) => x.id === n.id)) list.push(n);
      fileNodes.set(n.filePath, list);
    };

    const domainTermsEarly = extractDomainSearchTerms(query);
    const distinctiveEarly = domainTermsEarly.filter(
      (t) => /^[\x00-\x7F]+$/.test(t) && !GENERIC_VERB_ANCHOR_NOISE.has(t.toLowerCase()),
    );

    // Distinctive-token IMPORT seeds first — `@ohos.convertxml` / `XmlParse*` before
    // structure FTS fills the budget with unrelated Parser* hits.
    for (const term of distinctiveEarly.slice(0, 4)) {
      const termLc = term.toLowerCase();
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(term, { kinds: ['import'], limit: 40 });
      } catch {
        continue;
      }
      for (const r of hits) {
        if (isOhosApiFilePath(r.node.filePath)) continue;
        const line = resolveImportLineFromNode(r.node, projectRoot).toLowerCase();
        const nameLc = r.node.name.toLowerCase();
        const sigLc = (r.node.signature || '').toLowerCase();
        if (!nameLc.includes(termLc) && !line.includes(termLc) && !sigLc.includes(termLc)) continue;
        addNode(r.node);
        try {
          for (const n of cg.getNodesInFile(r.node.filePath)) {
            if (STRUCTURE_KINDS.has(n.kind) && n.name.toLowerCase().includes(termLc)) addNode(n);
          }
        } catch { /* optional */ }
        if (seedIds.size >= 16) break;
      }
    }

    for (const seed of extractMechanismEntrySeeds(query)) {
      if (seed.startsWith('@')) {
        let hits: SearchResult[] = [];
        try {
          hits = cg.searchNodes(seed, { kinds: ['import'], limit: 12 });
        } catch {
          continue;
        }
        for (const r of hits) addNode(r.node);
        continue;
      }
      for (const n of cg.getNodesByName(seed)) {
        if (STRUCTURE_KINDS.has(n.kind)) addNode(n);
      }
    }

    if (seedIds.size < 2 || distinctiveEarly.length > 0) {
      const domainTerms = domainTermsEarly;
      // Prefer distinctive ASCII (xml) then Chinese nouns — never seed on bare verbs
      // when a distinctive token exists (xml parse → convertxml, not ParseNotification*).
      const distinctive = distinctiveEarly;
      const ranked = distinctive.length > 0
        ? [
            ...distinctive,
            ...domainTerms.filter((t) => !/^[\x00-\x7F]+$/.test(t) && t.length >= 2 && t.length <= 8),
          ]
        : [
            ...domainTerms.filter((t) => /^[\x00-\x7F]+$/.test(t) && !GENERIC_VERB_ANCHOR_NOISE.has(t.toLowerCase())),
            ...domainTerms.filter((t) => !/^[\x00-\x7F]+$/.test(t) && t.length >= 2 && t.length <= 8),
            ...domainTerms.filter((t) => /^[\x00-\x7F]+$/.test(t) && GENERIC_VERB_ANCHOR_NOISE.has(t.toLowerCase())),
          ];
      for (const term of ranked.slice(0, 10)) {
        let hits: SearchResult[] = [];
        try {
          hits = cg.searchNodes(term, {
            kinds: ['class', 'struct', 'interface', 'function', 'method', 'import'],
            limit: 20,
          });
        } catch {
          continue;
        }
        const termIsVerb = GENERIC_VERB_ANCHOR_NOISE.has(term.toLowerCase());
        const termLc = term.toLowerCase();
        for (const r of hits) {
          if (isOhosApiFilePath(r.node.filePath)) continue;
          const nameLc = r.node.name.toLowerCase();
          const pathLc = r.node.filePath.toLowerCase();
          const sigLc = (r.node.signature || '').toLowerCase();
          const nameHit = nameLc.includes(termLc);
          const pathHit = pathLc.includes(termLc);
          const sigHit = sigLc.includes(termLc);
          // Verb-only hits need path affinity; imports for verbs are dropped when
          // distinctive tokens exist (handled by ranked list above).
          if (termIsVerb && !pathHit) continue;
          // Distinctive token: require name/path/signature to actually mention it
          // (drops FTS neighbors that only share an unrelated Parser suffix).
          if (!termIsVerb && distinctive.length > 0 && !nameHit && !pathHit && !sigHit) continue;
          const entryOk =
            r.node.kind === 'import'
            || ((r.node.kind === 'function' || r.node.kind === 'method' || r.node.kind === 'class'
              || r.node.kind === 'interface' || r.node.kind === 'struct')
              && (nameHit || pathHit));
          if (!entryOk) continue;
          addNode(r.node);
          if (seedIds.size >= 16) break;
        }
        if (seedIds.size >= 12) break;
      }

      // Prefer seeds that mention a distinctive token when we have any.
      if (distinctive.length > 0 && seedIds.size > 0) {
        const keep = new Set<string>();
        for (const id of seedIds) {
          const n = cg.getNode(id);
          if (!n) continue;
          const line = n.kind === 'import' ? resolveImportLineFromNode(n, projectRoot) : '';
          const blob = `${n.name}\n${n.filePath}\n${n.signature || ''}\n${line}`.toLowerCase();
          if (distinctive.some((t) => blob.includes(t.toLowerCase()))) keep.add(id);
        }
        if (keep.size > 0) {
          for (const id of [...seedIds]) {
            if (!keep.has(id)) {
              seedIds.delete(id);
            }
          }
          for (const [fp, nodes] of [...fileNodes.entries()]) {
            const filtered = nodes.filter((n) => keep.has(n.id));
            if (filtered.length === 0) fileNodes.delete(fp);
            else fileNodes.set(fp, filtered);
          }
        }
      }
    }

    if (seedIds.size === 0) return null;

    const seeds = extractMechanismEntrySeeds(query);
    const flow = this.buildFlowFromNamedSymbols(cg, `${query} ${seeds.join(' ')}`);

    const lines: string[] = [
      `**Exploration: ${query}**`,
      '',
      '> **ANSWER NOW from this response.** Do **not** Grep or Read listed files in parallel — Source below is authoritative.',
      '',
      `Mechanism anchors: **${seedIds.size}** symbol(s) — lightweight explore (seed + flow spine).`,
      '',
    ];

    // Import inventory: only distinctive deps (xml), never bare parse/parsing.
    const distinctiveDeps = extractDependencySymbolsFromQuery(query)
      .filter((s) => !GENERIC_VERB_ANCHOR_NOISE.has(s.toLowerCase()));
    const importQuery = distinctiveDeps.length > 0
      ? distinctiveDeps.join(' ')
      : extractDomainSearchTerms(query)
          .filter((t) => /^[\x00-\x7F]+$/.test(t) && !GENERIC_VERB_ANCHOR_NOISE.has(t.toLowerCase()))
          .join(' ');
    const importResult = importQuery
      ? this.buildImportSitesSection(cg, importQuery, projectRoot)
      : { section: '', siteCount: 0, compactListing: false };
    if (importResult.section) lines.push(importResult.section);
    if (flow.text) lines.push(flow.text);

    // Shared-lib + GLES/EGL thread: surface CMake link lines before bodies.
    if (queryAsNativeRenderThreadSurvey(query)) {
      const cmakeHits: string[] = [];
      try {
        for (const f of cg.getFiles()) {
          const fp = f.path.replace(/\\/g, '/');
          if (!/CMakeLists\.txt$/i.test(fp)) continue;
          if (!/foldeffect|effectrender|render|egl/i.test(fp) && extractPathSegmentsFromQuery(query).length > 0) {
            const segs = extractPathSegmentsFromQuery(query);
            if (!segs.some((s) => fp.toLowerCase().includes(s.toLowerCase().split('/').pop() || s))) {
              // still allow any CMake with GLESv3/EGL
            }
          }
          const abs = validatePathWithinRoot(projectRoot, f.path);
          if (!abs) continue;
          let content = '';
          try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
          if (!/GLES|EGL|OpenGL/i.test(content)) continue;
          const fileLines = content.split('\n');
          for (let i = 0; i < fileLines.length; i++) {
            const line = fileLines[i] ?? '';
            if (/GLES|EGL|OpenGL|target_link|pthread|thread/i.test(line)) {
              cmakeHits.push(`- \`${fp}:${i + 1}\`  \`${line.trim().slice(0, 100)}\``);
            }
          }
          if (cmakeHits.length >= 12) break;
        }
      } catch { /* optional */ }
      if (cmakeHits.length > 0) {
        lines.push('**CMake / link + GL libs**', '');
        lines.push(...cmakeHits.slice(0, 12));
        lines.push('');
      }
    }

    const distinctiveForScore = extractDomainSearchTerms(query).filter(
      (t) => /^[\x00-\x7F]+$/.test(t) && !GENERIC_VERB_ANCHOR_NOISE.has(t.toLowerCase()),
    );
    const fileScores = new Map<string, number>();
    for (const [fp, nodes] of fileNodes) {
      if (isOhosApiFilePath(fp)) continue;
      let score = 0;
      const fpLc = fp.toLowerCase();
      if (distinctiveForScore.some((t) => fpLc.includes(t.toLowerCase()))) score += 30;
      for (const n of nodes) {
        const line = n.kind === 'import' ? resolveImportLineFromNode(n, projectRoot) : '';
        const blob = `${n.name}\n${n.signature || ''}\n${line}`.toLowerCase();
        if (distinctiveForScore.some((t) => blob.includes(t.toLowerCase()))) score += 20;
        // Prefer files whose imports/modules compound the domain token (convertxml ⊃ xml).
        if (
          n.kind === 'import'
          && distinctiveForScore.some((t) => {
            const tLc = t.toLowerCase();
            return (line.includes(tLc) || blob.includes(tLc)) && (line.includes('@ohos.') || line.includes('@kit.'));
          })
        ) {
          score += 20;
        }
        if (flow.pathNodeIds.has(n.id)) score += 20;
        else if (flow.uniqueNamedNodeIds.has(n.id)) score += 10;
        else score += 5;
      }
      fileScores.set(fp, score);
    }

    const sortedFiles = [...fileScores.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    lines.push('**Source Code**', '');
    lines.push(
      '> Line-numbered source below — treat as already Read. Do **not** grep/read/`homegraph_node` these files again.',
    );
    lines.push('');

    let totalChars = lines.join('\n').length;
    let filesRendered = 0;
    for (const [fp] of sortedFiles) {
      if (filesRendered >= 4 || totalChars > 12_000) break;
      const chunk = this.renderLightMechanismSource(projectRoot, fp, fileNodes.get(fp) ?? [], 3800);
      if (!chunk) continue;
      lines.push(chunk);
      totalChars += chunk.length;
      filesRendered++;
    }

    if (filesRendered === 0 && !importResult.section && !flow.text) return null;

    lines.push('---');
    lines.push(
      '> **Mechanism explore complete — ANSWER NOW.** Sections above cover the wired mechanism. ' +
      'Do **not** call `homegraph_node`, Read, or Grep for symbols/files already shown (that multiplies tokens). ' +
      'Only one tighter `homegraph_explore` if a **named** symbol essential to the answer is still missing.',
    );
    lines.push('');

    return this.textResult(lines.join('\n'));
  }

  /**
   * Compact explore for local-symbol behavior questions — skips findRelevantContext
   * and caps to 1–2 defining files (avoids the ~24K related-file dump).
   */
  private tryCompactLocalSymbolExplore(cg: HomeGraph, query: string, projectRoot: string): ToolResult | null {
    // Inventory runs *before* this on the call sites. Do not refuse compact
    // merely because inventory *intent* matched — empty inventory must fall
    // through here (bare callbacks like OnSurfaceChangedCB).
    // Hard rule: 1–3 named anchors → compact for local-detail / bare-id shapes.
    // Multi-anchor flow bags (routeSave/onSave, aboutToAppear/build, thunk→thunk)
    // must fall through to full explore so Flow / Dynamic-dispatch / adaptive
    // sizing still surface — compact trail is not a substitute.
    // Mechanism / domain-mechanism bags belong to light-mechanism (or full explore),
    // never compact — agents rewrite "如何实现 xml 解析" to "xml parse" and would
    // otherwise seed every method named `parse`.
    if (shouldTryLightMechanismExplore(query) || queryAsMechanismSurvey(query)) {
      return null;
    }
    const bareId = /^[A-Za-z_][\w]*$/.test(query.trim());
    if (
      !queryAsLocalSymbolDetail(query)
      && !queryAsFocusedUiCluster(query)
      && !queryAsComponentSurfaceSurvey(query)
      && !bareId
      && !queryHasFocusedNamedAnchors(query)
    ) {
      return null;
    }

    const STRUCTURE_KINDS = new Set([
      'class', 'struct', 'interface', 'component', 'method', 'function', 'constant', 'variable', 'property', 'field',
    ]);
    const isTestPath = (p: string) => /(^|\/)(tests?|spec)\//i.test(p) || /\.(test|spec)\./i.test(p);

    const names = extractLocalDetailAnchors(query).slice(0, 4);

    if (names.length === 0) return null;

    // Multi-anchor bags that form a Flow / Dynamic-dispatch section normally fall
    // through to full explore. EXCEPT focused UI Type clusters / local-detail /
    // Type.member — full explore is a 15–30k dump for a local composition question.
    const stayOnCompact =
      queryAsFocusedUiCluster(query)
      || queryAsComponentSurfaceSurvey(query)
      || queryAsNamedComponentAction(query)
      || queryHasNamedMemberFocus(query)
      || queryAsLocalSymbolDetail(query);
    const rawTokens = query.split(/[\s,()[\]]+/).filter(
      (t) => t.length >= 3 && /^[A-Za-z_][\w]*$/.test(t),
    );
    // Multi-anchor: prefer full explore when Flow / Dynamic-dispatch has content.
    // Type.member / UI-cluster bags stay on compact UNLESS the flow surfaces
    // @Prop/@Link state transfers — those hops are the answer for decorator
    // dependency questions and must not be buried under a compact UI trail.
    if (names.length >= 2 || rawTokens.length >= 2) {
      try {
        const flow = this.buildFlowFromNamedSymbols(cg, query);
        if (flow.text.length > 0) {
          if (!stayOnCompact) return null;
          if (/state: @(?:Prop|Link)\b/.test(flow.text)) return null;
        }
      } catch {
        // Probe is best-effort — stay on compact if flow build fails.
      }
    }

    const fileNodes = new Map<string, Node[]>();
    const seedIds = new Set<string>();

    const addNode = (n: Node): void => {
      if (isTestPath(n.filePath) && !queryAsTestOnlyInterpretation(query)) return;
      if (!STRUCTURE_KINDS.has(n.kind)) return;
      seedIds.add(n.id);
      const list = fileNodes.get(n.filePath) ?? [];
      if (!list.some((x) => x.id === n.id)) list.push(n);
      fileNodes.set(n.filePath, list);
    };

    const typeNames = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
    const typeNameSet = new Set(typeNames.map((t) => t.toLowerCase()));
    const bridge = queryNeedsCoNamedUseBridge(query);
    const memberFocus = queryHasNamedMemberFocus(query);
    const uiCluster = queryAsFocusedUiCluster(query);
    const typeLifecycle = queryAsTypeLifecycleSurvey(query);
    const componentSurface = queryAsComponentSurfaceSurvey(query)
      || uiCluster
      || typeLifecycle
      || names.some(queryLooksLikeUiComponentType);
    // Page/Dialog surface & UI clusters: trail only — pulling callee files ballooned
    // ThemeHome-style answers by 5–10k without adding the UI-child / nav answer.
    const surfaceTrailOnly = (componentSurface || uiCluster || typeLifecycle) && !memberFocus
      && !queryAsNamedComponentAction(query);
    const bareMemberOnly = bareId && isMemberLikeIdentifier(query.trim());

    const ownedByNamedType = (n: Node): boolean => {
      if (typeNameSet.size === 0) return true;
      const qn = (n.qualifiedName || '').toLowerCase();
      if ([...typeNameSet].some((t) => qn === t || qn.startsWith(`${t}.`) || qn.startsWith(`${t}::`) || qn.includes(`::${t}.`) || qn.endsWith(`::${t}`))) {
        return true;
      }
      // Same file as a named type definition.
      try {
        for (const t of typeNames) {
          for (const owner of cg.getNodesByName(t)) {
            if (
              (owner.kind === 'class' || owner.kind === 'struct' || owner.kind === 'interface' || owner.kind === 'component')
              && owner.filePath === n.filePath
            ) {
              return true;
            }
          }
        }
      } catch { /* */ }
      return false;
    };

    for (const seed of names) {
      const candidates = cg.getNodesByName(seed);
      const preferOwned =
        memberFocus
        && isMemberLikeIdentifier(seed)
        && typeNameSet.size > 0;
      // Prefer in-repo implementations over SDK `.d.ts` / @ohos API stubs when both exist.
      const projectFirst = [...candidates].sort((a, b) => {
        const score = (n: Node) => {
          let s = 0;
          if (isOhosApiFilePath(n.filePath) || /\.d\.ts$/i.test(n.filePath)) s -= 50;
          if (isTestFile(n.filePath)) s -= 20;
          if (n.kind === 'class' || n.kind === 'struct' || n.kind === 'component') s += 5;
          return s;
        };
        return score(b) - score(a);
      });
      const filtered = preferOwned
        ? (() => {
            const owned = projectFirst.filter(ownedByNamedType);
            return owned.length > 0 ? owned : projectFirst;
          })()
        : projectFirst;
      for (const n of filtered) {
        // Skip SDK stubs when a project definition of the same name exists.
        if (
          (isOhosApiFilePath(n.filePath) || /\.d\.ts$/i.test(n.filePath))
          && filtered.some(
            (o) =>
              o.name === n.name
              && !isOhosApiFilePath(o.filePath)
              && !/\.d\.ts$/i.test(o.filePath),
          )
        ) {
          continue;
        }
        addNode(n);
        // Page/Component surface digests need build/aboutToAppear as their own
        // nodes — otherwise we only have the outer struct and dump the whole body.
        if (componentSurface || uiCluster || typeLifecycle) {
          if (n.kind === 'component' || n.kind === 'class' || n.kind === 'struct') {
            try {
              for (const e of cg.getOutgoingEdges(n.id)) {
                if (e.kind !== 'contains') continue;
                const child = cg.getNode(e.target);
                if (
                  child
                  && (child.kind === 'method' || child.kind === 'function')
                  && isUiSurfaceDigestMethod(child.name, uiCluster)
                ) {
                  addNode(child);
                }
              }
            } catch { /* */ }
          }
        }
        if (seedIds.size >= 12) break;
      }
      if (seedIds.size >= 12) break;
    }

    if (seedIds.size === 0) return null;

    const pathAffinity = (seedPath: string, otherPath: string): boolean => {
      const a = seedPath.replace(/\\/g, '/').split('/');
      const b = otherPath.replace(/\\/g, '/').split('/');
      // Same package only (e.g. feature/foldeffect/…). Do NOT fallback to
      // top-level alone — that keeps cross-feature logError homonyms.
      return a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[1] === b[1];
    };
    const seedPaths = [...seedIds].map((id) => {
      try { return cg.getNode(id)?.filePath; } catch { return undefined; }
    }).filter((p): p is string => !!p);
    const nearSeed = (fp: string): boolean =>
      seedPaths.some((sp) => sp === fp || pathAffinity(sp, fp));

    // Neighbor policy (agents often search("Foo") alone — do not dump 11 callees):
    // - bareId / caller-bridge: callers of PRIMARY name only, no callee fan-out
    // - Type.member / UI action / pinpoint local-detail: callers + callees
    // - Type.member: expand on the *member* (isExpired), not only the Type, and
    //   do not path-filter callers — UI marking often lives in another package.
    const callersOnly =
      surfaceTrailOnly
      || bareMemberOnly
      || (bareId && !componentSurface)
      || bridge
      || (shouldBuildCallerInventory(query) && !queryAsNamedComponentAction(query) && !memberFocus && !componentSurface)
      // Conditional wiring ("失败时还会…") — method body + callers, not logInfo fan-out.
      || /失败时|还会被注册|还会被|still\s+(?:be\s+)?(?:register|call)|if\s+.+\s+fails?/i.test(query);
    const primaryName = names[0]!;
    const memberNames = new Set<string>([
      ...extractMemberAccessFromQuery(query).map((m) => m.member),
      ...names.filter((n) => isMemberLikeIdentifier(n)),
    ]);
    // UI Type clusters: expand every named *Page/*Dialog seed — not only the first
    // token — so Page↔Dialog composition stays in one compact answer.
    const expandNameSet = new Set<string>(
      uiCluster || componentSurface
        ? [...typeNames, primaryName]
        : [primaryName],
    );
    const expandIds = [...seedIds].filter((id) => {
      try {
        const n = cg.getNode(id);
        if (!n) return false;
        if (memberFocus && memberNames.size > 0) return memberNames.has(n.name);
        return expandNameSet.has(n.name);
      } catch {
        return false;
      }
    });
    // Fall back to primary type seeds if member name wasn't indexed as its own node.
    const expandIdsFinal = expandIds.length > 0
      ? expandIds
      : [...seedIds].filter((id) => {
          try {
            return cg.getNode(id)?.name === primaryName;
          } catch {
            return false;
          }
        });

    // Pull one-hop neighbors into the focus set so the answer is graph-complete
    // without dumping an import inventory for isExpired/onClick.
    const neighborIds = new Set<string>();
    for (const id of expandIdsFinal) {
      let seedPath = '';
      try { seedPath = cg.getNode(id)?.filePath ?? ''; } catch { /* */ }
      try {
        for (const { node: c } of cg.getCallers(id).slice(0, callersOnly ? 8 : 12)) {
          // Type.member / UI-marking: keep cross-package callers (path filter drops them).
          if (
            !memberFocus
            && !queryAsNamedComponentAction(query)
            && !nearSeed(c.filePath)
            && seedPath
            && !pathAffinity(seedPath, c.filePath)
          ) {
            continue;
          }
          if (!isTestPath(c.filePath) || queryAsTestOnlyInterpretation(query)) {
            neighborIds.add(c.id);
            // List callers in the trail, but don't pull their whole files into Source
            // for bare-name / caller-bridge shapes (that ballooned search("SortWidgets")).
            if (!callersOnly) addNode(c);
          }
        }
        if (!callersOnly) {
          for (const { node: c } of cg.getCallees(id).slice(0, 10)) {
            // Skip log*/hilog helpers — Export→logInfo homonyms ballooned seeds.
            if (/^log(?:Info|Error|Warn|Debug|Fatal)?$/i.test(c.name) || /^hilog$/i.test(c.name)) {
              continue;
            }
            if (
              !memberFocus
              && !nearSeed(c.filePath)
              && seedPath
              && !pathAffinity(seedPath, c.filePath)
            ) {
              continue;
            }
            if (!isTestPath(c.filePath) || queryAsTestOnlyInterpretation(query)) {
              neighborIds.add(c.id);
              addNode(c);
            }
          }
        }
      } catch {
        // skip edge trail for this seed
      }
    }

    const lines: string[] = [
      `**Exploration: ${query}**`,
      '',
      '> **ANSWER NOW from this response.** Do **not** Grep/Read/search/explore/node/callers for the same symbols — trail + Source below are authoritative.',
      '',
      `Local-symbol focus: **${seedIds.size}** seed(s)` +
        (neighborIds.size > 0 ? `, **${neighborIds.size}** caller/callee neighbor(s)` : '') +
        ' — compact explore (definition + edge trail, no related-file dump).',
      '',
    ];

    // Blast radius for entry seeds (locations only) — same signal full explore
    // always-on section gives, so bare-name edits know what to update/verify.
    {
      const nodes = new Map<string, Node>();
      for (const id of seedIds) {
        try {
          const n = cg.getNode(id);
          if (n) nodes.set(id, n);
        } catch { /* skip */ }
      }
      const blast = this.buildBlastRadiusSection(cg, {
        nodes,
        edges: [],
        roots: [...seedIds],
      } as Subgraph);
      if (blast) lines.push(blast);
    }

    // Always list a short edge trail — property→UI and button→action questions
    // need callers/callees; agents otherwise re-grep the same names.
    {
      const trail: string[] = ['**Call / use trail**', ''];
      let trailBullets = 0;
      const trailIds = (callersOnly ? expandIdsFinal : [...seedIds]).slice(0, 6);
      for (const id of trailIds) {
        let seedNode: Node | null | undefined;
        try {
          seedNode = cg.getNode(id);
        } catch {
          continue;
        }
        if (!seedNode) continue;
        let callers: Array<{ node: Node }> = [];
        let callees: Array<{ node: Node }> = [];
        try { callers = cg.getCallers(id).slice(0, memberFocus ? 12 : 8) as Array<{ node: Node }>; } catch { /* */ }
        if (!callersOnly) {
          try { callees = cg.getCallees(id).slice(0, 8) as Array<{ node: Node }>; } catch { /* */ }
        }
        if (!memberFocus) {
          callers = callers.filter((c) => nearSeed(c.node.filePath) || pathAffinity(seedNode.filePath, c.node.filePath));
          callees = callees.filter((c) => nearSeed(c.node.filePath) || pathAffinity(seedNode.filePath, c.node.filePath));
        }
        if (callers.length === 0 && callees.length === 0) continue;
        trail.push(`- \`${seedNode.name}\` (${seedNode.kind}) — ${seedNode.filePath}:${seedNode.startLine}`);
        for (const c of callers) {
          const loc = c.node.startLine ? `:${c.node.startLine}` : '';
          trail.push(`  ← used by \`${c.node.name}\` (${c.node.kind}) — ${c.node.filePath}${loc}`);
          trailBullets++;
        }
        for (const c of callees) {
          const loc = c.node.startLine ? `:${c.node.startLine}` : '';
          trail.push(`  → calls \`${c.node.name}\` (${c.node.kind}) — ${c.node.filePath}${loc}`);
          trailBullets++;
        }
      }
      if (trailBullets > 0) {
        trail.push('');
        trail.push(
          '> **ANSWER NOW** from this trail + Source below. Do not grep/search/read the same symbols again.',
        );
        trail.push('');
        lines.push(...trail);
      }
    }

    // When the graph has no call edges (common for static Type.member reads),
    // fall back to a bounded indexed-file text scan for `name(` usages so the
    // agent does not pay a Grep round-trip for the same anchors.
    const textUsageHits: Array<{ filePath: string; line: number; text: string; symbol: string }> = [];
    // Also scan when the agent asks upstream/registration — callee neighbors
    // alone do not show Export / OH_NativeXComponent wiring sites.
    const needUsageScan =
      !componentSurface
      && (neighborIds.size === 0
        || memberFocus
        || /上下游|上游|下游|注册|挂到|callback|upstream|downstream/i.test(query)
        || names.every((n) => /(?:CB|Callback)$/i.test(n)));
    if (needUsageScan) {
      // Scan ALL focused anchors (incl. PascalCase callables) — previously only
      // lowercase names were scanned, so OnSurfaceChangedCB registration sites
      // never surfaced and agents fell through to callers/grep/read.
      const typeSeeds = extractTypeNamesFromQuery(query);
      // Prefer member-like names for Type.member UI questions (isExpired over Type).
      const scanNames = memberFocus && memberNames.size > 0
        ? [...memberNames].slice(0, 3)
        : names.slice(0, 3);
      if (scanNames.length > 0) {
        try {
          const defLineKeys = new Set<string>();
          for (const nodes of fileNodes.values()) {
            for (const n of nodes) {
              if (scanNames.includes(n.name)) defLineKeys.add(`${n.filePath}:${n.startLine}`);
            }
          }
          const norm = (fp: string) => fp.replace(/\\/g, '/');
          const defDirs = new Set(
            [...fileNodes.keys()].map((fp) => norm(fp).split('/').slice(0, 4).join('/')),
          );
          // Large monorepos: never rely on getFiles() order + hard slice — Type.member
          // call sites (LauncherCardInfo.isExpired filters) live near the defining
          // package and must be scanned first or Grep wins.
          const rankScanFile = (fp: string): number => {
            const n = norm(fp);
            let score = 0;
            if ([...defDirs].some((d) => n === d || n.startsWith(`${d}/`))) score += 100;
            if (typeSeeds.some((t) => n.toLowerCase().includes(t.toLowerCase()))) score += 40;
            return score;
          };
          const files = cg.getFiles()
            .map((f) => f.path)
            .filter((fp) => !isTestPath(fp))
            .map((fp) => ({ fp, score: rankScanFile(fp) }))
            .sort((a, b) => b.score - a.score || a.fp.localeCompare(b.fp))
            .map((x) => x.fp);

          const hitCap = bareMemberOnly ? 6 : memberFocus ? 10 : 8;
          const scanFileList = (list: string[], requireTypeMention: boolean): void => {
            for (const fp of list) {
              if (textUsageHits.length >= hitCap) break;
              const absPath = validatePathWithinRoot(projectRoot, fp);
              if (!absPath || !existsSync(absPath)) continue;
              let content: string;
              try {
                content = readFileSync(absPath, 'utf-8');
              } catch {
                continue;
              }
              if (
                requireTypeMention
                && typeSeeds.length > 0
                && !typeSeeds.some((t) => content.includes(t))
              ) {
                continue;
              }
              // Prefer files that also mention a co-named type when both present
              // (skip for single-anchor upstream/registration scans and Type.member).
              if (
                !memberFocus
                && typeSeeds.length > 1
                && names.length > 1
                && !typeSeeds.some((t) => content.includes(t))
              ) {
                continue;
              }
              const fileLines = content.split('\n');
              for (const sym of scanNames) {
                const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Match call OR bare identifier use; prefer Type.member when typed.
                const typeAlt = typeSeeds.length > 0
                  ? `(?:\\b(?:${typeSeeds.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\.)?`
                  : '';
                const re = new RegExp(`${typeAlt}\\b${escaped}\\b`);
                const defRe = new RegExp(
                  `^\\s*(?:export\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*${escaped}\\s*\\(`,
                );
                for (let i = 0; i < fileLines.length; i++) {
                  const lineText = fileLines[i] ?? '';
                  if (!re.test(lineText)) continue;
                  if (defLineKeys.has(`${fp}:${i + 1}`)) continue;
                  // Skip the method's own definition line (no Type. prefix / no call punctuation).
                  if (defRe.test(lineText) && !lineText.includes(`.${sym}`)) continue;
                  textUsageHits.push({ filePath: fp, line: i + 1, text: lineText.trim(), symbol: sym });
                  if (!fileNodes.has(fp)) fileNodes.set(fp, []);
                  if (textUsageHits.length >= hitCap) break;
                }
                if (textUsageHits.length >= hitCap) break;
              }
            }
          };

          // Pass 1: same package / type-path affinity (score > 0), require Type mention when known.
          const nearFiles = files.filter((fp) => rankScanFile(fp) > 0).slice(0, memberFocus ? 80 : 40);
          scanFileList(nearFiles, memberFocus && typeSeeds.length > 0);
          // Pass 2: broader if still empty / thin (still bounded).
          if (textUsageHits.length < 3) {
            const rest = files.filter((fp) => rankScanFile(fp) === 0).slice(0, memberFocus ? 160 : 80);
            scanFileList(rest, false);
          }
        } catch {
          // text scan is best-effort
        }
      }
      if (textUsageHits.length > 0) {
        lines.push('**Text usage sites** (no call-edge indexed for these names — scanned in-repo)', '');
        for (const h of textUsageHits.slice(0, 10)) {
          lines.push(`- \`${h.symbol}\` — ${h.filePath}:${h.line}  \`${h.text.slice(0, 120)}\``);
        }
        lines.push('');
        lines.push(
          memberFocus
            ? '> These lines are the in-repo **call/filter sites** for the named member. **ANSWER NOW** from them + Source — do not Grep/`homegraph_callers` the same member.'
            : '> These lines are the in-repo use sites. Answer from them + Source; do not grep the same names again.',
        );
        lines.push('');
      } else if (memberFocus) {
        lines.push(
          '> No in-repo text call sites found for this member beyond its definition. Answer from Source; avoid a broad Grep unless needed.',
          '',
        );
      }
    }

    // Also surface #include / import lines that make a co-named type visible
    // near the primary symbol's use sites (IntGrid ↔ SortWidgets shapes).
    if (
      names.length >= 2
      && /include|import|visible|定义可见|可见|头文件|definition/i.test(query)
    ) {
      const includeHits: string[] = [];
      const primaryFiles = new Set([
        ...fileNodes.keys(),
        ...textUsageHits.map((h) => h.filePath),
      ]);
      // Files that call / define earlier anchors.
      for (const id of seedIds) {
        try {
          for (const { node: c } of cg.getCallers(id).slice(0, 8)) {
            primaryFiles.add(c.filePath);
          }
        } catch { /* */ }
      }
      const secondary = names.slice(1);
      for (const fp of [...primaryFiles].slice(0, 12)) {
        const absPath = validatePathWithinRoot(projectRoot, fp);
        if (!absPath || !existsSync(absPath)) continue;
        let content: string;
        try { content = readFileSync(absPath, 'utf-8'); } catch { continue; }
        const fileLines = content.split('\n');
        for (let i = 0; i < Math.min(fileLines.length, 120); i++) {
          const lineText = fileLines[i] ?? '';
          if (!/^\s*(?:#\s*include|import\s)/.test(lineText)) continue;
          if (!secondary.some((s) => lineText.includes(s))) continue;
          includeHits.push(`- \`${fp}:${i + 1}\`  \`${lineText.trim().slice(0, 140)}\``);
          if (includeHits.length >= 8) break;
        }
        if (includeHits.length >= 8) break;
      }
      if (includeHits.length > 0) {
        lines.push('**Include / import visibility** (how co-named types become visible at use sites)', '');
        lines.push(...includeHits);
        lines.push('');
        lines.push('> Answer the visibility question from these include/import lines — do not re-read headers.');
        lines.push('');
      }
    }

    const callerSection = shouldBuildCallerInventory(query)
      ? this.buildCallerListingSection(cg, query, projectRoot)
      : '';
    if (callerSection) lines.push(callerSection);

    // Prefer files whose nodes exactly match query names; then neighbor / usage files.
    // Primary named symbol (first anchor) always ranks first — secondary types like
    // IntGrid used to drown SortWidgets' defining .cpp via higher exact-count on the header.
    // UI clusters: co-occurrence of 2+ named Types beats a lonely homonym elsewhere.
    const nameSet = new Set(names);
    const usageFiles = new Set(textUsageHits.map((h) => h.filePath));
    const maxFiles =
      bareMemberOnly
        ? 2
        : memberFocus
          // Call/filter sites already listed above — dumping caller file bodies
          // (FormStack…) burns tokens and invites a follow-up Read of isExpired.
          ? 1
        : (queryAsNamedComponentAction(query) || componentSurface || usageFiles.size > 0 || bridge)
          ? (uiCluster ? 2 : (componentSurface ? 2 : 3))
          : 2;
    const ranked = [...fileNodes.entries()]
      .filter(([, nodes]) => {
        if (!memberFocus || memberNames.size === 0) return true;
        return nodes.some((n) => memberNames.has(n.name) || typeNameSet.has(n.name.toLowerCase()));
      })
      .map(([fp, nodes]) => {
        const exact = nodes.filter((n) => nameSet.has(n.name)).length;
        const typeHits = typeNames.filter((t) => nodes.some((n) => n.name === t)).length;
        const clusterCoOccur = typeHits >= 2 ? 250 : typeHits === 1 ? 80 : 0;
        const primaryHit = nodes.some((n) => n.name === primaryName) ? 100 : 0;
        const neighborHit = nodes.filter((n) => neighborIds.has(n.id)).length;
        const usageHit = usageFiles.has(fp) ? (memberFocus ? 60 : 15) : 0;
        return {
          fp,
          nodes,
          exact,
          score:
            (uiCluster || componentSurface ? clusterCoOccur : 0)
            + primaryHit
            + exact * 20
            + neighborHit * 5
            + usageHit
            + nodes.length,
        };
      })
      .sort((a, b) => b.score - a.score || a.fp.localeCompare(b.fp))
      .slice(0, maxFiles);

    lines.push('**Source Code**', '');
    lines.push(
      '> Line-numbered source — treat as already Read. **ANSWER NOW** — do not Read/Grep/search/explore/node the same symbols again.',
    );
    lines.push('');

    let totalChars = lines.join('\n').length;
    // Lean ceilings: without-HG Grep/Read stacks were ~15k session tokens; a 10–14k
    // compact body + follow-up Read is what loses the token A/B.
    const maxTotal = bareMemberOnly
      ? 4500
      : componentSurface || uiCluster
        ? 7000
        : memberFocus && usageFiles.size > 0
          ? 6500
          : 5500;
    const maxPerFile = bareMemberOnly
      ? 2800
      : componentSurface || uiCluster
        ? 4500
        : memberFocus
          ? 2800
          : 3200;
    let rendered = 0;

    for (const { fp, nodes } of ranked) {
      if (rendered >= maxFiles || totalChars > maxTotal) break;
      const absPath = validatePathWithinRoot(projectRoot, fp);
      if (!absPath || !existsSync(absPath)) continue;
      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }
      const fileLines = fileContent.split('\n');
      const focusNodes = nodes
        .filter((n) => nameSet.has(n.name) || STRUCTURE_KINDS.has(n.kind))
        .sort((a, b) => a.startLine - b.startLine);

      // Prefer contiguous windows around named symbols; usage-only files
      // window around the first text-hit line.
      let start = 1;
      let end = Math.min(fileLines.length, 120);
      const usageLine = textUsageHits.find((h) => h.filePath === fp)?.line;
      const surfaceMethodsRaw = (componentSurface || uiCluster)
        ? focusNodes
          .filter((n) => (n.kind === 'method' || n.kind === 'function') && isUiSurfaceDigestMethod(n.name, uiCluster))
          .sort((a, b) => surfaceMethodPriority(a.name) - surfaceMethodPriority(b.name) || a.startLine - b.startLine)
        : [];
      // When build/PageMap answer the surface question, skip lifecycle — it ate
      // the budget and agents re-Read PageMap anyway.
      const hasBuildOrPageMap = surfaceMethodsRaw.some((n) => /^(build|PageMap)$/i.test(n.name));
      const surfaceMethods = hasBuildOrPageMap
        ? surfaceMethodsRaw.filter((n) => !/^(aboutToAppear|aboutToDisappear)$/i.test(n.name))
        : surfaceMethodsRaw;
      // Type.member: keep the member body, not the whole owning class dump.
      const memberOnlyNodes = memberFocus && memberNames.size > 0
        ? focusNodes.filter((n) => memberNames.has(n.name) && (n.kind === 'method' || n.kind === 'function' || n.kind === 'property' || n.kind === 'field'))
        : [];

      if (focusNodes.length > 0) {
        const named = focusNodes.filter((n) => nameSet.has(n.name));
        const use = named.length > 0 ? named : focusNodes.slice(0, 3);
        const surfaceNodes: Node[] = componentSurface
          ? use.filter((n) =>
              (n.kind === 'component' || n.kind === 'class' || n.kind === 'struct'
                || queryLooksLikeUiComponentType(n.name))
              && (typeNameSet.size === 0 || typeNameSet.has(n.name.toLowerCase()) || nameSet.has(n.name)),
            )
          : [];
        if (surfaceNodes.length === 0 && componentSurface) {
          const one = use.find((n) =>
            n.kind === 'component' || n.kind === 'class' || n.kind === 'struct'
            || queryLooksLikeUiComponentType(n.name),
          ) ?? use[0];
          if (one) surfaceNodes.push(one);
        }
        if (memberOnlyNodes.length > 0) {
          start = Math.max(1, Math.min(...memberOnlyNodes.map((n) => n.startLine)) - 2);
          end = Math.min(fileLines.length, Math.max(...memberOnlyNodes.map((n) => n.endLine)) + 2);
        } else if (surfaceMethods.length > 0) {
          // Per-method chunks below — placeholder window unused.
          start = 1;
          end = 1;
        } else if (surfaceNodes.length > 0 && surfaceNodes.some((n) => n.endLine > n.startLine)) {
          start = Math.max(1, Math.min(...surfaceNodes.map((n) => n.startLine)) - 2);
          end = Math.min(fileLines.length, Math.max(...surfaceNodes.map((n) => n.endLine)) + 2);
        } else {
          start = Math.max(1, Math.min(...use.map((n) => n.startLine)) - 2);
          end = Math.min(fileLines.length, Math.max(...use.map((n) => n.endLine)) + 2);
        }
        // Keep window bounded (non-surface paths)
        if (surfaceMethods.length === 0 && (end - start + 1) * 40 > maxPerFile) {
          end = Math.min(fileLines.length, start + Math.floor(maxPerFile / 40) - 1);
        }
      } else if (usageLine) {
        start = Math.max(1, usageLine - 10);
        end = Math.min(fileLines.length, usageLine + 18);
      }

      const header = fileSectionHeader(fp, focusNodes.map((n) => `${n.name}(${n.kind})`).slice(0, 6).join(', '));
      const withLineNumbers = exploreLineNumbersEnabled();
      const bodyLines: string[] = [header, '```' + (nodes[0]?.language || ''), ''];

      if (surfaceMethods.length > 0) {
        // Do NOT span aboutToAppear→build as one window — ThemeHome-sized pages
        // always trim before PageMap/build. Emit imports + each method separately,
        // prioritizing build/PageMap/preview.
        let lastImportLine = 0;
        for (let i = 0; i < Math.min(fileLines.length, 60); i++) {
          if (/^\s*import\s+/.test(fileLines[i] ?? '')) lastImportLine = i + 1;
        }
        const inventory = extractUiSurfaceInventory(fileLines, surfaceMethods);
        // Inventory is prepended outside the code fence below via chunk assembly.
        const methodBudget = Math.max(900, Math.floor((maxPerFile - Math.min(lastImportLine, 40) * 40) / Math.max(1, Math.min(surfaceMethods.length, 4))));
        if (lastImportLine > 0) {
          const importCap = Math.min(lastImportLine, 45);
          for (let i = 1; i <= importCap; i++) {
            const code = fileLines[i - 1] ?? '';
            bodyLines.push(withLineNumbers ? `${i}\t${code}` : code);
          }
          bodyLines.push(withLineNumbers ? `…\t// …` : '// …');
        }
        let methodsEmitted = 0;
        for (const m of surfaceMethods) {
          if (methodsEmitted >= 5) break;
          const mStart = Math.max(1, m.startLine - 1);
          let mEnd = Math.min(fileLines.length, m.endLine + 1);
          // Cap each method so later build/PageMap still fit.
          const maxLines = Math.max(25, Math.floor(methodBudget / 40));
          if (mEnd - mStart + 1 > maxLines) {
            mEnd = mStart + maxLines - 1;
          }
          bodyLines.push(withLineNumbers ? `…\t// --- ${m.name} ---` : `// --- ${m.name} ---`);
          for (let i = mStart; i <= mEnd; i++) {
            const code = fileLines[i - 1] ?? '';
            bodyLines.push(withLineNumbers ? `${i}\t${code}` : code);
          }
          methodsEmitted++;
        }
        bodyLines.push('```', '');
        let chunk = (inventory ? inventory + '\n' : '') + bodyLines.join('\n');
        if (chunk.length > maxPerFile + (inventory ? 1200 : 0)) {
          chunk = `${chunk.slice(0, maxPerFile + (inventory ? 1200 : 0))}\n... (trimmed — answer from inventory + visible methods; do not Read the rest)\n\`\`\`\n`;
        }
        if (totalChars + chunk.length > maxTotal && rendered > 0) break;
        lines.push(chunk);
        totalChars += chunk.length;
        rendered++;
        continue;
      }

      for (let i = start; i <= end; i++) {
        const code = fileLines[i - 1] ?? '';
        bodyLines.push(withLineNumbers ? `${i}\t${code}` : code);
      }
      bodyLines.push('```', '');
      let chunk = bodyLines.join('\n');
      if (chunk.length > maxPerFile) {
        chunk = `${chunk.slice(0, maxPerFile)}\n... (trimmed — answer from visible lines; do not Read the rest)\n\`\`\`\n`;
      }
      if (totalChars + chunk.length > maxTotal && rendered > 0) break;
      lines.push(chunk);
      totalChars += chunk.length;
      rendered++;
    }

    if (rendered === 0) return null;

    lines.push('---');
    lines.push(
      '> **Compact local explore complete — ANSWER NOW.** ' +
      'Do **not** Read/Grep/`homegraph_search`/`homegraph_explore`/`homegraph_node` for the same symbols.',
    );
    lines.push('');
    return this.textResult(lines.join('\n'));
  }

  /**
   * Hover / pointer-handler inventory — onHover / Hover* symbols + short snippets.
   * Used when the agent asks about hover effects without naming a Type yet.
   */
  private buildHoverHandlerSurveySection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; hitCount: number } {
    const topicBoost = /图标|icon|appicon|dock|launcher/i.test(query);
    const searchTerms = ['onHover', 'HoverAnimation', 'HoverEffect', 'HoverConstants', 'hover'];
    const seen = new Set<string>();
    const hits: Array<{ file: string; line: number; name: string; kind: string; score: number; snippet: string }> = [];

    for (const term of searchTerms) {
      let results: SearchResult[] = [];
      try {
        results = cg.searchNodes(term, {
          kinds: ['method', 'function', 'property', 'field', 'variable', 'constant', 'class', 'component'],
          limit: 30,
        });
      } catch {
        continue;
      }
      for (const r of results) {
        if (isOhosApiFilePath(r.node.filePath) || isTestFile(r.node.filePath)) continue;
        const nameLc = r.node.name.toLowerCase();
        const pathLc = r.node.filePath.toLowerCase();
        const termLc = term.toLowerCase();
        if (!nameLc.includes(termLc) && !pathLc.includes(termLc)) continue;
        const key = `${r.node.filePath}:${r.node.startLine}:${r.node.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let score = nameLc === 'onhover' || nameLc.startsWith('onhover') ? 40 : 10;
        if (/hover/.test(nameLc)) score += 15;
        if (topicBoost && /icon|appicon|dock|launcher|smartdock|appcenter/i.test(pathLc)) score += 25;
        let snippet = (r.node.signature || r.node.name).slice(0, 120);
        try {
          const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
          if (abs && existsSync(abs) && r.node.startLine > 0) {
            const lines = readFileSync(abs, 'utf-8').split('\n');
            const from = Math.max(0, r.node.startLine - 1);
            const to = Math.min(lines.length, from + 4);
            snippet = lines.slice(from, to).map((l) => l.trim()).filter(Boolean).join(' / ').slice(0, 160);
          }
        } catch { /* keep signature */ }
        hits.push({
          file: r.node.filePath,
          line: r.node.startLine,
          name: r.node.name,
          kind: r.node.kind,
          score,
          snippet,
        });
      }
    }

    if (hits.length === 0) {
      return {
        section: [
          '**Hover / pointer handler survey**',
          '',
          'No `onHover` / Hover* handlers found in the indexed project graph.',
          '',
          '> Next: Grep `onHover` / `Hover` in `*.ets` if the index is incomplete.',
          '',
        ].join('\n'),
        hitCount: 0,
      };
    }

    hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    const lines = [
      '**Hover / pointer handler survey**',
      '',
      '> **ANSWER NOW** from these in-repo hover handlers + snippets. Do not Grep `onHover` again unless a named Type is still missing.',
      '',
    ];
    for (const h of hits.slice(0, 18)) {
      lines.push(`- \`${h.name}\` (${h.kind}) — \`${h.file}:${h.line}\``);
      if (h.snippet) lines.push(`  \`${h.snippet}\``);
    }
    if (hits.length > 18) lines.push(`- … and ${hits.length - 18} more`);
    lines.push('');
    return { section: lines.join('\n'), hitCount: hits.length };
  }

  /**
   * @kit module capability survey — repo import/usage only (SDK defs are not indexed).
   */
  private buildKitModuleUsageSection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; symbolCount: number } {
    const kitTerms = extractKitModuleNamesFromQuery(query);
    const submodules = extractKitSubmoduleNamesFromQuery(query);
    if (kitTerms.length === 0) return { section: '', symbolCount: 0 };

    const kitSearchTerms = extractImportSearchTerms(query);
    const seen = new Set<string>();
    const imports: Array<{ file: string; line: number; lineText: string; symbols: string[] }> = [];

    const parseImportedSymbols = (lineText: string): string[] => {
      const syms = new Set<string>();
      const brace = lineText.match(/import\s*\{([^}]+)\}/);
      if (brace?.[1]) {
        for (const part of brace[1].split(',')) {
          const tok = part.trim().split(/\s+as\s+/i)[0]?.trim();
          if (tok) syms.add(tok);
        }
      }
      const def = lineText.match(/import\s+(\w+)\s+from\b/);
      if (def?.[1]) syms.add(def[1]);
      const ns = lineText.match(/import\s+\*\s+as\s+(\w+)/);
      if (ns?.[1]) syms.add(ns[1]);
      return [...syms];
    };

    const matchesSubmodule = (lineText: string, symbols: string[]): boolean => {
      if (submodules.length === 0) return true;
      const lc = lineText.toLowerCase();
      return submodules.some((sm) => {
        const s = sm.toLowerCase();
        return symbols.some((sym) => sym.toLowerCase() === s || sym.toLowerCase().startsWith(`${s}.`))
          || lc.includes(`.${s}`) || lc.includes(`'${s}'`) || lc.includes(`"${s}"`);
      });
    };

    const resolveImportLine = (node: Node): string => resolveImportLineFromNode(node, projectRoot);

    const tryPushImport = (node: Node): void => {
      if (isOhosApiFilePath(node.filePath)) return;
      const lineText = resolveImportLine(node);
      const lineLc = lineText.toLowerCase();
      const symbols = parseImportedSymbols(lineText);
      if (!matchesSubmodule(lineText, symbols)) return;
      if (kitTerms.length > 0) {
        const matchesKit = kitTerms.some((k) => lineLc.includes(`@kit.${k.toLowerCase()}`));
        if (!matchesKit) return;
      }
      const key = `${node.filePath}:${node.startLine}`;
      if (seen.has(key)) return;
      seen.add(key);
      imports.push({
        file: node.filePath,
        line: node.startLine,
        lineText,
        symbols,
      });
    };

    // Prefer searching the named export/API (taskpool, util, …) — kit-only FTS
    // with a low limit misses focused import sites among popular @kit modules.
    const focusSearch = submodules.length > 0 ? submodules : [];
    for (const sym of focusSearch) {
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(sym, { kinds: ['import'], limit: 200 });
      } catch {
        continue;
      }
      for (const r of hits) tryPushImport(r.node);
    }

    for (const term of kitSearchTerms) {
      const termLc = term.toLowerCase().replace(/^@kit\./, '');
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(term, { kinds: ['import'], limit: focusSearch.length > 0 ? 40 : 120 });
      } catch {
        continue;
      }
      for (const r of hits) {
        const lineText = resolveImportLine(r.node);
        if (!lineText.toLowerCase().includes(termLc) && !lineText.toLowerCase().includes('@kit.')) continue;
        tryPushImport(r.node);
      }
    }

    if (imports.length === 0) {
      const kitLabel = kitTerms.map((k) => `@kit.${k}`).join(', ');
      const sub = submodules.length > 0 ? ` (${submodules.join(', ')} submodule)` : '';
      return {
        section: [
          '**Kit module usage (this repo)**',
          '',
          `No imports from ${kitLabel}${sub} were found in the indexed codebase.`,
          '',
          `> @kit module API definitions live in the HarmonyOS SDK, not this repository. Answer from repo imports/usages only.`,
          '',
        ].join('\n'),
        symbolCount: 0,
      };
    }

    const symbolFiles = new Map<string, Set<string>>();
    for (const imp of imports) {
      for (const sym of imp.symbols) {
        const set = symbolFiles.get(sym) ?? new Set<string>();
        set.add(imp.file);
        symbolFiles.set(sym, set);
      }
    }

    const lines = [
      '**Kit module usage (this repo)**',
      '',
      `> @kit module API definitions live in the HarmonyOS SDK, not this repository. Below: how **this project** imports and uses them.`,
      '',
      `Imports from ${kitTerms.map((k) => `\`@kit.${k}\``).join(', ')} (${imports.length} site(s)):`,
      '',
    ];
    for (const imp of imports.slice(0, 35)) {
      const symStr = imp.symbols.length > 0 ? imp.symbols.join(', ') : '(namespace)';
      lines.push(`- \`${imp.file}:${imp.line}\` — \`${imp.lineText}\` (${symStr})`);
    }
    if (imports.length > 35) lines.push(`- … and ${imports.length - 35} more import site(s)`);

    if (symbolFiles.size > 0) {
      lines.push('');
      lines.push('**Symbols imported (unique):**');
      for (const [sym, files] of [...symbolFiles.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 40)) {
        const fileList = [...files].slice(0, 5).map((f) => `\`${f}\``).join(', ');
        const more = files.size > 5 ? ` +${files.size - 5} files` : '';
        lines.push(`- \`${sym}\` — imported in ${fileList}${more}`);
      }
    }

    // "需要额外安装哪些依赖" — surface oh-package.json5 lines naming the kit.
    if (/额外安装|还需.*依赖|需要.*依赖|install(?:ing)?\s+(?:extra\s+)?deps?|which\s+deps?/i.test(query)) {
      const depLines: string[] = [];
      try {
        for (const f of cg.getFiles()) {
          const fp = f.path.replace(/\\/g, '/');
          if (!/oh-package\.json5?$/i.test(fp)) continue;
          const abs = validatePathWithinRoot(projectRoot, f.path);
          if (!abs) continue;
          let content = '';
          try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
          if (!kitTerms.some((k) => content.toLowerCase().includes(k.toLowerCase()))) continue;
          const fileLines = content.split('\n');
          for (let i = 0; i < fileLines.length; i++) {
            const line = fileLines[i] ?? '';
            if (!kitTerms.some((k) => line.toLowerCase().includes(k.toLowerCase()))) continue;
            depLines.push(`- \`${fp}:${i + 1}\`  \`${line.trim().slice(0, 100)}\``);
          }
          if (depLines.length >= 16) break;
        }
      } catch { /* optional */ }
      lines.push('');
      lines.push('**oh-package dependencies naming this Kit**');
      if (depLines.length === 0) {
        lines.push(
          '- No `oh-package.json5` dependency line naming this Kit was indexed. ' +
          '**ANSWER NOW**: calling `@kit.*` typically needs **no extra npm install** beyond the HarmonyOS SDK / DevEco kit — only what `oh-package.json5` already lists.',
        );
      } else {
        lines.push(...depLines.slice(0, 16));
      }
    }

    lines.push('');
    lines.push('> Kit usage survey complete — **ANSWER NOW** from this section; do not Grep `oh-package` / SDK docs again.');
    lines.push('');
    return { section: lines.join('\n'), symbolCount: Math.max(symbolFiles.size, imports.length, 1) };
  }

  /** Disambiguate homonymous types (Configuration, Rectangle) when several defs exist. */
  private buildHomonymDefinitionsSection(cg: HomeGraph, query: string): string {
    const typeNames = extractTypeNamesFromQuery(query);
    const queryFiles = extractFileBasenamesFromQuery(query);
    const lines: string[] = [];

    for (const name of typeNames.slice(0, 4)) {
      const defs = cg.getNodesByName(name).filter(
        (n) => (n.kind === 'class' || n.kind === 'struct' || n.kind === 'interface' || n.kind === 'type_alias')
          && !isTestFile(n.filePath),
      );
      if (defs.length <= 1) continue;
      lines.push(`**${name}** — ${defs.length} distinct definitions (pin with file basename in a follow-up explore):`);
      for (const d of defs.slice(0, 8)) {
        const pin = fileMatchesQueryBasename(d.filePath, queryFiles) ? ' ← matches query file' : '';
        lines.push(`- \`${d.qualifiedName || d.name}\` (\`${d.filePath}:${d.startLine}\`)${pin}`);
      }
      if (defs.length > 8) lines.push(`- … and ${defs.length - 8} more`);
      lines.push('');
    }
    if (lines.length === 0) return '';
    return lines.join('\n');
  }

  /** Direct subclasses of a named type — paths only. */
  private buildInheritanceSurveySection(cg: HomeGraph, query: string): string {
    if (!shouldBuildInheritanceSurvey(query)) return '';
    const rel = (p: string) => p.replace(/\\/g, '/');
    const lines: string[] = ['**Inheritance survey**', ''];
    let listed = 0;
    const projectRoot = (() => {
      try { return cg.getProjectRoot(); } catch { return ''; }
    })();

    for (const typeName of extractTypeNamesFromQuery(query).slice(0, 2)) {
      const bases = cg.getNodesByName(typeName).filter(
        (n) => (n.kind === 'class' || n.kind === 'struct' || n.kind === 'interface') && !isTestFile(n.filePath),
      );
      for (const base of bases.slice(0, 2)) {
        const publicSubs: Node[] = [];
        const otherSubs: Node[] = [];
        for (const e of cg.getIncomingEdges(base.id)) {
          if (e.kind !== 'extends' && e.kind !== 'implements') continue;
          try {
            const child = cg.getNode(e.source);
            if (!child || isTestFile(child.filePath)) continue;
            const isCpp = /\.(hpp|h|hh|hxx|cpp|cc|cxx)$/i.test(child.filePath);
            if (isCpp && projectRoot) {
              const abs = validatePathWithinRoot(projectRoot, child.filePath);
              if (abs && existsSync(abs) && child.startLine > 0) {
                try {
                  const fileLines = readFileSync(abs, 'utf-8').split('\n');
                  // Class decl may span a few lines (`class Foo\n: public Bar`).
                  const from = Math.max(0, child.startLine - 1);
                  const decl = fileLines.slice(from, Math.min(fileLines.length, from + 4)).join(' ');
                  const pub = cppExtendsLooksPublic(decl, base.name);
                  if (pub === false) {
                    otherSubs.push(child);
                    continue;
                  }
                } catch { /* keep as public-ish */ }
              }
            }
            publicSubs.push(child);
          } catch { /* skip */ }
        }
        // Prefer public / language-default is-a; only fall back to private if
        // nothing else is indexed (avoids empty answers).
        const subs = publicSubs.length > 0 ? publicSubs : otherSubs;
        if (subs.length === 0) continue;
        lines.push(`### Subtypes of \`${base.name}\` (\`${rel(base.filePath)}\`)`);
        for (const s of subs.slice(0, 30)) {
          lines.push(`- \`${s.name}\` (\`${rel(s.filePath)}:${s.startLine}\`)`);
          listed++;
        }
        if (subs.length > 30) lines.push(`- … and ${subs.length - 30} more`);
        if (publicSubs.length > 0 && otherSubs.length > 0) {
          lines.push(
            `- _(also private/protected C++ inherits, omitted: ${otherSubs.map((s) => s.name).slice(0, 8).join(', ')})` +
            `${otherSubs.length > 8 ? ', …' : ''})_`,
          );
        }
        lines.push('');
      }
    }
    if (listed === 0) return '';
    lines.push('> Inheritance survey complete — answer from this list; no read/grep needed for the subtype set.');
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Files/lines using a member or literal pattern (.drawModifier, .width('100%')).
   */
  private buildMemberSurveySection(cg: HomeGraph, query: string, projectRoot: string): string {
    const members = extractMemberAccessFromQuery(query);
    const patterns: string[] = [];
    for (const ma of members) {
      if (ma.dotted.startsWith('.')) patterns.push(ma.dotted);
      else patterns.push(ma.dotted);
    }
    // Literal chains in quotes: .width('100%')
    for (const m of query.matchAll(/(\.[a-zA-Z_][\w]*\s*\([^)]*\))/g)) {
      patterns.push(m[1]!.replace(/\s+/g, ''));
    }
    // Bare field / mutex names (m_eglMutex) — text-scan without a leading dot.
    for (const f of extractFieldLikeSymbolsFromQuery(query)) {
      patterns.push(f);
    }
    if (patterns.length === 0) return '';

    const rel = (p: string) => p.replace(/\\/g, '/');
    const hits = new Map<string, number[]>();

    const addHit = (file: string, line: number): void => {
      const arr = hits.get(file) ?? [];
      if (!arr.includes(line)) arr.push(line);
      hits.set(file, arr);
    };

    for (const pat of patterns) {
      const bare = pat.replace(/^\./, '');
      let nodes: SearchResult[] = [];
      try {
        nodes = cg.searchNodes(bare, { limit: 30 });
      } catch { /* skip */ }
      for (const r of nodes) {
        if (isTestFile(r.node.filePath)) continue;
        addHit(rel(r.node.filePath), r.node.startLine);
      }
    }

    // Scan top FTS files for literal pattern in source
    for (const pat of patterns.slice(0, 3)) {
      const literal = pat.startsWith('.') || pat.startsWith('m_') || /(?:Mutex|Lock)$/.test(pat)
        ? pat
        : `.${pat}`;
      const re = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      let files: SearchResult[] = [];
      try {
        files = cg.searchNodes(patterns[0]!.replace(/^\./, ''), { limit: 25 });
      } catch { continue; }
      for (const r of files) {
        if (isTestFile(r.node.filePath)) continue;
        const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
        if (!abs) continue;
        let content: string;
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        const fileLines = content.split('\n');
        for (let i = 0; i < fileLines.length; i++) {
          if (re.test(fileLines[i] ?? '')) addHit(rel(r.node.filePath), i + 1);
        }
      }
    }

    // Field patterns with zero FTS: seed from co-named methods/types in the query.
    const fieldPats = patterns.filter((p) => p.startsWith('m_') || /(?:Mutex|Lock)$/.test(p));
    if (fieldPats.length > 0 && hits.size < 2) {
      const seeds = [
        ...extractLocalDetailAnchors(query),
        ...extractTypeNamesFromQuery(query),
      ].filter((n) => !fieldPats.some((p) => p === n || p.endsWith(n)));
      const seen = new Set(hits.keys());
      for (const seed of seeds.slice(0, 5)) {
        let seedHits: SearchResult[] = [];
        try { seedHits = cg.searchNodes(seed, { limit: 20 }); } catch { continue; }
        for (const r of seedHits) {
          if (isTestFile(r.node.filePath)) continue;
          const fp = rel(r.node.filePath);
          if (seen.has(fp)) continue;
          seen.add(fp);
          const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
          if (!abs) continue;
          let content: string;
          try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
          const fileLines = content.split('\n');
          for (const pat of fieldPats) {
            const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            for (let i = 0; i < fileLines.length; i++) {
              if (re.test(fileLines[i] ?? '')) addHit(fp, i + 1);
            }
          }
        }
      }
    }

    if (hits.size === 0) return '';

    const lines = ['**Member / pattern usage**', ''];
    let fileCount = 0;
    for (const [fp, lineNos] of [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (fileCount >= 40) break;
      const sorted = lineNos.sort((a, b) => a - b).slice(0, 6);
      const lineStr = sorted.join(', ');
      const more = lineNos.length > 6 ? ` +${lineNos.length - 6} lines` : '';
      lines.push(`- \`${fp}\` — lines ${lineStr}${more}`);
      fileCount++;
    }
    if (hits.size > 40) lines.push(`- … and ${hits.size - 40} more file(s)`);
    lines.push('');
    lines.push('> Pattern survey complete — answer from this list; run another explore naming missing symbols if needed.');
    lines.push('');
    return lines.join('\n');
  }

  /**
   * API call-site survey — where a named API/symbol (statfs, napi_*) appears in repo source.
   */
  /**
   * In-repo how-to for system settings/capabilities (language/locale/…).
   * Lists concrete `@ohos.i18n` / `getSystemLanguage` call sites — not every
   * file that mentions the word "language".
   */
  private buildSystemCapabilityHowtoSection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; hitCount: number } {
    const searchTerms = [
      'getSystemLanguage',
      'getSystemRegion',
      'System.getSystemLanguage',
      '@ohos.i18n',
      'i18n.System',
    ];
    // Topic tokens from the question (language/locale) only as secondary filters.
    if (/\blanguage\b|语言/i.test(query)) searchTerms.push('getSystemLanguage');
    if (/\blocale\b|地区/i.test(query)) searchTerms.push('getSystemRegion');

    const rel = (p: string) => p.replace(/\\/g, '/');
    const rows: string[] = [];
    const seen = new Set<string>();

    for (const term of searchTerms) {
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(term.replace(/^@/, ''), { limit: 35 });
      } catch { continue; }
      for (const r of hits) {
        if (isTestFile(r.node.filePath) || isOhosApiFilePath(r.node.filePath)) continue;
        if (/\.d\.ts$/i.test(r.node.filePath)) continue;
        const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
        if (!abs || !existsSync(abs)) continue;
        let content: string;
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        const fileLines = content.split('\n');
        const re = new RegExp(
          term.startsWith('@')
            ? term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            : `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        );
        for (let i = 0; i < fileLines.length; i++) {
          const lineText = fileLines[i] ?? '';
          if (!re.test(lineText)) continue;
          // Prefer real get/import sites over comments.
          if (/getSystemLanguage|getSystemRegion|@ohos\.i18n|i18n\.System/i.test(lineText)
            || /import\s+.*i18n/i.test(lineText)) {
            const key = `${r.node.filePath}:${i + 1}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push(`- \`${rel(r.node.filePath)}:${i + 1}\`  \`${lineText.trim().slice(0, 120)}\``);
            if (rows.length >= 16) break;
          }
        }
        if (rows.length >= 16) break;
      }
      if (rows.length >= 16) break;
    }

    if (rows.length === 0) {
      return {
        section: [
          '**System capability howto (in-repo)**',
          '',
          'No `getSystemLanguage` / `@ohos.i18n` call sites indexed. **ANSWER NOW** from SDK docs if the project does not wrap this API.',
          '',
        ].join('\n'),
        hitCount: 0,
      };
    }

    return {
      section: [
        '**System capability howto (in-repo)**',
        '',
        '> Concrete call/import sites for system language/locale. **ANSWER NOW** — do not Grep `language` broadly.',
        '',
        ...rows,
        '',
      ].join('\n'),
      hitCount: rows.length,
    };
  }

  /**
   * Declaration / id / native-binding sites for a named UI/native Type (XComponent…).
   */
  private buildDeclarationSiteSurveySection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; hitCount: number; attempted: boolean } {
    const types = extractTypeNamesFromQuery(query)
      .filter((t) => !isFrameworkUiDecoratorName(t))
      .slice(0, 3);
    if (types.length === 0) return { section: '', hitCount: 0, attempted: false };

    const rel = (p: string) => p.replace(/\\/g, '/');
    const rows: string[] = [];
    const seen = new Set<string>();

    for (const typeName of types) {
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(typeName, { limit: 80 });
      } catch { continue; }
      // Also pull same-name defs (component/class) even when FTS ranks them low.
      try {
        for (const n of cg.getNodesByName(typeName).slice(0, 40)) {
          hits.push({ node: n, score: 1 });
        }
      } catch { /* optional */ }

      const files = new Map<string, string>(); // abs → rel
      for (const r of hits) {
        if (isTestFile(r.node.filePath)) continue;
        if (isOhosApiFilePath(r.node.filePath) && /\.d\.ts$/i.test(r.node.filePath)) continue;
        const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
        if (!abs || !existsSync(abs)) continue;
        files.set(abs, rel(r.node.filePath));
      }

      // Framework UI tags (XComponent…) often have no indexed symbol at the JSX
      // site — expand to sibling .ets under the same feature/staticcommon roots
      // already touched by native/header hits.
      const featureRoots = new Set<string>();
      for (const fp of files.values()) {
        const m = fp.match(/^(feature\/[^/]+|staticcommon\/[^/]+)/);
        if (m?.[1]) featureRoots.add(m[1]);
      }
      if (featureRoots.size > 0 && featureRoots.size <= 6) {
        try {
          for (const f of cg.getFiles()) {
            const fp = rel(f.path);
            if (!/\.ets$/i.test(fp) || isTestFile(fp)) continue;
            if (![...featureRoots].some((root) => fp.startsWith(`${root}/`))) continue;
            const abs = validatePathWithinRoot(projectRoot, f.path);
            if (!abs || !existsSync(abs)) continue;
            files.set(abs, fp);
          }
        } catch { /* optional */ }
      }

      const typeRe = new RegExp(`\\b${typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const jsxRe = new RegExp(`<${typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const callRe = new RegExp(`${typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
      for (const [abs, fp] of files) {
        let content: string;
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        const fileLines = content.split('\n');
        const isUi = /\.(ets|ts|tsx|jsx)$/i.test(fp);
        const isNative = /\.(cpp|cc|cxx|h|hpp)$/i.test(fp);
        for (let i = 0; i < fileLines.length; i++) {
          const lineText = fileLines[i] ?? '';
          if (!typeRe.test(lineText)) continue;
          const window = [lineText, fileLines[i + 1] ?? '', fileLines[i + 2] ?? ''].join('\n');
          const uiHit =
            isUi
            && (
              jsxRe.test(lineText)
              || callRe.test(lineText)
              || (/id\s*[:=]/.test(window) && !/Log(?:Error|Info|Warn|Debug|Message)/i.test(lineText))
            );
          const nativeHit =
            isNative
            && /OH_Native|RegisterCallback|Export\s*\(|napi_/i.test(window)
            && !/Log(?:Error|Info|Warn|Debug|Message)/i.test(lineText);
          // Prefer construction / JSX / id / native bind; skip log-only mentions.
          if (!uiHit && !nativeHit) continue;
          const key = `${fp}:${i + 1}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const clip = [lineText, fileLines[i + 1] ?? '', fileLines[i + 2] ?? '']
            .map((l) => l.trim())
            .filter(Boolean)
            .join(' / ')
            .slice(0, 160);
          rows.push(`- \`${typeName}\` — \`${fp}:${i + 1}\`  \`${clip}\``);
          if (rows.length >= 24) break;
        }
        if (rows.length >= 24) break;
      }
      if (rows.length >= 24) break;
    }

    // Prefer UI (.ets) rows first so C++ includes don't dominate.
    rows.sort((a, b) => {
      const score = (s: string) => (/\.ets`/.test(s) ? 0 : /\.cpp`|\.h`/.test(s) ? 2 : 1);
      return score(a) - score(b);
    });

    if (rows.length === 0) {
      return {
        section: [
          '**Declaration / id / native-binding survey**',
          '',
          `> No UI/native construction sites for \`${types.join('`, `')}\` in the index. **ANSWER NOW** — do not Grep the same Type for "declaration"; at most one Grep for \`<${types[0]}\` if you must.`,
          '',
        ].join('\n'),
        hitCount: 0,
        attempted: true,
      };
    }
    return {
      section: [
        '**Declaration / id / native-binding survey**',
        '',
        '> Construction / JSX / `id` / native register sites. **ANSWER NOW** — do not Grep the same Type again.',
        '',
        ...rows.slice(0, 20),
        '',
      ].join('\n'),
      hitCount: Math.min(rows.length, 20),
      attempted: true,
    };
  }

  private buildApiUsageSection(
    cg: HomeGraph,
    query: string,
    projectRoot: string,
  ): { section: string; fileCount: number } {
    // Include PascalCase SDK modules (Telephony) — deps-only missed them.
    const rawSymbols = extractApiUsageTokens(query).slice(0, 6);
    if (rawSymbols.length === 0) return { section: '', fileCount: 0 };
    // Expand Telephony → telephony / @ohos.telephony so import call sites hit.
    const symbols: string[] = [];
    for (const sym of rawSymbols) {
      symbols.push(sym);
      if (/^[A-Z][A-Za-z0-9]+$/.test(sym) && sym.length >= 4) {
        const lc = sym.toLowerCase();
        if (!symbols.includes(lc)) symbols.push(lc);
        const ohos = `@ohos.${lc}`;
        if (!symbols.includes(ohos)) symbols.push(ohos);
      }
    }

    const rel = (p: string) => p.replace(/\\/g, '/');
    const hits = new Map<string, { lines: number[]; stub: boolean }>();

    const addHit = (file: string, line: number): void => {
      if (isTestFile(file)) return;
      const fp = rel(file);
      const stub = /\.d\.ts$/i.test(fp) || /windowsceneinterfaces|@ohos\.|\/api\//i.test(fp);
      const prev = hits.get(fp) ?? { lines: [], stub };
      if (!prev.lines.includes(line)) prev.lines.push(line);
      prev.stub = prev.stub && stub;
      hits.set(fp, prev);
    };

    for (const sym of symbols.slice(0, 6)) {
      const symLc = sym.toLowerCase();
      let nodes: SearchResult[] = [];
      try {
        nodes = cg.searchNodes(sym.replace(/^@/, ''), { limit: 40 });
      } catch { /* skip */ }
      for (const r of nodes) {
        const n = r.node;
        const hay = `${n.name} ${n.signature || ''} ${n.filePath}`.toLowerCase();
        if (hay.includes(symLc) || n.name.toLowerCase() === symLc) {
          addHit(n.filePath, n.startLine);
        }
      }

      const wordRe = new RegExp(
        sym.startsWith('@')
          ? sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          : `\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i',
      );
      let scanHits: SearchResult[] = [];
      try {
        scanHits = cg.searchNodes(sym.replace(/^@/, ''), { limit: 35 });
      } catch { continue; }
      const seenFiles = new Set<string>();
      for (const r of scanHits) {
        if (isTestFile(r.node.filePath)) continue;
        const fp = rel(r.node.filePath);
        if (seenFiles.has(fp)) continue;
        seenFiles.add(fp);
        const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
        if (!abs) continue;
        let content: string;
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        const fileLines = content.split('\n');
        for (let i = 0; i < fileLines.length; i++) {
          if (wordRe.test(fileLines[i] ?? '')) addHit(fp, i + 1);
        }
      }
    }

    // Field/mutex tokens often have zero FTS hits (not extracted as nodes). Seed
    // scan files from co-named methods/types in the query (drawOnSubThread…).
    const fieldSyms = extractFieldLikeSymbolsFromQuery(query);
    if (fieldSyms.length > 0) {
      const seedNames = [
        ...extractLocalDetailAnchors(query),
        ...extractTypeNamesFromQuery(query),
      ].filter((n) => !fieldSyms.includes(n) && n.length >= 4);
      const seenSeedFiles = new Set<string>([...hits.keys()]);
      for (const seed of seedNames.slice(0, 5)) {
        let seedHits: SearchResult[] = [];
        try { seedHits = cg.searchNodes(seed, { limit: 20 }); } catch { continue; }
        for (const r of seedHits) {
          if (isTestFile(r.node.filePath)) continue;
          const fp = rel(r.node.filePath);
          if (seenSeedFiles.has(fp)) continue;
          seenSeedFiles.add(fp);
          const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
          if (!abs) continue;
          let content: string;
          try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
          const fileLines = content.split('\n');
          for (const field of fieldSyms) {
            const re = new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            for (let i = 0; i < fileLines.length; i++) {
              if (re.test(fileLines[i] ?? '')) addHit(fp, i + 1);
            }
          }
        }
      }
    }

    if (hits.size === 0) return { section: '', fileCount: 0 };

    // Prefer project call/import sites over SDK .d.ts stubs.
    const rankedFiles = [...hits.entries()].sort((a, b) => {
      if (a[1].stub !== b[1].stub) return a[1].stub ? 1 : -1;
      return a[0].localeCompare(b[0]);
    });
    const projectHits = rankedFiles.filter(([, v]) => !v.stub);
    const display = projectHits.length > 0 ? projectHits : rankedFiles;

    // In files that import the API, also record alias.method( call sites so
    // "which call methods" answers don't stop at import lines.
    const aliasCallRe =
      /\b((?:call|radio|data|sim|observer|telephony|i18n|sensor|wifi)(?:\.\w+)*)\.([A-Za-z_][\w]*)\s*\(/gi;
    const wantLifetime =
      queryAsFieldUsageSurvey(query)
      && /new|delete|allocat|释放|free/i.test(query);
    for (const [fp] of display.slice(0, 40)) {
      const abs = validatePathWithinRoot(projectRoot, fp);
      if (!abs || !existsSync(abs)) continue;
      let fileLines: string[] = [];
      try { fileLines = readFileSync(abs, 'utf-8').split('\n'); } catch { continue; }
      for (let i = 0; i < fileLines.length; i++) {
        const lineText = fileLines[i] ?? '';
        if (aliasCallRe.test(lineText)) addHit(fp, i + 1);
        aliasCallRe.lastIndex = 0;
        if (wantLifetime) {
          for (const sym of rawSymbols) {
            if (!lineText.includes(sym)) continue;
            if (/\b(?:new|delete|free|reset)\b/i.test(lineText) || /=\s*new\b/.test(lineText)) {
              addHit(fp, i + 1);
            }
          }
        }
      }
    }

    // Recompute display after call-site enrichment.
    const rankedFiles2 = [...hits.entries()].sort((a, b) => {
      if (a[1].stub !== b[1].stub) return a[1].stub ? 1 : -1;
      return a[0].localeCompare(b[0]);
    });
    const projectHits2 = rankedFiles2.filter(([, v]) => !v.stub);
    const display2 = projectHits2.length > 0 ? projectHits2 : rankedFiles2;

    // Extract concrete API method names from snippets (telephony.call.xxx / radio.getY).
    const methodNames = new Set<string>();
    for (const [fp, info] of display2.slice(0, 40)) {
      const abs = validatePathWithinRoot(projectRoot, fp);
      if (!abs || !existsSync(abs)) continue;
      let fileLines: string[] = [];
      try { fileLines = readFileSync(abs, 'utf-8').split('\n'); } catch { continue; }
      for (const ln of info.lines.slice(0, 12)) {
        const lineText = fileLines[ln - 1] ?? '';
        for (const m of lineText.matchAll(
          /\b((?:call|radio|data|sim|observer|telephony)(?:\.\w+)*)\.([A-Za-z_][\w]*)\s*\(/gi,
        )) {
          if (m[2] && m[2].length >= 2) methodNames.add(`${m[1]}.${m[2]}`);
        }
        for (const sym of rawSymbols) {
          const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(
            `(?:@ohos\\.)?${esc}(?:\\.[A-Za-z_][\\w]*)*\\.([A-Za-z_][\\w]*)\\s*\\(`,
            'g',
          );
          for (const m of lineText.matchAll(re)) {
            if (m[1] && m[1].length >= 2) methodNames.add(`${sym}.${m[1]}`);
          }
          // import X from '@ohos.telephony.call' → module surface
          const imp = lineText.match(new RegExp(`from\\s+['"]@ohos\\.${esc}(?:\\.(\\w+))?['"]`, 'i'));
          if (imp) methodNames.add(imp[1] ? `@ohos.${sym.toLowerCase()}.${imp[1]}` : `@ohos.${sym.toLowerCase()}`);
        }
      }
    }

    const lines = [
      '**API usage sites**',
      '',
      `> In-repo references to \`${rawSymbols.join('`, `')}\` (${display2.length} file(s)` +
      `${projectHits2.length > 0 && projectHits2.length < rankedFiles2.length ? `; SDK stubs omitted` : ''}). ` +
      '**ANSWER NOW** from this list (+ snippets); do not Grep the same API again.',
      '',
    ];
    if (methodNames.size > 0) {
      lines.push('**Called / imported API surfaces**');
      for (const m of [...methodNames].sort().slice(0, 24)) lines.push(`- \`${m}\``);
      if (methodNames.size > 24) lines.push(`- … and ${methodNames.size - 24} more`);
      lines.push('');
    }
    let shown = 0;
    const isImportish = (s: string) => /^\s*import\b/.test(s) || /\bfrom\s+['"]@/.test(s);
    const isLifetimeish = (s: string) =>
      /\b(?:new|delete|free|reset)\b/i.test(s) || /=\s*new\b/.test(s);
    for (const [fp, info] of display2) {
      if (shown >= 28) break;
      const abs = validatePathWithinRoot(projectRoot, fp);
      let fileLines: string[] = [];
      if (abs && existsSync(abs)) {
        try { fileLines = readFileSync(abs, 'utf-8').split('\n'); } catch { /* */ }
      }
      // Prefer call / new-delete lines over bare imports for the displayed snippet.
      const rankedLines = [...info.lines].sort((a, b) => {
        const ta = fileLines[a - 1] ?? '';
        const tb = fileLines[b - 1] ?? '';
        const score = (t: string) => {
          let s = 0;
          if (wantLifetime && isLifetimeish(t)) s += 4;
          if (/\.\w+\s*\(/.test(t) && !isImportish(t)) s += 3;
          if (isImportish(t)) s -= 2;
          return s;
        };
        return score(tb) - score(ta) || a - b;
      });
      // For field new/delete, surface both sides when present (not only `new`).
      let sortedLines = rankedLines.slice(0, 4);
      if (wantLifetime && fileLines.length > 0) {
        const news = rankedLines.filter((l) => /\bnew\b/i.test(fileLines[l - 1] ?? ''));
        const dels = rankedLines.filter((l) => /\bdelete\b|\bfree\b|=\s*nullptr/i.test(fileLines[l - 1] ?? ''));
        sortedLines = [...new Set([...news.slice(0, 2), ...dels.slice(0, 2), ...rankedLines])].slice(0, 4);
      }
      let snippet = '';
      if (fileLines.length > 0) {
        const ln = sortedLines[0]!;
        snippet = (fileLines[ln - 1] ?? '').trim().slice(0, 100);
        if (wantLifetime && sortedLines.length > 1) {
          const sn2 = (fileLines[sortedLines[1]! - 1] ?? '').trim().slice(0, 80);
          if (sn2 && sn2 !== snippet) snippet = `${snippet}` + ` | ${sn2}`;
        }
      }
      const lineStr = sortedLines.map((l) => `L${l}`).join(', ');
      const more = info.lines.length > sortedLines.length ? ` +${info.lines.length - sortedLines.length} more` : '';
      lines.push(
        snippet
          ? `- \`${fp}\` (${lineStr}${more})  \`${snippet}\``
          : `- \`${fp}\` (${lineStr}${more})`,
      );
      shown++;
    }
    if (display2.length > shown) lines.push(`- … and ${display2.length - shown} more file(s)`);
    lines.push('');
    lines.push(`> API usage survey complete — **${display2.length}** file(s). **ANSWER NOW.**`);
    lines.push('');
    return { section: lines.join('\n'), fileCount: display2.length };
  }

  /**
   * Domain file inventory — related files, usage existence, or concept comparison.
   * Paths + top symbols only; source bodies omitted when this section renders.
   */
  private buildDomainFileSurveySection(cg: HomeGraph, query: string): { section: string; fileCount: number } {
    const terms = extractDomainSearchTerms(query);
    if (terms.length === 0) return { section: '', fileCount: 0 };

    const rel = (p: string) => p.replace(/\\/g, '/');
    const fileScores = new Map<string, { score: number; symbols: string[] }>();

    const addFile = (filePath: string, score: number, symbol?: string): void => {
      if (isTestFile(filePath)) return;
      const fp = rel(filePath);
      const existing = fileScores.get(fp) ?? { score: 0, symbols: [] };
      existing.score += score;
      if (symbol && existing.symbols.length < 5 && !existing.symbols.includes(symbol)) {
        existing.symbols.push(symbol);
      }
      fileScores.set(fp, existing);
    };

    for (const term of terms) {
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(term, { limit: 45 });
      } catch {
        continue;
      }
      for (const r of hits) {
        addFile(r.node.filePath, (r.score ?? 1) + 2, r.node.name);
      }
    }

    try {
      for (const f of cg.getFiles()) {
        const fpLc = f.path.toLowerCase();
        for (const term of terms) {
          if (term.length >= 3 && fpLc.includes(term.toLowerCase())) {
            addFile(f.path, 6);
          }
        }
      }
    } catch { /* getFiles unavailable */ }

    if (fileScores.size === 0) return { section: '', fileCount: 0 };

    const sorted = [...fileScores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 50);

    const lines = [
      '**Related files (domain survey)**',
      '',
      `> File paths matching the query domain (${terms.map((t) => `\`${t}\``).join(', ')}). Answer from this inventory; source bodies omitted.`,
      '',
    ];
    for (const [fp, info] of sorted.slice(0, 40)) {
      const symStr = info.symbols.length > 0 ? ` — ${info.symbols.join(', ')}` : '';
      lines.push(`- \`${fp}\`${symStr}`);
    }
    if (sorted.length > 40) lines.push(`- … and ${sorted.length - 40} more file(s)`);
    lines.push('');
    lines.push(
      `> Domain file survey complete — **${sorted.length}** file(s) listed. ` +
      'Exhaustive related-file inventory; no glob/search needed.',
    );
    lines.push('');
    return { section: lines.join('\n'), fileCount: sorted.length };
  }

  /**
   * Render a small config/manifest file named in the query (build-profile.json5, …).
   */
  private buildConfigFileSection(cg: HomeGraph, query: string, projectRoot: string): string {
    const basenames = extractFileBasenamesFromQuery(query);
    if (basenames.length === 0) return '';

    const CONFIG_EXT = /\.(?:json5?|ya?ml|toml|xml|ini|properties)$/i;

    const rel = (p: string) => p.replace(/\\/g, '/');
    const lines: string[] = ['**Config / manifest**', ''];
    let any = false;

    for (const name of basenames.slice(0, 3)) {
      let files: SearchResult[] = [];
      try {
        files = cg.searchNodes(name, { kinds: ['file'], limit: 15 });
      } catch {
        continue;
      }
      for (const r of files) {
        const base = rel(r.node.filePath).split('/').pop() ?? '';
        if (!base.toLowerCase().includes(name.toLowerCase())) continue;
        if (!CONFIG_EXT.test(base)) continue;
        const abs = validatePathWithinRoot(projectRoot, r.node.filePath);
        if (!abs) continue;
        let content: string;
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        if (content.length > 12000) continue;
        any = true;
        lines.push(`**\`${rel(r.node.filePath)}\`**`);
        lines.push('');
        lines.push('```json5');
        lines.push(content.replace(/\n+$/, ''));
        lines.push('```');
        lines.push('');
      }
    }
    if (!any) return '';
    lines.push('> Config content above is verbatim — answer from it; no broad grep needed.');
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Compact "blast radius" for the entry symbols of an explore result: who
   * depends on each (callers) and which test files cover it — LOCATIONS ONLY,
   * no source, so the agent knows what to update / re-verify before editing
   * without reaching for a separate impact call. Always-on, but skips symbols
   * that have no dependents (nothing to warn about), and returns '' when none
   * qualify so a leaf-only exploration stays clean.
   */
  private buildBlastRadiusSection(cg: HomeGraph, subgraph: Subgraph): string {
    const ROOT_CAP = 5; // only the symbols the query actually targeted
    const FILE_CAP = 4; // caller files listed per symbol before "+N more"
    const MEANINGFUL = new Set<string>([
      'function', 'method', 'class', 'interface', 'struct', 'trait', 'protocol',
      'enum', 'type_alias', 'component', 'constant', 'variable', 'property', 'field',
    ]);
    const rel = (p: string) => p.replace(/\\/g, '/');

    const roots = subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => !!n && MEANINGFUL.has(n.kind))
      .slice(0, ROOT_CAP);
    if (roots.length === 0) return '';

    const entries: string[] = [];
    for (const root of roots) {
      let callers: Array<{ node: Node }> = [];
      try { callers = cg.getCallers(root.id) as Array<{ node: Node }>; } catch { /* skip this root */ }

      const seen = new Set<string>();
      const uniq: Node[] = [];
      for (const c of callers) {
        if (c?.node && !seen.has(c.node.id)) { seen.add(c.node.id); uniq.push(c.node); }
      }
      if (uniq.length === 0) continue; // no blast radius → nothing to flag

      const callerFiles = [...new Set(uniq.map((n) => rel(n.filePath)))];
      const testFiles = callerFiles.filter((f) => isTestFile(f));
      const nonTest = callerFiles.filter((f) => !isTestFile(f));

      const shown = nonTest.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
      const more = nonTest.length > FILE_CAP ? ` +${nonTest.length - FILE_CAP} more` : '';
      const where = nonTest.length > 0 ? ` in ${shown}${more}` : '';
      const tests = testFiles.length > 0
        ? `; tests: ${testFiles.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ')}${testFiles.length > FILE_CAP ? ` +${testFiles.length - FILE_CAP}` : ''}`
        : '; ⚠️ no covering tests found';

      entries.push(
        `- \`${root.name}\` (${rel(root.filePath)}:${root.startLine}) — ${uniq.length} caller${uniq.length === 1 ? '' : 's'}${where}${tests}`,
      );
    }
    if (entries.length === 0) return '';

    return [
      '**Blast radius — what depends on these (update/verify before editing)**',
      '',
      ...entries,
      '',
    ].join('\n');
  }

  /**
   * Graph-connectivity relevance via Random-Walk-with-Restart (personalized
   * PageRank) from the query's matched SEED nodes over the call/reference graph.
   *
   * This is the ranking signal text search (FTS/bm25) CANNOT provide, and it's
   * homegraph's home turf: relevance by STRUCTURE, not words. A file whose
   * symbols are call-connected to the matched cluster accrues walk mass and
   * ranks high; a lone TEXT match — e.g. `LensSwitcher.swift` matched the word
   * "switch" from `switchOrganization`, but calls none of `setUser`/`fetchUser`
   * — gets only its own restart probability and ranks ~0. Immune to the
   * tokenization trap that fools term matching, deterministic, no embeddings.
   *
   * Undirected adjacency (reachability both ways), restart α=0.25 to the seeds,
   * power iteration to convergence. Bounded to the already-relevant subgraph, so
   * it's a few hundred nodes × ~25 iterations — negligible cost.
   */
  private computeGraphRelevance(
    nodeIds: string[],
    edges: Edge[],
    seedIds: Set<string>,
  ): Map<string, number> {
    const out = new Map<string, number>();
    const n = nodeIds.length;
    if (n === 0) return out;
    const idx = new Map<string, number>();
    for (let i = 0; i < n; i++) idx.set(nodeIds[i]!, i);

    const RANK_EDGES = new Set<string>([
      'calls', 'references', 'extends', 'implements', 'overrides',
      'instantiates', 'returns', 'type_of', 'imports',
    ]);
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const e of edges) {
      if (!RANK_EDGES.has(e.kind)) continue;
      const i = idx.get(e.source);
      const j = idx.get(e.target);
      if (i === undefined || j === undefined || i === j) continue;
      adj[i]!.push(j);
      adj[j]!.push(i); // undirected — reachable either direction
    }

    // Restart vector: uniform over seeds present in the candidate set. (Falls
    // back to uniform-over-all if no seed landed in the set, so we never return
    // all-zero.)
    const r = new Array<number>(n).fill(0);
    let rsum = 0;
    for (const id of seedIds) {
      const i = idx.get(id);
      if (i !== undefined) { r[i] = 1; rsum += 1; }
    }
    if (rsum === 0) { for (let i = 0; i < n; i++) r[i] = 1; rsum = n; }
    for (let i = 0; i < n; i++) r[i]! /= rsum;

    const alpha = 0.25;
    let s = r.slice();
    for (let iter = 0; iter < 25; iter++) {
      const next = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        const si = s[i]!;
        if (si === 0) continue;
        const d = adj[i]!.length;
        if (d === 0) { next[i]! += si; continue; } // dangling: keep its mass
        const share = si / d;
        for (const j of adj[i]!) next[j]! += share;
      }
      for (let i = 0; i < n; i++) s[i] = (1 - alpha) * next[i]! + alpha * r[i]!;
    }
    for (let i = 0; i < n; i++) out.set(nodeIds[i]!, s[i]!);
    return out;
  }

  /**
   * Handle homegraph_explore — deep exploration in a single call
   *
   * Strategy: find relevant symbols via graph traversal, group by file,
   * then read contiguous file sections covering all symbols per file.
   * This replaces multiple homegraph_node + Read calls.
   *
   * Output size is adaptive to project file count via
   * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
   * tax on small projects while earning its keep on large ones.
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const rawQuery = this.validateString(args.query, 'query');
    if (typeof rawQuery !== 'string') return rawQuery;
    // One normalization point so the flow-builder, relevance search, and
    // ranking all see the same canonical spelling (Erlang `mod:fn/arity`).
    const query = normalizeQuerySpelling(rawQuery);

    const deferKind = queryShouldDeferToBuiltinTools(query);
    if (deferKind) {
      return this.textResult(homegraphDeferGuidance(deferKind, query));
    }

    const cg = this.getHomeGraph(args.projectPath as string | undefined);
    const projectRoot = cg.getProjectRoot();

    const compactLocal = this.tryFastInventoryExplore(cg, query, projectRoot)
      ?? this.tryLightMechanismExplore(cg, query, projectRoot)
      ?? this.tryCompactLocalSymbolExplore(cg, query, projectRoot);
    if (compactLocal) return compactLocal;

    // Light mechanism already attempted above.

    // Resolve adaptive output budget from project size.
    // largest-tier defaults if stats aren't available, which preserves
    // pre-#185 behavior for callers that hit the rare stats failure.
    let budget: ExploreOutputBudget;
    try {
      budget = getExploreOutputBudget(cg.getStats().fileCount);
    } catch {
      budget = getExploreOutputBudget(Infinity);
    }
    budget = tightenExploreBudgetForQuery(budget, query);
    const explicitMaxFiles = typeof args.maxFiles === 'number' && !Number.isNaN(args.maxFiles);
    let maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

    const queryFileBasenames = extractFileBasenamesFromQuery(query);
    const interpretationQuery = queryAsInterpretationSurvey(query);
    const testOnlyInterpretation = queryAsTestOnlyInterpretation(query);
    const crossModuleFlow = queryAsCrossModuleFlowSurvey(query);

    // Step 1: Find relevant context with generous parameters.
    const contextOpts = interpretationQuery && queryFileBasenames.length === 1
      ? { searchLimit: 6, traversalDepth: 2, maxNodes: 60, minScore: 0.25 }
      : { searchLimit: 8, traversalDepth: 3, maxNodes: 200, minScore: 0.2 };
    const contextQuery = interpretationQuery && queryFileBasenames.length === 1
      ? `${queryFileBasenames[0]} ${query}`
      : query;
    const subgraph = await cg.findRelevantContext(contextQuery, contextOpts);

    if (subgraph.nodes.size === 0) {
      return this.textResult(`No relevant code found for "${query}"`);
    }

    // Seed import nodes for @kit.* / *Kit names (and named symbols like taskpool).
    const importTerms = extractImportSearchTerms(query);
    const depSymbols = extractDependencySymbolsFromQuery(query);
    const seedImport = (r: SearchResult, lineText: string): void => {
      const lineLc = lineText.toLowerCase();
      if (importTerms.length > 0) {
        const kitNames = extractKitModuleNamesFromQuery(query);
        if (kitNames.length > 0 && !kitNames.some((k) => lineLc.includes(`@kit.${k.toLowerCase()}`))) {
          return;
        }
      }
      if (depSymbols.length > 0 && !depSymbols.some((s) => lineLc.includes(s.toLowerCase()))) {
        return;
      }
      if (!subgraph.nodes.has(r.node.id)) {
        subgraph.nodes.set(r.node.id, r.node);
        subgraph.roots.push(r.node.id);
      }
    };
    for (const sym of depSymbols) {
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(sym, { kinds: ['import'], limit: 40 });
      } catch {
        continue;
      }
      for (const r of hits) {
        const sig = (r.node.signature || r.node.name || '').trim();
        seedImport(r, sig);
      }
    }
    for (const term of importTerms) {
      const termLc = term.toLowerCase().replace(/^@kit\./, '');
      let hits: SearchResult[] = [];
      try {
        hits = cg.searchNodes(term, { kinds: ['import'], limit: 12 });
      } catch {
        continue;
      }
      for (const r of hits) {
        const sig = (r.node.signature || r.node.name || '').trim();
        if (!sig.toLowerCase().includes(termLc)) continue;
        seedImport(r, sig);
      }
    }

    // Graph-aware glue: findRelevantContext builds the subgraph from name/text
    // search, so a method that BRIDGES named symbols — e.g. App.tsx's
    // triggerRender, which calls the named triggerUpdate — is never a search hit
    // and gets missed, forcing the agent to Read the file to trace it. Pull in
    // the callers/callees of the entry (root) nodes, but ONLY those that live in
    // files the subgraph already surfaces (where the agent reads to fill gaps),
    // so we add wiring without dragging in unrelated files. These get an
    // importance boost below so they survive the per-file cluster budget.
    const glueNodeIds = new Set<string>();
    const subgraphFiles = new Set<string>();
    for (const n of subgraph.nodes.values()) subgraphFiles.add(n.filePath);
    const GLUE_NODE_CAP = 60;
    for (const rootId of subgraph.roots) {
      if (glueNodeIds.size >= GLUE_NODE_CAP) break;
      let neighbors: Node[] = [];
      try {
        neighbors = [
          ...cg.getCallers(rootId).map(c => c.node),
          ...cg.getCallees(rootId).map(c => c.node),
        ];
      } catch {
        continue;
      }
      for (const nb of neighbors) {
        if (glueNodeIds.size >= GLUE_NODE_CAP) break;
        if (subgraph.nodes.has(nb.id)) continue;
        if (!subgraphFiles.has(nb.filePath)) continue;
        subgraph.nodes.set(nb.id, nb);
        glueNodeIds.add(nb.id);
      }
    }

    // Named-symbol seeding: findRelevantContext is an FTS/text rank, so a query
    // that's a BAG of symbol names skewed toward one phase (Alamofire: 5 build
    // terms, each a high-frequency name, vs 3 validate terms) lets the
    // lower-frequency names fall below the search cut — their definitions, and
    // whole files (Validation.swift), never get gathered, so they can never
    // render and the agent Reads them. Resolve EACH named token to its
    // substantive definition (skip empty stubs + test files, same relevance the
    // trace endpoint picker uses) and inject it as an entry, so every symbol the
    // agent explicitly named is in the subgraph and its file is scored.
    const namedSeedIds = new Set<string>();
    // The subset of named seeds that earns the named-FIRST sort tier. We still
    // SEED every ≤3-def name (so RWR / flow ranking is unchanged), but only the
    // most-substantive def is tiered — a bare name's unrelated namesakes (Go's
    // `NewClient` = real client + test fake + xds pool) must not fill the tier
    // and crowd out the real answer file (grpc's `dialoptions.go`). Corroborated
    // overloads (the query also named the type) all earn it. (#1064)
    const tierSeedIds = new Set<string>();
    {
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro)$/i;
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      // Named types (BridgeInterceptor, ResponseFormatter) must also seed — the
      // adaptive sibling-skeleton path needs those files in the subgraph even
      // when they hold no callable the agent also named.
      const SEED_KINDS = new Set([
        ...CALLABLE,
        'class', 'struct', 'interface', 'trait', 'protocol', 'constant', 'variable',
      ]);
      const isTestPath = (p: string) => /(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
      const bodyLines = (n: Node) => Math.max(0, (n.endLine ?? n.startLine) - n.startLine);
      const callerCount = (n: Node) => { try { return cg.getCallers(n.id).length; } catch { return 0; } };
      const namedParts: string[] = [];
      for (const kit of extractKitModuleNamesFromQuery(query)) namedParts.push(kit);
      for (const base of extractFileBasenamesFromQuery(query)) namedParts.push(base);
      for (const ma of extractMemberAccessFromQuery(query)) {
        namedParts.push(ma.member);
        if (ma.receiver) namedParts.push(ma.receiver);
      }
      for (const m of query.matchAll(/\b([A-Za-z_][\w]*)(::)([A-Za-z_][\w]*)\b/g)) {
        if (m[1]) namedParts.push(m[1]);
        if (m[3]) namedParts.push(m[3]);
      }
      const tokens = [...new Set([
        ...namedParts,
        ...query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t)),
      ])].slice(0, 16);
      // PascalCase tokens in the query are type/file disambiguators — when the
      // agent writes "DataRequest task validate", the `task`/`validate` it wants
      // are DataRequest's, NOT the same-named overloads in Validation.swift /
      // Concurrency.swift / the abstract base. Used below to bias overloaded
      // names toward the file/class the query also names. EXCLUDE the project
      // name (a PascalCase token a user naturally includes) — it names the whole
      // repo, so biasing toward it just pulls overloads to whichever stack
      // embeds it, re-burying the rest (#720).
      const projectNameTokens = cg.getProjectNameTokens();
      const typeTokens = tokens.filter(
        (o) => /^[A-Z][A-Za-z0-9]{3,}/.test(o) && !projectNameTokens.has(normalizeNameToken(o)),
      );
      const inNamedContext = (n: Node) =>
        typeTokens.some((ct) => {
          const lc = ct.toLowerCase();
          return n.filePath.toLowerCase().includes(lc) || n.qualifiedName.toLowerCase().includes(lc);
        });
      for (const t of tokens) {
        // Enumerate ALL defs of a bare token via the direct index, not FTS — a
        // 50+-overload name (tokio `poll`) ranks the wanted def (`Harness::poll`)
        // below the FTS cut, so findAllSymbols would never see it and the
        // type-token bias below couldn't pick the harness.rs one. (Same fix as
        // homegraph_node's findSymbolMatches.) Qualified tokens keep findAllSymbols.
        const isQual = /[.\/]|::/.test(t);
        const raw = isQual ? this.findAllSymbols(cg, t).nodes : cg.getNodesByName(t);
        let cands = raw
          .filter((n) => SEED_KINDS.has(n.kind) && !isTestPath(n.filePath))
          .sort((a, b) => {
            // Prefer callables over types when both share a name, then body size.
            const ac = CALLABLE.has(a.kind) ? 1 : 0;
            const bc = CALLABLE.has(b.kind) ? 1 : 0;
            if (ac !== bc) return bc - ac;
            return (bodyLines(b) > 1 ? 1 : 0) - (bodyLines(a) > 1 ? 1 : 0) || bodyLines(b) - bodyLines(a);
          });
        // Field-name seeding fallback (#1196): a camelCase token that names NO
        // definition of its own is usually an object-literal key / API field —
        // seed its camel-infix callable definers instead.
        if (cands.length === 0 && !isQual && /[a-z][A-Z]/.test(t)) {
          const lcToken = t.toLowerCase();
          cands = cg
            .getNodesByNameSubstring(t, {
              kinds: ['function', 'method', 'component'],
              limit: 60,
            })
            .filter((n) => CALLABLE.has(n.kind) && !isTestPath(n.filePath))
            .filter((n) => {
              const idx = n.name.toLowerCase().indexOf(lcToken);
              if (idx < 0) return false;
              if (idx === 0) return n.name.length > t.length;
              return /[A-Z]/.test(n.name.charAt(idx));
            })
            .sort((a, b) => a.name.length - b.name.length)
            .slice(0, 3);
        }
        // A specific name (<=3 defs) injects all its defs. An overloaded name
        // (`validate` = 10, `request` = 44) would flood the subgraph, so inject
        // only: the overloads whose file/class the query ALSO names (the agent
        // told us which one it wants — DataRequest's, not Validation.swift's),
        // capped; else fall back to the single most-substantive def. This is the
        // explore-side mirror of homegraph_node's overload disambiguation.
        let picks: Node[];
        let tierPicks: Node[]; // subset that earns the named-first tier (#1064)
        if (cands.length <= 3) {
          picks = cands;
          // Centrality de-noise: tier the most-substantive def PLUS any co-named
          // def of comparable centrality (a real overload/wrapper — excalidraw's
          // `mutateElement` lives in mutateElement.ts, App.tsx AND Scene.ts, all
          // within ~2x callers). EXCLUDE a vastly-less-central namesake (Go's
          // `NewClient`: real client 492 callers vs xds-pool 11, test-fake 3 →
          // ratio <0.025) so it doesn't fill the tier and crowd out the answer.
          const counts = new Map(cands.map((c) => [c.id, callerCount(c)]));
          const maxCallers = Math.max(1, ...counts.values());
          tierPicks = cands.filter((c, i) => i === 0 || (counts.get(c.id) ?? 0) >= maxCallers * 0.25);
        } else {
          const ctx = cands.filter(inNamedContext);
          picks = ctx.length > 0 ? ctx.slice(0, 4) : cands.slice(0, 1);
          tierPicks = picks; // corroborated overloads (or the single fallback) all earn it
        }
        for (const n of picks) {
          if (!subgraph.nodes.has(n.id)) subgraph.nodes.set(n.id, n);
          // Mark as a named seed EVEN IF the FTS gather already had it — being
          // "named by the agent" is independent of whether search happened to
          // surface it, and it drives the +50 score, the gate, and the
          // named-file sort below. (Previously only NEW injections were marked,
          // so a named symbol FTS already gathered never sorted to the top.)
          namedSeedIds.add(n.id);
        }
        for (const n of tierPicks) tierSeedIds.add(n.id);
      }

      // Mechanism survey: seed query-shaped entry symbols first, then domain search.
      if (queryAsMechanismSurvey(query)) {
        const STRUCTURE_KINDS = new Set(['class', 'struct', 'interface', 'component']);
        const implEntryNames: string[] = [];
        for (const seed of extractMechanismEntrySeeds(query)) {
          if (seed.startsWith('@')) {
            let hits: SearchResult[] = [];
            try {
              hits = cg.searchNodes(seed, { kinds: ['import'], limit: 20 });
            } catch {
              continue;
            }
            for (const r of hits) {
              if (isTestPath(r.node.filePath)) continue;
              if (!subgraph.nodes.has(r.node.id)) subgraph.nodes.set(r.node.id, r.node);
              namedSeedIds.add(r.node.id);
              tierSeedIds.add(r.node.id);
            }
            continue;
          }
          const nodes = cg.getNodesByName(seed).filter(
            (n) => STRUCTURE_KINDS.has(n.kind) && !isTestPath(n.filePath),
          );
          for (const n of nodes.slice(0, 3)) {
            if (!subgraph.nodes.has(n.id)) subgraph.nodes.set(n.id, n);
            namedSeedIds.add(n.id);
            tierSeedIds.add(n.id);
            if (!implEntryNames.includes(n.name)) implEntryNames.push(n.name);
          }
        }
        if (implEntryNames.length < 2) {
          const domainTerms = extractDomainSearchTerms(query);
          for (const term of domainTerms.slice(0, 5)) {
            let hits: SearchResult[] = [];
            try {
              hits = cg.searchNodes(term, { kinds: ['class', 'struct', 'interface'], limit: 30 });
            } catch {
              continue;
            }
            for (const r of hits) {
              if (isTestPath(r.node.filePath)) continue;
              if (!isImplementationEntrySymbol(r.node.name, domainTerms)) continue;
              if (!subgraph.nodes.has(r.node.id)) subgraph.nodes.set(r.node.id, r.node);
              namedSeedIds.add(r.node.id);
              tierSeedIds.add(r.node.id);
              if (!implEntryNames.includes(r.node.name)) implEntryNames.push(r.node.name);
              if (implEntryNames.length >= 6) break;
            }
            if (implEntryNames.length >= 6) break;
          }
        }
      }
    }

    // Step 2: Group nodes by file, score by relevance
    const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
    const entryNodeIds = new Set([...subgraph.roots, ...namedSeedIds]);

    // Build a set of nodes directly connected to entry points (depth 1)
    const connectedToEntry = new Set<string>();
    for (const edge of subgraph.edges) {
      if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
      if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
    }

    // CHANGE SURFACE (#1064): a named method's signature types — its parameter
    // and return types — are part of what you'd edit to "add a parameter to X",
    // yet they can be lexically dissimilar to the query ("add a parameter to
    // NewClient" shares no words with `dialoptions.go`, which defines NewClient's
    // `DialOption`) and sit a hop away. COLLECT them here from each named-seed
    // callable's outgoing signature edges (full graph — the type is often not in
    // the subgraph); the decision to surface one is DEFERRED to the buried-rescue
    // pass below, which fires only when the type's file would otherwise be
    // dropped — so a well-connected type (excalidraw's element types, Alamofire's
    // `DataRequest` on a flow query) is left to rank on its own and never
    // displaces a flow-central file. Bounded: only the few named seeds, only the
    // types in their signatures.
    const CALLABLE_KINDS = new Set(['method', 'function', 'component', 'constructor']);
    const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'type_alias']);
    const SIG_EDGE = new Set(['references', 'type_of', 'returns']);
    const changeSurfaceCandidates: Node[] = [];
    const seenChangeSurface = new Set<string>();
    for (const seedId of tierSeedIds) {
      const seedNode = subgraph.nodes.get(seedId);
      if (!seedNode || !CALLABLE_KINDS.has(seedNode.kind)) continue;
      let outs: Edge[] = [];
      try { outs = cg.getOutgoingEdges(seedId); } catch { continue; }
      for (const e of outs) {
        if (!SIG_EDGE.has(e.kind)) continue;
        const tgt = cg.getNode(e.target);
        if (!tgt || !TYPE_KINDS.has(tgt.kind) || namedSeedIds.has(tgt.id)) continue;
        if (seenChangeSurface.has(tgt.id)) continue;
        seenChangeSurface.add(tgt.id);
        changeSurfaceCandidates.push(tgt);
      }
    }

    for (const node of subgraph.nodes.values()) {
      // Skip import/export nodes — they add noise without information
      if (node.kind === 'import' || node.kind === 'export') continue;
      // SECURITY (#383): never render the on-disk source of a config-leaf
      // (Spring application.{yml,properties} key) — its line is `key = <secret>`,
      // so whole-file/cluster rendering here would push secrets into context
      // unbidden. The key still appears in the flow/symbol listing above.
      if (isConfigLeafNode(node)) continue;

      const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
      group.nodes.push(node);
      // Score: a NAMED-SEED node (a symbol the agent named that FTS missed, now
      // injected) is worth far more than a mere reference — its file is where the
      // answer lives. Without this, an incidental file that name-drops the flow
      // (Combine.swift references request/task → score 23 from connected nodes)
      // outranks the file that DEFINES a named symbol (Validation.swift's
      // `validate` → 10) and steals its render slot. Definition ≫ reference.
      if (namedSeedIds.has(node.id)) {
        group.score += 50;
      } else if (entryNodeIds.has(node.id)) {
        group.score += 10;
      } else if (connectedToEntry.has(node.id)) {
        group.score += 3;
      } else {
        group.score += 1;
      }
      fileGroups.set(node.filePath, group);
    }

    if (testOnlyInterpretation) {
      for (const [, group] of fileGroups) {
        const fp = group.nodes[0]?.filePath ?? '';
        if (fp && !isTestFile(fp) && !fileMatchesQueryBasename(fp, queryFileBasenames)) {
          group.score = Math.max(0, group.score - 50);
        }
      }
    }

    // Only include files that have entry points or nodes directly connected to entry points
    let relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);

    // Extract query terms for relevance checking
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

    // Test/spec/icon/i18n file detector — used both for the pre-sort hard
    // filter (tiny tier) and the comparator deprioritization (all tiers).
    const isLowValue = (p: string) => {
      const lp = p.toLowerCase();
      return (
        /\/(tests?|__tests?__|spec)\//.test(lp) ||
        /_test\.go$/.test(lp) ||
        /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
        /_test\.py$/.test(lp) ||
        /_spec\.rb$/.test(lp) ||
        /_test\.rb$/.test(lp) ||
        /\.(test|spec)\.[jt]sx?$/.test(lp) ||
        /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
        /(tests?|spec)\.cs$/.test(lp) ||
        /tests?\.swift$/.test(lp) ||
        /_test\.dart$/.test(lp) ||
        /\bicons?\b/.test(lp) ||
        /\bi18n\b/.test(lp)
      );
    };

    // Hard-exclude test/spec files (ALL tiers, not just tiny). One slipped test
    // file dominates the per-file budget on small repos (cobra's `command_test.go`
    // displaced `args.go`) AND wastes budget on large ones (Django's
    // `custom_lookups/tests.py` ate ~2.3 KB of the 28 KB cap, crowding out the
    // SQLCompiler mechanism the agent then Read). A test file almost never answers
    // an architecture question. Skip when the query itself is about tests — the
    // legitimate "explore the tests" case — and only cut if ≥2 non-test candidates
    // remain (else tests are the only signal for this area).
    {
      const queryMentionsTests = /\b(test|tests|testing|spec|verify|verifies)\b/i.test(query);
      if (!queryMentionsTests) {
        const nonLow = relevantFiles.filter(([p]) => !isLowValue(p));
        if (nonLow.length >= 2) {
          relevantFiles = nonLow;
        }
      }
    }

    // Secondary signal: how many DISTINCT query terms each file matches (path +
    // symbol names). Kept only as a tiebreak — the PRIMARY relevance is graph
    // connectivity below. (Term counting alone tied the real central file with
    // incidental same-word matches; it's a weak text signal, not the ranker.)
    const uniqueQueryTerms = [...new Set(queryTerms)].filter(t => t.length >= 3);
    const fileTermHits = new Map<string, number>();
    for (const [fp, group] of relevantFiles) {
      const hay = fp.toLowerCase() + ' ' + group.nodes.map(n => n.name.toLowerCase()).join(' ');
      let hits = 0;
      for (const t of uniqueQueryTerms) if (hay.includes(t)) hits++;
      fileTermHits.set(fp, hits);
    }

    // PRIMARY relevance: graph connectivity (Random-Walk-with-Restart from the
    // matched seeds — see computeGraphRelevance). Aggregate each file's nodes'
    // walk mass. This is the signal text search lacks: the real cluster
    // (org-user.storage.ts, call-connected to the matches) accrues mass; a lone
    // text match (LensSwitcher.swift, matched "switch" but calls nothing in the
    // flow) gets only its restart probability → ~0, and is dropped by the gate.
    const nodeRwr = this.computeGraphRelevance(
      [...subgraph.nodes.keys()], subgraph.edges, entryNodeIds,
    );
    const fileGraphScore = new Map<string, number>();
    for (const node of subgraph.nodes.values()) {
      fileGraphScore.set(
        node.filePath,
        (fileGraphScore.get(node.filePath) ?? 0) + (nodeRwr.get(node.id) ?? 0),
      );
    }
    const maxGraph = Math.max(0, ...fileGraphScore.values());

    // Central file(s): the 1-2 most graph-central files that also match the
    // query textually (so a connected hub-utility with no term match isn't
    // mistaken for the subject). The heart of the answer — they earn the larger
    // WHOLE-FILE ceiling below (a god-file central file still exceeds it and
    // falls to generous full-method sectioning — never a whole dump).
    const centralFiles = new Set(
      [...fileGraphScore.entries()]
        .filter(([fp, g]) => g > 0 && (fileTermHits.get(fp) ?? 0) >= 1)
        .sort((a, b) => b[1] - a[1] || (fileTermHits.get(b[0]) ?? 0) - (fileTermHits.get(a[0]) ?? 0))
        .slice(0, 2)
        .map(([f]) => f),
    );

    // Files that DEFINE a symbol the agent named (or a subgraph root). These are
    // the highest-relevance files there are — the agent asked for them by name —
    // so the connectivity gate below must never drop them, even when their RWR
    // mass is low (a leaf family file like codec.ts is call-connected to little
    // but is exactly what the agent queried). Without this protection the gate
    // prunes a named file and the agent Reads it back.
    const entryFiles = new Set<string>();
    for (const id of entryNodeIds) {
      const n = subgraph.nodes.get(id);
      if (n) entryFiles.add(n.filePath);
    }
    // Buried-rescue pass (#1064): surface a named method's signature type ONLY
    // when its file is genuinely buried — near-zero graph mass AND not lexically
    // matched. That is the invisible case (grpc's `DialOption` → `dialoptions.go`,
    // g≈0, 0 term hits): reachable but ranked nowhere, so the agent greps. A
    // well-connected type file (excalidraw element types, Alamofire `DataRequest`)
    // is NOT buried and is left alone — rescuing it would displace a flow-central
    // file (App.tsx, Validation.swift). Buried is judged on the PRE-rescue graph,
    // so injecting the type below can't make it look connected. A rescued file is
    // injected (so it renders), force-kept (gate + relevantFiles), and tiered.
    const changeSurfaceFiles = new Set<string>();
    for (const t of changeSurfaceCandidates) {
      const fp = t.filePath;
      const buried = (fileGraphScore.get(fp) ?? 0) < maxGraph * 0.06
        && (fileTermHits.get(fp) ?? 0) < 2;
      if (!buried) continue;
      changeSurfaceFiles.add(fp);
      if (!subgraph.nodes.has(t.id)) subgraph.nodes.set(t.id, t);
      let group = fileGroups.get(fp);
      if (!group) { group = { nodes: [], score: 0 }; fileGroups.set(fp, group); }
      if (!group.nodes.some((n) => n.id === t.id)) group.nodes.push(t);
      group.score = Math.max(group.score, 45);
      if (!relevantFiles.some(([f]) => f === fp)) relevantFiles.push([fp, group]);
    }

    // Relevance gate (so the generous budget is a CEILING, not a target): keep a
    // file only if it is STRUCTURALLY relevant by ANY of:
    //   - graph score within a fraction of the top (it's on/near the flow), OR
    //   - central (a query entry-point lives here), OR
    //   - it DEFINES a symbol the agent named (entryFiles), OR
    //   - it matches >= 2 DISTINCT named query terms — a strong text signal that
    //     the agent is asking about this file even when nothing calls it (codec.ts:
    //     the agent named `encode`/`Codec`/`JsonCodec`, all leaf classes with zero
    //     RWR mass — graph alone wrongly drops it).
    // A lone text match on one shared word (LensSwitcher: term=1, g~0) is still
    // dropped, so the budget never fills with incidental files. Guarded so it
    // never prunes below 2.
    if (maxGraph > 0) {
      const gated = relevantFiles.filter(([fp]) =>
        (fileGraphScore.get(fp) ?? 0) >= maxGraph * 0.06
        || centralFiles.has(fp)
        || entryFiles.has(fp)
        || changeSurfaceFiles.has(fp)
        || (fileTermHits.get(fp) ?? 0) >= 2,
      );
      if (gated.length >= 2) relevantFiles = gated;
    }

    // Sort files: graph-central first, then distinct-term match, then the
    // existing low-value/generated/score tiebreaks.
    // Files that DEFINE a symbol the agent NAMED. These sort first — ahead of
    // graph connectivity — because the agent asked for them by name. Without
    // this, a named leaf override reached only by dynamic dispatch (Alamofire's
    // `DataRequest.task`/`validate`, low RWR mass) sorts below the high-
    // connectivity abstract base (`Request.swift`) and the same-named overloads
    // in other files (`Validation.swift`), falls outside the budget, and the
    // agent Reads it. The named file is the answer — rank it at the top.
    const namedSeedFiles = new Set<string>();
    for (const id of tierSeedIds) {
      const n = subgraph.nodes.get(id);
      if (n) namedSeedFiles.add(n.filePath);
    }
    // A rescued change-surface file (only the genuinely-buried ones — see the
    // buried-rescue pass) is the lexically-dissimilar answer; give it the named
    // tier so it isn't buried under files that merely share surface words (#1064).
    for (const fp of changeSurfaceFiles) namedSeedFiles.add(fp);

    // Multi-term corroboration tier: a file that is BOTH (a) an entry/central file
    // (a search root, named seed, or graph-central hub — i.e. structurally part of
    // the answer) AND (b) matched by ≥2 DISTINCT query terms must not be buried by
    // graph-centrality mass that accrued to a denser-but-off-topic cluster. In a
    // cross-layer monorepo (an API server alongside a much larger, internally dense
    // frontend that mirrors the same domain words) the Random-Walk-with-Restart mass
    // — seeded from text matches that skew to the bigger layer — floats hits=0
    // frontend files above the hits=2/3 backend service that IS the answer (its many
    // callers don't help: it's call-isolated from the frontend seed cluster). The
    // entry/central GUARD keeps this safe: an INCIDENTAL multi-term file that is
    // neither entry nor central (a type/util file that matches "element"+x but isn't
    // the flow) is NOT promoted, so it can't displace the graph-central answer file
    // (hits=1) the way a blunt hits-only tier would. Single-layer repos with one
    // cluster are unaffected (no competing mass). Set HOMEGRAPH_RANK_NO_MULTITERM=1
    // to disable.
    const MULTITERM_OFF = process.env.HOMEGRAPH_RANK_NO_MULTITERM === '1';
    const isCorroborated = (fp: string) =>
      !MULTITERM_OFF &&
      (fileTermHits.get(fp) ?? 0) >= 2 &&
      (entryFiles.has(fp) || centralFiles.has(fp));
    const queryMemberAccesses = extractMemberAccessFromQuery(query);

    const sortedFiles = relevantFiles.sort((a, b) => {
      const aPath = a[0].toLowerCase();
      const bPath = b[0].toLowerCase();

      // Query-named file (LocationController.ets in the question) before partial
      // substring matches (control.ets matching "Controller" inside LocationController).
      const aExactBase = fileMatchesQueryBasename(a[0], queryFileBasenames) ? 1 : 0;
      const bExactBase = fileMatchesQueryBasename(b[0], queryFileBasenames) ? 1 : 0;
      if (aExactBase !== bExactBase) return bExactBase - aExactBase;

      // Agent-named files first (it asked for a symbol defined here by name).
      const aNamed = namedSeedFiles.has(a[0]) ? 1 : 0;
      const bNamed = namedSeedFiles.has(b[0]) ? 1 : 0;
      if (aNamed !== bNamed) return bNamed - aNamed;

      // Corroborated (entry/central + ≥2 terms) tier, above the graph signal.
      const aCorr = isCorroborated(a[0]) ? 1 : 0;
      const bCorr = isCorroborated(b[0]) ? 1 : 0;
      if (aCorr !== bCorr) return bCorr - aCorr;

      // Graph connectivity is the next key (small epsilon so near-ties fall
      // through to the text signal rather than coin-flipping on float noise).
      const aG = fileGraphScore.get(a[0]) ?? 0;
      const bG = fileGraphScore.get(b[0]) ?? 0;
      if (Math.abs(aG - bG) > maxGraph * 0.01) return bG - aG;

      const aHits = fileTermHits.get(a[0]) ?? 0;
      const bHits = fileTermHits.get(b[0]) ?? 0;
      if (aHits !== bHits) return bHits - aHits;

      const aLow = isLowValue(aPath);
      const bLow = isLowValue(bPath);
      if (aLow !== bLow) return aLow ? 1 : -1;

      // Deprioritize generated source (.pb.go / .pulsar.go / _mocks.go / …) —
      // the agent rarely needs to see the protobuf scaffold or gomock output
      // when asking about the actual flow, and dumping their bodies inflates
      // the response (the cosmos Q3 explore otherwise leads with
      // `expected_keepers_mocks.go`, displacing the real `tally.go` content
      // and forcing the agent to Read tally.go anyway).
      const aGen = isGeneratedFile(a[0]);
      const bGen = isGeneratedFile(b[0]);
      if (aGen !== bGen) return aGen ? 1 : -1;

      if (a[1].score !== b[1].score) return b[1].score - a[1].score;
      return b[1].nodes.length - a[1].nodes.length;
    });

    // Step 3: Build relationship map
    const lines: string[] = [
      `**Exploration: ${query}**`,
      '',
      // Curated summary — filled in after the source loop (see below). We do NOT
      // report `subgraph.nodes.size` / `fileGroups.size` here: that's the raw
      // candidate gather, which a broad natural-language query inflates wildly
      // (260 symbols / 124 files on a 636-file repo) even though only a handful
      // render. Reporting the pool read as "260 results to wade through" when the
      // real, correctly-ranked answer is the few files below (#1046).
      '',
      '',
    ];
    const summaryLineIdx = 2;

    if (testOnlyInterpretation) {
      lines.push(
        '> **Test-file scope only** — answer from the named `.test.ets` file below; ' +
        'production handlers are out of scope unless explicitly referenced in the test.',
      );
      lines.push('');
    }

    const importResult = queryAsksKitInstallDeps(query)
      ? { section: '', siteCount: 0, compactListing: false }
      : this.buildImportSitesSection(cg, query, projectRoot);
    if (importResult.section) lines.push(importResult.section);

    const homonymSection = this.buildHomonymDefinitionsSection(cg, query);
    if (homonymSection) lines.push(homonymSection);

    const kitUsageResult =
      shouldBuildKitModuleUsageSurvey(query)
      && (
        queryAsksKitInstallDeps(query)
        || !(importResult.compactListing && importResult.siteCount > 0)
      )
        ? this.buildKitModuleUsageSection(cg, query, projectRoot)
        : { section: '', symbolCount: 0 };
    if (kitUsageResult.section) lines.push(kitUsageResult.section);

    const domainFileResult = shouldBuildDomainFileSurvey(query)
      ? this.buildDomainFileSurveySection(cg, query)
      : { section: '', fileCount: 0 };
    if (domainFileResult.section) lines.push(domainFileResult.section);

    const apiUsageResult = shouldBuildApiUsageSurvey(query)
      ? this.buildApiUsageSection(cg, query, projectRoot)
      : { section: '', fileCount: 0 };
    if (apiUsageResult.section) lines.push(apiUsageResult.section);

    const dataSourceResult = queryAsDataSourceSurvey(query)
      ? this.buildDataSourceSection(cg, query)
      : { section: '', edgeCount: 0 };
    if (dataSourceResult.section) lines.push(dataSourceResult.section);

    const importInventoryFilter = hasImportInventoryFilter(query);
    const multiAnchor = queryNamesMultipleExploreAnchors(query) || crossModuleFlow;
    const mechanismSurvey = queryAsMechanismSurvey(query);

    // Flow path — computed before omit-source so graph connectivity drives the decision,
    // not question-text keyword matching. Mechanism/cross-module surveys augment the
    // query with seeded entry symbol names so buildFlowFromNamedSymbols can connect them.
    let flowQuery = query;
    if (crossModuleFlow) {
      flowQuery = `${query} ${extractTypeNamesFromQuery(query).join(' ')}`;
    } else if (mechanismSurvey) {
      const seeds = extractMechanismEntrySeeds(query);
      if (seeds.length >= 2) {
        flowQuery = `${query} ${seeds.join(' ')}`;
      } else {
        const entryNames = [...subgraph.nodes.values()]
          .filter((n) => (n.kind === 'class' || n.kind === 'struct' || n.kind === 'interface')
            && isImplementationEntrySymbol(n.name, extractDomainSearchTerms(query)))
          .map((n) => n.name)
          .slice(0, 6);
        if (entryNames.length >= 2) flowQuery = `${query} ${entryNames.join(' ')}`;
      }
    }
    const flow = this.buildFlowFromNamedSymbols(cg, flowQuery);
    const hasFlowPath = flow.pathNodeIds.size > 0;
    budget = tightenExploreBudgetForQuery(budget, query, { hasFlowPath });
    // Honor an explicit maxFiles from the caller — budget.defaultMaxFiles is only
    // a default when the agent didn't ask for more (adaptive sibling tests pass 12).
    if (!explicitMaxFiles) {
      maxFiles = Math.min(maxFiles, clamp(budget.defaultMaxFiles, 1, 20));
    }
    const localDetail = queryAsLocalSymbolDetail(query);

    const inheritanceSection = !hasFlowPath && !multiAnchor
      ? this.buildInheritanceSurveySection(cg, query) : '';
    const listedTypeMethods = extractListedTypeMethodsFromQuery(query).length > 0;
    // Type + listed methods (BinaryGrid Set/Test/Fill) must keep caller inventory even
    // when multi-anchor would otherwise skip it into a fat source dump.
    const callerSection = !hasFlowPath && (!multiAnchor || listedTypeMethods) && shouldBuildCallerInventory(query)
      ? this.buildCallerListingSection(cg, query, projectRoot) : '';
    // Field new/delete inventories already list text sites — skip redundant member scan.
    const memberSection = !hasFlowPath && !multiAnchor && shouldBuildMemberSurvey(query)
      && !(queryAsFieldUsageSurvey(query) && apiUsageResult.fileCount > 0)
      ? this.buildMemberSurveySection(cg, query, projectRoot) : '';
    const configSection = shouldBuildConfigSection(query)
      ? this.buildConfigFileSection(cg, query, projectRoot) : '';

    if (inheritanceSection) lines.push(inheritanceSection);
    if (callerSection) lines.push(callerSection);
    if (memberSection) lines.push(memberSection);
    if (configSection) lines.push(configSection);

    const finishCompact = (summary: string): ToolResult => {
      lines[summaryLineIdx] = summary;
      return this.textResult(lines.join('\n'));
    };

    const memberFileCount = memberSection
      ? memberSection.split('\n').filter((l) => l.startsWith('- ')).length
      : 0;
    const callerBulletCount = callerSection
      ? callerSection.split('\n').filter((l) => l.startsWith('- ') && l.includes(' ← ')).length
      : 0;
    const inheritanceListed = inheritanceSection
      ? inheritanceSection.split('\n').filter((l) => l.startsWith('- `')).length > 0
      : false;
    const omitSource = shouldOmitSourceBodies({
      importSiteCount: importResult.siteCount,
      hasFilteredImports: importInventoryFilter && importResult.siteCount > 0,
      callerBulletCount,
      memberFileCount,
      apiUsageFileCount: apiUsageResult.fileCount,
      configRendered: !!configSection,
      kitModuleSurveyRendered: !!kitUsageResult.section,
      inheritanceListed,
      domainFileCount: domainFileResult.fileCount,
      dataSourceEdgeCount: dataSourceResult.edgeCount,
    }, hasFlowPath, multiAnchor);

    if (omitSource) {
      if (configSection) {
        return finishCompact('Config/manifest content above — answer from it directly.');
      }
      if (kitUsageResult.section) {
        return finishCompact(
          `Kit module **in-repo usage** survey — **${kitUsageResult.symbolCount}** imported symbol(s). ` +
          'Not an SDK catalog. **ANSWER NOW** from the usage list; do not Grep the same `@kit` path.',
        );
      }
      if (domainFileResult.section && domainFileResult.fileCount > 0) {
        return finishCompact(
          `Domain file survey — **${domainFileResult.fileCount}** related file(s) listed above. **ANSWER NOW.**`,
        );
      }
      if (apiUsageResult.section && apiUsageResult.fileCount > 0) {
        return finishCompact(
          `API usage survey — **${apiUsageResult.fileCount}** file(s). **ANSWER NOW** from the list above.`,
        );
      }
      if (listedTypeMethods && callerBulletCount > 0) {
        return finishCompact(
          `Caller inventory — **${callerBulletCount}** site(s) for listed methods. **ANSWER NOW**; do not fan out callers per method.`,
        );
      }
      if (dataSourceResult.section && dataSourceResult.edgeCount > 0) {
        return finishCompact(
          `Data-source survey — **${dataSourceResult.edgeCount}** upstream symbol(s). **ANSWER NOW.**`,
        );
      }
      if (inheritanceListed) {
        return finishCompact(
          'Inheritance survey above lists all direct subtypes found. **ANSWER NOW** — do not grep `extends`.',
        );
      }
      if (importResult.compactListing) {
        return finishCompact(
          `Listed **${importResult.siteCount}** import site(s). **ANSWER NOW** from the dependency list above.`,
        );
      }
      if (callerBulletCount >= 1) {
        return finishCompact(
          `Caller inventory above lists **${callerBulletCount}** method(s). **ANSWER NOW.**`,
        );
      }
      if (memberSection && memberFileCount >= 2) {
        return finishCompact(
          `Member/pattern usage in **${memberFileCount}** file(s). **ANSWER NOW** from the inventory above.`,
        );
      }
    }

    // Blast radius only for structural flow / mechanism answers — skip on local-detail
    // and no-flow dumps (it's expensive and rarely changes the answer there).
    if (!localDetail && (hasFlowPath || mechanismSurvey || crossModuleFlow)) {
      const blastRadius = this.buildBlastRadiusSection(cg, subgraph);
      if (blastRadius) lines.push(blastRadius);
    }

    // Relationship map — show how symbols connect (skip when no flow path: saves
    // tokens on survey/dependency/how-to questions that don't need call graphs).
    const significantEdges = subgraph.edges.filter(e =>
      e.kind !== 'contains' // skip contains — it's implied by file grouping
    );

    if (budget.includeRelationships && hasFlowPath && !importResult.compactListing
        && significantEdges.length > 0) {
      lines.push('**Relationships**');
      lines.push('');

      // Group edges by kind for readability
      const byKind = new Map<string, Array<{ source: string; target: string }>>();
      for (const edge of significantEdges) {
        const sourceNode = subgraph.nodes.get(edge.source);
        const targetNode = subgraph.nodes.get(edge.target);
        if (!sourceNode || !targetNode) continue;

        const group = byKind.get(edge.kind) || [];
        group.push({ source: sourceNode.name, target: targetNode.name });
        byKind.set(edge.kind, group);
      }

      for (const [kind, edges] of byKind) {
        const cap = budget.maxEdgesPerRelationshipKind;
        const shown = edges.slice(0, cap);
        lines.push(`**${kind}:**`);
        for (const e of shown) {
          lines.push(`- ${e.source} → ${e.target}`);
        }
        if (edges.length > cap) {
          lines.push(`- ... and ${edges.length - cap} more`);
        }
        lines.push('');
      }
    }

    // Step 4: Read contiguous file sections
    // (flow already computed above for relationship gating and adaptive sizing)
    // Polymorphic-sibling detector for adaptive sizing. A class that implements/
    // extends a supertype shared by >= MIN_SIBLINGS classes is one of many
    // INTERCHANGEABLE implementations (OkHttp's 14 `: Interceptor` classes —
    // showing one + the rest as signatures is enough), as opposed to a DISTINCT
    // pipeline step (Excalidraw's `renderStaticScene`, which shares no supertype and
    // must stay full or the agent loses real content). Only off-spine sibling files
    // skeletonize; distinct steps and on-spine files keep full source. Cache
    // supertype→(has ≥N implementers) so this stays a handful of edge queries.
    const MIN_SIBLINGS = 3;
    const siblingSuper = new Map<string, boolean>();
    const isPolymorphicSibling = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        for (const e of cg.getOutgoingEdges(n.id)) {
          if (e.kind !== 'implements' && e.kind !== 'extends') continue;
          let many = siblingSuper.get(e.target);
          if (many === undefined) {
            many = cg.getIncomingEdges(e.target)
              .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
            siblingSuper.set(e.target, many);
          }
          if (many) return true;
        }
      }
      return false;
    };

    // A file that DEFINES a polymorphic supertype (a class/interface with ≥
    // MIN_SIBLINGS implementers) AND co-locates its subclasses is a redundant
    // "family" file — Django's compiler.py holds `SQLCompiler` + its 4 subclasses
    // (SQLInsert/Update/Delete/AggregateCompiler) in 2,266 lines. Such files are
    // huge and read-anyway, so they should STILL skeletonize even when the agent
    // named a method in them: a full one eats ~6.5K of the explore budget (Django
    // is pinned at the 28K cap, truncating), starving the sibling files the agent
    // then Reads. This flag OVERRIDES the named-callable spare below — it does NOT
    // by itself spare a file. (OkHttp's RealCall implements the `Lockable` mixin
    // but defines no ≥3-impl supertype, so the named spare keeps it full.)
    const superMany = new Map<string, boolean>();
    const definesPolymorphicSupertype = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        if (n.kind !== 'class' && n.kind !== 'interface' && n.kind !== 'struct'
            && n.kind !== 'trait' && n.kind !== 'protocol' && n.kind !== 'type_alias') continue;
        let many = superMany.get(n.id);
        if (many === undefined) {
          many = cg.getIncomingEdges(n.id)
            .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
          superMany.set(n.id, many);
        }
        if (many) return true;
      }
      return false;
    };

    lines.push('**Source Code**');
    lines.push('');
    lines.push(
      '> Line-numbered source — treat as already Read. Answer from Flow + Source below when you can; ' +
      'do not re-read/grep these files, and do not fan out `homegraph_node` / search for symbols already shown. ' +
      'Another `homegraph_explore` with tighter names only if a needed symbol is missing.',
    );
    lines.push('');

    let totalChars = lines.join('\n').length;
    let filesIncluded = 0;
    // Paths we actually render source for below. Drives the curated header count
    // (#1046) — it must reflect what we show, not the raw candidate gather.
    const renderedFilePaths: string[] = [];
    let anyFileTrimmed = false;

    const limitSingleFile = shouldLimitToQueryNamedFile(query, hasFlowPath, multiAnchor)
      || (interpretationQuery && queryFileBasenames.length === 1);
    let filesToRender = sortedFiles;
    if (limitSingleFile) {
      const anchored = sortedFiles.filter(([fp]) => fileMatchesQueryBasename(fp, queryFileBasenames));
      if (anchored.length > 0) filesToRender = anchored.slice(0, 1);
    } else if (shouldFocusOnNamedTypeFile(query, hasFlowPath, multiAnchor)) {
      const typeName = extractTypeNamesFromQuery(query)[0]!;
      const anchored = sortedFiles.filter(([, group]) =>
        group.nodes.some((n) =>
          n.name === typeName && (n.kind === 'class' || n.kind === 'interface' || n.kind === 'struct'),
        ),
      );
      if (anchored.length > 0) filesToRender = anchored.slice(0, 1);
    } else if (shouldFocusOnQueryNamedDefs(query, hasFlowPath, multiAnchor)) {
      const nameSet = new Set([
        ...extractTypeNamesFromQuery(query),
        ...extractDependencySymbolsFromQuery(query),
        ...extractMemberAccessFromQuery(query).map((m) => m.member),
      ]);
      const anchored = sortedFiles.filter(([, group]) =>
        group.nodes.some((n) => nameSet.has(n.name)),
      );
      if (anchored.length > 0) {
        filesToRender = anchored.slice(0, localDetail ? 2 : 3);
      }
    } else if (crossModuleFlow && hasFlowPath) {
      const onSpine = sortedFiles.filter(([, group]) =>
        group.nodes.some((n) => flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id)),
      );
      if (onSpine.length > 0) filesToRender = onSpine;
    }
    const sourceFileCap = limitSingleFile && filesToRender.length === 1
      ? 1
      : localDetail
        ? Math.min(maxFiles, 2)
        : crossModuleFlow && hasFlowPath
          ? Math.min(maxFiles, 5)
          : mechanismSurvey && hasFlowPath
            ? Math.min(maxFiles, 4)
            : mechanismSurvey
              ? Math.min(maxFiles, 3)
              : !hasFlowPath
                ? Math.min(maxFiles, 3)
                : maxFiles;

    for (const [filePath, group] of filesToRender) {
      if (filesIncluded >= sourceFileCap) break;
      // A file DEFINES a named/spine symbol (the answer) vs merely references the
      // flow. Past 90% budget, stop pulling INCIDENTAL files — but keep scanning
      // for necessary ones, which render even past the cap (bounded by maxFiles).
      // Without this `continue` (was an unconditional `break`), the loop stopped
      // after the build + validators-exec files and never reached the ranked-in
      // validate-logic file (Alamofire's Validation.swift).
      const fileNecessary = group.nodes.some(n =>
        entryNodeIds.has(n.id) || flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id));
      if (!fileNecessary && totalChars > budget.maxOutputChars * 0.9) continue;

      if (isOhosApiFilePath(filePath)) {
        const rel = filePath.slice(OHOS_API_FILE_PREFIX.length);
        const syms = group.nodes
          .filter((n) => n.kind !== 'import' && n.kind !== 'export')
          .sort((a, b) => a.startLine - b.startLine);
        if (syms.length === 0) continue;

        lines.push(fileSectionHeader(rel, 'HarmonyOS SDK API (prebuilt db)'));
        lines.push('');
        for (const n of syms) {
          const sig = n.signature || n.docstring || `${n.kind} ${n.qualifiedName || n.name}`;
          lines.push(`\`${sig}\``);
        }
        lines.push('');
        totalChars = lines.join('\n').length;
        filesIncluded++;
        continue;
      }

      const absPath = validatePathWithinRoot(projectRoot, filePath);
      if (!absPath || !existsSync(absPath)) continue;

      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const fileLines = fileContent.split('\n');
      const lang = group.nodes[0]?.language || '';

      // Adaptive sizing (HOMEGRAPH_ADAPTIVE_EXPLORE, default on): collapse a file
      // to a per-symbol view when it's a redundant member of a polymorphic family.
      // Engages iff ALL hold:
      //   1. a flow spine exists,
      //   2. no symbol in the file is on that spine (it's not the mechanism path),
      //   3. it IS a polymorphic sibling (≥ MIN_SIBLINGS impls of a shared supertype),
      //   4. it is NOT SPARED, where a file is spared iff the agent named a
      //      (near-)UNIQUE callable in it (`getResponseWithInterceptorChain`, 1 def →
      //      keep RealCall.kt full) UNLESS the file DEFINES the family supertype (a
      //      base+subclasses "family" file like Django's compiler.py — collapse it).
      //      Uniqueness matters: `as_sql` has 110 defs across every Compiler/Expression
      //      subclass; naming it must NOT keep every backend variant + test file full
      //      and flood the budget. That's why the spare reads uniqueNamedNodeIds.
      // Within a collapsed file the render is PER-SYMBOL (condition B): a method the
      // agent NAMED or that's on the spine is shown with its FULL body (so the agent
      // doesn't Read the file back for it — Django's SQLCompiler.execute_sql/as_sql);
      // every other symbol is just its signature. So the base mechanism survives while
      // the file's other ~80 symbols + the redundant subclasses collapse to one line each.
      const spareNamed = group.nodes.some(n => flow.uniqueNamedNodeIds.has(n.id));
      const fileDefinesSuper = definesPolymorphicSupertype(group.nodes);
      const spared = spareNamed && !fileDefinesSuper;
      const CALLABLE_BODY = new Set(['method', 'function', 'constructor', 'component']);
      const hasSpineNode = group.nodes.some(n => flow.pathNodeIds.has(n.id));
      // On-spine god-file: the flow path runs THROUGH this file, but it also holds
      // many OTHER named methods, and rendering all of them in full blows the
      // per-file budget and starves the other flow files (Alamofire: the agent
      // names ~7 Session.swift methods — the build spine PLUS off-path
      // task/didCompleteTask — far past the whole response budget). Engage the
      // per-symbol view to keep the SPINE full and collapse the off-path named
      // methods to signatures. Only when there IS off-path content to shed —
      // otherwise the spine is irreducible (a sequential flow has no redundancy),
      // so leave it to the normal full render.
      const namedBodyChars = group.nodes
        .filter(n => CALLABLE_BODY.has(n.kind) && (flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id)))
        .reduce((s, n) => s + fileLines.slice(n.startLine - 1, n.endLine).join('\n').length, 0);
      const onSpineGodFile = hasSpineNode
        && namedBodyChars > budget.maxCharsPerFile
        && group.nodes.some(n => CALLABLE_BODY.has(n.kind) && flow.uniqueNamedNodeIds.has(n.id) && !flow.pathNodeIds.has(n.id));
      if (adaptiveExploreEnabled() && flow.pathNodeIds.size > 0
          && (onSpineGodFile || (!hasSpineNode && isPolymorphicSibling(group.nodes) && !spared))) {
        const syms = group.nodes
          .filter(n => n.kind !== 'import' && n.kind !== 'export' && n.startLine > 0)
          .sort((a, b) => a.startLine - b.startLine);
        // Pass 1: choose which symbols get a FULL body, by priority, greedily within
        // a per-file body cap — so one huge family file can't body every named method
        // and crowd out the other flow files (Django's query.py). A symbol earns a
        // body if it's on-spine, or UNIQUELY named (`SQLCompiler.execute_sql`), or a
        // co-named method WHEN this file DEFINES the family supertype (so the base
        // `SQLCompiler.as_sql` body shows, but the 110 leaf `as_sql` overrides — and
        // OkHttp's 5 `intercept`s if the agent names `intercept` — stay signatures).
        const prio = (n: Node) => !CALLABLE_BODY.has(n.kind) ? 99
          : flow.pathNodeIds.has(n.id) ? 0
          : flow.uniqueNamedNodeIds.has(n.id) ? 1
          : (fileDefinesSuper && flow.namedNodeIds.has(n.id)) ? 2 : 99;
        // One ~250-line WINDOW per file. syms are taken by priority (spine first,
        // then uniquely-named, then family-base), and the cap applies to ALL of
        // them — including the spine — so a big-spine god-file (tokio's worker.rs:
        // run→run_task→next_task→steal_work) can't eat the whole response and
        // starve the co-flow file (harness.rs's poll). The native agent windows
        // such a file too (~190 lines at a time), so this mimics, not truncates.
        // Always emit ≥1 (never an empty section).
        const bodyCap = budget.maxCharsPerFile * 1.5;
        const bodyIds = new Set<string>();
        let bodyChars = 0;
        for (const n of syms.filter(n => prio(n) < 99 && n.endLine >= n.startLine).sort((a, b) => prio(a) - prio(b))) {
          const sz = fileLines.slice(n.startLine - 1, n.endLine).join('\n').length;
          if (bodyChars + sz > bodyCap && bodyIds.size > 0) continue;
          bodyIds.add(n.id);
          bodyChars += sz;
        }
        // Pass 2: render in line order — full body for chosen symbols, else the
        // signature line (capped, with a "+N more" tail so the structure map of a
        // god-file doesn't itself bloat the budget).
        const skel: string[] = [];
        let coveredUntil = 0; // skip symbols already inside an emitted body
        let sigCount = 0, sigDropped = 0;
        const SIG_MAX = Math.max(12, budget.maxSymbolsInFileHeader * 2);
        for (const n of syms) {
          if (n.startLine <= coveredUntil) continue;
          if (bodyIds.has(n.id)) {
            const end = n.endLine;
            const body = fileLines.slice(n.startLine - 1, end).join('\n');
            skel.push(exploreLineNumbersEnabled() ? numberSourceLines(body, n.startLine) : body);
            coveredUntil = end;
          } else {
            // Elide the body, emit the signature. node.startLine can point at a
            // decorator/annotation, so scan forward for the line that names the symbol.
            let lineNo = n.startLine;
            for (let k = 0; k < 4; k++) {
              if ((fileLines[n.startLine - 1 + k] || '').includes(n.name)) { lineNo = n.startLine + k; break; }
            }
            if (lineNo <= coveredUntil) continue;
            if (sigCount >= SIG_MAX) { sigDropped++; continue; }
            const sig = (fileLines[lineNo - 1] || '').trim();
            if (sig) { skel.push(exploreLineNumbersEnabled() ? `${lineNo}\t${sig}` : sig); sigCount++; }
          }
        }
        if (sigDropped > 0) skel.push(`… +${sigDropped} more (signatures elided)`);
        if (skel.length > 0) {
          const names = [...new Set(group.nodes.filter(n => n.kind !== 'import' && n.kind !== 'export').map(n => n.name))]
            .slice(0, budget.maxSymbolsInFileHeader).join(', ');
          // Steer the agent to homegraph_explore for an elided body — NEVER to
          // Read. The old "Read for more" / "Read for a full body" tags invited
          // a Read of the very file just skeletonized; on a central, wanted file
          // (Session.swift, DataRequest.swift) that fired an over-investigation
          // spiral (the agent Read the skeletonized file, then kept digging).
          // AGENTS.md: explore output must never tell the agent to Read.
          const tag = bodyIds.size > 0
            ? 'focused (the methods you named in full, the rest as signatures — homegraph_explore a signature by name for its body; do NOT Read)'
            : 'skeleton (signatures only — homegraph_explore a name for its full body; do NOT Read)';
          lines.push(fileSectionHeader(filePath, `${names} · ${tag}`), '', '```' + lang, skel.join('\n'), '```', '');
          totalChars += skel.join('\n').length + 120;
          renderedFilePaths.push(filePath);
          filesIncluded++;
          continue;
        }
      }

      // Whole-file rule: if a relevant file is small enough to afford, return it
      // ENTIRELY instead of clustering. Clustering exists to tame god-files
      // (App.tsx ~13k lines); on a ~134-line component a cluster is a lossy
      // subset of a file the agent will just Read in full anyway — costing a
      // round-trip and a re-read every later turn. Reserve clustering for files
      // too big to ship whole. Still bounded by the total maxOutputChars check.
      //
      // CENTRAL files (where the query's entry points live) get a larger — but
      // bounded — ceiling: they're the heart of the answer, the file(s) the agent
      // would Read whole, so a genuinely small one comes back whole rather than as
      // thin clusters. A LARGE central file (the 791-line org-user store) exceeds
      // the ceiling and falls through to sectioning/clustering below — full method
      // bodies + signatures — so we never dump (or overflow on) a whole god-file.
      const isCentralFile = centralFiles.has(filePath);
      // Central files get a slightly larger whole-file window than peripheral ones,
      // but a TIGHT one (~1.5× the per-file cap): the native read of a central file
      // is a ~150–250 line orientation window, NOT the whole file. A flat "whole
      // central file" both overflowed the inline cap AND starved the co-flow files
      // (worker.rs ate the budget, dropping harness.rs's poll). A larger central
      // file falls through to per-method windowing/clustering below.
      const WHOLE_FILE_MAX_LINES = isCentralFile ? 280 : 220;
      const WHOLE_FILE_MAX_CHARS = isCentralFile
        ? Math.min(Math.max(0, budget.maxOutputChars - totalChars - 200), Math.round(budget.maxCharsPerFile * 1.5))
        : budget.maxCharsPerFile * 3;
      if (fileLines.length <= WHOLE_FILE_MAX_LINES && fileContent.length <= WHOLE_FILE_MAX_CHARS) {
        const body = fileContent.replace(/\n+$/, '');
        let wholeSection = exploreLineNumbersEnabled() ? numberSourceLines(body, 1) : body;
        const uniqSymbols = [...new Set(
          group.nodes
            .filter(n => n.kind !== 'import' && n.kind !== 'export')
            .map(n => `${n.name}(${n.kind})`)
        )];
        const headerNames = uniqSymbols.slice(0, budget.maxSymbolsInFileHeader);
        const omitted = uniqSymbols.length - headerNames.length;
        const wholeHeader = fileSectionHeader(filePath, omitted > 0 ? `${headerNames.join(', ')}, +${omitted} more` : headerNames.join(', '));

        if (!fileNecessary && totalChars + wholeSection.length + 200 > budget.maxOutputChars) {
          // Don't slice a whole file mid-method: an incidental file that doesn't
          // fit is skipped; a necessary one (below) renders in full. Half a file
          // forces the Read this is meant to prevent.
          anyFileTrimmed = true;
          continue;
        }
        lines.push(wholeHeader, '', '```' + lang, wholeSection, '```', '');
        totalChars += wholeSection.length + 200;
        renderedFilePaths.push(filePath);
        filesIncluded++;
        continue;
      }

      // Cluster nearby symbols to avoid reading huge gaps between distant symbols.
      // Sort by start line, then merge overlapping/adjacent ranges (within the
      // adaptive gap threshold). Include both node ranges AND edge source
      // locations so template sections with component usages/calls are
      // covered (not just script block symbols).
      //
      // Each range carries an `importance` score so we can rank clusters
      // when the per-file budget forces us to drop some: entry-point nodes
      // are worth 10, directly-connected nodes 3, peripheral nodes 1, and
      // bare edge-source lines 2 (less than a connected node but more than
      // a peripheral one — they hint at a reference but aren't a definition).
      // Container kinds whose body can span most/all of a file. When such a
      // node covers most of the file we drop it from the ranges: keeping it
      // would merge every method inside it into one giant cluster spanning
      // the whole file, which then tail-trims down to just the container's
      // opening lines (its header/declarations) and buries the methods the
      // query actually asked about (#185 follow-up — Session.swift in
      // Alamofire is the canonical case: the `Session` class spans ~1,400
      // lines). We want the granular symbols inside, not the envelope.
      const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
      // Cluster from this file's gathered nodes PLUS any callable the agent NAMED that
      // lives here. Explore's relevance gather can miss a named method def in a huge
      // non-sibling file — Django's query.py is 3,040 lines and `_fetch_all` (L2237)
      // was gathered only as call-reference edges, never as a def, so it formed no
      // cluster and the agent Read it back. Inject named defs directly and rank them
      // ABOVE connected/glue nodes (importance 9) so their cluster wins the per-file
      // budget — the agent explicitly asked for these symbols.
      const rangeNodes = new Map<string, Node>();
      for (const n of group.nodes) if (n.startLine > 0 && n.endLine > 0) rangeNodes.set(n.id, n);
      for (const id of flow.namedNodeIds) {
        if (rangeNodes.has(id)) continue;
        const n = cg.getNode(id);
        if (n && n.filePath === filePath && n.startLine > 0 && n.endLine > 0) rangeNodes.set(id, n);
      }
      const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number; spine: boolean; spineCallLine?: number }> = [...rangeNodes.values()]
        // Drop whole-file envelope nodes (containers covering >50% of the file).
        .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5))
        .map(n => {
          let importance = 1;
          if (entryNodeIds.has(n.id)) importance = 10;
          else if (flow.namedNodeIds.has(n.id)) importance = 9; // agent named it → keep its cluster
          else if (glueNodeIds.has(n.id)) importance = 6; // bridging caller/callee of an entry
          else if (connectedToEntry.has(n.id)) importance = 3;
          // On the rendered call-path spine? That IS the flow answer — its cluster
          // must never be dropped by the per-file budget (n8n's huge workflow-execute.ts:
          // processRunExecutionData, the named flow ENTRY at L1562, is a large
          // low-density method that lost the budget to denser blocks and got cut, so
          // the agent Read it back — the very thing explore exists to prevent).
          return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance, spine: flow.pathNodeIds.has(n.id), spineCallLine: flow.spineCallSites.get(n.id) };
        });

      // Add edge source locations in this file — captures template references
      // (component usages, event handlers) that aren't nodes themselves.
      // Query edges directly from the DB (not just the subgraph) because BFS
      // traversal may have pruned template reference targets due to node budget.
      const edgeLines = new Set<string>(); // dedup by "line:name"
      for (const node of group.nodes) {
        const outgoing = cg.getOutgoingEdges(node.id);
        for (const edge of outgoing) {
          if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
          const key = `${edge.line}:${edge.target}`;
          if (edgeLines.has(key)) continue;
          edgeLines.add(key);
          // Look up target name from subgraph first, fall back to edge kind
          const targetNode = subgraph.nodes.get(edge.target);
          const targetName = targetNode?.name ?? edge.kind;
          ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2, spine: false });
        }
      }

      // Query member-access anchors: pin lines the question names (locationManager.on,
      // .drawModifier) so per-file budget gaps don't hide the exact call site.
      if (queryMemberAccesses.length > 0) {
        const anchorLines = new Set<number>();
        for (const ma of queryMemberAccesses) {
          const patterns: RegExp[] = [];
          if (ma.receiver) {
            const recv = ma.receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const mem = ma.member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            patterns.push(new RegExp(`${recv}\\.${mem}\\s*\\(`));
            patterns.push(new RegExp(`${recv}\\.${mem}\\b`));
          } else if (ma.dotted.startsWith('.')) {
            const lit = ma.dotted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            patterns.push(new RegExp(`${lit}\\b`));
          }
          for (let i = 0; i < fileLines.length; i++) {
            const line = fileLines[i] ?? '';
            if (patterns.some((p) => p.test(line))) anchorLines.add(i + 1);
          }
        }
        for (const lineNo of anchorLines) {
          ranges.push({
            start: lineNo,
            end: lineNo,
            name: 'query-anchor',
            kind: 'anchor',
            importance: 11,
            spine: false,
          });
        }
      }

      ranges.sort((a, b) => a.start - b.start);

      if (ranges.length === 0) continue;

      const gapThreshold = budget.gapThreshold;
      const clusters: Array<{ start: number; end: number; symbols: string[]; score: number; maxImportance: number; hasSpine: boolean; spineCallLine?: number }> = [];
      let current = {
        start: ranges[0]!.start,
        end: ranges[0]!.end,
        symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
        score: ranges[0]!.importance,
        maxImportance: ranges[0]!.importance,
        hasSpine: ranges[0]!.spine,
        spineCallLine: ranges[0]!.spineCallLine,
      };

      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.start <= current.end + gapThreshold) {
          current.end = Math.max(current.end, r.end);
          current.symbols.push(`${r.name}(${r.kind})`);
          current.score += r.importance;
          current.maxImportance = Math.max(current.maxImportance, r.importance);
          current.hasSpine = current.hasSpine || r.spine;
          current.spineCallLine = current.spineCallLine ?? r.spineCallLine;
        } else {
          clusters.push(current);
          current = {
            start: r.start,
            end: r.end,
            symbols: [`${r.name}(${r.kind})`],
            score: r.importance,
            maxImportance: r.importance,
            hasSpine: r.spine,
            spineCallLine: r.spineCallLine,
          };
        }
      }
      clusters.push(current);

      // Build file section output from clusters, capped by per-file budget.
      // The pathological case (#185): a file like Session.swift where every
      // method is adjacent collapses into one cluster spanning the whole
      // file, and dumping that into the agent's context is most of the
      // token cost on small projects. We pick clusters in priority order
      // until the per-file char cap is hit. Truly enormous single clusters
      // get tail-trimmed with a marker.
      const contextPadding = 3;
      const withLineNumbers = exploreLineNumbersEnabled();
      // Language-neutral separator (no `//` — not a comment in Python, Ruby,
      // etc.). With line numbers on, the line-number jump also signals the gap.
      const GAP_MARKER = '\n\n... (gap) ...\n\n';
      // An oversize spine method (the call path runs THROUGH a god-method — n8n's
      // processRunExecutionData is 962 lines) is windowed to its next-hop CALL site
      // plus the signature head, NOT dumped whole. Without this the cluster is too big
      // for any per-file cap and gets dropped, so the agent Reads the method back —
      // the exact gap this closes. Bounded, so a god-method can't blow the budget yet
      // the spine's call still appears in context.
      const OVERSIZE_SPINE_LINES = 200;
      const SPINE_WINDOW = 28; // lines each side of the next-hop call site
      const buildSection = (c: { start: number; end: number; hasSpine?: boolean; spineCallLine?: number }): string => {
        if (c.hasSpine && c.spineCallLine && (c.end - c.start + 1) > OVERSIZE_SPINE_LINES) {
          const call = c.spineCallLine;
          const winStart = Math.max(c.start, call - SPINE_WINDOW);
          const winEnd = Math.min(c.end, call + SPINE_WINDOW);
          const parts: string[] = [];
          // Signature head, only when it sits clearly above the window (else the
          // window already covers the method opening).
          const headEnd = Math.min(c.start + 4, winStart - 2);
          if (headEnd >= c.start) {
            const head = fileLines.slice(c.start - 1, headEnd).join('\n');
            parts.push(withLineNumbers ? numberSourceLines(head, c.start) : head);
          }
          const win = fileLines.slice(winStart - 1, winEnd).join('\n');
          parts.push(withLineNumbers ? numberSourceLines(win, winStart) : win);
          return parts.join(GAP_MARKER);
        }
        const startIdx = Math.max(0, c.start - 1 - contextPadding);
        const endIdx = Math.min(fileLines.length, c.end + contextPadding);
        const slice = fileLines.slice(startIdx, endIdx).join('\n');
        // startIdx is 0-based, so the slice's first line is line startIdx + 1.
        return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
      };

      // Rank clusters for inclusion under the per-file cap. Entry-point
      // clusters come first: a cluster containing a query entry point
      // (importance 10) must outrank a dense block of mere declarations,
      // otherwise on a large file like Session.swift the top-of-file class
      // header + property list (many adjacent low-importance nodes, high
      // density) wins the budget and buries the actual methods the query
      // asked about (perform/didCreateURLRequest/task live deep in the
      // file). Within the same importance tier, prefer density (score per
      // line) so we still favor focused clusters over sprawling ones, then
      // smaller span as a cheap-to-include tiebreak.
      const rankedClusters = clusters
        .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
        .sort((a, b) => {
          // Spine clusters first — the rendered call path IS the flow answer, so it
          // outranks any denser block of peripheral declarations (a low-density entry
          // method must not lose the budget to them). Within spine / within non-spine,
          // the existing importance → density → score → span order holds.
          if (a.c.hasSpine !== b.c.hasSpine) return (b.c.hasSpine ? 1 : 0) - (a.c.hasSpine ? 1 : 0);
          if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
          const densityA = a.c.score / a.span;
          const densityB = b.c.score / b.span;
          if (densityB !== densityA) return densityB - densityA;
          if (b.c.score !== a.c.score) return b.c.score - a.c.score;
          return a.span - b.span;
        });

      // Per-file budget is the SMALLER of the per-file cap and what's left of the
      // total output cap — so selection (which ranks by importance) keeps the
      // high-importance clusters and drops peripheral ones, instead of the
      // downstream source-order trim slicing off whatever comes last in the file.
      // That source-order slice is what cut Django's `_fetch_all` (L2237, importance
      // 9 — agent-named) when query.py was the last of four big files to be emitted.
      const fileBudget = Math.min(budget.maxCharsPerFile, Math.max(0, budget.maxOutputChars - totalChars - 200));
      // Spine ceiling: a flow-path cluster may exceed the per-file cap (the call
      // path is the answer), but bounded — at most ~2.5× the per-file cap and never
      // past what's left of the total output cap — so a pathological long in-file
      // spine can't run away or starve co-flow files entirely.
      const SPINE_CEILING = Math.min(budget.maxCharsPerFile * 2.5, Math.max(0, budget.maxOutputChars - totalChars - 200));
      const chosenIndices = new Set<number>();
      let projectedChars = 0;
      for (const rc of rankedClusters) {
        const sectionLen = buildSection(rc.c).length + (chosenIndices.size > 0 ? GAP_MARKER.length : 0);
        // Always take the top-ranked cluster, even if oversize, so we don't
        // return an empty file section (agent would then re-Read the file,
        // negating the savings).
        if (chosenIndices.size === 0) {
          chosenIndices.add(rc.idx);
          projectedChars += sectionLen;
          continue;
        }
        // A spine cluster (the rendered call path) is the flow answer — include it
        // past the per-file budget up to the spine ceiling; non-spine clusters obey
        // the normal per-file budget.
        const fits = projectedChars + sectionLen <= fileBudget;
        const spineFits = rc.c.hasSpine && projectedChars + sectionLen <= SPINE_CEILING;
        if (!fits && !spineFits) continue;
        chosenIndices.add(rc.idx);
        projectedChars += sectionLen;
      }

      // Emit chosen clusters in source order so the file reads top-to-bottom.
      let fileSection = '';
      const allSymbols: string[] = [];
      for (let i = 0; i < clusters.length; i++) {
        if (!chosenIndices.has(i)) continue;
        const cluster = clusters[i]!;
        const section = buildSection(cluster);
        if (fileSection.length > 0) fileSection += GAP_MARKER;
        fileSection += section;
        allSymbols.push(...cluster.symbols);
      }

      // A chosen cluster is a COMPLETE method-range — we never cut through a body.
      // An oversize single cluster (a long monolithic function) renders in FULL:
      // half a method is useless (the agent just Reads the rest for the other half),
      // which is the very fallback explore exists to prevent. A pathological file is
      // bounded by the per-file cluster SELECTION above + the total hard ceiling.
      if (chosenIndices.size < clusters.length) {
        anyFileTrimmed = true;
      }

      // Dedupe + cap the symbols list shown in the per-file header. Some
      // files (Session.swift in Alamofire) produced 3.4KB symbol lists
      // from cluster scoring + edge-source lines, dwarfing the per-file
      // body cap. Show top names by frequency, with a "+N more" tail.
      const symbolCounts = new Map<string, number>();
      for (const s of allSymbols) {
        symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
      }
      const sortedSymbols = [...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
      const headerCap = budget.maxSymbolsInFileHeader;
      const headerSymbols = sortedSymbols.slice(0, headerCap);
      const omittedCount = sortedSymbols.length - headerSymbols.length;
      const headerSuffix = omittedCount > 0
        ? `${headerSymbols.join(', ')}, +${omittedCount} more`
        : headerSymbols.join(', ');
      const fileHeader = fileSectionHeader(filePath, headerSuffix);

      // The total cap bounds INCIDENTAL files only. A file that DEFINES a symbol
      // the agent named (or that's on the flow spine) renders even when the
      // nominal total is used up — it's the answer, and the set is bounded by
      // maxFiles AND by true-spine/named-seeding having already trimmed each file
      // to its necessary content. A file that merely REFERENCES the flow
      // (Combine.swift name-drops request/task) is incidental → still capped, so
      // freed budget never leaks into noise. This is the last god-file layer:
      // build (Session, true-spined) + validators-exec (Request) + validate
      // (DataRequest/Validation) all render, instead of the cap dropping whichever
      // phase the file order happened to put last.
      if (!fileNecessary && totalChars + fileSection.length + 200 > budget.maxOutputChars) {
        // Incidental file that doesn't fit: SKIP it whole — never slice mid-method.
        // Keep scanning for necessary files (which bypass this cap and render in
        // full, bounded by the hard ceiling).
        anyFileTrimmed = true;
        continue;
      }

      lines.push(fileHeader);
      lines.push('');
      lines.push('```' + lang);
      lines.push(fileSection);
      lines.push('```');
      lines.push('');

      totalChars += fileSection.length + 200;
      renderedFilePaths.push(filePath);
      filesIncluded++;
    }

    // The curated header count is computed from the files that SURVIVE the final
    // truncation (see end of method) — `filesIncluded` can over-count when the
    // hard ceiling drops trailing sections — so leave a sentinel here and fill it
    // in once the output is final.
    lines[summaryLineIdx] = SUMMARY_SENTINEL;

    // Add remaining files as references (from both relevant and peripheral files).
    // Small projects (per budget) skip this — the relevant story already fits
    // in the source section, and a trailing pointer list is pure overhead.
    if (budget.includeAdditionalFiles) {
      const remainingRelevant = sortedFiles.slice(filesIncluded);
      const peripheralFiles = [...fileGroups.entries()]
        .filter(([, group]) => group.score < 3)
        .sort((a, b) => b[1].score - a[1].score);
      const remainingFiles = [...remainingRelevant, ...peripheralFiles];
      if (remainingFiles.length > 0) {
        lines.push('**Not shown above — explore these names for their source**');
        lines.push('');
        for (const [filePath, group] of remainingFiles.slice(0, 10)) {
          const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
          lines.push(`- ${filePath}: ${symbols}`);
        }
        if (remainingFiles.length > 10) {
          lines.push(`- ... and ${remainingFiles.length - 10} more files`);
        }
      }
    }

    // Add completeness signal so agents know they don't need to re-read these files.
    // On small projects the budget gates this off — but if we actually had to
    // trim or drop clusters, surface a brief note so the agent knows it can
    // still Read for more detail.
    if (budget.includeCompletenessSignal) {
      lines.push('');
      lines.push('---');
      lines.push(`> **Complete source for ${filesIncluded} files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER homegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can't surface.`);
    } else if (anyFileTrimmed) {
      lines.push('');
      lines.push(`> Some file sections were trimmed for size. For a specific symbol you still need, run another \`homegraph_explore\` (or \`homegraph_node\`) with its exact name — line-numbered source, cheaper and more complete than Read.`);
    }

    // Add explore budget note based on project size
    if (budget.includeBudgetNote) {
      try {
        const stats = cg.getStats();
        const callBudget = getExploreBudget(stats.fileCount);
        lines.push('');
        lines.push(
          `> **Usually one explore is enough** (budget ≤${callBudget} for ${stats.fileCount.toLocaleString()} files). ` +
          'Answer from Flow + Source above. Extra explore/`homegraph_node`/Read for the **same** symbols multiplies tokens — ' +
          'only call again for a missing **named** symbol.',
        );
      } catch {
        // Stats unavailable — skip budget note
      }
    }

    // Final ceiling — an ABSOLUTE inline cap, not a multiple of the budget. The
    // render loop renders necessary (named/spine) files even a bit past
    // maxOutputChars and caps only incidental ones, so this is the last safety.
    // It MUST stay under the host's inline tool-result limit (~25K chars): above
    // that the result is externalized to a file the agent Reads back (a 35K
    // vscode explore did exactly this in the n=4 A/B). So allow a little
    // necessary overflow above the 24K budget, but hard-stop at 25K — never into
    // externalize territory.
    const output = flow.text + lines.join('\n');

    const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), 25000);
    let finalText: string;
    if (output.length > hardCeiling) {
      // Cut at a FILE-SECTION boundary (the last ``**` `` file header before the
      // ceiling) so we drop whole trailing file-sections rather than slicing
      // through a method body — a half-rendered method just forces the Read this
      // tool exists to prevent. Fall back to a line boundary only if no section
      // header sits in the back half (degenerate single-giant-section case).
      const cut = output.slice(0, hardCeiling);
      const lastSection = cut.lastIndexOf('\n' + FILE_SECTION_PREFIX);
      const boundary = lastSection > hardCeiling * 0.5 ? lastSection : cut.lastIndexOf('\n');
      const safe = boundary > 0 ? cut.slice(0, boundary) : cut;
      finalText = safe + '\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For uncovered files/symbols, run another homegraph_explore with their exact names — not grep/read/node for symbols already shown.)';
    } else {
      finalText = output;
    }
    if (!finalText.includes('**Partial result**') && !finalText.includes('> **Explore complete**')) {
      finalText +=
        '\n\n> **Explore complete — ANSWER NOW.** Flow + Source above are authoritative for this query. ' +
        'Do **not** grep/read/`homegraph_node`/`homegraph_search` for the same symbols or files (multiplies tokens). ' +
        'Only call one tighter `homegraph_explore` if a named symbol essential to the answer is missing.';
    }

    // Curated header (#1046): substitute the sentinel with the count of files
    // whose source SURVIVES in the final text — not `subgraph`/`fileGroups` (the
    // raw gather a broad query inflates) and not `filesIncluded` (which can
    // over-count when the ceiling above drops trailing sections). A file counts
    // only if its section header is still present; its relevant (non-import)
    // symbols are summed for N. Files we couldn't fit are still named under "Not
    // shown above" + the budget note, so nothing is silently dropped.
    const survivors = renderedFilePaths.filter((fp) =>
      finalText.includes(`${FILE_SECTION_PREFIX}${fp}\``));
    const shownSymbols = survivors.reduce((sum, fp) => {
      const g = fileGroups.get(fp);
      if (!g) return sum;
      return sum + new Set(
        g.nodes.filter((n) => n.kind !== 'import' && n.kind !== 'export').map((n) => n.id),
      ).size;
    }, 0);
    const summaryLine = survivors.length > 0
      ? `Found ${shownSymbols} symbol${shownSymbols === 1 ? '' : 's'} across ${survivors.length} file${survivors.length === 1 ? '' : 's'}.`
      : `Found ${subgraph.nodes.size} symbol${subgraph.nodes.size === 1 ? '' : 's'} across ${fileGroups.size} file${fileGroups.size === 1 ? '' : 's'}.`;
    finalText = finalText.replace(SUMMARY_SENTINEL, summaryLine);

    return this.textResult(finalText);
  }

  /**
   * Handle homegraph_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getHomeGraph(args.projectPath as string | undefined);
    // Default to false to minimize context usage
    const includeCode = args.includeCode === true;
    const fileHint = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : undefined;
    const lineHint = typeof args.line === 'number' && args.line > 0 ? args.line : undefined;
    const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : undefined;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
    const symbolsOnly = args.symbolsOnly === true;
    const symbolRaw = typeof args.symbol === 'string' ? args.symbol.trim() : '';

    // FILE READ MODE: a `file` with no `symbol` reads that file like the Read
    // tool — its current on-disk source with line numbers, narrowable with
    // `offset`/`limit` exactly as Read does — PLUS a one-line blast-radius
    // header (which files depend on it). `symbolsOnly` returns just the
    // structural map instead. Backed by the index: same bytes Read gives you.
    if (!symbolRaw && fileHint) {
      return this.handleFileView(cg, fileHint, { offset, limit, symbolsOnly });
    }

    if (!symbolRaw && !fileHint) {
      return this.badArgResult(
        '`homegraph_node` needs either `symbol` (symbol mode) or `file` alone (file mode). Both were missing.',
        'symbol',
        {
          symbol: 'authenticate',
          includeCode: true,
        },
      );
    }

    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    let matches = this.findSymbolMatches(cg, symbol);
    if (matches.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Disambiguate a heavily-overloaded name to a specific definition the caller
    // pinned by file/line (the `file:line` a trail or another tool showed it) —
    // so it can fetch e.g. `Harness::poll` at harness.rs:153 out of 50+ `poll`s
    // instead of Reading. file matches by path suffix/substring; line prefers the
    // def whose body contains it, else the nearest start. Only narrows (never
    // empties — if a hint matches nothing it's ignored).
    if (matches.length > 1 && (fileHint || lineHint !== undefined)) {
      const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      let narrowed = matches;
      if (fileHint) {
        const fh = norm(fileHint);
        const byFile = narrowed.filter((n) => norm(n.filePath).endsWith(fh) || norm(n.filePath).includes(fh));
        if (byFile.length > 0) narrowed = byFile;
      }
      if (lineHint !== undefined && narrowed.length > 1) {
        const containing = narrowed.filter((n) => n.startLine <= lineHint && (n.endLine ?? n.startLine) >= lineHint);
        narrowed = containing.length > 0
          ? containing
          : [...narrowed].sort((a, b) => Math.abs(a.startLine - lineHint) - Math.abs(b.startLine - lineHint)).slice(0, 1);
      }
      if (narrowed.length > 0) matches = narrowed;
    }

    // Single definition — the common case.
    if (matches.length === 1) {
      return this.textResult(this.truncateOutput(await this.renderNodeSection(cg, matches[0]!, includeCode)));
    }

    // Multiple definitions share this name — overloads, or same-named methods on
    // different types (Alamofire `didCompleteTask`/`task`/`validate`, gin
    // `reset`). Returning ONE forces the agent to guess, and when it guesses
    // wrong it READS the file to find the right overload — the dominant
    // homegraph_node read cause on Swift/Go. So return them ALL: pack as many
    // FULL bodies as fit a char budget (the agent gets the one it needs in this
    // one call, no follow-up parameter to learn), and list any remainder by
    // file:line so a large overload set can't overflow the per-tool cap.
    const header = `**${matches.length} definitions named "${symbol}"**`;
    if (!includeCode) {
      const list = matches.map((n) => `- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`);
      return this.textResult(this.truncateOutput(
        [header, '', 'Re-query with `includeCode: true` to get every body in one call — no need to pick one first.', '', ...list].join('\n'),
      ));
    }

    const BODY_BUDGET = 10_000; // leaves room under MAX_OUTPUT_LENGTH for the header + list
    // The CHAR budget is the real limiter — keep the count cap high so a set of
    // SHORT overloads (Alamofire's 10 `validate` variants, each a few lines) all
    // render in full rather than relegating the one the agent wanted to a
    // bodiless list. Only a set of many LARGE bodies hits the char budget first.
    const HARD_CAP = 12;
    const rendered: string[] = [];
    const listed: Node[] = [];
    let used = 0;
    for (const n of matches) {
      if (rendered.length >= HARD_CAP) { listed.push(n); continue; }
      const section = await this.renderNodeSection(cg, n, true);
      // Always emit the first; emit the rest only while within the char budget.
      if (rendered.length === 0 || used + section.length <= BODY_BUDGET) {
        rendered.push(section);
        used += section.length;
      } else {
        listed.push(n);
      }
    }

    const out: string[] = [
      header,
      `Returning ${rendered.length} in full${listed.length ? `; ${listed.length} more listed below` : ''} — pick the one you need (no Read required).`,
      '',
      rendered.join('\n\n---\n\n'),
    ];
    if (listed.length) {
      const LIST_CAP = 20;
      const shownList = listed.slice(0, LIST_CAP);
      out.push(
        '',
        '**Other definitions**',
        ...shownList.map((n) => `- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`),
      );
      if (listed.length > LIST_CAP) out.push(`- … +${listed.length - LIST_CAP} more`);
      out.push(
        '',
        `> Need one of these in full? Call homegraph_node again with \`file\` (e.g. \`"${listed[0]!.filePath.split('/').pop()}"\`) or \`line\` — do NOT Read it.`,
      );
    }
    return this.textResult(this.truncateOutput(out.join('\n')));
  }

  /**
   * FILE READ MODE: resolve `fileArg` (path or basename) to an indexed file and
   * read it like the Read tool — its current on-disk source with line numbers,
   * narrowable with `offset`/`limit` exactly as Read's are — preceded by a
   * one-line blast-radius header (which files depend on it). `symbolsOnly`
   * returns just the structural map (symbols + dependents) instead of source.
   *
   * Parity goal: the numbered source block is byte-for-byte the shape Read
   * returns (`<n>\t<line>`, no padding), so the agent treats it as a Read — only
   * faster (served from the index) and with the blast radius attached. Security:
   * yaml/properties files are summarized by key, never dumped (#383); reads go
   * through validatePathWithinRoot (#527).
   */
  private async handleFileView(
    cg: HomeGraph,
    fileArg: string,
    opts: { offset?: number; limit?: number; symbolsOnly?: boolean } = {},
  ): Promise<ToolResult> {
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^(?:\.?\/+)+/, '').replace(/\/+$/, '');
    const wantLower = normalize(fileArg).toLowerCase();
    const allFiles = cg.getFiles();
    if (allFiles.length === 0) return this.textResult('No files indexed. Run `homegraph index` first.');

    let resolved = allFiles.find((f) => f.path.toLowerCase() === wantLower);
    let candidates: typeof allFiles = [];
    if (!resolved) {
      candidates = allFiles.filter((f) => f.path.toLowerCase().endsWith('/' + wantLower));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length === 0) {
      candidates = allFiles.filter((f) => f.path.toLowerCase().includes(wantLower));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length > 1) {
      return this.textResult(
        [`"${fileArg}" matches ${candidates.length} indexed files — pass a longer path:`, '',
          ...candidates.slice(0, 25).map((f) => `- ${f.path}`)].join('\n'),
      );
    }
    if (!resolved) {
      return this.textResult(
        `No indexed file matches "${fileArg}". Codegraph indexes source files; configs/docs it doesn't parse won't appear — Read those directly.`,
      );
    }

    const filePath = resolved.path;
    const nodes = cg.getNodesInFile(filePath)
      .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
      .sort((a, b) => a.startLine - b.startLine);
    const dependents = cg.getFileDependents(filePath);

    // Compact, one-line blast radius (homegraph's value-add over a plain Read).
    const depSummary = dependents.length
      ? `used by ${dependents.length} file${dependents.length === 1 ? '' : 's'}: ${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? `, +${dependents.length - 8} more` : ''}`
      : 'no other indexed file depends on it';

    // Symbol-map renderer — for symbolsOnly, the config fallback, and read errors.
    const symbolMap = (heading: string, limit = 200): string[] => {
      const lines: string[] = [heading];
      for (const n of nodes.slice(0, limit)) {
        const sig = n.signature ? ` ${formatInlineSignature(n.signature)}` : '';
        lines.push(`- \`${n.name}\` (${n.kind})${sig} — :${n.startLine}`);
      }
      if (nodes.length > limit) lines.push(`- … +${nodes.length - limit} more`);
      return lines;
    };

    // symbolsOnly → the cheap structural overview, no source.
    if (opts.symbolsOnly) {
      const out = [`**${filePath}** — ${nodes.length} symbol${nodes.length === 1 ? '' : 's'}, ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('**Symbols**'));
      else out.push('_No indexed symbols in this file._');
      out.push('', '> Drop `symbolsOnly` (or pass `offset`/`limit`) to read the source, like Read.');
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // SECURITY (#383): never dump a raw config/data file — a yaml/properties
    // line is `key: <secret>`. Summarize by key and point to a real Read.
    if (CONFIG_LEAF_LANGUAGES.has(resolved.language)) {
      const out = [`**${filePath}** — configuration/data file, ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('**Keys (values withheld for safety)**'));
      out.push('', '> Values may be secrets, so homegraph indexes keys only. Read the file directly if you need a value.');
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // Read the current bytes from disk through the security chokepoint
    // (validatePathWithinRoot: blocks `../` traversal and symlink escapes, #527).
    const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
    let content: string | null = null;
    if (abs) {
      try { content = readFileSync(abs, 'utf-8'); } catch { content = null; }
    }
    if (content === null) {
      const out = [`**${filePath}** — could not read from disk (it may have moved since indexing). ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('**Symbols**'));
      out.push('', `> Read \`${filePath}\` directly for its current content.`);
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // Split exactly as Read does — keep the trailing empty line a final newline
    // produces (Read numbers it too), so line numbers line up byte-for-byte.
    const fileLines = content.split('\n');
    const total = fileLines.length;

    // Read-parity windowing: `offset`/`limit` mean exactly what they do on Read
    // (1-based start line; max line count). Default window is intentionally
    // smaller than explore's flow budget — dumping a whole multi-kLOC file from
    // `homegraph_node` teaches the agent to over-drill and burns tokens.
    // Overflow is stated explicitly (pass offset/limit or name a symbol).
    const CHAR_BUDGET = 12_000;
    const DEFAULT_LIMIT = 400;
    const offset = Math.max(1, opts.offset ?? 1);
    if (offset > total) {
      return this.textResult(`**${filePath}** has ${total} line${total === 1 ? '' : 's'} — offset ${offset} is past the end. ${depSummary}`);
    }
    const maxLines = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const start = offset - 1; // 0-based
    const header = `**${filePath}** — ${total} lines, ${nodes.length} symbol${nodes.length === 1 ? '' : 's'} · ${depSummary}`;

    // Numbered lines, byte-for-byte Read's shape: `<n>\t<line>`, no left-pad.
    const numbered: string[] = [];
    let used = header.length + 8;
    let i = start;
    for (; i < total && numbered.length < maxLines; i++) {
      const ln = `${i + 1}\t${fileLines[i]}`;
      if (used + ln.length + 1 > CHAR_BUDGET && numbered.length > 0) break;
      numbered.push(ln);
      used += ln.length + 1;
    }
    const shownEnd = start + numbered.length;
    const complete = offset === 1 && shownEnd >= total;

    const out: string[] = [header, '', ...numbered];
    if (!complete) {
      out.push(
        '',
        `(lines ${offset}–${shownEnd} of ${total} — pass \`offset\`/\`limit\` for another range, or \`homegraph_node\` with a symbol name for one body in full)`,
      );
    }
    out.push(
      '',
      '> Treat this source as already Read. Prefer answering now; do not grep/read the same file or fan out more `homegraph_node` calls for symbols listed above.',
    );
    // Self-bounded to CHAR_BUDGET — do NOT route through truncateOutput (15k).
    return this.textResult(out.join('\n'));
  }

  /** Render one symbol: details + (optional) body/outline + its caller/callee trail. */
  private async renderNodeSection(cg: HomeGraph, node: Node, includeCode: boolean): Promise<string> {
    let code: string | null = null;
    let outline: string | null = null;
    if (includeCode) {
      // For container symbols (class/interface/struct/…), the full body is the
      // sum of every method body — a wall of source. Return a structural outline
      // (members + signatures + line numbers) instead; leaf symbols return their
      // full body.
      if (CONTAINER_NODE_KINDS.has(node.kind)) {
        outline = this.buildContainerOutline(cg, node);
      }
      if (!outline) {
        code = await cg.getCode(node.id);
      }
    }
    return this.formatNodeDetails(node, code, outline) + this.formatTrail(cg, node);
  }

  /**
   * Build the "trail" for a symbol: its direct callees (what it calls) and
   * callers (what calls it), each with file:line — so homegraph_node doubles as
   * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
   * Capped to stay cheap. Walk the graph by calling homegraph_node on a trail
   * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
   * dynamic dispatch the static graph couldn't resolve — that absence is itself
   * a signal (read that one hop) rather than a dead end.
   */
  private formatTrail(cg: HomeGraph, node: Node): string {
    const TRAIL_CAP = 12;
    const fmt = (e: { node: Node; edge: Edge }) => {
      const base = `${e.node.name} (${e.node.filePath}:${e.node.startLine})`;
      const synth = this.synthEdgeNote(e.edge);
      return synth ? `${base} [${synth.compact}]` : base;
    };
    const collect = (edges: Array<{ node: Node; edge: Edge }>): Array<{ node: Node; edge: Edge }> => {
      const seen = new Set<string>([node.id]);
      const out: Array<{ node: Node; edge: Edge }> = [];
      for (const e of edges) {
        if (seen.has(e.node.id)) continue;
        seen.add(e.node.id);
        out.push(e);
      }
      return out;
    };
    const callees = collect(cg.getCallees(node.id));
    const callers = collect(cg.getCallers(node.id));
    if (callees.length === 0 && callers.length === 0) return '';
    const lines: string[] = ['', '**Trail — homegraph_node any of these to follow it (no Read needed)**'];
    if (callees.length > 0) {
      lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
    }
    if (callers.length > 0) {
      lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
    }
    return lines.join('\n');
  }

  /**
   * Handle homegraph_status
   */
  private async handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
    let cg = this.getHomeGraph(args.projectPath as string | undefined);
    // Same trick as withStalenessNotice — when an explicit projectPath
    // resolves to the same project as the default session cg, prefer the
    // default so getPendingFiles() (only populated by the default's watcher)
    // is non-empty when there are pending edits.
    if (this.cg && cg !== this.cg) {
      try {
        if (resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot())) {
          cg = this.cg;
        }
      } catch { /* closed instance — leave as is */ }
    }
    const stats = cg.getStats();

    // Warn when this index actually belongs to a different git working tree
    // (e.g. the server resolved up from a nested worktree to the main checkout).
    // Queries then reflect that tree's branch, not the worktree being edited.
    // status shows the verbose, multi-line form; the read tools get the compact
    // one-liner via withWorktreeNotice. Both share the cached detection.
    const mismatch = this.worktreeMismatchFor(args.projectPath as string | undefined);

    const lines: string[] = [
      '**HomeGraph Status**',
      '',
    ];
    if (mismatch) {
      lines.push(`> ⚠ ${worktreeMismatchWarning(mismatch).replace(/\n/g, '\n> ')}`, '');
    }
    lines.push(
      `**Files indexed:** ${stats.fileCount}`,
      `**Total nodes:** ${stats.nodeCount}`,
      `**Total edges:** ${stats.edgeCount}`,
      `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
    );

    // Surface the active SQLite backend: node:sqlite → better-sqlite3 → wasm.
    const backend = cg.getBackend();
    if (backend === 'node-sqlite') {
      lines.push(`**Backend:** node-sqlite (built-in)`);
    } else if (backend === 'native') {
      lines.push(`**Backend:** native (better-sqlite3)`);
    } else {
      lines.push(
        `**Backend:** ⚠ wasm (no WAL backend available) — ` +
        `5-10x slower than WAL. Fix: ${WASM_FALLBACK_FIX_RECIPE}`
      );
    }

    // Effective journal mode. 'wal' ⇒ concurrent reads never block on a writer;
    // anything else ⇒ they can ("database is locked"). node:sqlite / native
    // support WAL; wasm remaps to DELETE.
    const journalMode = cg.getJournalMode();
    if (journalMode === 'wal') {
      lines.push(`**Journal mode:** wal (concurrent reads safe)`);
    } else {
      lines.push(
        `**Journal mode:** ⚠ ${journalMode || 'unknown'} — WAL not active, so reads ` +
        `can block on a concurrent write`
      );
    }

    lines.push('', '**Nodes by Kind:**');

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if ((count as number) > 0) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    lines.push('', '**Languages:**');
    for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
      if ((count as number) > 0) {
        lines.push(`- ${lang}: ${count}`);
      }
    }

    // Whole-index degradation (#876): when live watching has permanently
    // stopped, getPendingFiles() is empty (so no "Pending sync" section below)
    // but the index is frozen — call that out explicitly here, the one place an
    // agent asks "is the index caught up?".
    if (cg.isWatcherDegraded()) {
      lines.push(
        '',
        '**Auto-sync disabled:**',
        `- ${cg.getWatcherDegradedReason() ?? 'live file watching stopped'}`,
        '- The index is frozen; Read files directly for current content.'
      );
    }

    // Per-file freshness — the inverse of the auto-prepended staleness banner
    // (issue #403). Surfacing it inside `status` gives the agent a single
    // place to ask "is the index caught up?" rather than inferring from
    // banners on other tool calls.
    const pending = cg.getPendingFiles();
    if (pending.length > 0) {
      lines.push('', '**Pending sync:**');
      const now = Date.now();
      for (const p of pending) {
        const ageMs = Math.max(0, now - p.lastSeenMs);
        const label = p.indexing ? 'indexing in progress' : 'pending sync';
        lines.push(`- ${p.path} (edited ${ageMs}ms ago, ${label})`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  /**
   * Handle homegraph_files - get project file structure from the index
   */
  private async handleFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getHomeGraph(args.projectPath as string | undefined);
    const pathFilter = args.path as string | undefined;
    const pattern = args.pattern as string | undefined;
    const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
    const includeMetadata = args.includeMetadata !== false;
    const maxDepth = args.maxDepth != null ? clamp(args.maxDepth as number, 1, 20) : undefined;

    // Get all files from the index
    const allFiles = cg.getFiles();

    if (allFiles.length === 0) {
      return this.textResult('No files indexed. Run `homegraph index` first.');
    }

    // Filter by path prefix. Stored paths are project-relative POSIX (e.g.
    // "src/foo.ts"), but agents commonly pass project-root variants like "/",
    // ".", "./", "" or Windows-style "src\foo" — and prefixes with leading
    // "/", "./" or "\". Normalize all of those before matching so the agent
    // gets results instead of falling back to Read/Glob (see #426).
    const normalizedFilter = pathFilter
      ? pathFilter
          .replace(/\\/g, '/')
          .replace(/^(?:\.?\/+)+/, '')
          .replace(/^\.$/, '')
          .replace(/\/+$/, '')
      : '';
    let files = normalizedFilter
      ? allFiles.filter(f => f.path === normalizedFilter || f.path.startsWith(normalizedFilter + '/'))
      : allFiles;

    // Filter by glob pattern
    if (pattern) {
      const regex = this.globToRegex(pattern);
      files = files.filter(f => regex.test(f.path));
    }

    if (files.length === 0) {
      return this.textResult(`No files found matching the criteria.`);
    }

    // Format output
    let output: string;
    switch (format) {
      case 'flat':
        output = this.formatFilesFlat(files, includeMetadata);
        break;
      case 'grouped':
        output = this.formatFilesGrouped(files, includeMetadata);
        break;
      case 'tree':
      default:
        output = this.formatFilesTree(files, includeMetadata, maxDepth);
        break;
    }

    return this.textResult(this.truncateOutput(output));
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars except * and ?
      .replace(/\*\*/g, '{{GLOBSTAR}}')       // Temp placeholder for **
      .replace(/\*/g, '[^/]*')                // * matches anything except /
      .replace(/\?/g, '[^/]')                 // ? matches single char except /
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');    // ** matches anything including /
    return new RegExp(escaped);
  }

  /**
   * Format files as a flat list
   */
  private formatFilesFlat(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const lines: string[] = [`**Files (${files.length})**`, ''];

    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format files grouped by language
   */
  private formatFilesGrouped(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const byLang = new Map<string, typeof files>();

    for (const file of files) {
      const existing = byLang.get(file.language) || [];
      existing.push(file);
      byLang.set(file.language, existing);
    }

    const lines: string[] = [`**Files by Language (${files.length} total)**`, ''];

    // Sort languages by file count (descending)
    const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [lang, langFiles] of sortedLangs) {
      lines.push(`**${lang} (${langFiles.length})**`);
      for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
        if (includeMetadata) {
          lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
        } else {
          lines.push(`- ${file.path}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format files as a tree structure
   */
  private formatFilesTree(
    files: { path: string; language: string; nodeCount: number }[],
    includeMetadata: boolean,
    maxDepth?: number
  ): string {
    // Build tree structure
    interface TreeNode {
      name: string;
      children: Map<string, TreeNode>;
      file?: { language: string; nodeCount: number };
    }

    const root: TreeNode = { name: '', children: new Map() };

    for (const file of files) {
      const parts = file.path.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (!current.children.has(part)) {
          current.children.set(part, { name: part, children: new Map() });
        }
        current = current.children.get(part)!;

        // If this is the last part, it's a file
        if (i === parts.length - 1) {
          current.file = { language: file.language, nodeCount: file.nodeCount };
        }
      }
    }

    // Render tree
    const lines: string[] = [`**Project Structure (${files.length} files)**`, ''];

    const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
      if (maxDepth !== undefined && depth > maxDepth) return;

      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (node.name) {
        let line = prefix + connector + node.name;
        if (node.file && includeMetadata) {
          line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
        }
        lines.push(line);
      }

      const children = [...node.children.values()];
      // Sort: directories first, then files, both alphabetically
      children.sort((a, b) => {
        const aIsDir = a.children.size > 0 && !a.file;
        const bIsDir = b.children.size > 0 && !b.file;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const nextPrefix = node.name ? prefix + childPrefix : prefix;
        renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
      }
    };

    renderNode(root, '', true, 0);

    return lines.join('\n');
  }

  // =========================================================================
  // handleSpecMatch — Commit4Spec knowledge-graph search
  // =========================================================================

  /**
   * Match a spec/feature description against the Commit4Spec knowledge graph.
   *
   * Uses FTS5 full-text search to find the most similar historical specs,
   * returning each with its linked commits and optional code fragments.
   * The database lives at `.homegraph/commit4spec/commit4spec.db` by default and is
   * separate from the HomeGraph code-symbol index — this tool works whether
   * or not the code index is present.
   */
  private async handleSpecMatch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const repoPath = args.repoPath as string | undefined;
    const topKRaw = Number(args.topK);
    const topK = Math.max(1, Math.min(isNaN(topKRaw) ? 5 : topKRaw, 50));
    const includeFragments = args.includeFragments !== false;

    // Lazily require spec modules so the MCP startup path stays lean.
    const { resolveDbPath } = require('../spec/utils') as typeof import('../spec/utils');
    const { createDatabase } = require('../db/sqlite-adapter') as typeof import('../db/sqlite-adapter');
    const { searchAndGetContext } = require('../spec/graph/queries') as typeof import('../spec/graph/queries');
    const {
      truncateCodeDiff,
      truncateSubtitles,
      computeBudgetProfile,
    } = require('../spec/utils') as typeof import('../spec/utils');

    // Resolve the database path.
    const dbPath = resolveDbPath(repoPath || process.cwd());

    // Open the database.
    let db: SqliteDatabase;
    try {
      db = createDatabase(dbPath).db;
    } catch (err) {
      return this.errorResult(
        `Failed to open Commit4Spec database at "${dbPath}": ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      // Search and traverse.
      const contexts = searchAndGetContext(db, query, topK, includeFragments);

      if (contexts.length === 0) {
        return this.textResult(
          JSON.stringify({
            query: query.slice(0, 200),
            matched_count: 0,
            results: [],
          }, null, 2)
        );
      }

      // Build budget profile for truncation.
      const profile = computeBudgetProfile(contexts.length);

      // Serialize to JSON (matching Python's spec_contexts_to_results format).
      const results = contexts.map((ctx) => {
        const subtitles = profile.tier === 'vlarge'
          ? [] // vlarge disables subtitles entirely
          : truncateSubtitles(ctx.spec.subtitles, 200, profile.maxContents);

        const commits = ctx.commits.slice(0, profile.maxContents || 5).map((c) => {
          const cd: Record<string, unknown> = {
            hash: c.commit.hash,
            message: c.commit.message,
            relation_type: c.relationType,
          };

          if (includeFragments) {
            const maxFrags = profile.maxFragments || 3;
            cd.fragments = c.fragments.slice(0, maxFrags).map((f) => ({
              file_path: f.filePath,
              change_type: f.changeType,
              start_line: f.startLine,
              end_line: f.endLine,
              code_diff: truncateCodeDiff(f.codeDiff),
            }));
          }

          return cd;
        });

        return {
          spec_id: ctx.spec.id,
          title: ctx.spec.title,
          subtitles,
          file_path: ctx.spec.filePath,
          commits,
        };
      });

      const response = {
        query: query.slice(0, 200),
        matched_count: results.length,
        results,
      };

      const json = JSON.stringify(response, null, 2);

      // Hard cap to MAX_OUTPUT_LENGTH to prevent context bloat.
      if (json.length <= MAX_OUTPUT_LENGTH) {
        return this.textResult(json);
      }

      // When the full payload exceeds the cap, drop fragments first,
      // then trim commits, then trim the whole thing.
      if (includeFragments) {
        const slimResults = results.map((r) => ({
          ...r,
          commits: r.commits.map((c: Record<string, unknown>) => {
            const { fragments: _, ...rest } = c;
            return rest;
          }),
        }));
        const slim = JSON.stringify({ ...response, results: slimResults }, null, 2);
        if (slim.length <= MAX_OUTPUT_LENGTH) {
          return this.textResult(
            `(Fragments elided — output exceeded ${MAX_OUTPUT_LENGTH} chars)\n\n` + slim
          );
        }
      }

      // Fallback: truncate at a newline to avoid broken JSON.
      return this.textResult(this.truncateOutput(json));
    } finally {
      db.close();
    }
  }

  // =========================================================================
  // handleSpecFind — file-path based spec lookup
  // =========================================================================

  /**
   * Find which specs are related to the given file path by matching against
   * code-fragment file paths in the Commit4Spec knowledge graph.
   *
   * Traverses: filePath → code_fragment_nodes → commit_fragment_relations
   * → spec_commit_relations → spec_nodes.
   */
  private async handleSpecFind(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.validateString(args.filePath, 'filePath');
    if (typeof filePath !== 'string') return filePath;

    const repoPath = args.repoPath as string | undefined;

    // Lazily require spec modules so the MCP startup path stays lean.
    const { resolveDbPath } = require('../spec/utils') as typeof import('../spec/utils');
    const { createDatabase } = require('../db/sqlite-adapter') as typeof import('../db/sqlite-adapter');
    const { findSpecsByFilePath } = require('../spec/graph/queries') as typeof import('../spec/graph/queries');

    // Resolve the database path.
    const dbPath = resolveDbPath(repoPath || process.cwd());

    // Open the database.
    let db: SqliteDatabase;
    try {
      db = createDatabase(dbPath).db;
    } catch (err) {
      return this.errorResult(
        `Failed to open Commit4Spec database at "${dbPath}": ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      const result = findSpecsByFilePath(db, filePath);

      const response = {
        filePath,
        matched_count: result.matched_count,
        truncated: result.truncated,
        results: result.results,
      };

      const json = JSON.stringify(response, null, 2);
      if (json.length <= MAX_OUTPUT_LENGTH) {
        return this.textResult(json);
      }

      // Truncate: reduce results
      const slim = {
        ...response,
        results: response.results.slice(0, Math.max(1, Math.floor(response.results.length / 2))),
      };
      const slimJson = JSON.stringify(slim, null, 2);
      if (slimJson.length <= MAX_OUTPUT_LENGTH) {
        return this.textResult(`(Results trimmed to fit output limit)\n\n${slimJson}`);
      }

      return this.textResult(this.truncateOutput(json));
    } finally {
      db.close();
    }
  }

  // =========================================================================
  // handleSpecTrace — code symbol → Spec reverse trace
  // =========================================================================

  /**
   * Trace a code symbol back to its associated Specs.
   *
   * Uses the HomeGraph code index to resolve the symbol to AST-level node(s),
   * then queries the Commit4Spec knowledge graph for associated Specs via
   * five-dimensional scoring (file-path, content FTS5, name FTS5, recency,
   * line overlap).
   *
   * This bridges the two databases: homegraph.db (code entities) →
   * commit4spec.db (Spec knowledge graph).
   */
  private async handleSpecTrace(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const fileRaw = this.validateOptionalPath(args.file, 'file');
    if (typeof fileRaw === 'object') return fileRaw;
    const file: string | undefined = fileRaw;
    const line = typeof args.line === 'number' ? args.line : undefined;
    const repoPath = args.repoPath as string | undefined;
    const topKRaw = Number(args.topK);
    const topK = Math.max(1, Math.min(isNaN(topKRaw) ? 10 : topKRaw, 50));

    // Lazily require all needed modules
    const HomeGraph = loadHomeGraph();
    const { resolveDbPath } = require('../spec/utils') as typeof import('../spec/utils');
    const { createDatabase } = require('../db/sqlite-adapter') as typeof import('../db/sqlite-adapter');
    const { findSpecsByCodeSymbol } = require('../spec/graph/queries') as typeof import('../spec/graph/queries');
    const { initSpecSchema, runSpecMigrations, getCurrentSpecVersion, CURRENT_SPEC_SCHEMA_VERSION } = require('../spec/db/schema') as typeof import('../spec/db/schema');

    // Resolve project path for the code graph
    const projectPath = repoPath || process.cwd();

    // Open the HomeGraph code index
    let cg: HomeGraph;
    try {
      cg = await HomeGraph.open(projectPath);
    } catch (err) {
      return this.errorResult(
        `Failed to open HomeGraph code index at "${projectPath}": ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      // Step 1: Resolve symbol to nodes via findSymbolMatches
      let nodes = this.findSymbolMatches(cg, symbol);

      if (nodes.length === 0) {
        await cg.close();
        return this.textResult(JSON.stringify({
          symbol,
          error: `No code entities found for symbol "${symbol}".`,
          matches: [],
        }, null, 2));
      }

      // Disambiguate by file/line if provided
      if (file) {
        // Use endsWith for precise file path matching
        nodes = nodes.filter((n) => n.filePath.endsWith(file));
      }
      if (line !== undefined && nodes.length > 1) {
        const closest = nodes.reduce((best, n) => {
          const bestDist = Math.abs(best.startLine - line!) + Math.abs(best.endLine - line!);
          const curDist = Math.abs(n.startLine - line!) + Math.abs(n.endLine - line!);
          return curDist < bestDist ? n : best;
        });
        nodes = [closest];
      }

      // Take the best disambiguated node
      const node = nodes[0];
      if (!node) {
        await cg.close();
        return this.textResult(JSON.stringify({
          symbol,
          error: `Could not resolve symbol "${symbol}" to a specific code entity.`,
          matches: [],
        }, null, 2));
      }

      // Step 2: Resolve the Spec database path
      const dbPath = resolveDbPath(repoPath || process.cwd());

      // Step 3: Open the Spec database
      let db: SqliteDatabase;
      try {
        db = createDatabase(dbPath).db;
      } catch (err) {
        await cg.close();
        return this.errorResult(
          `Failed to open Commit4Spec database at "${dbPath}": ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }

      try {
        // Ensure schema is up to date
        initSpecSchema(db);
        const currentVersion = getCurrentSpecVersion(db);
        if (currentVersion < CURRENT_SPEC_SCHEMA_VERSION) {
          runSpecMigrations(db, currentVersion);
        }

        // Step 4: Query Specs for the code entity
        const result = findSpecsByCodeSymbol(db, {
          name: node.name,
          qualifiedName: node.qualifiedName,
          kind: node.kind,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
        }, topK);

        // Step 5: Serialize the response
        const response = {
          symbol,
          entity: {
            name: result.entity.name,
            qualifiedName: result.entity.qualifiedName,
            kind: result.entity.kind,
            filePath: result.entity.filePath,
            startLine: result.entity.startLine,
            endLine: result.entity.endLine,
          },
          matched_count: result.matches.length,
          total_candidates: result.totalCandidates,
          matches: result.matches.map((m) => ({
            spec_id: m.spec.id,
            title: m.spec.title,
            status: m.spec.status,
            version: m.spec.version,
            file_path: m.spec.filePath,
            score: Math.round(m.score * 1000) / 1000,
            score_detail: {
              file_path: Math.round(m.scoreDetail.filePathScore * 1000) / 1000,
              content: Math.round(m.scoreDetail.contentScore * 1000) / 1000,
              name: Math.round(m.scoreDetail.nameScore * 1000) / 1000,
              recency: Math.round(m.scoreDetail.recencyScore * 1000) / 1000,
              line_overlap: Math.round(m.scoreDetail.overlapScore * 1000) / 1000,
            },
            fragment_count: m.fragmentCount,
            commit_count: m.commitCount,
          })),
        };

        const json = JSON.stringify(response, null, 2);
        if (json.length <= MAX_OUTPUT_LENGTH) {
          return this.textResult(json);
        }

        // Truncate: reduce matches
        const slim = {
          ...response,
          matches: response.matches.slice(0, Math.max(1, Math.floor(topK / 2))),
        };
        const slimJson = JSON.stringify(slim, null, 2);
        if (slimJson.length <= MAX_OUTPUT_LENGTH) {
          return this.textResult(`(Results trimmed to fit output limit)\n\n${slimJson}`);
        }

        return this.textResult(this.truncateOutput(json));
      } finally {
        try { db.close(); } catch { /* best effort */ }
      }
    } finally {
      try { await cg.close(); } catch { /* best effort */ }
    }
  }

  // =========================================================================
  // Symbol resolution helpers
  // =========================================================================

  /**
   * Find a symbol by name, handling disambiguation when multiple matches exist.
   * Returns the best match and a note about alternatives if any.
   */
  /**
   * Check if a node matches a symbol query.
   *
   * Accepts simple names (`run`) and three flavors of qualifier:
   *   - dotted     `Session.request`         (TS/JS/Python)
   *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
   *   - slash      `configurator/stage_apply` (path-ish)
   *
   * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
   * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
   * the canonical `crate::module::symbol` form resolves.
   *
   * Resolution order, last part must always equal `node.name`:
   *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
   *      where the extractor builds the qualified name from the AST stack)
   *   2. File-path containment (handles file-derived modules in Rust/
   *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
   */
  private matchesSymbol(node: Node, symbol: string): boolean {
    // Simple name match
    if (node.name === symbol) return true;
    // File basename match (e.g., "product-card" matches "product-card.liquid")
    if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

    // Qualified-name lookups: split on any supported separator. `\w` keeps
    // identifier chars (incl. `_`) intact; everything else is treated as
    // a separator we tolerate.
    if (!/[.\/]|::/.test(symbol)) return false;
    const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
    if (parts.length < 2) return false;

    const lastPart = parts[parts.length - 1]!;
    if (node.name !== lastPart) return false;

    // Stage 1: qualified-name suffix match. The extractor joins the
    // semantic hierarchy with `::`, so `Session.request` and
    // `Session::request` both become `Session::request` here.
    const colonSuffix = parts.join('::');
    if (node.qualifiedName.includes(colonSuffix)) return true;

    // Stage 2: file-path containment. Rust modules and Python packages
    // are not in `qualifiedName` — they're encoded in the file path. So
    // `stage_apply::run` matches a `run` in any file whose path
    // contains a `stage_apply` segment (with or without an extension).
    //
    // Filter out Rust path prefixes that have no file-system equivalent.
    const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
    if (containerHints.length === 0) return false;

    const segments = node.filePath.split('/').filter((s) => s.length > 0);
    return containerHints.every((hint) =>
      segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
    );
  }

  /**
   * Find ALL definitions matching a name, ranked, so homegraph_node can return
   * every overload instead of guessing one (the wrong guess → a Read). Keepers
   * rank before generated stubs (.pb.go etc.); stable within a group preserves
   * FTS order. Returns [] when nothing matches; a qualified lookup that finds no
   * exact match returns [] rather than a misleading fuzzy file hit (#173); a
   * bare name with no exact match falls back to the single top fuzzy result.
   */
  private findSymbolMatches(cg: HomeGraph, symbol: string): Node[] {
    const isQualified = /[.\/]|::/.test(symbol);

    // For a bare name, enumerate EVERY exact-name definition via the direct index
    // (not FTS, which caps + ranks): tokio's `poll` has 50+ defs and the one the
    // caller wants (`Harness::poll` at harness.rs:153) ranks below any search cut,
    // so it could be neither rendered nor pinned by the file/line disambiguator —
    // and the agent Read it. With the full set, the multi-overload render + the
    // file/line filter can both reach it.
    if (!isQualified) {
      const exact = cg.getNodesByName(symbol);
      if (exact.length > 0) {
        return [...exact].sort((a, b) => (isGeneratedFile(a.filePath) ? 1 : 0) - (isGeneratedFile(b.filePath) ? 1 : 0));
      }
      // No exact match — use the single top fuzzy result (e.g. a file basename).
      const fuzzy = cg.searchNodes(symbol, { limit: 10 });
      return fuzzy[0] ? [fuzzy[0].node] : [];
    }

    // Qualified lookup (`Session.request`, `stage_apply::run`): FTS + matchesSymbol.
    const limit = 50;
    let results = cg.searchNodes(symbol, { limit });

    // FTS strips colons, so `stage_apply::run` searches the literal
    // `stage_applyrun` and finds nothing. Re-search by the bare last part and
    // let `matchesSymbol` filter by qualifier.
    if (isQualified && results.length === 0) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
    }

    if (results.length === 0) return [];

    const exactMatches = results.filter((r) => this.matchesSymbol(r.node, symbol));
    if (exactMatches.length === 0) {
      // No exact match — a qualified lookup must not fall back to a fuzzy file
      // hit (#173); a bare name may use the single top fuzzy result.
      return isQualified ? [] : results[0] ? [results[0].node] : [];
    }

    // Down-rank generated files (.pb.go, .pulsar.go, _grpc.pb.go, …) so a flow
    // query prefers the keeper implementation over the protobuf-generated stub.
    return [...exactMatches]
      .sort((a, b) => (isGeneratedFile(a.node.filePath) ? 1 : 0) - (isGeneratedFile(b.node.filePath) ? 1 : 0))
      .map((r) => r.node);
  }

  /**
   * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
   * results across all matching symbols (e.g., multiple classes with an `execute` method).
   */
  private findAllSymbols(cg: HomeGraph, symbol: string): { nodes: Node[]; note: string } {
    let results = cg.searchNodes(symbol, { limit: 50 });

    // Mirror the fallback in `findSymbol` for qualified queries — FTS
    // strips colons, so a module-qualified lookup needs a second pass
    // by the bare last part.
    if (results.length === 0 && /[.\/]|::/.test(symbol)) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
    }

    const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

    // Prefer exact name/qualified matches. Never fall back to the top FTS
    // hit — that resolved unrelated symbols (e.g. OnSurfaceChangedCB → a
    // function whose body merely mentions "surface") and poisoned callees.
    let pool = exactMatches.map((r) => r.node);
    if (pool.length === 0) {
      try {
        pool = cg.getNodesByName(symbol).filter((n) => this.matchesSymbol(n, symbol));
      } catch {
        pool = [];
      }
    }
    if (pool.length === 0 && /[.\/]|::/.test(symbol)) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) {
        try {
          pool = cg.getNodesByName(tail).filter((n) => this.matchesSymbol(n, symbol) || this.matchesSymbol(n, tail));
        } catch {
          pool = [];
        }
      }
    }

    if (pool.length === 0) {
      return { nodes: [], note: '' };
    }

    if (pool.length === 1) {
      return { nodes: pool, note: '' };
    }

    // Same generated-file down-rank as findSymbol — keeps callers/callees
    // /impact aggregation aligned (a query against "Send" returns the
    // hand-written implementations before the protobuf scaffold).
    const ranked = [...pool].sort((a, b) => {
      const aGen = isGeneratedFile(a.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.filePath) ? 1 : 0;
      return aGen - bGen;
    });

    const locations = ranked.map(n =>
      `${n.kind} at ${n.filePath}:${n.startLine}`
    );
    const note = `\n\n> **Note:** Aggregated results across ${ranked.length} symbols named "${symbol}": ${locations.join(', ')}`;
    return { nodes: ranked, note };
  }

  /**
   * Truncate output if it exceeds the maximum length
   */
  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  // =========================================================================
  // Formatting helpers (compact by default to reduce context usage)
  // =========================================================================

  private formatSearchResults(results: SearchResult[]): string {
    const lines: string[] = [`**Search Results (${results.length} found)**`, ''];

    for (const result of results) {
      const { node } = result;
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact format: one line per result with key info
      lines.push(`**${node.name}** (${node.kind})`);
      lines.push(`${node.filePath}${location}`);
      if (node.signature) lines.push(`\`${formatInlineSignature(node.signature)}\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatNodeList(nodes: Node[], title: string, labels?: Map<string, string>): string {
    const lines: string[] = [`**${title} (${nodes.length} found)**`, ''];

    for (const node of nodes) {
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact: just name, kind, location — plus the relationship when it
      // isn't a plain call (callback registration, instantiation, …).
      const label = labels?.get(node.id);
      lines.push(
        `- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`
      );
    }

    return lines.join('\n');
  }

  /**
   * At caller sites, list nearby `#include` / `import` lines — answers
   * "which call makes Type X's definition visible" without a second Grep/Read
   * when the agent only called `homegraph_callers`.
   */
  private formatCallerIncludeVisibility(cg: HomeGraph, callers: Node[]): string {
    if (callers.length === 0) return '';
    let projectRoot = '';
    try { projectRoot = cg.getProjectRoot(); } catch { return ''; }
    const rows: string[] = [];
    const seen = new Set<string>();
    for (const caller of callers.slice(0, 8)) {
      const abs = validatePathWithinRoot(projectRoot, caller.filePath);
      if (!abs || !existsSync(abs)) continue;
      let content: string;
      try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
      const fileLines = content.split('\n');
      const scanTo = Math.min(fileLines.length, Math.max(120, (caller.startLine || 1) + 5));
      for (let i = 0; i < scanTo; i++) {
        const lineText = fileLines[i] ?? '';
        if (!/^\s*(?:#\s*include|import\s)/.test(lineText)) continue;
        const key = `${caller.filePath}:${i + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(`- \`${caller.filePath}:${i + 1}\`  \`${lineText.trim().slice(0, 140)}\``);
        if (rows.length >= 12) break;
      }
      if (rows.length >= 12) break;
    }
    if (rows.length === 0) return '';
    return [
      '',
      '**Include / import at caller files** (definition visibility cues)',
      '',
      ...rows,
      '',
      '> Use these includes with the caller list when asking which call makes another type visible.',
    ].join('\n');
  }

  /**
   * Relationship label for a non-`calls` edge in callers/callees lists. A
   * function-as-value edge (#756) is the high-signal one: `callers(cb)`
   * showing "via callback registration" tells the agent this is where the
   * callback is WIRED, not where it's invoked.
   */
  private edgeLabel(edge: Edge): string | null {
    if (edge.kind === 'calls') return null;
    if (edge.metadata?.fnRef === true) return 'callback registration';
    if (edge.kind === 'instantiates') return 'instantiation';
    if (edge.kind === 'imports') return 'import';
    if (edge.kind === 'references') return 'reference';
    return edge.kind;
  }

  private formatImpact(symbol: string, impact: Subgraph): string {
    const nodeCount = impact.nodes.size;

    // Compact format: just list affected symbols grouped by file
    const lines: string[] = [
      `**Impact: "${symbol}" affects ${nodeCount} symbols**`,
      '',
    ];

    // Group by file
    const byFile = new Map<string, Node[]>();
    for (const node of impact.nodes.values()) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      lines.push(`**${file}:**`);
      // Compact: inline list
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(nodeList);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build a compact structural outline of a container symbol from its
   * indexed children (methods, fields, properties, …) — name, kind,
   * line number, and signature — so the agent gets the shape of a class
   * without the full source of every method. Returns '' when the container
   * has no indexed children, so the caller can fall back to full source.
   */
  private buildContainerOutline(cg: HomeGraph, node: Node): string {
    const children = cg.getChildren(node.id)
      .filter(c => c.kind !== 'import' && c.kind !== 'export')
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    if (children.length === 0) return '';

    const lines = [`**Members (${children.length}):**`, ''];
    for (const c of children) {
      const loc = c.startLine ? `:${c.startLine}` : '';
      const sig = c.signature ? ` — \`${formatInlineSignature(c.signature)}\`` : '';
      lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
    }
    return lines.join('\n');
  }

  private formatNodeDetails(node: Node, code: string | null, outline?: string | null): string {
    const location = node.startLine ? `:${node.startLine}` : '';
    const lines: string[] = [
      `**${node.name}** (${node.kind})`,
      '',
      `**Location:** ${node.filePath}${location}`,
    ];

    if (node.signature) {
      lines.push(...formatNodeSignatureBlock(node.signature));
    }

    // Only include docstring if it's short and useful
    if (node.docstring && node.docstring.length < 200) {
      lines.push('', node.docstring);
    }

    if (outline) {
      lines.push('', outline, '',
        `> Structural outline only. Read \`${node.filePath}\` or call homegraph_node on a specific member for its body.`);
    } else if (code) {
      // Line-numbered (cat -n style, like homegraph_explore and Read) so the
      // agent can cite/edit exact lines without re-Reading the file for them.
      const numbered = node.startLine ? numberSourceLines(code, node.startLine) : code;
      lines.push('', '```' + node.language, numbered, '```');
    }

    return lines.join('\n');
  }

  private textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  /**
   * Recoverable bad-argument guidance: SUCCESS-shaped (no `isError`) so agents
   * retry with fixed args instead of abandoning HomeGraph for the session.
   * Reserved `isError` cases stay in {@link errorResult} (security / real faults).
   */
  private badArgResult(
    problem: string,
    argName: string,
    exampleOverride?: Record<string, unknown>,
  ): ToolResult {
    const example =
      exampleOverride ??
      ({ [argName]: BAD_ARG_EXAMPLES[argName] ?? '…' } as Record<string, unknown>);
    return this.textResult(
      `${problem}\n\n` +
        'This is not a HomeGraph failure — fix the arguments and retry the same tool.\n' +
        'Example:\n' +
        '```json\n' +
        `${JSON.stringify(example, null, 2)}\n` +
        '```',
    );
  }

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
