/** Versioned retrieval intent, not a replacement for the user's question or graph evidence. */
import * as shape from './query-utils';

export const QUERY_PLAN_VERSION = 2 as const;
export type QueryIntent = 'general' | 'usages' | 'modules' | 'native' | 'flow' | 'overview';
export type QueryRoute = 'general' | 'usages' | 'modules' | 'native' | 'inventory' | 'mechanism' | 'compact' | 'project';
export const QUERY_RELATIONS = ['incoming_references', 'registration_sites', 'outgoing_calls', 'module_imports', 'module_cycles'] as const;
export const QUERY_SOURCE_SCOPES = ['local', 'sdk', 'all'] as const;
export type QueryRelation = typeof QUERY_RELATIONS[number];
export type QuerySourceScope = typeof QUERY_SOURCE_SCOPES[number];

export interface QueryPlanningDecision {
  eligible: boolean;
  reason: 'planner_disabled' | 'builtin_tool' | 'exact_symbol_or_path'
    | 'task_context_requires_planning' | 'existing_shape_route' | 'focused_query' | 'ambiguous_or_compound';
  /** Preserve the rule route even if a model later selects another route. */
  ruleRoute: QueryRoute;
}

export interface QueryPlanStep {
  id: string;
  query: string;
  intent: QueryIntent;
  /** Code-shaped mentions / exact index matches, not completed-step evidence. */
  anchors: string[];
  /** Optional per-step semantic terms; omitted by older planner responses. */
  searchTerms?: string[];
  /** Verbatim user-supplied UI/resource values; never translated symbol names. */
  literalTexts?: string[];
  relation?: QueryRelation;
  sourceScope?: QuerySourceScope;
  dependsOn: string[];
}

/** Exact predecessor evidence supplied by the executor, never by the planner. */
export interface QueryPlanBinding {
  id: string;
  name: string;
  qualifiedName?: string;
  filePath: string;
  startLine: number;
}

export interface QueryPlan {
  version: typeof QUERY_PLAN_VERSION;
  originalQuery: string;
  /** Bounded user-supplied task constraints; never repository evidence. */
  taskContext?: string;
  canonicalQuery: string;
  intent: QueryIntent;
  route: QueryRoute;
  anchors: string[];
  searchTerms: string[];
  literalTexts?: string[];
  relation?: QueryRelation;
  sourceScope?: QuerySourceScope;
  bindings?: QueryPlanBinding[];
  steps: QueryPlanStep[];
  features: Record<string, boolean>;
  source: 'rules' | 'llm';
  confidence: number;
  telemetry: { durationMs: number; requestCount?: number; inputTokens?: number; outputTokens?: number;
    fallbackReason?: string; decision?: QueryPlanningDecision };
}

export interface QueryPlanOptions {
  /** Absolute request deadline. Planning consumes, rather than resets, this budget. */
  deadlineAt: number;
  /** Original task used to retain scope across narrower retrieval queries. */
  taskContext?: string;
  /** Only return true for an exact, current repository symbol/path match. */
  validateAnchor?: (anchor: string) => boolean;
}

/** One shared bound for provider input, transferred plans and cache identity. */
export function normalizeQueryPlanTaskContext(value?: string): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, 4000) || undefined : undefined;
}

function withTaskContext(query: string, taskContext?: string): string {
  // This string reaches lexical retrieval. Framework prose such as "code evidence"
  // would become unrelated symbol seeds, so concatenate only the supplied data.
  return taskContext && taskContext !== query ? `${query}\n${taskContext}` : query;
}

/** A host's original task cannot be replaced by an agent's abbreviated focus. */
export function mergeQueryPlanTaskContext(original?: string, focus?: string): string | undefined {
  const parts = [normalizeQueryPlanTaskContext(original), normalizeQueryPlanTaskContext(focus)]
    .filter((part): part is string => !!part);
  return normalizeQueryPlanTaskContext([...new Set(parts)].join('\n'));
}

