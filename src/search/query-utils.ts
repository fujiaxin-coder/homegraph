/**
 * Search Query Utilities
 *
 * Shared module for search term extraction and scoring.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node } from '../types';
import { validatePathWithinRoot } from '../utils';

/** Normalize a name to a comparable token: lowercase, alphanumerics only. */
export function normalizeNameToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Source/config extensions recognized in natural-language queries. */
export const QUERY_SOURCE_FILE_EXT =
  'ets|ts|tsx|js|jsx|mjs|cjs|json5?|ya?ml|toml|hpp|h|cpp|c|cmake';

/** Member-access anchor extracted from a query (e.g. locationManager.on, .drawModifier). */
export interface QueryMemberAccess {
  receiver?: string;
  member: string;
  /** Dotted form as written in the query. */
  dotted: string;
}

/**
 * File basenames from queries — supports `Foo.ets` and path-style `common\\constants.ets`.
 */
export function extractFileBasenamesFromQuery(query: string): string[] {
  const basenames = new Set<string>();
  const ext = QUERY_SOURCE_FILE_EXT;
  const pathStyle = new RegExp(`(?:^|[/\\\\])([A-Za-z][A-Za-z0-9_-]*)\\.(?:${ext})\\b`, 'gi');
  const wordStyle = new RegExp(`\\b([A-Za-z][A-Za-z0-9_-]*)\\.(?:${ext})\\b`, 'gi');
  for (const re of [pathStyle, wordStyle]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      if (m[1] && m[1].length >= 2) basenames.add(m[1]);
    }
  }
  for (const m of query.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*)\.test\.(?:ets|ts|tsx)\b/gi)) {
    if (m[1] && m[1].length >= 2) {
      basenames.add(m[1]);
      basenames.delete('test');
    }
  }
  if (/\bCMakeLists\.txt\b/i.test(query)) basenames.add('CMakeLists');
  for (const m of query.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*)\.d\.ts\b/gi)) {
    if (m[1] && m[1].length >= 2) basenames.add(m[1]);
  }
  return [...basenames];
}

/**
 * Path-shaped anchors from a query — `feature/foo`, `staticcommon/launchercommon`.
 */
export function extractPathSegmentsFromQuery(query: string): string[] {
  const segments = new Set<string>();
  for (const m of query.matchAll(
    /(?:^|[\s,;])([a-z][a-z0-9_-]*(?:[\\/][a-z][a-z0-9_-]+)+)\b/gi,
  )) {
    if (m[1]) segments.add(m[1].replace(/\\/g, '/'));
  }
  return [...segments];
}

/** Query names code/API context (kit paths, extensions, member access) — not NL keywords. */
export function queryMentionsCodeContext(query: string): boolean {
  return (
    /@kit\.|@ohos\./i.test(query)
    || /\bapi\b/i.test(query)
    || new RegExp(`\\.(?:${QUERY_SOURCE_FILE_EXT}|d\\.ts)\\b`, 'i').test(query)
    || /\bCMakeLists\.txt\b/i.test(query)
    || extractMemberAccessFromQuery(query).length > 0
    || extractKitModuleNamesFromQuery(query).length > 0
  );
}

/**
 * HarmonyOS @kit module names — from `@kit.ArkTS` literals or PascalCase `*Kit` tokens
 * (e.g. ServiceCollaborationKit in "调用 ServiceCollaborationKit 需要…").
 */
export function extractKitModuleNamesFromQuery(query: string): string[] {
  const names = new Set<string>();
  for (const m of query.matchAll(/@kit\.([A-Za-z][A-Za-z0-9]*)/gi)) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of query.matchAll(/\b([A-Z][A-Za-z0-9]*Kit)\b/g)) {
    if (m[1] && m[1].length >= 5) names.add(m[1]);
  }
  return [...names];
}

/** Submodule / named-export tokens from kit usage questions.
 *  Covers `util模块`, `util 模块`, and `@kit.Foo的bar` / `@kit.Foo bar` (export focus).
 */
export function extractKitSubmoduleNamesFromQuery(query: string): string[] {
  // NL leftovers in agent rewrites ("util module API functions") — not exports.
  const SUBMODULE_NOISE = new Set([
    'module', 'modules', 'function', 'functions', 'feature', 'features',
    'api', 'apis', 'capability', 'capabilities', 'export', 'exports',
  ]);
  const names = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw || raw.length < 2) return;
    const s = raw.toLowerCase();
    if (STOP_WORDS.has(s) || GENERIC_VERB_ANCHOR_NOISE.has(s) || SUBMODULE_NOISE.has(s)) return;
    names.add(raw);
  };
  for (const m of query.matchAll(/([a-z][a-z0-9_]{1,24})模块/gi)) {
    add(m[1]);
  }
  for (const m of query.matchAll(/\b([a-z][a-z0-9_]*)\s+模块\b/gi)) {
    add(m[1]);
  }
  // `@kit.ArkTS的taskpool` / `@kit.ArkTS的 foo` — named export, not a catalog.
  for (const m of query.matchAll(/@kit\.[A-Za-z][A-Za-z0-9]*的\s*([a-z][a-zA-Z0-9_]{2,24})\b/gi)) {
    add(m[1]);
  }
  for (const m of query.matchAll(/@kit\.[A-Za-z][A-Za-z0-9]*[\s.]+([a-z][a-zA-Z0-9_]{2,24})\b/gi)) {
    add(m[1]);
  }
  return [...names];
}

/**
 * "@kit.X 的 Y 模块有哪些功能" — SDK API docs are outside the repo; answer from
 * indexed import/usage only.
 */
export function queryAsKitModuleCapabilitySurvey(query: string): boolean {
  if (extractKitModuleNamesFromQuery(query).length === 0) return false;
  const capability =
    /有哪些功能|有什么功能|哪些功能|模块功能|功能有哪些|what\s+(?:are\s+the\s+)?features|module\s+features|kit\s+features/i.test(
      query,
    )
    // Agent rewrites: "@kit.ArkTS util module API functions"
    || /(?:module\s+)?API\s+functions?|API\s+(?:list|catalog|surface)|what\s+(?:APIs?|functions?)\s+(?:does|are)/i.test(
      query,
    );
  if (!capability) return false;
  return /@kit\.|模块|\bkit\b/i.test(query) || extractKitSubmoduleNamesFromQuery(query).length > 0;
}

/**
 * Out-of-repo SDK / kit **capability or API catalog** questions — wrong shape
 * for HomeGraph (graph has imports/usages, not official feature lists).
 * Shape-driven: kit token + catalog phrasing; never matches a specific product name.
 */
/**
 * Member-like / event-handler identifiers — useful as graph seeds (isExpired,
 * onClick) but NOT as "which files import X" inventory filters. Treating them
 * as import inventory makes explore return a dependency list and forces agents
 * back to Grep.
 */
export function isMemberLikeIdentifier(token: string): boolean {
  if (!token || token.length < 2) return false;
  if (/^(is|has|get|set|on)[A-Z0-9_]/.test(token)) return true;
  if (/^on[A-Z]/.test(token)) return true;
  // camelCase property/method: first lower, later upper
  return /^[a-z][a-zA-Z0-9]*[A-Z]/.test(token);
}

/**
 * Owning Type + co-named PascalCase methods (CanPlace/Place ↔ BinaryGrid).
 * Not Type.member dotted form — agents name methods as sibling Types.
 * Must stay on compact explore — 「是怎么」alone would light-mechanism dump.
 */
export function queryAsCoNamedTypeMethodInteraction(query: string): boolean {
  // "who calls Type's Set/Test/Fill" is a caller inventory, not body interaction.
  if (queryAsCallerOrMethodSurvey(query)) return false;
  const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
  if (types.length < 2 || types.length > 4) return false;
  const owners = types.filter(
    (t) =>
      t.length >= 8
      || /(?:Grid|Manager|Service|Controller|Render|Plugin|Layout|Handler|Provider|Store)/i.test(t),
  );
  const methods = types.filter((t) => !owners.includes(t));
  if (owners.length < 1 || methods.length < 1) return false;
  if (
    /交互|是怎么|如何.*(?:用|调|连|互)|how\s+(?:do|does|are).{0,48}(?:interact|relate|use|call)|与.+交互|和.+交互/i.test(
      query,
    )
  ) {
    return true;
  }
  // Method-looking PascalCase co-named with an owner — even without 交互.
  return methods.some((m) =>
    /^(?:Can|Is|Has|Get|Set|Place|Fill|Test|Put|Add|Remove|Update|Draw|Check|Find)/.test(m),
  );
}

/**
 * Named Type + member (dot form, or co-named Type + member-like token).
 * Structural — no product/question nouns.
 */
export function queryHasNamedMemberFocus(query: string): boolean {
  if (extractMemberAccessFromQuery(query).length > 0) return true;
  if (queryAsCoNamedTypeMethodInteraction(query)) return true;
  const types = extractTypeNamesFromQuery(query);
  if (types.length === 0 || types.length > 3) return false;
  return extractDependencySymbolsFromQuery(query).some((d) => isMemberLikeIdentifier(d));
}

/**
 * Named UI/component symbol + event token (onClick / click) — "what happens when
 * this control fires" is a one-symbol / callees question, not an import survey.
 */
export function queryAsNamedComponentAction(query: string): boolean {
  const types = extractTypeNamesFromQuery(query);
  if (types.length < 1 || types.length > 2) return false;
  const looksUi = types.some((t) =>
    /(Button|Component|View|Page|Dialog|Bar|Item|Panel|Menu|Chip|Card)$/i.test(t),
  );
  if (!looksUi) return false;
  const deps = extractDependencySymbolsFromQuery(query);
  if (deps.some((d) => /^on[A-Z]/.test(d) || /^(click|tap|press|hover)$/i.test(d))) return true;
  // Optional thin intent — only with a UI-looking Type already present.
  return /点击|单击|按下|按钮|悬停|hover|onClick|onTap|onHover|会发生什么|what\s+happens|when\s+(?:clicked|pressed|hovered)/i.test(
    query,
  );
}

/**
 * Out-of-repo SDK catalog phrasing (kit + "what features/APIs").
 * Routed to Skip HomeGraph — graph has usages, not official feature lists.
 */