/** Only the supplied request, never a generated retrieval cue, may authorize a map. */
export function queryExplicitlyRequestsProjectMap(query: string): boolean {
  // Map/overview can be part of a UI control's name, not the requested output.
  if (/\b(?:overview|map|structure|architecture|layout)\s+(?:button|component|handler|widget|view|screen|page)\b|(?:概览|总览|地图|结构)(?:按钮|组件|控件|页面|点击|事件)/i.test(query)) return false;
  if (/(?:不要|无需|不用|不是|不需要|排除).{0,20}(?:项目|工程|仓库|模块|目录|文件).{0,12}(?:概览|总览|结构|架构|地图)|\b(?:not|no|without|exclude)\b.{0,28}\b(?:project|repo(?:sitory)?|module|directory|file)\b.{0,20}\b(?:overview|map|structure|architecture|layout)\b|\b(?:not|no|without|exclude)\b.{0,16}\b(?:overview|map|structure|architecture|layout)\b.{0,24}\b(?:project|repo(?:sitory)?|module|directory|file)\b/i.test(query)) return false;
  return /(?:项目|工程|仓库|代码库|模块|目录|文件)\s*(?:整体|总体)?\s*(?:结构|架构|概览|总览|地图|组织|划分)|(?:整体|总体|全局)\s*(?:架构|目录树)|\b(?:project|repo(?:sitory)?|codebase|modules?|director(?:y|ies)|files?)\s+(?:overall\s+)?(?:structure|architecture|overview|map|layout|organization)\b|\b(?:overview|map|architecture|structure|layout|organization)\s+(?:(?:of|for)\s+)?(?:(?:the|this|our|entire|whole|overall)\s+)*(?:project|repo(?:sitory)?|codebase|modules?|directories|files?)\b/i.test(query);
}

const featureChecks: Record<string, (query: string) => boolean> = {
  shouldTryFastInventoryExplore: shape.shouldTryFastInventoryExplore,
  shouldTryLightMechanismExplore: shape.shouldTryLightMechanismExplore,
  shouldUseCompactExploreBudget: shape.shouldUseCompactExploreBudget,
  shouldBuildApiUsageSurvey: shape.shouldBuildApiUsageSurvey,
  shouldBuildMemberSurvey: shape.shouldBuildMemberSurvey,
  shouldBuildCallerInventory: shape.shouldBuildCallerInventory,
  shouldBuildInheritanceSurvey: shape.shouldBuildInheritanceSurvey,
  shouldBuildKitModuleUsageSurvey: shape.shouldBuildKitModuleUsageSurvey,
  shouldBuildDomainFileSurvey: shape.shouldBuildDomainFileSurvey,
  shouldBuildConfigSection: shape.shouldBuildConfigSection,
  shouldBuildHoverHandlerSurvey: shape.shouldBuildHoverHandlerSurvey,
  shouldPreferMemberUsageInventory: shape.shouldPreferMemberUsageInventory,
  queryAsCrossModuleFlowSurvey: shape.queryAsCrossModuleFlowSurvey,
  queryAsModuleDependencySurvey: shape.queryAsModuleDependencySurvey,
  queryAsModuleExportSurvey: shape.queryAsModuleExportSurvey,
  queryAsReturnValueConsumerSurvey: shape.queryAsReturnValueConsumerSurvey,
  queryAsMechanismSurvey: shape.queryAsMechanismSurvey,
  queryAsDataSourceSurvey: shape.queryAsDataSourceSurvey,
  queryAsDataSourceDistinguishAsk: shape.queryAsDataSourceDistinguishAsk,
  queryAsEventDispatchSurvey: shape.queryAsEventDispatchSurvey,
  queryAsMultiTypeDependencySurvey: shape.queryAsMultiTypeDependencySurvey,
  queryAsDeclarationSiteSurvey: shape.queryAsDeclarationSiteSurvey,
  queryAsConstantUsageSurvey: shape.queryAsConstantUsageSurvey,
  queryAsFieldUsageSurvey: shape.queryAsFieldUsageSurvey,
  queryAsDtsWrapSurvey: shape.queryAsDtsWrapSurvey,
  queryAsTypeLifecycleSurvey: shape.queryAsTypeLifecycleSurvey,
  queryAsContainerCompositionSurvey: shape.queryAsContainerCompositionSurvey,
  queryAsNativeRenderThreadSurvey: shape.queryAsNativeRenderThreadSurvey,
  queryAsNamedControlStateSyncSurvey: shape.queryAsNamedControlStateSyncSurvey,
  queryAsAssignedFlagImpactSurvey: shape.queryAsAssignedFlagImpactSurvey,
  queryAsInterpretationSurvey: shape.queryAsInterpretationSurvey,
  queryAsTestOnlyInterpretation: shape.queryAsTestOnlyInterpretation,
  queryAsLocalSymbolDetail: shape.queryAsLocalSymbolDetail,
  queryHasNamedMemberFocus: shape.queryHasNamedMemberFocus,
  queryAsFocusedUiCluster: shape.queryAsFocusedUiCluster,
  queryAsComponentSurfaceSurvey: shape.queryAsComponentSurfaceSurvey,
  queryAsNamedComponentAction: shape.queryAsNamedComponentAction,
  queryNeedsCoNamedUseBridge: shape.queryNeedsCoNamedUseBridge,
  queryAsInRepoSystemCapabilityHowto: shape.queryAsInRepoSystemCapabilityHowto,
  queryAsCodeChangeOrientation: shape.queryAsCodeChangeOrientation,
  queryLooksLikeLiteralOrCopyHunt: shape.queryLooksLikeLiteralOrCopyHunt,
};