export function queryAsOutOfRepoSdkCatalog(query: string): boolean {
  if (queryAsKitModuleCapabilitySurvey(query)) return true;
  const catalog =
    /有哪些(?:功能|API|接口|方法|能力)|提供(?:哪些|什么)|模块有哪些|what\s+(?:are\s+the\s+)?(?:apis?|features|methods)|(?:api|feature)\s+(?:list|catalog)|official\s+(?:api|sdk)\s+docs|module\s+features|kit\s+features/i.test(
      query,
    )
    || /(?:module\s+)?API\s+functions?|API\s+(?:list|catalog|surface)/i.test(query);
  if (catalog && /@kit\.|\b[A-Z][A-Za-z0-9]*Kit\b/i.test(query)) return true;

  // Pure SDK "which callback must I implement" with no in-repo file anchor.
  // OHAudio-style SDK tokens may parse as Types — still catalog if no .ets/.ts file.
  const hasFile = extractFileBasenamesFromQuery(query).length > 0;
  const types = extractTypeNamesFromQuery(query);
  const onlySdkishTypes = types.length > 0
    && types.every((t) => /^(?:OH|Napi|NAPI)/.test(t) || /(?:Kit|API)$/.test(t));
  if (
    !hasFile
    && (types.length === 0 || onlySdkishTypes)
    && /(?:C\s+API|NAPI|\bOH[A-Z][A-Za-z]+\b)/i.test(query)
    && /需要实现哪个回调|实现哪个回调|哪个回调函数|which\s+callback\s+(?:must|should|to)\s+implement|callback\s+(?:to|must)\s+(?:implement|provide)/i.test(
      query,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Query shapes where HomeGraph is *definitely* the wrong tool.
 *
 * Default is **do not skip** (agent already chose explore/search — serve it).
 * Blacklist only — absence from this list means run. Do not add allowlists.
 *
 * Kit **feature/API catalogs** ("what APIs does util have") are skipped — the
 * graph has import/usage sites, not official capability lists. In-repo kit
 * *usage* questions stay on explore.
 * Shape-driven only — no product nouns.
 */
export type HomeGraphDeferKind =
  | 'file-listing'
  | 'literal-hunt'
  | 'concept-or-existence'
  | 'external-manual'
  | 'sdk-catalog'
  | 'greenfield'
  | 'vcs-history'
  | 'media-assets';

/**
 * Agent is about to change an existing codebase (feature / fix / refactor).
 * Used for explore *routing* (prefer explore / light mechanism), not Skip.
 */
export function queryAsCodeChangeOrientation(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return (
    /(?:请)?(?:直接)?(?:在|给|为).{0,40}(?:工程|项目|代码|模块|页面|组件).{0,40}(?:新增|添加|增加|修改|改造|实现|修复|重构)/i.test(q)
    || /(?:新增|添加|增加|修改|改造|实现|修复|重构|接入|改一下|帮我改).{0,40}(?:功能|逻辑|页面|组件|入口|按钮|接口|模块)/i.test(q)
    || /\b(?:implement|add|introduce|wire|integrate|extend|refactor|fix|modify|update|change)\b.{0,60}\b(?:feature|page|component|module|handler|api|bug|crash|flow)\b/i.test(q)
    || /\b(?:fix|repair|debug)\b.{0,40}\b(?:crash|bug|error|issue|regression)\b/i.test(q)
    || /定位并修复|修复.*崩溃|修复.*闪退|find\s+(?:and\s+)?fix/i.test(q)
  );
}

/** Explicit "answer from official docs / website only" — no repo graph needed. */
export function queryAsExternalManualOnly(query: string): boolean {
  return (
    /(?:请)?(?:只|仅)?(?:查阅|查看|打开|去看|参考)(?:一下)?(?:官方|官网)(?:文档|手册|网站)/i.test(query)
    || /developer\.huawei\.com|华为开发者(?:联盟|官网)/i.test(query)
    || /according\s+to\s+(?:the\s+)?official\s+(?:sdk\s+)?docs?(?:\s+only)?/i.test(query)
    || /(?:read|see|check)\s+(?:the\s+)?official\s+(?:documentation|docs|website)\s+only/i.test(query)
    || /不要看代码.*(?:文档|官网)|(?:文档|官网).*(?:不要|别)看代码/i.test(query)
  );
}

/** Scaffold / empty project from scratch — nothing useful in an existing index. */
export function queryAsGreenfieldScaffold(query: string): boolean {
  return (
    /从零(?:开始)?(?:创建|新建|搭建)|创建(?:一个)?空的(?:工程|项目|应用)|新建(?:一个)?空白(?:工程|项目)/i.test(query)
    || /create\s+(?:a\s+)?(?:new\s+)?(?:empty\s+)?(?:harmonyos\s+|arkts\s+)?(?:project|app)\s+from\s+scratch/i.test(query)
    || /scaffold\s+(?:a\s+)?(?:brand\s+)?new\s+(?:empty\s+)?project/i.test(query)
  );
}

/** Git / VCS history — not in the symbol graph. */
export function queryAsVcsHistoryOnly(query: string): boolean {
  return (
    /\bgit\s+(?:log|blame|diff|show|bisect|history)\b/i.test(query)
    || /(?:提交历史|commit\s+history|git\s+blame|谁改过|上次提交|最近一次提交|哪次\s*commit)/i.test(query)
    || /(?:查看|看一下|列出).{0,12}(?:git\s+)?(?:log|blame|diff)/i.test(query)
  );
}

/** Media / binary asset inventory by extension — Glob, not the symbol graph. */
export function queryAsMediaAssetInventory(query: string): boolean {
  const listing =
    /(?:所有|全部|列出|找(?:出|到)?|盘点|有哪些|which|list|find|inventory)\b/i.test(query)
    || /资源文件|图片资源|音频资源|媒体资源|media\s+assets?/i.test(query);
  if (!listing) return false;
  return (
    /\.(?:png|jpe?g|gif|svg|webp|bmp|ico|mp4|mp3|wav|aac|flac|ttf|otf|woff2?)\b/i.test(query)
    || /(?:png|jpe?g|gif|svg|webp|图片|图标|音频|视频|字体)\s*(?:文件|资源|assets?)/i.test(query)
  );
}

export function queryShouldDeferToBuiltinTools(query: string): HomeGraphDeferKind | null {
  const q = query.trim();
  if (!q) return null;

  const hasType = extractTypeNamesFromQuery(q).length > 0;
  const hasFile = extractFileBasenamesFromQuery(q).length > 0;
  const hasMember = extractMemberAccessFromQuery(q).length > 0;
  const hasKit = /@kit\.|@ohos\./i.test(q);
  const hasCaps = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(q);
  const hasField = extractFieldLikeSymbolsFromQuery(q).length > 0;
  const hasPath = extractPathSegmentsFromQuery(q).length > 0;
  const hasGraphAnchor = hasType || hasFile || hasMember || hasKit || hasCaps || hasField || hasPath;

  // 1) Explicit external-manual-only asks.
  if (queryAsExternalManualOnly(q)) return 'external-manual';

  // 1b) Kit/SDK feature catalogs ("what APIs does X have") — not in-repo usage.
  if (queryAsOutOfRepoSdkCatalog(q)) return 'sdk-catalog';

  // 2) VCS history (independent of anchors — graph has no commits).
  if (queryAsVcsHistoryOnly(q)) return 'vcs-history';

  // 3) Media/binary asset inventories → Glob.
  if (queryAsMediaAssetInventory(q)) return 'media-assets';

  // 4) Greenfield empty scaffold (no existing code to orient on).
  if (!hasGraphAnchor && queryAsGreenfieldScaffold(q)) return 'greenfield';

  // 5) Repo-wide literal / copy / layout-string hunts → Grep.
  // Layout chains (`.width('100%')`) can look like member access — still Skip.
  if (queryLooksLikeLiteralOrCopyHunt(q)) return 'literal-hunt';

  // 6) Topic → file list with no Type/file anchor → Glob/Grep.
  if (
    !hasType
    && !hasFile
    && /哪些文件|有哪些.*文件|相关的?\s*文件|涉及.*文件|which\s+files?|files?\s+(?:are\s+)?related/i.test(q)
  ) {
    return 'file-listing';
  }

  // 7) Pure existence / concept-compare with zero graph anchors → Grep/docs.
  // Module/cycle surveys already recognized by queryAsModuleDependencySurvey
  // (e.g. `*constants` / `*common` leaf tokens + 循环依赖) must not fall through
  // to concept-skip when extractTypeNames/path anchors are empty.
  if (
    !hasGraphAnchor
    && !queryAsModuleDependencySurvey(q)
    && /有使用|是否使用|有没有使用|使用了.*吗|是否存在|有没有完整|有什么不同|区别|difference|vs\.?|versus|对比|does\s+(?:this\s+)?(?:project|repo)\s+have|is\s+there\s+(?:a\s+)?complete/i.test(
      q,
    )
  ) {
    return 'concept-or-existence';
  }

  return null;
}

/** Short success-shaped reply when explore/search should not run. */
export function homegraphDeferGuidance(kind: HomeGraphDeferKind, query: string): string {
  const q = query.trim().slice(0, 120);
  const reasons: Record<HomeGraphDeferKind, string> = {
    'file-listing':
      'Topic → file lists need Grep/Glob (keyword paths), not the symbol graph.',
    'literal-hunt':
      'Repo-wide literal / copy / layout-string hunts with no Type/file/@kit anchor — use Grep.',
    'concept-or-existence':
      'Pure existence/concept-compare with no named in-repo Type/file/@kit/@ohos anchor — Grep/docs.',
    'external-manual':
      'Question asks for official website/docs only — open the manual; HomeGraph indexes code/API graphs, not marketing pages.',
    'sdk-catalog':
      'Kit/SDK **feature or API catalogs** ("what does util export") need SDK docs — HomeGraph indexes in-repo imports/usages, not official capability lists. Rephrase as "which files import @kit.X / export Y" if you want usages.',
    'greenfield':
      'Scaffolding an empty project from scratch needs generators/docs, not an existing code graph.',
    'vcs-history':
      'Git/commit/blame/diff history is not in the symbol graph — use git / IDE history.',
    'media-assets':
      'Media/binary asset inventories (.png/.mp4/fonts/…) need Glob, not the symbol graph.',
  };
  return [
    'Skip HomeGraph for this question shape — do **not** retry any `homegraph_*` tool for it.',
    reasons[kind],
    `Query: "${q}${query.trim().length > 120 ? '…' : ''}"`,
    'Next: Grep / Glob / Read / git / SDK docs / project generators as appropriate. Otherwise call `homegraph_explore` with the task or symbol names.',
  ].join('\n');
}

/**
 * Question already names files/symbols/@kit — prefer explore over FTS search.
 */
export function queryShouldPreferExploreOverSearch(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (queryLooksLikeLiteralOrCopyHunt(query) && !queryAsCodeChangeOrientation(query)) return false;
  if (queryAsCodeChangeOrientation(query)) return true;
  if (/^[A-Za-z_][\w]*$/.test(q)) return true;
  if (
    extractFileBasenamesFromQuery(query).length > 0
    || extractTypeNamesFromQuery(query).length > 0
    || extractMemberAccessFromQuery(query).length > 0
    || extractImportSearchTerms(query).length > 0
    || extractKitModuleNamesFromQuery(query).length > 0
    || extractFieldLikeSymbolsFromQuery(query).length > 0
    || queryAsConstantUsageSurvey(query)
    || queryAsDeclarationSiteSurvey(query)
    || queryAsFieldUsageSurvey(query)
    || queryAsModuleExportSurvey(query)
    || queryAsModuleDependencySurvey(query)
    || queryAsDtsWrapSurvey(query)
    || shouldBuildApiUsageSurvey(query)
    || queryAsAssignedFlagImpactSurvey(query)
    || queryAsNativeRenderThreadSurvey(query)
    || queryAsInRepoSystemCapabilityHowto(query)
    || shouldBuildHoverHandlerSurvey(query)
    || queryAsDataSourceSurvey(query)
    || queryAsksKitInstallDeps(query)
    || queryAsTypeLifecycleSurvey(query)
    || shouldBuildCallerInventory(query)
  ) {
    return true;
  }
  return extractDependencySymbolsFromQuery(query).some((d) => isDistinctiveIdentifier(d));
}

/**
 * In-repo pointer/hover handler inventory — no named Type yet, but the graph
 * still has onHover / Hover* symbols. Soft-skip→Grep lost accuracy; inventory wins.
 */
export function shouldBuildHoverHandlerSurvey(query: string): boolean {
  if (extractTypeNamesFromQuery(query).length > 0) return false;
  if (extractMemberAccessFromQuery(query).length > 0) return false;
  if (queryAsNamedComponentAction(query)) return false;
  return /悬停|\bhover\b|onHover|hoverEffect|HoverAnimation|HoverConstants/i.test(query);
}

/**
 * Framework decorator / ambient UI names — agents paste `@CustomDialog` etc.
 * Keep real *Page/*Dialog types; drop these when counting UI surfaces / anchors.
 */
export const FRAMEWORK_UI_DECORATOR_NAMES = new Set([
  'customdialog', 'component', 'entry', 'builder', 'preview', 'observed', 'observable',
  'state', 'prop', 'link', 'objectlink', 'provide', 'consume', 'watch', 'builderparam',
]);

export function isFrameworkUiDecoratorName(name: string): boolean {
  return FRAMEWORK_UI_DECORATOR_NAMES.has(name.toLowerCase());
}

/** PascalCase names that look like UI surfaces (Page / View / … / ThemeHome). */
export function queryLooksLikeUiComponentType(name: string): boolean {
  // `@CustomDialog` / bare `Component` match the suffix regex but are not app Types.
  if (isFrameworkUiDecoratorName(name)) return false;
  return /(Button|Component|View|Page|Dialog|Bar|Item|Panel|Menu|Chip|Card|Home)$/i.test(name);
}

/**
 * 2–3 concrete UI Types named together (Page+Dialog, View+Panel, …).
 * Must stay on compact explore — full findRelevantContext is a 15–30k / multi-minute
 * dump for what is a local composition / resource question.
 */
export function queryAsFocusedUiCluster(query: string): boolean {
  if (queryAsMechanismSurvey(query) || queryAsCrossModuleFlowSurvey(query)) return false;
  const types = extractTypeNamesFromQuery(query).filter(
    (t) => queryLooksLikeUiComponentType(t) && !isFrameworkUiDecoratorName(t),
  );
  return types.length >= 2 && types.length <= 3;
}

/**
 * Named Page/Component overview: which UI children / where does it navigate /
 * how does Page embed Dialog. Needs component bodies, not full-graph explore.
 */
export function queryAsComponentSurfaceSurvey(query: string): boolean {
  if (queryAsFocusedUiCluster(query)) return true;
  const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
  if (types.length < 1 || types.length > 3) return false;
  if (!types.some(queryLooksLikeUiComponentType)) return false;
  if (
    /使用了哪些|哪些UI|哪些组件|UI组件|跳转到|可以跳转|内嵌|嵌入|preview|加载|page\s+navigation|which\s+(?:ui\s+)?components|navigat|embed/i.test(
      query,
    )
  ) {
    return true;
  }
  // Bare / near-bare `ThemeHome` / `FooPage` — agents search("ThemeHome") for overview.
  return queryIsTypeNameFocus(query);
}

/**
 * In-repo kit/import **usage** inventory (call sites / which files import).
 */
export function shouldBuildKitModuleUsageSurvey(query: string): boolean {
  if (queryAsOutOfRepoSdkCatalog(query) || queryAsKitModuleCapabilitySurvey(query)) return false;
  if (
    extractKitModuleNamesFromQuery(query).length === 0
    && extractImportSearchTerms(query).length === 0
  ) {
    return false;
  }
  return (
    /依赖|引用|哪里用|哪些代码|哪里调用|哪些.*(?:依赖|引用|使用)|import\s+sites?|usages?\b|\buses\b|call\s*sites?/i.test(
      query,
    )
    // "调用 Kit 需要额外安装哪些依赖 / how to install deps for Kit"
    || queryAsksKitInstallDeps(query)
  );
}

/** "需要额外安装哪些依赖" — kit survey must include oh-package, not only imports. */
export function queryAsksKitInstallDeps(query: string): boolean {
  return (
    /额外安装|还需.*依赖|需要.*依赖|引入.*依赖|其他参数和依赖|other\s+(?:params?.{0,24})?deps?/i.test(
      query,
    )
    || /install(?:ing)?\s+(?:extra\s+)?deps?|which\s+deps?|need(?:s)?\s+(?:other\s+)?deps?/i.test(query)
    // Agent EN rewrites of 「其他参数和依赖」often drop "other/extra" and keep
    // "parameters … dependencies" / "import usage … dependencies" beside a Kit name.
    || /parameters?\s+(?:and\s+)?dependenc/i.test(query)
    || /(?:import|usage).{0,48}(?:parameters?.{0,24})?dependenc/i.test(query)
  );
}

/**
 * Member-access patterns from a query — `obj.method`, `Type.method`, or `.member`.
 * Skips `@kit.X` / `@ohos.X` module paths (those are imports, not Type.member).
 */
/** Shared-object / binary suffixes — not Type.member (libfoo.so → member "so"). */
const FILE_EXT_MEMBER_NOISE = new Set([
  'so', 'dll', 'dylib', 'a', 'lib', 'exe', 'apk', 'hap', 'bin', 'wasm', 'o', 'obj',
]);

export function extractMemberAccessFromQuery(query: string): QueryMemberAccess[] {
  const results: QueryMemberAccess[] = [];
  const seen = new Set<string>();

  for (const m of query.matchAll(/\b([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)+)\b/g)) {
    const dotted = m[1];
    if (!dotted || seen.has(dotted)) continue;
    const idx = m.index ?? 0;
    // `@kit.ArkTS` / `@ohos.foo` — module specifier, not receiver.member
    if (idx > 0 && query[idx - 1] === '@') continue;
    if (/^(?:kit|ohos)\./i.test(dotted)) continue;
    const parts = dotted.split('.');
    if (parts.length < 2) continue;
    const member = parts[parts.length - 1]!;
    if (member.length < 2) continue;
    // `libeffectrender.so` / `foo.dll` — not a member access.
    if (FILE_EXT_MEMBER_NOISE.has(member.toLowerCase())) continue;
    seen.add(dotted);
    results.push({
      receiver: parts.slice(0, -1).join('.'),
      member,
      dotted,
    });
  }

  for (const m of query.matchAll(/\.([A-Za-z_][\w]*)\b/g)) {
    const member = m[1]!;
    const idx = m.index ?? 0;
    // Skip the `.X` inside `@kit.X` / `@ohos.X`
    const before = query.slice(0, idx);
    if (/@(?:kit|ohos)$/i.test(before)) continue;
    if (FILE_EXT_MEMBER_NOISE.has(member.toLowerCase())) continue;
    const dotted = `.${member}`;
    if (seen.has(dotted)) continue;
    seen.add(dotted);
    results.push({ member, dotted });
  }

  // C++ / ArkTS qualified `Type::method` — same shape as dotted member access.
  for (const m of query.matchAll(/\b([A-Za-z_][\w]*)::([A-Za-z_][\w]*)\b/g)) {
    const receiver = m[1]!;
    const member = m[2]!;
    const dotted = `${receiver}::${member}`;
    if (seen.has(dotted) || member.length < 2) continue;
    seen.add(dotted);
    results.push({ receiver, member, dotted });
  }

  return results;
}

/** Terms for targeted import-node FTS (kit modules and their @kit.* paths). */
export function extractImportSearchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const kit of extractKitModuleNamesFromQuery(query)) {
    terms.add(kit);
    terms.add(`@kit.${kit}`);
  }
  return [...terms];
}

/** True when the file's basename matches a basename named in the query (Foo.ets, bar.ts, …). */
export function fileMatchesQueryBasename(filePath: string, basenames: string[]): boolean {
  if (basenames.length === 0) return false;
  const base = path.basename(filePath).toLowerCase();
  return basenames.some((b) => {
    const stem = b.toLowerCase();
    return base === stem || base.startsWith(`${stem}.`);
  });
}

/**
 * Full `import … from '…'` line for an import node — reads from disk when the
 * stored signature is module-only (common for @kit.* extraction).
 */
export function resolveImportLineFromNode(node: Node, projectRoot: string): string {
  const fromSig = (node.signature || '').trim();
  if (/import\b|from\s+['"]/.test(fromSig)) return fromSig;
  if (node.startLine > 0) {
    try {
      const abs = validatePathWithinRoot(projectRoot, node.filePath);
      if (abs) {
        const lines = fs.readFileSync(abs, 'utf-8').split('\n');
        const raw = (lines[node.startLine - 1] || '').trim();
        if (raw) return raw;
      }
    } catch { /* fall through */ }
  }
  return fromSig || node.name;
}

/**
 * Tokens that name the PROJECT as a whole — its `go.mod` module, `package.json`
 * name, or repo root directory — rather than any specific symbol. A user
 * naturally puts the project name in a query as context ("MyApp backend
 * routes"), but it carries no discriminative signal: when it's also a substring
 * of a symbol or path on one stack (a `MyAppFrontend/` dir, a `MyAppApp` class)
 * it lexically inflates that stack and buries the rest (#720).
 *
 * Returned normalized (lowercase, alphanumerics only) so a query word can be
 * compared by its normalized form. Only names ≥5 chars are kept — short ones
 * (`api`, `app`, `core`, `web`) collide with real query terms too often to
 * safely down-weight.
 */
export function deriveProjectNameTokens(projectRoot: string): Set<string> {
  const tokens = new Set<string>();
  const add = (raw: string | undefined | null): void => {
    if (!raw) return;
    const norm = normalizeNameToken(raw);
    if (norm.length >= 5) tokens.add(norm);
  };

  // go.mod module last segment (the most reliable signal for Go repos).
  try {
    const gomod = fs.readFileSync(path.join(projectRoot, 'go.mod'), 'utf-8');
    const m = gomod.match(/^\s*module\s+(\S+)/m);
    if (m && m[1]) add(m[1].split('/').pop());
  } catch { /* no go.mod */ }

  // package.json name (strip an `@scope/` prefix).
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    if (typeof pkg.name === 'string') add(pkg.name.replace(/^@[^/]+\//, ''));
  } catch { /* no / invalid package.json */ }

  // Repo root directory name — a fallback when neither manifest names the project.
  add(path.basename(path.resolve(projectRoot)));

  return tokens;
}

/**
 * Common stop words to filter from search queries.
 * Includes generic English + code-specific noise words.
 */
export const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'are', 'was',
  'be', 'has', 'had', 'have', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'not', 'no', 'all', 'each',
  'every', 'how', 'what', 'where', 'when', 'who', 'which', 'why',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'show', 'give', 'tell',
  'been', 'done', 'made', 'used', 'using', 'work', 'works', 'found',
  'also', 'into', 'then', 'than', 'just', 'more', 'some', 'such',
  'over', 'only', 'out', 'its', 'so', 'up', 'as', 'if',
  'look', 'need', 'needs', 'want', 'happen', 'happens',
  'affect', 'affected', 'break', 'breaks', 'failing',
  'implemented', 'implement',
  // Code-specific noise (avoid filtering common symbol names like get/set/add/build/find/list)
  'code', 'file', 'files', 'function', 'method', 'class', 'type',
  'fix', 'bug', 'called',
]);

/**
 * Lowercase API / import symbol names in a dependency question (taskpool, formInfo).
 * Used to filter import sites to the symbol actually asked about, not every @kit.ArkTS import.
 */
/**
 * Generic verbs agents put in rewritten how-implemented bags ("xml parse").
 * Not useful as dependency/import inventory filters or local-detail anchors —
 * they match every `parse`/`load` method and drown the distinctive token (xml).
 */
export const GENERIC_VERB_ANCHOR_NOISE = new Set([
  'parse', 'parsing', 'parser', 'parsers', 'load', 'save', 'read', 'write', 'update', 'delete', 'create',
  'init', 'handle', 'process', 'run', 'start', 'stop', 'open', 'close', 'convert',
  'get', 'set', 'add', 'remove', 'list', 'show', 'find',
  // Lifetime / allocator verbs — agents ask "where new/delete" and these must not
  // become explore seeds (AnimateEx.new / RdbStoreHelper.delete).
  'new', 'pointer', 'alloc', 'allocate', 'dealloc', 'deallocate', 'free', 'release',
  // Inventory / NL fillers agents leave in rewritten bags (not real symbols).
  'usage', 'usages', 'use', 'uses', 'using', 'api', 'apis', 'endpoint', 'endpoints',
  'project', 'codebase', 'repo', 'documentation', 'document', 'docs', '说明',
  // Kit-deps rewrite leftovers: "ServiceCollaborationKit import usage dependencies"
  // must NOT become import-inventory focus (matches every `import` line).
  'import', 'imports', 'importing', 'dependency', 'dependencies', 'deps', 'dep',
  'param', 'params', 'parameter', 'parameters', 'extra', 'other', 'require', 'requires',
  'calling', 'call', 'calls', 'needed', 'install', 'installing',
  // Kit catalog rewrites: "util module API functions"
  'module', 'modules', 'function', 'functions', 'feature', 'features',
  'capability', 'capabilities', 'export', 'exports',
  // Data-source EN rewrites: "badge source system service" must NOT become
  // import-inventory focus (matches every `*Service` / ServiceExtensionAbility).
  'service', 'services', 'source', 'sources', 'system', 'systems',
  'upstream', 'origin', 'origins',
  // Shared-lib / GL thread NL leftovers (not symbols).
  'context', 'opengl', 'gles', 'glesv3', 'egl',
]);

export function extractDependencySymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();
  for (const ma of extractMemberAccessFromQuery(query)) {
    if (ma.member.length >= 3 && !STOP_WORDS.has(ma.member.toLowerCase())) {
      if (!GENERIC_VERB_ANCHOR_NOISE.has(ma.member.toLowerCase())) symbols.add(ma.member);
    }
  }
  for (const f of extractFieldLikeSymbolsFromQuery(query)) symbols.add(f);
  // ≥3-char lowercase tokens (includes xml); drop generic verbs.
  for (const m of query.matchAll(/\b([a-z][a-zA-Z0-9]{2,})\b/g)) {
    const sym = m[1]!;
    if (STOP_WORDS.has(sym.toLowerCase())) continue;
    if (GENERIC_VERB_ANCHOR_NOISE.has(sym.toLowerCase())) continue;
    symbols.add(sym);
  }
  // Lowercase API tokens (statfs, napi_wrap) when the query is clearly about code.
  if (queryMentionsCodeContext(query)) {
    for (const m of query.matchAll(/\b([a-z][a-z0-9_]{4,})\b/g)) {
      const sym = m[1]!;
      if (GENERIC_VERB_ANCHOR_NOISE.has(sym)) continue;
      if (!STOP_WORDS.has(sym) && isDistinctiveIdentifier(sym)) symbols.add(sym);
      else if (!STOP_WORDS.has(sym) && sym.length >= 6) symbols.add(sym);
    }
  }
  for (const kit of extractKitModuleNamesFromQuery(query)) {
    symbols.delete(kit);
    symbols.delete(kit.charAt(0).toLowerCase() + kit.slice(1));
  }
  return [...symbols];
}

/**
 * Query text names a config/manifest file by basename + extension (structural, not a hardcoded whitelist).
 */
export function queryNamesConfigFile(query: string): boolean {
  if (/\b[\w./\\-]+\.(?:json5?|ya?ml|toml|xml|ini|properties)\b/i.test(query)) return true;
  const basenames = extractFileBasenamesFromQuery(query);
  if (basenames.length === 0) return false;
  return /\.(?:json5?|ya?ml|toml)/i.test(query);
}

/** Query names concrete import/kit/symbol tokens usable to filter dependency sites. */
export function hasSymbolFilterInQuery(query: string): boolean {
  return (
    extractDependencySymbolsFromQuery(query).length > 0
    || extractKitModuleNamesFromQuery(query).length > 0
    || extractImportSearchTerms(query).length > 0
  );
}

/** Import-inventory omit/compact — @kit.* or distinctive symbol; not generic terms like "item". */
export function hasImportInventoryFilter(query: string): boolean {
  if (extractKitModuleNamesFromQuery(query).length > 0) return true;
  const deps = extractDependencySymbolsFromQuery(query).filter((d) => !isMemberLikeIdentifier(d));
  if (deps.some((d) => isDistinctiveIdentifier(d))) return true;
  // API usage surveys (statfs, napi_wrap) — filter to the named API token.
  if (queryAsApiUsageSurvey(query) && deps.some((d) => d.length >= 5)) return true;
  return false;
}

/** Where-is-API-used / call-site intent (statfs, snake_case APIs, "哪里使用了 X"). */
export function queryAsApiUsageSurvey(query: string): boolean {
  return (
    /哪里使用|何处使用|哪些地方使用|在哪里使用|什么地方使用|项目中.*使用|使用了.*API|API端点|调用.*API|使用了哪些调用|哪些调用方法|调用方法|使用了哪些方法|哪些组件使用|哪些.*使用了|使用了\s*\.|自定义绘制|where\s+(?:is|are).+(?:used|called)|which\s+(?:files?|code|components?)\s+(?:use|call)/i.test(
      query,
    )
    // Agent rewrites (Telephony API usages / call methods in the project).
    || /\bAPI\s+usages?\b/i.test(query)
    || /\busages?\s+(?:of|for|in)\b/i.test(query)
    || /\bcall\s+methods?\b/i.test(query)
    || /\b(?:used|called)\s+(?:methods?|APIs?)\b/i.test(query)
    || /\bin(?:\s+the)?\s+project\b.{0,40}\b(?:API|usages?|methods?|calls?)\b/i.test(query)
    || /\b(?:API|usages?|methods?|calls?)\b.{0,40}\bin(?:\s+the)?\s+project\b/i.test(query)
  );
}

/**
 * Member / field symbols agents paste for cross-file usage hunts (`m_eglMutex`,
 * `drawModifier`). Distinct from PascalCase Types.
 */
export function extractFieldLikeSymbolsFromQuery(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(/\b(m_[A-Za-z][\w]{2,})\b/g)) {
    if (m[1]) out.add(m[1]);
  }
  for (const m of query.matchAll(/\b([A-Za-z][\w]*(?:Mutex|Lock))\b/g)) {
    if (m[1] && m[1].length >= 4) out.add(m[1]);
  }
  return [...out];
}

/** Named Type + declaration / id / native-binding sites across files. */
export function queryAsDeclarationSiteSurvey(query: string): boolean {
  const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
  if (types.length < 1 || types.length > 3) return false;
  return (
    /在哪些文件|哪些文件.*(?:声明|定义|出现)|被声明|声明了|id\s*分别|各自绑定|绑定到|which\s+files?.{0,80}(?:declar|defin|appear)|where\s+(?:is|are).{0,40}declar/i.test(
      query,
    )
    // Agent English rewrites: "XComponent declaration id native render binding"
    || /\bdeclarations?\b/i.test(query)
    || /\bdeclared\b/i.test(query)
    || (/\bids?\b/i.test(query) && /\b(?:bind|binding|native|renderer|xcomponent)\b/i.test(query))
  );
}

/**
 * How-to get a system setting/capability *as used in this repo* (language/locale/…).
 * Must NOT become a light-mechanism dump of every `language` import.
 */
export function queryAsInRepoSystemCapabilityHowto(query: string): boolean {
  if (extractTypeNamesFromQuery(query).some((t) => /Manager|Service|Controller/i.test(t))) {
    // Named Manager data-source / lifecycle owns those questions.
    if (queryAsDataSourceSurvey(query) || queryAsTypeLifecycleSurvey(query)) return false;
  }
  return (
    /如何获取系统|怎样获取系统|怎么获取系统|获取系统当前|系统当前设置|系统.*语言|当前设置的语言/i.test(query)
    || /how\s+to\s+get\s+(?:the\s+)?system\s+(?:language|locale|setting)/i.test(query)
    || (
      /\b(?:language|locale|i18n)\b/i.test(query)
      && /(?:获取|当前设置|get\s+system|system\s+(?:language|locale))/i.test(query)
    )
  );
}

/**
 * "Who uses the return value of Type.member / fn" — callers of the member, not a
 * create→get flow dump or an import flood on leftover words like `state`.
 */
export function queryAsReturnValueConsumerSurvey(query: string): boolean {
  const hasMember =
    extractMemberAccessFromQuery(query).length > 0
    || extractLocalDetailAnchors(query).some((n) => isMemberLikeIdentifier(n));
  if (!hasMember && extractTypeNamesFromQuery(query).length === 0) return false;
  return (
    /返回结果被|返回值.*(?:被|由).*(?:使用|调用)|其返回.*使用|返回结果.*哪些/i.test(query)
    || /who\s+uses\s+the\s+(?:return|result)|return(?:ed)?\s+(?:value|result).{0,80}(?:used|consum)/i.test(query)
    || /哪些其他函数使用|被项目中哪些.{0,20}函数使用|which\s+(?:other\s+)?functions?\s+use/i.test(query)
  );
}