export function queryPlanFeatures(query: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(featureChecks).map(([name, check]) => [name, check(query)]));
}

/** Keep this identical to the legacy ALL_CAPS-only compatibility gate. */
export function queryAsPlannedBareSymbolInventory(query: string): boolean {
  if (process.env.HOMEGRAPH_EXPLORE_SHAPE_ROUTING === '0') return false;
  const tokens = String(query || '').split(/[\s,、，]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 6) return false;
  if (/如何|怎[么样]|机制|流程|原理|为什么|为何|架构|生命周期|时序|调用链|关系|\b(how|why|flow|mechanism|lifecycle|architecture|sequence|pipeline|between|implement|implementation)\b/i.test(query)) return false;
  const actions = new Set(['trigger', 'callback', 'handler', 'listener', 'observer', 'dispatch', 'emit',
    'notify', 'render', 'draw', 'init', 'start', 'stop', 'update', 'refresh', 'subscribe', 'publish',
    'invoke', 'execute', 'run', 'process', 'handle', 'post', 'send', 'receive', 'load', 'save', 'open', 'close']);
  if (tokens.some((token) => token.replace(/[._]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/\s+/).some((part) => actions.has(part)))) return false;
  return tokens.every((token) => /^[A-Z][A-Z0-9_]{3,}$/.test(token));
}

function localRoute(query: string, features: Record<string, boolean>): QueryRoute {
  if (shape.queryShouldDeferToBuiltinTools(query)) return 'general';
  if (features.queryAsModuleDependencySurvey) return 'modules';
  if (features.queryAsModuleExportSurvey) return 'native';
  if (!features.queryAsReturnValueConsumerSurvey) {
    if (features.shouldBuildApiUsageSurvey || queryAsPlannedBareSymbolInventory(query)) return 'usages';
    if (features.shouldBuildMemberSurvey
      && /哪里(?:用|使用|调用)|哪些.{0,24}(?:用|使用|调用|依赖)|使用位置|引用位置|调用位置|\busages?\b|\bwhere\b.{0,36}\bused\b|\bwhich\b.{0,36}\b(?:files?|functions?|methods?)\b.{0,24}\b(?:use|call|depend)/i.test(query)) return 'usages';
  }
  if (features.shouldTryFastInventoryExplore) return 'inventory';
  if (features.shouldTryLightMechanismExplore) return 'mechanism';
  // Compact eligibility also depends on graph hits. Let the legacy executor try it.
  return 'general';
}

/** These are textual hints only. Extraction does not certify that an anchor exists. */
export function extractQueryPlanAnchors(query: string): string[] {
  const explicit = [...query.matchAll(/(?:@[A-Za-z][\w.]*|[A-Za-z_][\w]*(?:(?:\.|::)[A-Za-z_][\w]*)+|\b[A-Za-z][\w.-]*(?:[/\\][A-Za-z][\w.-]*)+|\b[A-Z][A-Z0-9_]{3,}\b|\b[a-z]+[A-Z]\w{2,}\b)/g)]
    .map((match) => match[0]);
  return [...new Set([
    ...explicit,
    ...shape.extractTypeNamesFromQuery(query),
    ...shape.extractLocalDetailAnchors(query),
  ])].filter((value) => value.length <= 256 && query.includes(value)).slice(0, 16);
}

/** Preserve explicit user text during provider failure, without translating it. */
export function extractQueryPlanLiteralTexts(query: string): string[] {
  const values = [...query.matchAll(/"([^"\r\n]{1,256})"|(?<![A-Za-z0-9_])'([^'\r\n]{1,256})'(?![A-Za-z0-9_])|“([^”\r\n]{1,256})”|‘([^’\r\n]{1,256})’|「([^」\r\n]{1,256})」|『([^』\r\n]{1,256})』/g)]
    .map(match => match.slice(1).find(value => value !== undefined)?.trim() ?? '')
    .filter(Boolean);
  return [...new Set(values)].slice(0, 8);
}

export function buildRuleQueryPlan(query: string, originalTaskContext?: string): QueryPlan {
  const started = Date.now();
  const taskContext = normalizeQueryPlanTaskContext(originalTaskContext);
  const canonicalQuery = withTaskContext(query, taskContext);
  const features = queryPlanFeatures(canonicalQuery);
  const route = localRoute(canonicalQuery, features);
  const intent: QueryIntent = route === 'usages' || route === 'modules' || route === 'native'
    ? route : features.queryAsCrossModuleFlowSurvey ? 'flow' : 'general';
  const anchors = [...new Set([...extractQueryPlanAnchors(query),
    ...extractQueryPlanAnchors(taskContext ?? '')])].slice(0, 16);
  const literalTexts = extractQueryPlanLiteralTexts(canonicalQuery);
  return {
    version: QUERY_PLAN_VERSION,
    originalQuery: query,
    ...(taskContext ? { taskContext } : {}),
    canonicalQuery,
    intent,
    route,
    anchors,
    ...(literalTexts.length ? { literalTexts } : {}),
    searchTerms: shape.extractSearchTerms(canonicalQuery, { stems: false }).slice(0, 24),
    steps: [{ id: 's1', query, intent, anchors: [...anchors],
      ...(literalTexts.length ? { literalTexts: [...literalTexts] } : {}), dependsOn: [] }],
    features,
    source: 'rules',
    confidence: route !== 'general' || anchors.length ? 1 : 0.5,
    telemetry: { durationMs: Date.now() - started },
  };
}

/** Eligibility is separate from provider availability, actual requests and plan acceptance. */
export function getModelQueryPlanningDecision(plan: QueryPlan): QueryPlanningDecision {
  const decision = (eligible: boolean, reason: QueryPlanningDecision['reason']): QueryPlanningDecision =>
    ({ eligible, reason, ruleRoute: plan.route });
  const defer = shape.queryShouldDeferToBuiltinTools(plan.originalQuery);
  if (defer && defer !== 'file-listing' && defer !== 'concept-or-existence') return decision(false, 'builtin_tool');
  // A precise follow-up stays cheap, even under a larger original task.
  const query = plan.originalQuery.trim();
  if (/^[\w@./\\: ,、，-]+$/.test(query) && plan.anchors.length > 0
    && query.split(/[\s,、，]+/).filter(Boolean).every((token) =>
      plan.anchors.includes(token) || /^[A-Za-z_][\w]*(?:[./:][\w.-]+)*$/.test(token))) {
    // Only symbol bags, not ordinary all-English sentences with one Type name.
    const words = query.split(/[\s,、，]+/).filter(Boolean);
    // Hint extraction also returns prose such as "metadata" and "reference".
    // Under task context, only code-shaped tokens (plus an optional declaration
    // kind suffix) qualify as a cheap exact lookup; hints alone certify nothing.
    const scopedExact = words.every((word, i) => /[a-z0-9][A-Z]|[._/:@]|^[A-Z][A-Z0-9_]{3,}$/.test(word)
      || (words.length > 1 && i === words.length - 1 && /^(?:class|struct|interface|enum|function|method)$/.test(word)));
    if (words.length <= 8 && words.every((word) => plan.anchors.includes(word)
      || /[A-Z_./:@]/.test(word)) && (!plan.taskContext || scopedExact)) return decision(false, 'exact_symbol_or_path');
  }
  // Matching one retrieval shape says nothing about the completeness of a
  // scoped change task. Give explicit llm callers one bounded planning chance.
  if (normalizeQueryPlanTaskContext(plan.taskContext)) return decision(true, 'task_context_requires_planning');
  // Without task context retain the existing low-cost eligibility behavior.
  const compound = /然后|并且|同时|此外|\bthen\b|\balso\b|\bin addition\b|[;；]/i.test(plan.originalQuery);
  if (!compound && (plan.route !== 'general' || plan.features.queryAsCrossModuleFlowSurvey)) return decision(false, 'existing_shape_route');
  if (!compound && (plan.features.queryAsLocalSymbolDetail || plan.features.queryHasNamedMemberFocus
    || plan.features.queryAsFocusedUiCluster || plan.features.queryAsNamedComponentAction)) return decision(false, 'focused_query');
  return decision(true, 'ambiguous_or_compound');
}

/** Compatibility boolean for callers that do not need the diagnostic reason. */
export function shouldUseModelQueryPlan(plan: QueryPlan): boolean {
  return getModelQueryPlanningDecision(plan).eligible;
}

const intentCue: Record<QueryIntent, string> = {
  general: '', usages: 'where used usages', modules: 'module dependencies',
  native: 'NAPI exports which APIs', flow: 'call chain', overview: 'project module file overview',
};

const relationCue: Record<QueryRelation, string> = {
  incoming_references: 'incoming references where used',
  registration_sites: 'registration sites where used',
  outgoing_calls: 'outgoing calls call chain',
  module_imports: 'module imports dependencies',
  module_cycles: 'circular module import cycles',
};