/** ALL_CAPS constants — where used / which scenarios (not "what does this macro mean"). */
export function queryAsConstantUsageSurvey(query: string): boolean {
  const caps = [...query.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map((m) => m[1]!);
  // Enum-style `Type.MEMBER` / `audio.Type.RINGTONE` — ALL_CAPS member (with or without `_`).
  const dottedCaps = [
    ...query.matchAll(/\.[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g),
  ]
    .map((m) => m[0]!.slice(1))
    .filter((s) => s === s.toUpperCase() && s.length >= 3);
  const all = [...new Set([...caps, ...dottedCaps])];
  if (all.length === 0) return false;
  return /用于|场景|哪里用|哪些.*用|依赖|调用|where\s+(?:is|are).+used|which\s+(?:scenarios?|functions?)|what\s+(?:are\s+)?(?:they|these)\s+for|which\s+methods?.{0,20}(?:call|depend)/i.test(
    query,
  );
}

/** Field / mutex / lock — which other functions also touch it. */
export function queryAsFieldUsageSurvey(query: string): boolean {
  if (extractFieldLikeSymbolsFromQuery(query).length === 0) return false;
  return (
    /哪些函数|还会用到|用到这个|哪些.*(?:用到|使用)|who\s+(?:else\s+)?(?:uses|locks)|which\s+functions?.{0,40}(?:use|lock|mutex)|\bmutex\b|这[个把]锁/i.test(
      query,
    )
    // Lifetime: where is m_foo new'd / delete'd / freed.
    || /new\s*出来|被\s*new|delete\s*掉|被\s*delete|new\s*\/\s*delete|(?:哪里|哪些地方).{0,12}(?:new|delete)|(?:new|delete).{0,20}(?:哪里|哪些)|被释放|释放掉|allocat|deallocat|where.{0,40}(?:new|delete|allocat|free)/i.test(
      query,
    )
  );
}

/**
 * Native shared lib + GL/EGL thread questions (`libfoo.so` … OpenGL … 哪个线程).
 * Light-mechanism (CMake + named Draw/Render/EGL owners), not `.so` member survey.
 */
export function queryAsNativeRenderThreadSurvey(query: string): boolean {
  const hasLib =
    /\b\w+\.(?:so|dll|dylib)\b/i.test(query)
    || /\blib\w+\b/i.test(query);
  const hasGl = /\b(?:GLES(?:v3)?|EGL|OpenGL)\b/i.test(query);
  const hasThread = /线程|thread|UI\s*线程|主线程|JS\s*主?线程/i.test(query);
  if ((hasLib || hasGl) && hasThread) return true;
  // Named Draw/Render/EGL owner + frame-sync / sub-thread (no project Type list).
  if (
    /\b(?:[A-Z][A-Za-z0-9]*(?:Draw|Render)|EGL(?:Core)?|EglCore)\b/.test(query)
    && /帧同步|撕裂|tearing|frame\s*sync|synchron|mutex|sub-?thread|子线程/i.test(query)
  ) {
    return true;
  }
  return false;
}

/** Named `.d.ts` wrap — what calls / imports it in-repo. */
export function queryAsDtsWrapSurvey(query: string): boolean {
  if (!/\.d\.ts\b/i.test(query) && extractFileBasenamesFromQuery(query).length === 0) {
    return false;
  }
  if (!/\.d\.ts\b/i.test(query)) return false;
  return /封装|wrap(?:s|ped)?|调用|哪里|功能|where|called|uses?|import/i.test(query);
}

/**
 * Assigned flag / boolean field impact on later call timing
 * (`isChangeSurface = true` … 如何影响 … 时序).
 */
export function queryAsAssignedFlagImpactSurvey(query: string): boolean {
  const hasAssign =
    /=\s*(?:true|false)\b/i.test(query)
    || /设置\s*\w+.*=/.test(query)
    || /里设置\s+\w+/i.test(query)
    || /\bsets?\s+\w+\s*=\s*(?:true|false)\b/i.test(query);
  const hasImpact =
    /影响|时序|后续|how\s+(?:does|will).{0,40}affect|affect.{0,40}timing/i.test(query);
  if (!hasAssign || !hasImpact) return false;
  return extractLocalDetailAnchors(query).length >= 1;
}

/**
 * Named Toggle/control kept consistent across surfaces — which module guarantees it.
 */
export function queryAsNamedControlStateSyncSurvey(query: string): boolean {
  // Prefer Toggle/Switch anchors — bag-of-words rewrites often add Control/Center noise Types.
  const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
  const controlTypes = types.filter((t) => /Toggle|Switch|开关/i.test(t));
  const anchors = controlTypes.length > 0 ? controlTypes : types;
  if (anchors.length < 1 || anchors.length > 3) return false;
  return (
    /状态一致|保持一致|多处|多端|哪个模块保证|who\s+keeps|consistent\s+state|state\s+consistenc|state\s+sync|consistenc(?:y|ies)|guarantees?\s+it|which\s+module\s+guarantees|across\s+(?:surfaces|places)/i.test(
      query,
    )
    || (
      /Toggle|Switch|开关/i.test(query)
      && /一致|保证|模块|consistenc|consistent|guarantees?/i.test(query)
    )
  );
}

/**
 * Methods listed beside a Type for caller inventories
 * (`BinaryGrid … Set、Test 或 Fill` — including short verbs normally treated as noise).
 */
export function extractListedTypeMethodsFromQuery(query: string): string[] {
  if (!queryAsCallerOrMethodSurvey(query)) return [];
  const types = extractTypeNamesFromQuery(query);
  if (types.length === 0) return [];
  // Owning Type(s): longer CamelCase — short Set/Test/Fill are method tokens, not owners.
  const owners = new Set(
    types.filter((t) => t.length >= 6 || /(?:Grid|Manager|Service|Controller|Render|Plugin|Layout)/i.test(t)),
  );
  if (owners.size === 0) {
    // Fall back to longest type name as owner.
    const longest = [...types].sort((a, b) => b.length - a.length)[0];
    if (longest) owners.add(longest);
  }
  const out = new Set<string>();
  // `Set、Test 或 Fill` / `Set, Test, or Fill` — list of PascalCase methods.
  for (const m of query.matchAll(
    /\b([A-Z][A-Za-z0-9]{1,})(?:\s*[、,]\s*([A-Z][A-Za-z0-9]{1,}))+(?:\s*(?:或|or)\s*([A-Z][A-Za-z0-9]{1,}))?/g,
  )) {
    for (let i = 1; i < m.length; i++) {
      const name = m[i];
      if (name && !owners.has(name) && name.length >= 2) out.add(name);
    }
  }
  // `的 Set` / `methods Set` / `调用了 Set` (owner already required above).
  for (const m of query.matchAll(
    /(?:的|of|模板类的|类的|methods?)\s+([A-Z][A-Za-z0-9]{1,})\b/g,
  )) {
    const name = m[1]!;
    if (!owners.has(name) && name.length >= 2) out.add(name);
  }
  return [...out].slice(0, 8);
}

/** Path module + NAPI / exported API surface (or named Type + NAPI/expose). */
export function queryAsModuleExportSurvey(query: string): boolean {
  const napi =
    /NAPI|napi|暴露了哪些|暴露哪些|暴露给|expose(?:d|s)?\s+to|napi_module_register|哪些\s*API|API\s*接口|exports?\s+(?:which|what)|which\s+(?:APIs?|exports?)/i.test(
      query,
    );
  if (!napi) return false;
  if (extractPathSegmentsFromQuery(query).length > 0) return true;
  // "LayoutRotatePacking … NAPI expose to ArkTS" — no path segment required.
  if (extractTypeNamesFromQuery(query).length > 0) return true;
  return false;
}

/** Multi-module path interdependence (A/B/C… mutual deps). */
export function queryAsModuleDependencySurvey(query: string): boolean {
  const paths = extractPathSegmentsFromQuery(query);
  const moduleTokens = query.match(
    /\b[A-Za-z][\w]*(?:common|service|component|constants)\b/gi,
  ) ?? [];
  const circular = /循环依赖|circular\s+depend|互为依赖/i.test(query);
  // "commonconstants … 循环依赖" — one module token + cycle intent is enough.
  if (circular && (paths.length + moduleTokens.length >= 1 || /\b[a-z][a-z0-9_]{5,}\b/.test(query))) {
    return true;
  }
  if (paths.length + moduleTokens.length < 2) return false;
  return /相互依赖|互相依赖|之间.*依赖|依赖关系|depend(?:ency|encies| on each other)|cross-?depend/i.test(
    query,
  );
}

/**
 * Single named Type + state/lifecycle/callback surface — needs the type body,
 * not a thin callers stub.
 */
/**
 * Repo-wide literal / copy / "imported text object" hunts — Grep territory.
 * Shape-only: no PascalCase Type / file / member / kit anchors.
 */
export function queryLooksLikeLiteralOrCopyHunt(query: string): boolean {
  // Layout/style literal chains first — `.width('100%')` looks like member access
  // to extractors but is Grep territory.
  if (
    /检索所有\s*\.\w+\(\s*['"][^'"]+['"]\s*\)/i.test(query)
    || /\.\w+\(\s*['"][^'"]{1,40}['"]\s*\).{0,80}\.\w+\(\s*['"][^'"]{1,40}['"]\s*\)/i.test(query)
  ) {
    if (extractTypeNamesFromQuery(query).length === 0
      && extractFileBasenamesFromQuery(query).length === 0
      && extractKitModuleNamesFromQuery(query).length === 0) {
      return true;
    }
  }
  if (extractTypeNamesFromQuery(query).length > 0) return false;
  if (extractFileBasenamesFromQuery(query).length > 0) return false;
  if (extractMemberAccessFromQuery(query).length > 0) return false;
  if (extractKitModuleNamesFromQuery(query).length > 0) return false;
  if (extractFieldLikeSymbolsFromQuery(query).length > 0) return false;
  return (
    /全仓|全搜|字面量|中文\s*(?:text|字符串)|绑了.*(?:text|文案)|literal\s+strings?/i.test(query)
    || /从.{0,16}包.{0,40}(?:导入|import).{0,20}\btext\b|导入的\s*text\s*对象|imported\s+text\s+objects?/i.test(
      query,
    )
  );
}

/**
 * Container page + ViewModel/config injection — which pages share a shell
 * component and pass differentiated state into a shared ViewModel.
 */
export function queryAsContainerCompositionSurvey(query: string): boolean {
  if (queryAsMechanismSurvey(query) || queryAsCrossModuleFlowSurvey(query)) return false;
  const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
  const hasContainerAsk =
    (/共享|共用|share|shared/i.test(query) && /容器|container|Screen|Page|View/i.test(query))
    || types.some((t) => /(?:Screen|Page|View|Container)$/i.test(t));
  const hasInjectAsk = /注入|inject|差异化|differentiat|配置|config|property/i.test(query);
  const hasViewModel = types.some((t) => /ViewModel$/i.test(t)) || /\bViewModel\b/i.test(query);
  return (hasContainerAsk && hasInjectAsk && (hasViewModel || types.length >= 2))
    || (types.length >= 2
      && types.some((t) => /(?:Screen|Page|View|Container)$/i.test(t))
      && types.some((t) => /ViewModel$/i.test(t))
      && hasInjectAsk);
}

/**
 * Named member + UI consequence ("how does UI mark/show when member returns true").
 * Definition/filter sites alone are rarely sufficient — steer to UI evidence.
 */
export function queryAsMemberUiConsequenceSurvey(query: string): boolean {
  if (!queryHasNamedMemberFocus(query)) return false;
  if (queryAsCoNamedTypeMethodInteraction(query)) return false;
  return (
    /UI|界面|显示|标记|展示|render|visual|样式|效果|\bmark\b/i.test(query)
    && /如何|怎样|what|how/i.test(query)
  );
}

export function queryAsTypeLifecycleSurvey(query: string): boolean {
  if (queryAsCrossModuleFlowSurvey(query)) return false;
  // "状态来源" is a data-source inventory, not a lifecycle body dump.
  if (/状态来源|status\s+source|state\s+source/i.test(query)) return false;
  // Release ↔ destructor compare may name CB + Manager + Render.
  if (
    /析构|destructor/i.test(query)
    && /Release|做了哪些|有没有重复|跟.+做的事|same\s+(?:work|things?)|overlap/i.test(query)
  ) {
    return extractLocalDetailAnchors(query).length >= 1;
  }
  const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
  if (types.length < 1 || types.length > 2) return false;
  return /状态机|状态变化|状态转换|状态.*回调|回调.*状态|foreground|background|lifecycle|state\s*machine|哪些状态|state\s+change|how\s+(?:are|is)\s+.+states?\s+(?:unified|distinguished)/i.test(
    query,
  );
}

/**
 * Member-access inventory ("which files use .drawModifier") — not Type×method
 * interaction / Export fail wiring / Release↔dtor (those need compact bodies).
 */
export function shouldPreferMemberUsageInventory(query: string): boolean {
  if (queryAsCoNamedTypeMethodInteraction(query)) return false;
  if (queryAsTypeLifecycleSurvey(query)) return false;
  if (queryAsFieldUsageSurvey(query)) return true;
  if (extractMemberAccessFromQuery(query).length === 0) return false;
  // Conditional wiring / interaction / purpose → compact, not member-file list.
  if (
    /失败时|还会被|是怎么|交互|析构|destructor|做了哪些|什么作用|做什么|purpose|what\s+does/i.test(
      query,
    )
  ) {
    return false;
  }
  return /哪些|哪里|where|which|使用了|谁用|call\s*sites?/i.test(query);
}

/** API / SDK tokens named in the query — lowercase deps + PascalCase modules (Telephony). */
export function extractApiUsageTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const d of extractDependencySymbolsFromQuery(query)) {
    if (d.length >= 4) tokens.add(d);
  }
  for (const t of extractTypeNamesFromQuery(query)) {
    if (t.length >= 4 && !isFrameworkUiDecoratorName(t)) tokens.add(t);
  }
  for (const ma of extractMemberAccessFromQuery(query)) {
    if (ma.member.length >= 3) tokens.add(ma.member);
  }
  for (const f of extractFieldLikeSymbolsFromQuery(query)) tokens.add(f);
  for (const m of query.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    if (m[1] && m[1].length >= 6) tokens.add(m[1]);
  }
  // "statfs这个API端点" / "使用了statfs这个API" — Chinese demonstrative after the symbol.
  for (const m of query.matchAll(/\b([A-Za-z_][\w]{2,})\s*这个\s*(?:API|接口|端点|方法)/gi)) {
    if (m[1] && !GENERIC_VERB_ANCHOR_NOISE.has(m[1].toLowerCase())) tokens.add(m[1]);
  }
  // When a PascalCase SDK/module token is present (Telephony, DrawContext), drop
  // short lowercase bag noise agents add (`call`/`radio`/`usage`) — those flood
  // false-positive files and tank precision.
  const primary = [...tokens].filter(
    (t) =>
      (/^[A-Z]/.test(t) && t.length >= 4)
      || t.startsWith('@')
      || /^(?:statfs|napi_\w+)$/i.test(t)
      || extractFieldLikeSymbolsFromQuery(query).includes(t)
      || extractMemberAccessFromQuery(query).some((m) => m.member === t || m.dotted === t),
  );
  if (primary.length > 0) return primary.slice(0, 8);
  return [...tokens].filter((t) => t.length >= 4 && !GENERIC_VERB_ANCHOR_NOISE.has(t.toLowerCase())).slice(0, 8);
}