/** Relation direction is explicit data, not guessed from a dependency word. */
export function intentForQueryRelation(intent: QueryIntent, relation?: QueryRelation): QueryIntent {
  if (relation === 'incoming_references' || relation === 'registration_sites') return 'usages';
  if (relation === 'outgoing_calls') return 'flow';
  if (relation === 'module_imports' || relation === 'module_cycles') return 'modules';
  return intent;
}

/** Add verified/name hints for every intent, including the general retrieval path. */
export function adaptQueryPlanQuery(query: string, intent: QueryIntent, anchors: string[], relation?: QueryRelation): string {
  const cue = relation ? relationCue[relation] : intentCue[intent];
  const tokens = new Set(query.split(/\s+/));
  const extra = [...anchors.filter((anchor) => !tokens.has(anchor)), ...(cue ? [cue] : [])];
  return extra.length ? `${query}\n${extra.join(' ')}` : query;
}

export function routeForQueryIntent(intent: QueryIntent, canonicalQuery: string, originalQuery = canonicalQuery): QueryRoute {
  if (intent === 'usages' || intent === 'modules' || intent === 'native') return intent;
  if (intent === 'overview') return queryExplicitlyRequestsProjectMap(originalQuery) ? 'project' : 'general';
  // Never collapse a requested call chain into one unrelated inventory or mechanism.
  if (intent === 'flow') return 'general';
  return localRoute(canonicalQuery, queryPlanFeatures(canonicalQuery));
}

/** Rebind only exact symbols resolved by the executor, never prose scraped from tool output. */
export function compileQueryPlanStep(plan: QueryPlan, step: QueryPlanStep, resolvedAnchors: string[] = []): QueryPlan {
  const anchors = [...new Set([...step.anchors, ...resolvedAnchors])]
    .filter((value) => value.length > 0 && value.length <= 256).slice(0, 16);
  const downgradedOverview = step.intent === 'overview' && !queryExplicitlyRequestsProjectMap(plan.originalQuery);
  const relation = step.relation;
  const stepIntent = intentForQueryRelation(downgradedOverview ? 'general' : step.intent, relation);
  const query = downgradedOverview ? plan.originalQuery : step.query;
  const literalTexts = step.literalTexts ?? (plan.steps.length === 1 ? plan.literalTexts : undefined) ?? [];
  const sourceScope = step.sourceScope ?? plan.sourceScope;
  // Scope and negations remain losslessly in originalQuery/taskContext for the
  // executor and cache. Repeating that prose here erases the step's focus.
  // A planner's English explanation is not source text. Only its typed slots
  // become seeds; this prevents a verb such as "locate" matching an SDK method.
  // Legacy/malformed seedless steps retain the USER's query, never planner prose.
  const seeds = [...new Set([...anchors, ...(step.searchTerms ?? []), ...literalTexts])];
  const retrievalQuery = plan.source === 'llm'
    ? seeds.join(' ') || plan.originalQuery : withTaskContext(query, plan.taskContext);
  const canonicalQuery = plan.source === 'rules' && stepIntent === 'general'
    ? retrievalQuery : adaptQueryPlanQuery(retrievalQuery, stepIntent, anchors, relation);
  const searchTerms = plan.source === 'llm' && seeds.length
    ? seeds.slice(0, 24) : [...new Set([...anchors, ...(step.searchTerms ?? []),
      ...shape.extractSearchTerms(retrievalQuery, { stems: false })])].slice(0, 24);
  return {
    ...plan,
    canonicalQuery,
    intent: stepIntent,
    route: routeForQueryIntent(stepIntent, canonicalQuery, plan.originalQuery),
    anchors,
    searchTerms,
    literalTexts,
    relation,
    sourceScope,
    steps: [{ ...step, intent: stepIntent, anchors, literalTexts, sourceScope, dependsOn: [] }],
    features: queryPlanFeatures(canonicalQuery),
  };
}

/** Remote planning is lazy, opt-in and has no provider/credential discovery. */
export async function planQuery(query: string, options: QueryPlanOptions): Promise<QueryPlan> {
  const local = buildRuleQueryPlan(query, options.taskContext);
  local.telemetry.decision = process.env.HOMEGRAPH_QUERY_PLANNER === 'llm'
    ? getModelQueryPlanningDecision(local) : { eligible: false, reason: 'planner_disabled', ruleRoute: local.route };
  if (!local.telemetry.decision.eligible) return local;
  const { requestModelQueryPlan } = await import('./query-plan-provider');
  return requestModelQueryPlan(local, options);
}