export function shouldBuildApiUsageSurvey(query: string): boolean {
  // Declaration-site surveys have their own section — do NOT also claim API-usage
  // (that used to fire after an empty declaration scan and dump include hits).
  if (queryAsDeclarationSiteSurvey(query)) return false;
  if (queryAsConstantUsageSurvey(query)) return true;
  if (queryAsFieldUsageSurvey(query)) return true;
  return queryAsApiUsageSurvey(query) && extractApiUsageTokens(query).length > 0;
}

/** Caller / method survey intent — not every PascalCase token. */
export function queryAsCallerOrMethodSurvey(query: string): boolean {
  if (
    /哪里调用|何处调用|谁调用|调用了|被调用|callers?\s+of|who\s+calls|called\s+by|哪些.*调用|外部.*调用|\bexternal\b/i.test(query)
    || /哪些方法|which\s+methods|methods?\s+(?:are\s+)?called|which\s+files?.{0,20}(?:call|invoke)/i.test(query)
    // Agents often write "Type … methods … callers" / bare "callers" without "of".
    || /\bcallers?\b/i.test(query)
    || /methods?.{0,40}\bcall/i.test(query)
  ) {
    return true;
  }
  // Agent EN rewrites of "Type 有哪些方法被外部调用" often become
  // "Type class definition methods" and lose 调用 — still route to caller inventory
  // when a named Type + plural methods bag is present. Singular "method" is too
  // broad ("Session method helper" is a symbol bag, not a caller survey).
  if (extractTypeNamesFromQuery(query).length > 0 && /\bmethods\b/i.test(query)) {
    return true;
  }
  return false;
}

/**
 * Query is essentially just type name(s) (plus filler). Used for *inheritance*
 * surveys when agents pass bare `Rectangle` — NOT for every PascalCase token
 * (that wrongly classified callbacks like `OnSurfaceChangedCB` as types and
 * blocked the compact callable path).
 */
export function queryIsTypeNameFocus(query: string): boolean {
  const types = extractTypeNamesFromQuery(query);
  if (types.length < 1 || types.length > 3) return false;
  // Callable-ish suffixes — treat as function/method focus, not type hierarchy.
  if (types.every((t) => /(?:CB|Callback|Handler|Listener|Fn|Func|Proc)$/i.test(t))) {
    return false;
  }
  let rest = query;
  for (const t of types) {
    rest = rest.replace(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
  }
  rest = rest
    .replace(
      /\b(class|struct|interface|type|enum|the|a|an|of|for|in|project|code|repo|file|files|what|which|who|how|is|are|does|do|list|show|find|get|all|有哪些|哪些|什么|是|的|类|项目中|项目里)\b/gi,
      ' ',
    )
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .trim();
  return rest.length === 0;
}

/** Subtype / extends-base intent (Chinese 子类 or English subclass/extends Type). */
export function queryAsInheritanceSurvey(query: string): boolean {
  // Note: `subclasses?` does NOT match "subclass" (the `?` only applies to the
  // final `s` of "subclasses"). Use `subclass(?:es)?`.
  // Likewise `extend(?:s|ing)` requires a suffix — bare "extend" needs `extends?`.
  return (
    /子类|继承|subclass(?:es)?/i.test(query)
    || /\bextends\s+[A-Z][A-Za-z0-9_]*/.test(query)
    || /\b(?:classes?\s+)?(?:that\s+)?extends?\s+[A-Z][A-Za-z0-9_]*/i.test(query)
  );
}

export function shouldBuildCallerInventory(query: string): boolean {
  if (extractCallerSurveySymbols(query).length === 0) return false;
  // "Which Telephony methods does the project use" is an API/import survey —
  // not a class→callers inventory (SDK modules often have zero local defs).
  if (
    shouldBuildApiUsageSurvey(query)
    && /使用了哪些调用|哪些调用方法|调用方法|使用了哪些方法/.test(query)
  ) {
    return false;
  }
  // Return-value consumers: list callers of the named member/fn.
  if (queryAsReturnValueConsumerSurvey(query)) return true;
  // Require real caller/method intent — bare PascalCase alone is NOT enough
  // (that emptied inventory → blocked compact → 15K full explore on callbacks).
  return queryAsCallerOrMethodSurvey(query);
}

/** Symbols to list callers for — types, free functions (SortWidgets), snake_case APIs. */
export function extractCallerSurveySymbols(query: string): string[] {
  const names = new Set<string>(extractTypeNamesFromQuery(query));
  const wantMembers =
    queryAsCallerOrMethodSurvey(query) || queryAsReturnValueConsumerSurvey(query);
  if (!wantMembers) return [...names].filter((n) => n.length >= 3);
  for (const d of extractDependencySymbolsFromQuery(query)) {
    if (d.length >= 4) names.add(d);
  }
  for (const ma of extractMemberAccessFromQuery(query)) {
    names.add(ma.member);
    if (ma.receiver) names.add(ma.receiver);
  }
  for (const a of extractLocalDetailAnchors(query)) {
    if (isMemberLikeIdentifier(a) || /^(?:get|set|is|has|create|on)[A-Z]/.test(a)) {
      names.add(a);
    }
  }
  // Type + listed methods (BinaryGrid Set/Test/Fill) — keep short verbs co-named with a Type.
  for (const m of extractListedTypeMethodsFromQuery(query)) names.add(m);
  // "通过 getConnectionState 获取…" — bare camelCase after 通过/via is the consumer target.
  for (const m of query.matchAll(
    /(?:通过|经由|via|using|call(?:ing)?)\s*([a-z][a-zA-Z0-9]{3,})\b/g,
  )) {
    if (m[1] && (/^(?:get|set|is|has|create|on)[A-Z]/.test(m[1]) || isMemberLikeIdentifier(m[1]))) {
      names.add(m[1]);
    }
  }
  const all = [...names].filter((n) => n.length >= 3);
  if (!queryAsReturnValueConsumerSurvey(query)) return all;
  // Prefer the member whose return value is consumed over a preceding create/factory.
  const preferred = all.filter(
    (n) => /^(?:get|is|has)[A-Z]/.test(n) || /State|Result|Status|Value$/i.test(n),
  );
  if (preferred.length === 0) return all;
  const rest = all.filter((n) => !preferred.includes(n));
  return [...preferred, ...rest];
}

/** Cross-module call-chain intent (A → B → engine). */
export function queryAsCrossModuleFlowSurvey(query: string): boolean {
  const types = extractTypeNamesFromQuery(query);
  if (types.length < 2) return false;
  // Note: bare 渲染 alone is too common (flag-impact / UI surface) — require a
  // real cross-hop cue with it.
  return (
    /经过|跨模块|调用链|链路|流程|到达|落到|再到|落盘|then\s+to|across\s+modules/i.test(query)
    || (/渲染/.test(query) && /跨模块|经过|再到|落到|链路|call\s*chain/i.test(query))
  );
}

/** Data-source / upstream-service intent (来源于哪个服务 / which service). */
export function queryAsDataSourceSurvey(query: string): boolean {
  if (
    /来源于|数据来源|状态来源|来自哪个|哪个系统服务|来自什么服务|data\s+source|status\s+source|state\s+source|which\s+service|来源.*服务|如何统一或区分/i.test(
      query,
    )
  ) {
    return true;
  }
  // Agent EN / bag-of-words rewrites of the same intent.
  if (/\bsystem\s+service\b/i.test(query)) return true;
  if (/\bupstream\s+(?:service|source|data)\b/i.test(query)) return true;
  if (/\bsource\b.{0,48}\b(?:system\s+)?service\b/i.test(query)) return true;
  if (/\b(?:data|status|state)\b.{0,48}\bsource\b/i.test(query)) return true;
  return false;
}

/** "How are sources unified/distinguished" — inventory alone is Partial, not ANSWER NOW. */
export function queryAsDataSourceDistinguishAsk(query: string): boolean {
  if (
    /如何统一或区分|统一或区分|区分.*来源|来源.*区分|unify|distinguish|how\s+(?:are|is).{0,40}(?:unified|distinguished)/i.test(
      query,
    )
  ) {
    return true;
  }
  // Rewrites may drop 「如何统一或区分」but keep 状态来源 / status|state source.
  if (/哪个系统服务|which\s+system\s+service|来源于哪个|来自哪个系统/i.test(query)) {
    return false;
  }
  if (/\bsystem\s+service\b/i.test(query) && !/状态来源|status\s*source|state.{0,24}source/i.test(query)) {
    return false;
  }
  return /状态来源|status\s*source|state\s+change\s+source|state.{0,24}source/i.test(query);
}

/**
 * ≥3 named Types + dependency/relationship ask — inventory edges, not a fat
 * multi-body compact that hits the soft deadline.
 */
export function queryAsMultiTypeDependencySurvey(query: string): boolean {
  const types = extractTypeNamesFromQuery(query).filter(
    (t) =>
      t.length >= 8
      || /(?:Manager|Installer|Parser|Service|Controller|Handler|Provider|Store)$/i.test(t),
  );
  if (types.length < 3) return false;
  return /依赖|关系|互相|之间|调用关系|dependenc|relationship|how\s+(?:do|are).{0,40}relate|related/i.test(
    query,
  );
}

/**
 * Event-type → handler/Manager dispatch inventory
 * (`FooEvent` types / which Managers handle them).
 */
export function queryAsEventDispatchSurvey(query: string): boolean {
  const types = extractTypeNamesFromQuery(query);
  const hasEventType = types.some((t) => /Event$/i.test(t));
  const hasEventCue =
    hasEventType
    || /\b[A-Z][A-Za-z0-9]*Event\b|事件类型|事件枚举/i.test(query);
  if (!hasEventCue) return false;
  return /分发|分发给|哪些\s*Manager|handlers?|dispatch|routed?\s+to|handled\s+by|处理/i.test(
    query,
  );
}

/**
 * Local one/few-symbol behavior or contract — NOT multi-file mechanism / inventory.
 * These questions need a small body (or callers list), not a 24K related-file dump.
 */
export function extractLocalDetailAnchors(query: string): string[] {
  const names = new Set<string>();
  for (const t of extractTypeNamesFromQuery(query)) names.add(t);
  for (const d of extractDependencySymbolsFromQuery(query)) {
    if (d.length >= 3) names.add(d);
  }
  for (const ma of extractMemberAccessFromQuery(query)) {
    names.add(ma.member);
    if (ma.receiver) names.add(ma.receiver);
  }
  // ALL_CAPS / snake macros (ARGS_POS_0, KEY_CODE_POWER)
  for (const m of query.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    if (m[1] && m[1].length >= 4) names.add(m[1]);
  }
  for (const f of extractFieldLikeSymbolsFromQuery(query)) names.add(f);
  // Drop path/extension/verb noise that long NL explores otherwise seed on
  // (`cpp`, `calls`, `include`, `render`…) — that ballooned neighbor fan-out.
  const ANCHOR_NOISE = new Set([
    ...STOP_WORDS,
    'cpp', 'hpp', 'ets', 'ts', 'tsx', 'js', 'jsx', 'h', 'c', 'cc', 'cxx',
    'calls', 'call', 'calling', 'called', 'callers', 'caller', 'include', 'includes', 'import', 'imports',
    'render', 'frame', 'sync', 'thread', 'subthread', 'layout', 'method', 'methods',
    'function', 'functions', 'file', 'files', 'src', 'main', 'define', 'visible',
    'usage', 'usages', 'api', 'apis', 'project', 'codebase', 'repo',
    'language', 'locale', 'i18n', 'radio', 'state', 'communication', 'binding',
    'renderer', 'native', 'declaration', 'declarations', 'declared',
    // Generic UI nouns agents leave in NL (not the PascalCase Type).
    'dialog', 'page', 'view', 'button', 'component', 'card', 'icon', 'background',
    'animation', 'hover', 'preview', 'image', 'resource', 'network', 'application',
    'text', 'layout', 'layouts', 'string', 'strings', 'constant', 'constants',
    // Shared-lib / GL leftovers after stripping `.so`.
    'so', 'dll', 'dylib', 'libeffectrender', 'glesv3', 'opengl', 'context',
    ...GENERIC_VERB_ANCHOR_NOISE,
  ]);
  const ranked = [...names].filter((n) => n.length >= 3 && !ANCHOR_NOISE.has(n.toLowerCase()));
  // Prefer PascalCase / dotted members first — they're the real anchors.
  ranked.sort((a, b) => {
    const score = (s: string) => (/^[A-Z]/.test(s) ? 2 : 0) + (s.includes('.') ? 1 : 0) + Math.min(s.length, 20) / 20;
    return score(b) - score(a) || a.localeCompare(b);
  });
  // Drop framework decorator names when a concrete UI Type is also present
  // (`@CustomDialog` + `FooDialog` → keep only the concrete UI types).
  const hasConcreteUi = ranked.some(
    (n) => queryLooksLikeUiComponentType(n) && !isFrameworkUiDecoratorName(n),
  );
  const filtered = hasConcreteUi
    ? ranked.filter((n) => !isFrameworkUiDecoratorName(n))
    : ranked;
  return filtered.slice(0, 4);
}

/**
 * Caller survey that also asks how a co-named type becomes visible / used.
 * Inventory-only (paths) is incomplete — need compact body + callers together.
 */
export function queryNeedsCoNamedUseBridge(query: string): boolean {
  if (!queryAsCallerOrMethodSurvey(query)) return false;
  const anchors = extractLocalDetailAnchors(query);
  if (anchors.length < 2) return false;
  // Narrow intent — how a co-named type becomes visible / included.
  return /定义可见|确保.*可见|头文件可见|definition\s+visible|visible\s+definition|how\s+.+\s+visible|makes?\s+.+\s+visible|如何确保.*可见/i.test(
    query,
  );
}

export function queryAsLocalSymbolDetail(query: string): boolean {
  if (queryAsCrossModuleFlowSurvey(query)) return false;
  if (queryAsDomainFileSurvey(query)) return false;
  if (shouldBuildKitModuleUsageSurvey(query)) return false;
  // Cross-file API / declaration / constant / field inventories — not definition-only.
  if (shouldBuildApiUsageSurvey(query) && !queryAsTypeLifecycleSurvey(query)) return false;
  if (queryAsModuleExportSurvey(query) || queryAsModuleDependencySurvey(query)) return false;
  if (queryAsInRepoSystemCapabilityHowto(query)) return false;
  if (queryAsReturnValueConsumerSurvey(query)) return false;
  if (queryAsDeclarationSiteSurvey(query)) return false;
  // lib*.so + GL thread → light-mechanism, not compact OpenGL/context seeds.
  if (queryAsNativeRenderThreadSurvey(query)) return false;
  // Assigned flag impact → compact body. Named Toggle sync may have zero FTS
  // hits for the Type — inventory owns that shape instead.
  if (queryAsAssignedFlagImpactSurvey(query)) return true;
  if (queryAsNamedControlStateSyncSurvey(query)) return false;
  // Caller + co-named visibility → compact (body + callers), not inventory-only.
  if (queryNeedsCoNamedUseBridge(query)) return true;
  if (shouldBuildCallerInventory(query)) return false;
  if (queryAsDataSourceSurvey(query)) return false;
  if (queryAsEventDispatchSurvey(query)) return false;

  // Named UI control + event: compact body + callees (not import inventory).
  if (queryAsNamedComponentAction(query)) return true;

  // Page/Component surface or 2–3 UI Type cluster — body, not full-graph explore.
  if (queryAsComponentSurfaceSurvey(query) || queryAsFocusedUiCluster(query)) return true;

  // Named Type + state/lifecycle surface — full type body.
  if (queryAsTypeLifecycleSurvey(query)) return true;

  // Release vs destructor / multi-method compare on named anchors.
  if (
    extractLocalDetailAnchors(query).length >= 2
    && /析构|destructor|有没有重复|是否重复|跟.+做的事|做了哪些事情/i.test(query)
  ) {
    return true;
  }

  // Type.member / Type + isFoo co-named — even if the agent used 怎么/如何 NL.
  if (queryHasNamedMemberFocus(query)) return true;

  if (queryAsMechanismSurvey(query)) return false;

  const anchors = extractLocalDetailAnchors(query);
  if (anchors.length < 1) return false;

  if (queryAsInterpretationSurvey(query)) return true;

  const pinpoint =
    /什么作用|做什么|起什么|用途|含义|语义|什么功能|上下游|上游|下游|upstream|downstream|返回|失败|为\s*0|为0|时(?:会|会)|会如何|会怎样|会发生什么|是否(?:应该|会|能)|Promise|async|同步|异步|宏定义|宏|指针|生命周期|冲突|误响应|触发|什么时候|入参|when\s+.+\s+(?:return|fail|trigger)|what\s+does|what\s+happens|meaning|purpose/i.test(
      query,
    )
    || (/回调|callback/i.test(query) && anchors.length > 0);

  if (!pinpoint) return false;
  const types = extractTypeNamesFromQuery(query);
  if (types.length >= 5) return false;
  return true;
}

/**
 * Agent already named 1–3 concrete symbols. Those must take compact explore —
 * never fall through to findRelevantContext (10k+ Dynamic-dispatch dumps + Read).
 */
export function queryHasFocusedNamedAnchors(query: string): boolean {
  if (queryAsMechanismSurvey(query) || queryAsCrossModuleFlowSurvey(query)) return false;
  if (shouldTryFastInventoryExplore(query)) return false;
  const anchors = extractLocalDetailAnchors(query);
  if (anchors.length < 1 || anchors.length > 3) return false;
  // Require a real code anchor (PascalCase Type / member-like), not leftover
  // English topic nouns that survived domain extraction (application, …).
  return (
    extractMemberAccessFromQuery(query).length > 0
    || anchors.some((a) => /^[A-Z]/.test(a) || isMemberLikeIdentifier(a))
  );
}

/**
 * Prefer a tight explore budget: local-detail questions, or named-symbol
 * questions that are not mechanism / cross-module flows.
 */
export function shouldUseCompactExploreBudget(query: string): boolean {
  if (queryAsMechanismSurvey(query) || queryAsCrossModuleFlowSurvey(query)) return false;
  // Inventory surveys own the type-name / hierarchy / "who calls Type" shape —
  // do not shrink those into a definition-only budget.
  if (shouldTryFastInventoryExplore(query)) return false;
  if (queryAsLocalSymbolDetail(query) || queryAsFocusedUiCluster(query) || queryAsComponentSurfaceSurvey(query)) {
    return true;
  }
  if (queryIsTypeNameFocus(query)) return false;
  const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
  const deps = extractDependencySymbolsFromQuery(query);
  return types.length + deps.length >= 1 && types.length <= 3;
}

/** Keep rendering to files that define symbols named in the query. */
export function shouldFocusOnQueryNamedDefs(
  query: string,
  hasFlowPath: boolean,
  multiAnchorQuery: boolean,
): boolean {
  if (hasFlowPath || multiAnchorQuery) return false;
  if (shouldFocusOnNamedTypeFile(query, hasFlowPath, multiAnchorQuery)) return true;
  if (!queryAsLocalSymbolDetail(query) && !shouldUseCompactExploreBudget(query)) return false;
  return (
    extractTypeNamesFromQuery(query).length > 0
    || extractDependencySymbolsFromQuery(query).length > 0
    || extractMemberAccessFromQuery(query).length > 0
  );
}

/** Single named file + role/interpretation intent (test.ets method purpose). */
export function queryAsInterpretationSurvey(query: string): boolean {
  if (extractFileBasenamesFromQuery(query).length !== 1) return false;
  return /什么作用|起什么|做什么|用途|meaning|role|purpose|返回.*起|在.*中起/i.test(query);
}

/** Interpretation scoped to a `.test.ets` / `.test.ts` file — production code is out of scope. */
export function queryAsTestOnlyInterpretation(query: string): boolean {
  if (!queryAsInterpretationSurvey(query)) return false;
  return /\.test\.(?:ets|ts|tsx)\b/i.test(query);
}

/**
 * Mechanism-query entry symbol seeds from query shape — symbols the user actually named,
 * not a corpus-specific synonym table.
 */
export function extractMechanismEntrySeeds(query: string): string[] {
  const seeds = new Set<string>();
  for (const t of extractTypeNamesFromQuery(query)) seeds.add(t);
  for (const s of extractDependencySymbolsFromQuery(query)) {
    if (s.length >= 3) seeds.add(s);
  }
  for (const imp of extractImportSearchTerms(query)) seeds.add(imp);
  for (const ma of extractMemberAccessFromQuery(query)) {
    seeds.add(ma.member);
    if (ma.receiver) seeds.add(ma.receiver);
  }
  for (const m of query.matchAll(
    /\b([A-Z][A-Za-z0-9]*(?:Manager|Service|Handler|Parser|Extension|Controller|Subscriber|Provider))\b/g,
  )) {
    if (m[1]) seeds.add(m[1]);
  }
  for (const term of extractDomainSearchTerms(query)) {
    if (/^[\x00-\x7F]+$/.test(term) && IMPLEMENTATION_ENTRY_NAME_RE.test(term)) {
      seeds.add(term);
    }
  }
  // Shared-lib + GLES/EGL thread — seed Draw/Render/EGL owners named in the query.
  if (queryAsNativeRenderThreadSurvey(query)) {
    for (const t of extractTypeNamesFromQuery(query)) seeds.add(t);
    for (const m of query.matchAll(/\b([A-Z][A-Za-z0-9]*(?:Draw|Render|Core))\b/g)) {
      if (m[1]) seeds.add(m[1]);
    }
    if (/\bCMakeLists\b|\.so\b|链接|link/i.test(query)) seeds.add('CMakeLists');
  }

  return [...seeds].filter((s) => s.length >= 3).slice(0, 12);
}

/**
 * Lightweight mechanism explore — seed symbols + flow spine only, no full
 * findRelevantContext (keeps MCP calls fast and avoids agent grep fallback).
 *
 * Domain-mechanism *bag*: agents often strip the how-phrase and keep only
 * keywords (`xml parse`, `foo convert`). Structural — distinctive ASCII token
 * plus an action verb or a CJK domain token; named Types take other paths.
 */
export function queryAsDomainMechanismBag(query: string): boolean {
  if (queryAsMechanismSurvey(query)) return false;
  if (queryAsInterpretationSurvey(query)) return false;
  // Named Type / Type.member / UI control → compact / inventory / click-flow.
  if (extractTypeNamesFromQuery(query).length > 0) return false;
  if (extractMemberAccessFromQuery(query).length > 0) return false;
  if (queryAsNamedComponentAction(query)) return false;
  // Hover/悬停 bags without a how-implemented cue are UI-behavior, not mechanism.
  if (
    /悬停|\bhover\b|onHover/i.test(query)
    && !/\b(?:parse|implement|manage|handle|process|subscribe|convert)\b/i.test(query)
  ) {
    return false;
  }

  const domain = extractDomainSearchTerms(query);
  const distinct = domain.filter(
    (t) => /^[A-Za-z][A-Za-z0-9._-]{2,}$/.test(t) && !GENERIC_VERB_ANCHOR_NOISE.has(t.toLowerCase()),
  );
  if (distinct.length === 0) return false;

  // Only *verb* leftovers count as the action half. Noun noise in
  // GENERIC_VERB_ANCHOR_NOISE (`service` / `source` / `system` / `api` / …)
  // must not turn a multi-term locator bag (`item service`) into light-mechanism.
  const MECHANISM_BAG_NOUN_NOISE = new Set([
    'service', 'services', 'source', 'sources', 'system', 'systems',
    'upstream', 'origin', 'origins',
    'usage', 'usages', 'use', 'uses', 'using',
    'api', 'apis', 'endpoint', 'endpoints',
    'module', 'modules', 'function', 'functions', 'feature', 'features',
    'capability', 'capabilities', 'export', 'exports',
    'dependency', 'dependencies', 'deps', 'dep',
    'param', 'params', 'parameter', 'parameters',
    'project', 'codebase', 'repo', 'documentation', 'document', 'docs',
    'context', 'opengl', 'gles', 'glesv3', 'egl',
    'extra', 'other', 'require', 'requires', 'needed',
  ]);
  const hasActionVerb =
    domain.some((t) => {
      const l = t.toLowerCase();
      return GENERIC_VERB_ANCHOR_NOISE.has(l) && !MECHANISM_BAG_NOUN_NOISE.has(l);
    })
    || /\b(?:parse|implement|manage|handle|process|subscribe|convert|encode|decode)(?:s|d|ing)?\b/i.test(
      query,
    );
  // Remaining CJK tokens are the topic half of a rewritten how-question bag.
  const hasCjkDomain = domain.some((t) => /[\u4e00-\u9fff]/.test(t));
  return hasActionVerb || hasCjkDomain;
}

export function shouldTryLightMechanismExplore(query: string): boolean {
  if (queryShouldDeferToBuiltinTools(query)) return false;
  if (queryAsCrossModuleFlowSurvey(query)) return false;
  if (queryAsInterpretationSurvey(query)) return false;
  // Literal / copy hunts → Grep (never light dump), unless this is an edit/fix task.
  if (queryLooksLikeLiteralOrCopyHunt(query) && !queryAsCodeChangeOrientation(query)) return false;
  // Pre-edit orientation: task keywords → light mechanism seeds (domain / Type / file).
  if (queryAsCodeChangeOrientation(query)) {
    if (
      extractDomainSearchTerms(query).length >= 1
      || extractTypeNamesFromQuery(query).length > 0
      || extractFileBasenamesFromQuery(query).length > 0
      || extractMemberAccessFromQuery(query).length > 0
    ) {
      return true;
    }
  }
  // System-setting howto → lean capability inventory, not every `language` import.
  if (queryAsInRepoSystemCapabilityHowto(query)) return false;
  // Return-value consumers → callers of the member, not a seed+flow dump.
  if (queryAsReturnValueConsumerSurvey(query)) return false;
  // Manager data/status source → inventory, not light-mechanism.
  if (queryAsDataSourceSurvey(query)) return false;
  // Event type → Manager dispatch inventory.
  if (queryAsEventDispatchSurvey(query)) return false;
  // ≥3 Types + dependency relationship → lean inventory (not light/compact dump).
  if (queryAsMultiTypeDependencySurvey(query)) return false;
  // Named UI control + event → compact (body + callees + usage sites), not light-mechanism.
  if (queryAsNamedComponentAction(query)) return false;
  if (queryAsAssignedFlagImpactSurvey(query) || queryAsNamedControlStateSyncSurvey(query)) {
    return false;
  }
  // Kit in-repo usage / extra-deps → kit inventory, not a mechanism dump.
  if (shouldBuildKitModuleUsageSurvey(query)) return false;
  // Caller + "how is Type visible" → compact (callers + include), not light.
  if (queryNeedsCoNamedUseBridge(query)) return false;
  // Named Type.member / UI cluster / local pinpoint → compact, even if NL has 怎么/如何.
  if (
    queryHasNamedMemberFocus(query)
    || queryAsFocusedUiCluster(query)
    || queryAsComponentSurfaceSurvey(query)
    || queryAsLocalSymbolDetail(query)
  ) {
    return false;
  }
  // Declaration / constant / field / module-export inventories own these shapes.
  if (
    queryAsDeclarationSiteSurvey(query)
    || queryAsConstantUsageSurvey(query)
    || queryAsFieldUsageSurvey(query)
    || queryAsModuleExportSurvey(query)
    || queryAsModuleDependencySurvey(query)
    || queryAsTypeLifecycleSurvey(query)
    || shouldBuildApiUsageSurvey(query)
    || queryAsDtsWrapSurvey(query)
  ) {
    return false;
  }
  // lib*.so + GLES/EGL + which thread → CMake/EGLCore spine, not `.so` member dump.
  if (queryAsNativeRenderThreadSurvey(query)) return true;
  if (queryAsDomainMechanismBag(query)) {
    if (queryLooksLikeLiteralOrCopyHunt(query)) return false;
    return extractDomainSearchTerms(query).length >= 1;
  }
  if (!queryAsMechanismSurvey(query)) return false;
  return extractMechanismEntrySeeds(query).length >= 1
    || extractDomainSearchTerms(query).length >= 1;
}

/**
 * Skip expensive subgraph gathering — inventory sections alone answer the query.
 */
export function shouldTryFastInventoryExplore(query: string): boolean {
  if (queryShouldDeferToBuiltinTools(query)) return false;
  if (queryAsCrossModuleFlowSurvey(query)) return false;
  if (shouldTryLightMechanismExplore(query)) return false;
  if (queryAsInterpretationSurvey(query)) return false;
  if (queryLooksLikeLiteralOrCopyHunt(query)) return false;
  // Caller paths alone cannot answer "which call makes Type X visible" — compact.
  if (queryNeedsCoNamedUseBridge(query)) return false;
  // Type lifecycle / Release↔destructor compares need bodies, not path lists.
  if (queryAsTypeLifecycleSurvey(query)) return false;
  // Type×method interaction (CanPlace/Place ↔ Grid) → compact, not member inventory.
  if (queryAsCoNamedTypeMethodInteraction(query)) return false;

  // Import / kit-usage / domain / API / config / data-source listings win even if
  // a dotted `@kit.X` once looked like Type.member (defense in depth).
  // Member-pattern inventories only when the question is a usage listing.
  if (
    shouldBuildKitModuleUsageSurvey(query)
    || shouldBuildApiUsageSurvey(query)
    || shouldBuildDomainFileSurvey(query)
    || shouldBuildConfigSection(query)
    || queryAsDataSourceSurvey(query)
    || queryAsEventDispatchSurvey(query)
    || queryAsMultiTypeDependencySurvey(query)
    || queryAsContainerCompositionSurvey(query)
    || shouldBuildHoverHandlerSurvey(query)
    || queryAsModuleExportSurvey(query)
    || queryAsModuleDependencySurvey(query)
    || queryAsDtsWrapSurvey(query)
    || queryAsNamedControlStateSyncSurvey(query)
    || shouldPreferMemberUsageInventory(query)
    || queryAsInRepoSystemCapabilityHowto(query)
    || queryAsReturnValueConsumerSurvey(query)
    || queryAsDeclarationSiteSurvey(query)
  ) {
    return true;
  }

  // One named symbol / UI action / Type.member / component surface — inventory is wrong.
  if (
    queryAsLocalSymbolDetail(query)
    || queryHasNamedMemberFocus(query)
    || queryAsNamedComponentAction(query)
    || queryAsComponentSurfaceSurvey(query)
    || queryAsFocusedUiCluster(query)
  ) {
    return false;
  }
  const types = extractTypeNamesFromQuery(query);
  if (types.length >= 2 && !queryAsCallerOrMethodSurvey(query) && !queryAsInheritanceSurvey(query)) {
    return false;
  }
  const inventoryDeps = extractDependencySymbolsFromQuery(query).filter((d) => !isMemberLikeIdentifier(d));
  return (
    (hasImportInventoryFilter(query)
      && (inventoryDeps.length > 0 || extractKitModuleNamesFromQuery(query).length > 0)
      && inventoryDeps.length > 0)
    || shouldBuildCallerInventory(query)
    || shouldBuildInheritanceSurvey(query)
  );
}

export function shouldBuildInheritanceSurvey(query: string): boolean {
  if (queryAsInheritanceSurvey(query) && extractTypeNamesFromQuery(query).length > 0) return true;
  // UI Page/Component overview needs the body — not an empty subtype list.
  if (queryAsComponentSurfaceSurvey(query)) return false;
  // Bare / near-bare type queries — agent search("Foo") for subtypes/overview.
  if (queryIsTypeNameFocus(query)) {
    const types = extractTypeNamesFromQuery(query);
    if (types.some(queryLooksLikeUiComponentType)) return false;
    return true;
  }
  return false;
}

export function shouldBuildMemberSurvey(query: string): boolean {
  const members = extractMemberAccessFromQuery(query);
  if (members.length > 0) return true;
  // Field/mutex co-use without a leading dot still needs the text-usage inventory.
  return queryAsFieldUsageSurvey(query);
}

export function shouldBuildConfigSection(query: string): boolean {
  return queryNamesConfigFile(query);
}

/**
 * Domain terms for broad file/usage surveys — Chinese noun phrases, type names,
 * path segments, and distinctive API tokens. Strips only generic survey
 * boilerplate (有哪些 / 如何 / …) — never a product-noun whitelist.
 */
export function extractDomainSearchTerms(query: string): string[] {
  const terms = new Set<string>();

  for (const t of extractTypeNamesFromQuery(query)) terms.add(t);
  for (const seg of extractPathSegmentsFromQuery(query)) {
    const leaf = seg.split(/[/\\]/).pop();
    if (leaf && leaf.length >= 3) terms.add(leaf);
  }
  for (const s of extractDependencySymbolsFromQuery(query)) {
    if (s.length >= 4) terms.add(s);
  }
  for (const kit of extractKitModuleNamesFromQuery(query)) {
    terms.delete(kit);
    terms.delete(kit.charAt(0).toLowerCase() + kit.slice(1));
  }

  // Always keep ASCII code tokens (xml, parse, subscribe…) — mechanism NL often
  // mixes them with Chinese and used to drop them unless a @kit/path was present.
  for (const m of query.matchAll(/\b([A-Za-z][A-Za-z0-9]{2,})\b/g)) {
    const w = m[1]!;
    if (!STOP_WORDS.has(w.toLowerCase())) terms.add(w);
  }

  const stripped = query
    .replace(/[@#][\w.]+/g, ' ')
    .replace(
      /哪些文件|有哪些|什么|如何|怎样|怎么|项目中|项目里|项目|涉及|相关的?|文件|模块|功能|吗|？|\?|有使用|是否|有没有|使用|不同|区别|对比|这个|那个|是怎样|是如何|怎么|如何|它与|它和|实现|的/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  for (const m of stripped.matchAll(/[\u4e00-\u9fff]{2,8}/g)) {
    let t = m[0]!.replace(/^与/, '');
    if (t.length >= 2) terms.add(t);
  }

  return [...terms].filter((t) => t.length >= 2).slice(0, 12);
}

/** How/implementation/mechanism intent — needs entry symbols + flow, not flat file list. */
export function queryAsMechanismSurvey(query: string): boolean {
  // Cross-Type drive / state-machine interaction — must not collapse into compact
  // hard-ANSWER-NOW on abstract base names (Machine+Engine, Session FG/BG, …).
  const types = extractTypeNamesFromQuery(query).filter((t) => !isFrameworkUiDecoratorName(t));
  if (
    types.length >= 2
    && /驱动|触发|状态机|状态变化|重新计算|foreground|background|layout|布局/i.test(query)
  ) {
    return true;
  }
  return /如何(?:实现|获取|做|处理|管理|驱动|触发)|怎样(?:实现|获取|做|驱动|触发)|怎么(?:实现|获取|做|驱动|触发)|是如何|是怎么|how\s+(?:is|does|are|to\s+(?:get|implement|work|drive|trigger))|机制|状态机|流程|架构|多线程|多进程|multithread|multi-thread|会走到哪些|步骤中会|解析和安装|下载完|下载后|状态变化如何|如何驱动|如何触发/i.test(
    query,
  );
}

/**
 * Broad domain survey — related files, usage existence, or concept comparison.
 * Omits source when the file inventory is the complete answer.
 */
export function queryAsDomainFileSurvey(query: string): boolean {
  if (queryAsKitModuleCapabilitySurvey(query)) return false;
  if (queryLooksLikeLiteralOrCopyHunt(query)) return false;
  if (queryAsCallerOrMethodSurvey(query)) return false;
  if (shouldBuildApiUsageSurvey(query)) return false;
  if (hasImportInventoryFilter(query)) return false;
  if (shouldBuildMemberSurvey(query)) return false;
  if (extractFileBasenamesFromQuery(query).length > 0) return false;
  if (queryAsMechanismSurvey(query)) return false;
  // Module dep → dedicated cycle survey. Module NAPI export → dedicated export
  // survey (must NOT become a 50-file domain dump of every "API"/"NAPI" token).
  if (queryAsModuleDependencySurvey(query)) return true;
  if (queryAsModuleExportSurvey(query) || queryAsDtsWrapSurvey(query)) return false;
  // Step / "which code runs" flow questions are mechanism — not domain file lists.
  if (/会走到|步骤中|解析和安装|下载完|下载后|call\s*chain|which\s+code\s+(?:runs|paths?)/i.test(query)) {
    return false;
  }

  const listing = /哪些文件|有哪些.*文件|相关的?\s*文件|涉及.*文件|which\s+files?|files?\s+(?:are\s+)?related/i.test(
    query,
  );
  const usage = /有使用|是否使用|有没有使用|使用了.*吗|is\s+.+\s+used/i.test(query);
  const compare = /有什么不同|区别|difference|vs\.?|versus|对比/i.test(query);
  const broad = /有哪些|哪些/.test(query) && extractTypeNamesFromQuery(query).length === 0;

  return listing || usage || compare || broad;
}

export function shouldBuildDomainFileSurvey(query: string): boolean {
  return queryAsDomainFileSurvey(query) && extractDomainSearchTerms(query).length > 0;
}

/** Callable/class names that commonly anchor implementation flows. */
export const IMPLEMENTATION_ENTRY_NAME_RE =
  /Manager|Service|Handler|Extension|Parser|Helper|Controller|Provider|Worker|Backup|Restore|Subscription|Monitor|Coordinator|Delegate|Adapter|Factory|Processor|Subscriber|Listener/i;

/**
 * ASCII path/name stems for mechanism affinity.
 * Expands a few CJK domain nouns so `通知订阅` can match `/notification/` paths
 * without a product-specific file blacklist.
 */
export function mechanismDomainPathTokens(query: string): string[] {
  const out = new Set<string>();
  for (const t of extractDomainSearchTerms(query)) {
    // ≥3 so short distinctive stems (`xml`) survive agent EN rewrites; verb
    // noise (`parse`/`parser`) stays out via GENERIC_VERB_ANCHOR_NOISE.
    if (/^[\x00-\x7F]+$/.test(t) && t.length >= 3 && !GENERIC_VERB_ANCHOR_NOISE.has(t.toLowerCase())) {
      out.add(t.toLowerCase());
    }
  }
  if (/通知/.test(query)) out.add('notification');
  if (/订阅/.test(query)) {
    out.add('subscribe');
    out.add('subscriber');
  }
  if (/壁纸|wallpaper/i.test(query)) out.add('wallpaper');
  if (/主题|theme/i.test(query)) {
    out.add('theme');
    // Prefer themeservice / themepack paths over appinstall "download/install" Managers.
    out.add('themeservice');
    out.add('themepack');
  }
  if (/备份|backup/i.test(query)) out.add('backup');
  if (/恢复|restore/i.test(query)) out.add('restore');
  if (/锁屏|screenlock|keyguard/i.test(query)) {
    out.add('screenlock');
    out.add('keyguard');
  }
  return [...out].slice(0, 12);
}

/** Class/file looks like a domain Manager/Service under matching path or name. */
export function isDomainRoleSymbol(name: string, filePath: string, domainTokens: string[]): boolean {
  if (!IMPLEMENTATION_ENTRY_NAME_RE.test(name)) return false;
  if (domainTokens.length === 0) return /Manager|Subscriber|Listener$/i.test(name);
  const blob = `${name}\n${filePath}`.toLowerCase().replace(/\\/g, '/');
  return domainTokens.some((t) => {
    const tl = t.toLowerCase();
    if (tl.length < 4) return false;
    return blob.includes(tl) || blob.includes(`/${tl}/`);
  });
}

export function isImplementationEntrySymbol(name: string, domainTerms: string[]): boolean {
  if (!IMPLEMENTATION_ENTRY_NAME_RE.test(name)) return false;
  const asciiDomains = domainTerms.filter((t) => /^[\x00-\x7F]+$/.test(t));
  if (asciiDomains.length === 0) return true;
  const nl = name.toLowerCase();
  return asciiDomains.some((t) => {
    const tl = t.toLowerCase();
    return nl.includes(tl) || (tl.length >= 4 && nl.includes(tl.slice(0, 4)));
  });
}

/** Compact import list when query filters symbols and at least one site matches. */
export function shouldCompactImportListing(
  siteCount: number,
  hasSymbolFilter: boolean,
): boolean {
  if (!hasSymbolFilter) return false;
  return siteCount >= 1;
}

export interface ExploreInventorySignals {
  importSiteCount: number;
  hasFilteredImports: boolean;
  callerBulletCount: number;
  memberFileCount: number;
  apiUsageFileCount: number;
  configRendered: boolean;
  kitModuleSurveyRendered: boolean;
  inheritanceListed: boolean;
  domainFileCount: number;
  dataSourceEdgeCount: number;
}

/** Single file basename anchor with no flow — render that file only. */
export function shouldLimitToQueryNamedFile(
  query: string,
  hasFlowPath: boolean,
  multiAnchorQuery: boolean,
): boolean {
  if (hasFlowPath || multiAnchorQuery) return false;
  return extractFileBasenamesFromQuery(query).length === 1;
}

/** Multiple named anchors in one query → trace/connect intent, not flat inventory. */
export function queryNamesMultipleExploreAnchors(query: string): boolean {
  const typeCount = extractTypeNamesFromQuery(query).length;
  const memberCount = extractMemberAccessFromQuery(query).length;
  const fileCount = extractFileBasenamesFromQuery(query).length;
  const pathCount = extractPathSegmentsFromQuery(query).length;
  if (typeCount >= 2 || memberCount >= 2) return true;
  return typeCount + memberCount + fileCount + pathCount >= 2;
}

/** Omit source bodies when inventory sections suffice and the graph found no flow path. */
export function shouldOmitSourceBodies(
  inv: ExploreInventorySignals,
  hasFlowPath: boolean,
  multiAnchorQuery: boolean,
): boolean {
  if (hasFlowPath || multiAnchorQuery) return false;
  if (inv.configRendered) return true;
  if (inv.kitModuleSurveyRendered) return true;
  if (inv.inheritanceListed) return true;
  // Filtered import lists are complete answers (even a single site).
  if (inv.hasFilteredImports && inv.importSiteCount >= 1) return true;
  // Caller / method inventory (paths only).
  if (inv.callerBulletCount >= 1) return true;
  // Member-usage survey (e.g. `.drawModifier`) — paths in inventory, not full bodies.
  if (inv.memberFileCount >= 2 && !inv.hasFilteredImports) return true;
  // Domain file/usage survey — paths + top symbols, not full bodies.
  if (inv.domainFileCount >= 1) return true;
  // API call-site survey (statfs, napi_*, …) — paths only.
  if (inv.apiUsageFileCount >= 1) return true;
  // Upstream data-source survey (BadgeManager → notification service).
  if (inv.dataSourceEdgeCount >= 1) return true;
  return false;
}

/** Single named type + member/callback intent — render that type's file only. */
export function shouldFocusOnNamedTypeFile(
  query: string,
  hasFlowPath: boolean,
  multiAnchorQuery: boolean,
): boolean {
  if (hasFlowPath || multiAnchorQuery) return false;
  if (extractFileBasenamesFromQuery(query).length > 0) return false;
  const types = extractTypeNamesFromQuery(query);
  if (types.length !== 1) return false;
  return (
    extractMemberAccessFromQuery(query).length > 0
    || /回调|callback|事件处理|事件|成员|member|字段|field|属性|property|函数体|方法体/i.test(query)
  );
}

/** PascalCase type / class names mentioned in the query (Configuration, BadgeManager). */
export function extractTypeNamesFromQuery(query: string): string[] {
  const names = new Set<string>();
  for (const m of query.matchAll(/\b([A-Z][A-Za-z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z][A-Za-z0-9]*)\b/g)) {
    if (m[1] && m[1].length >= 3) names.add(m[1]);
  }
  for (const base of extractFileBasenamesFromQuery(query)) {
    if (/^[A-Z]/.test(base)) names.add(base);
  }
  return [...names];
}

/** True when the query names concrete indexed-code anchors (for explore-first guidance). */
export function hasConcreteExploreAnchors(query: string): boolean {
  if (
    extractFileBasenamesFromQuery(query).length > 0
    || extractPathSegmentsFromQuery(query).length > 0
    || extractKitModuleNamesFromQuery(query).length > 0
    || extractMemberAccessFromQuery(query).length > 0
    || extractTypeNamesFromQuery(query).length > 0
    || /\b[A-Za-z_][\w]*::[A-Za-z_][\w]*/.test(query)
  ) {
    return true;
  }
  const deps = extractDependencySymbolsFromQuery(query);
  if (deps.some((d) => isDistinctiveIdentifier(d))) return true;
  return queryMentionsCodeContext(query) && deps.length > 0;
}

/**
 * Generate stem variants of a search term by removing common English suffixes.
 * Used for FTS query expansion so "caching" also finds "cache", "eviction" finds "evict", etc.
 * Stems are used as PREFIX matches in FTS, so they don't need to be perfect English words.
 */
export function getStemVariants(term: string): string[] {
  const variants = new Set<string>();
  const t = term.toLowerCase();

  // -ing: caching→cach/cache, handling→handl/handle, running→run
  if (t.endsWith('ing') && t.length > 5) {
    const base = t.slice(0, -3);
    variants.add(base);
    variants.add(base + 'e');
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  // -tion/-sion: eviction→evict, expression→express
  if ((t.endsWith('tion') || t.endsWith('sion')) && t.length > 5) {
    variants.add(t.slice(0, -3));
  }

  // -ment: management→manage
  if (t.endsWith('ment') && t.length > 6) {
    variants.add(t.slice(0, -4));
  }

  // -ies: entries→entry
  if (t.endsWith('ies') && t.length > 4) {
    variants.add(t.slice(0, -3) + 'y');
  }
  // -es: processes→process, classes→class
  else if (t.endsWith('es') && t.length > 4) {
    variants.add(t.slice(0, -2));
  }
  // -s: errors→error (skip -ss endings like "class")
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 4) {
    variants.add(t.slice(0, -1));
  }

  // -ed: handled→handle, propagated→propagate, carried→carry
  if (t.endsWith('ed') && !t.endsWith('eed') && t.length > 4) {
    variants.add(t.slice(0, -1));
    variants.add(t.slice(0, -2));
    if (t.endsWith('ied') && t.length > 5) {
      variants.add(t.slice(0, -3) + 'y');
    }
  }

  // -er: builder→build/builde, handler→handl/handle, getter→get
  if (t.endsWith('er') && t.length > 4) {
    const base = t.slice(0, -2);
    variants.add(base);
    variants.add(base + 'e');
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  return [...variants].filter(v => v.length >= 3 && v !== t);
}

/**
 * Extract meaningful search terms from a natural language query.
 * Splits camelCase, PascalCase, snake_case, SCREAMING_SNAKE, and dot.notation
 * into individual tokens before filtering.
 *
 * Preserves original compound identifiers (e.g., "scrapeLoop") alongside
 * their split parts so that FTS can match both the full symbol name and
 * individual words within it.
 *
 * Also generates stem variants (e.g., "caching"→"cache", "eviction"→"evict")
 * so FTS prefix matching can find related code symbols.
 */
export function extractSearchTerms(query: string, options?: { stems?: boolean }): string[] {
  const includeStems = options?.stems !== false;
  const tokens = new Set<string>();
  let match: RegExpExecArray | null;

  for (const kit of extractKitModuleNamesFromQuery(query)) {
    tokens.add(kit.toLowerCase());
  }

  for (const base of extractFileBasenamesFromQuery(query)) {
    if (base.length >= 2) tokens.add(base.toLowerCase());
  }

  for (const seg of extractPathSegmentsFromQuery(query)) {
    for (const part of seg.split('/')) {
      if (part.length >= 3) tokens.add(part.toLowerCase());
    }
  }

  for (const ma of extractMemberAccessFromQuery(query)) {
    if (ma.member.length >= 3) tokens.add(ma.member.toLowerCase());
    if (ma.receiver && ma.receiver.length >= 3) tokens.add(ma.receiver.toLowerCase());
  }

  // C++ qualified names
  const cppQualPattern = /\b([A-Za-z_][\w]*)(::)([A-Za-z_][\w]*)\b/g;
  while ((match = cppQualPattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) tokens.add(match[1].toLowerCase());
    if (match[3] && match[3].length >= 3) tokens.add(match[3].toLowerCase());
  }

  // First, extract and preserve compound identifiers before splitting
  // CamelCase: scrapeLoop, UserService, getCallGraph
  const compoundPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
  while ((match = compoundPattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      tokens.add(match[1].toLowerCase()); // preserve full compound: "scrapeloop"
    }
  }

  // snake_case: scrape_loop, user_service
  const snakePattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g;
  while ((match = snakePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      tokens.add(match[1].toLowerCase());
    }
  }

  // Split camelCase / PascalCase: "getUserName" → "get User Name"
  const camelSplit = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Replace underscores and dots with spaces (snake_case, dot.notation)
  const normalised = camelSplit.replace(/[_.]+/g, ' ');

  // Split on any non-alphanumeric character
  const words = normalised.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length < 3) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.add(lower);
  }

  // Generate stem variants for broader FTS matching.
  // "caching" → "cache" finds CacheBuilder; "eviction" → "evict" finds evictEntries.
  // Also enables co-occurrence dampening by increasing term count above 1.
  // Stems are skipped when scoring path relevance (stems inflate path scores).
  if (includeStems) {
    const stems = new Set<string>();
    for (const token of tokens) {
      for (const variant of getStemVariants(token)) {
        if (!tokens.has(variant) && !STOP_WORDS.has(variant)) {
          stems.add(variant);
        }
      }
    }
    for (const stem of stems) {
      tokens.add(stem);
    }
  }

  return [...tokens];
}

/**
 * Score path relevance to a query
 * Higher score = more relevant path
 */
export function scorePathRelevance(
  filePath: string,
  query: string,
  projectNameTokens?: Set<string>,
): number {
  const pathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();
  let score = 0;

  // Score per original query WORD, not per sub-token. A single PascalCase word
  // splits into many sub-tokens (a project name "SuperBizAgent" →
  // superbizagent / super / biz / agent) that all match the SAME path segment,
  // so summing per sub-token boosted that path 4× for one concept — enough to
  // bury the rest of the query's stack (#720). A word matches a path level if
  // ANY of its sub-tokens do, and counts ONCE; distinct words still each add.
  // Split the ORIGINAL-case query into words; extractSearchTerms does the
  // camelCase/snake split per word (so `getUserName` still matches a
  // `get_user_name` path) — we just attribute each word's matches once.
  const allWords = query.split(/\s+/).filter((w) => w.length > 0);
  if (allWords.length === 0) return 0;

  // A query word that just names the PROJECT (its go.mod / package.json / repo
  // name) carries no discriminative path signal — drop it so the rest of the
  // query decides the ranking, instead of every file under a `<ProjectName>…/`
  // tree winning on the project name alone (#720). Only when OTHER words remain,
  // so a bare project-name query still scores on its path.
  const words =
    projectNameTokens && projectNameTokens.size > 0
      ? allWords.filter((w) => !projectNameTokens.has(normalizeNameToken(w)))
      : allWords;
  const scored = words.length > 0 ? words : allWords;

  for (const word of scored) {
    // Use base terms only — stem variants inflate path scores by generating
    // many near-duplicate terms that all match the same path segments.
    const subtokens = extractSearchTerms(word, { stems: false });
    if (subtokens.length === 0) continue;
    // Exact filename match (strongest)
    if (subtokens.some((t) => fileName.includes(t))) score += 10;
    // Directory match
    if (subtokens.some((t) => dirName.includes(t))) score += 5;
    // General path match
    else if (subtokens.some((t) => pathLower.includes(t))) score += 3;
  }

  // Deprioritize test files unless the query is explicitly about tests
  const queryLower = query.toLowerCase();
  const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
  if (!isTestQuery && isTestFile(filePath)) {
    score -= 15;
  }

  return score;
}

/**
 * Check if a file path looks like a test file
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const fileName = path.basename(filePath);   // original case — needed for camelCase boundaries
  const lowerName = fileName.toLowerCase();

  // --- Filename patterns ---
  if (
    lowerName.startsWith('test_') ||                              // python: test_foo.py
    lowerName.startsWith('test.') ||
    // separator-delimited: foo_test.go, foo.test.ts, foo-spec.rb, bar_spec.py
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
    // CamelCase suffix (Java/Kotlin/Swift/C#/Scala): FooTest.kt, BarTests.swift,
    // BazSpec.scala, QuxTestCase.java. Capital-led so "latest.kt"/"manifest.kt"
    // (lowercase "test") are NOT matched.
    /(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
  ) {
    return true;
  }

  // --- Directory patterns ---
  if (
    lower.includes('/tests/') || lower.includes('/test/') ||
    lower.includes('/__tests__/') || lower.includes('/spec/') ||
    lower.includes('/specs/') || lower.includes('/testlib/') ||
    lower.includes('/testing/') ||
    // HarmonyOS / OpenHarmony instrumented test trees
    lower.includes('/ohostest/') ||
    lower.startsWith('test/') || lower.startsWith('tests/') ||
    lower.startsWith('spec/') || lower.startsWith('specs/') ||
    // CamelCase test source-set dirs (Kotlin Multiplatform / Gradle / Xcode):
    // jvmTest/, commonTest/, androidTest/, iosTest/, integrationTest/. Capital-led
    // so "latest/" / "manifest/" are not matched.
    /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath)
  ) {
    return true;
  }

  // Non-production directories: examples, samples, benchmarks, fixtures, demos.
  // Check both mid-path (/integration/) and start-of-path (integration/) since
  // file paths may be stored as relative paths without a leading slash.
  return matchesNonProductionDir(lower);
}

/**
 * Check if a path is in a non-production directory (integration, sample, example, etc.)
 * Handles both absolute paths (/foo/integration/bar) and relative paths (integration/bar).
 */
function matchesNonProductionDir(lowerPath: string): boolean {
  const dirs = [
    'integration', 'sample', 'samples', 'example', 'examples',
    'fixture', 'fixtures', 'benchmark', 'benchmarks', 'demo', 'demos',
  ];
  for (const dir of dirs) {
    if (lowerPath.includes('/' + dir + '/') || lowerPath.startsWith(dir + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Bonus when a node's name matches the search query.
 * Exact matches get the largest boost; prefix matches get smaller boosts.
 * Multi-word queries also check individual term matches against the name.
 */
export function nameMatchBonus(nodeName: string, query: string): number {
  const nameLower = nodeName.toLowerCase();

  // Split query into word-level terms (handles "CacheBuilder build" → ["cache","builder","build"])
  const rawTerms = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2);

  // Also keep original space-separated tokens for exact-term matching
  const queryTokens = query.split(/\s+/).map(t => t.toLowerCase()).filter(t => t.length >= 2);

  // Full query as a single token (for compound identifiers like "CacheBuilder")
  const queryLower = query.replace(/[\s]+/g, '').toLowerCase();

  // Exact match: query exactly equals the node name
  if (nameLower === queryLower) return 80;

  // Exact match on a query token: "CacheBuilder build" and node name is "build"
  if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return 60;

  // Name starts with query — scale by length ratio so "Pod"→"Pod" (exact, handled above)
  // scores much higher than "Pod"→"PodGCControllerOptions" (ratio 0.125).
  if (nameLower.startsWith(queryLower)) {
    const ratio = queryLower.length / nameLower.length;
    return Math.round(10 + 30 * ratio);
  }

  // All camelCase-split terms appear in the name
  if (rawTerms.length > 1) {
    const allMatch = rawTerms.every(t => nameLower.includes(t));
    if (allMatch) return 15;
  }

  // Name contains the full query as substring
  if (nameLower.includes(queryLower)) return 10;

  return 0;
}

/**
 * Kind-based bonus for search ranking
 * Functions and classes are typically more relevant than variables/imports
 */
export function kindBonus(kind: Node['kind']): number {
  const bonuses: Record<string, number> = {
    function: 10,
    method: 10,
    class: 8,
    interface: 9,
    type_alias: 6,
    struct: 6,
    trait: 9,
    enum: 5,
    component: 8,
    route: 9,
    module: 4,
    property: 3,
    field: 3,
    variable: 2,
    constant: 3,
    import: 1,
    export: 1,
    parameter: 0,
    namespace: 4,
    file: 0,
    protocol: 9,
    enum_member: 3,
  };
  return bonuses[kind] ?? 0;
}

/**
 * Whether a query token looks like a code identifier the user deliberately typed
 * (camelCase / PascalCase-with-internal-caps / snake_case / has a digit) rather
 * than a plain dictionary word ("flat", "object", "screen").
 *
 * Used to decide whether an EXACT name match earns the "the user named this
 * symbol" exemption from single-term dampening. A common English word that
 * happens to exact-match an unrelated symbol — the query "flat object" matching
 * a constant named `FLAT` — must NOT get that exemption, or the +exact-name
 * bonus floats it to the top of a prose query on its own.
 *
 * Classifies the token AS THE USER TYPED IT, not the matched symbol's name:
 * "flat" (lowercase, descriptive) is non-distinctive even though it matches
 * `FLAT`. A leading-capital-only word ("Screen", "Zustand") is also treated as
 * a plain word — sentence-start capitalization and proper nouns aren't reliable
 * identifier signals.
 */
export function isDistinctiveIdentifier(token: string): boolean {
  if (!token) return false;
  // snake_case / SCREAMING_SNAKE, or an embedded digit → a deliberate identifier.
  if (/[_0-9]/.test(token)) return true;
  // An uppercase letter anywhere AFTER the first char → a camelCase/PascalCase
  // boundary (setLastEmail, OrgUserStore) or an acronym (REST, HTTP).
  if (/[A-Z]/.test(token.slice(1))) return true;
  return false;
}
