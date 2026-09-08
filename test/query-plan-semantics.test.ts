import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuleQueryPlan, compileQueryPlanStep, normalizeQueryPlanTaskContext, mergeQueryPlanTaskContext, planQuery,
  queryExplicitlyRequestsProjectMap, routeForQueryIntent,
} from '../src/search/query-plan';
import { validateModelQueryPlan } from '../src/search/query-plan-provider';

const options = () => ({ deadlineAt: Date.now() + 15000 });
const overview = () => ({
  canonicalQuery: 'project module file overview', intent: 'overview', anchors: [],
  searchTerms: ['project', 'module', 'overview'], confidence: 0.9,
  steps: [{ id: 'locate', query: 'project module file overview', intent: 'overview', anchors: [], dependsOn: [] }],
});

function configured(proposal: unknown = overview()) {
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'llm');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_URL', 'https://planner.test.invalid/v1');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_MODEL', 'fixture');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', 'fixture-secret');
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(proposal) } }],
  }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('query planner semantic scope', () => {
  it.each([
    '首页 组件列表 Text组件 component list Text',
    '分享 HuaweiShare 组件库 Sample',
    'Find the sign-in button and its click handler',
    'Give an overview of the payment feature',
    'TextWidget component overview',
    'Locate the repository overview button handler',
    'Find settings, not a project overview',
    'Find settings; do not map the repository',
    '定位设置入口，不要项目结构概览',
  ])('does not broaden focused retrieval into a project map: %s', (query) => {
    const local = buildRuleQueryPlan(query);
    const plan = validateModelQueryPlan(overview(), local, options());
    expect(plan.source).toBe('llm');
    expect(plan.intent).toBe('general');
    expect(plan.route).not.toBe('project');
    expect(plan.canonicalQuery).toBe(query);
    expect(plan.searchTerms).toEqual(local.searchTerms);
    const step = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(step.intent).toBe('general');
    expect(step.route).not.toBe('project');
    expect(step.originalQuery).toBe(query);
    expect(step.canonicalQuery).not.toContain('project module file overview');
  });

  it.each([
    'Show the project architecture',
    'Give me an overview of the whole repository',
    'Map modules and files',
    'module structure',
    '请说明项目整体结构',
    '查看模块划分和目录组织',
  ])('keeps explicitly requested structural maps: %s', (query) => {
    const plan = validateModelQueryPlan(overview(), buildRuleQueryPlan(query), options());
    expect(queryExplicitlyRequestsProjectMap(query)).toBe(true);
    expect(plan.intent).toBe('overview');
    expect(plan.route).toBe('project');
    expect(compileQueryPlanStep(plan, plan.steps[0]!).route).toBe('project');
  });

  it('downgrades an overview step independently of the overall intent', () => {
    const query = 'Find the sharing entry, then inspect the selected target';
    const plan = validateModelQueryPlan({ ...overview(), intent: 'general' }, buildRuleQueryPlan(query), options());
    expect(plan.steps[0]!.intent).toBe('general');
    expect(compileQueryPlanStep(plan, plan.steps[0]!).canonicalQuery).toBe(query);
  });

  it('drops an over-broad single-step rewrite and unrelated verified anchors after downgrade', () => {
    const query = 'Find the sharing entry';
    const proposal = { ...overview(), anchors: ['OtherFeature'], steps: [
      { ...overview().steps[0]!, intent: 'general', anchors: ['OtherFeature'] },
    ] };
    const plan = validateModelQueryPlan(proposal, buildRuleQueryPlan(query), {
      ...options(), validateAnchor: () => true,
    });
    expect(plan.anchors).not.toContain('OtherFeature');
    expect(plan.steps[0]!.anchors).not.toContain('OtherFeature');
    expect(compileQueryPlanStep(plan, plan.steps[0]!).canonicalQuery).toBe(query);
  });

  it('does not let generated overview cues authorize a project route', () => {
    expect(routeForQueryIntent('overview', 'project module overview', 'Find the sharing entry')).toBe('general');
    const local = buildRuleQueryPlan('Find the sharing entry');
    const step = { id: 'map', query: 'project overview', intent: 'overview' as const, anchors: [], dependsOn: [] };
    expect(compileQueryPlanStep(local, step).route).not.toBe('project');
  });

  it('recovers the focused query from an overview provider response without another request', async () => {
    const fetcher = configured();
    const query = '首页 组件列表 Text组件 component list Text';
    const plan = await planQuery(query, options());
    expect(plan.source).toBe('llm');
    expect(plan.route).not.toBe('project');
    expect(plan.canonicalQuery).toBe(query);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(plan.telemetry.fallbackReason).toBeUndefined();
  });
});

describe('original task context', () => {
  const query = 'Find the sharing entry, then inspect the selected target';
  const taskContext = 'Change sharing in the phone product only; exclude wearable; preserve the existing list order.';

  it('retains original paths and exclusions when an agent supplies an abbreviated focus', () => {
    const original = 'Fix products/phone/EntryAbility.ets; keep the wearable product unchanged';
    const merged = mergeQueryPlanTaskContext(original, 'fix the crash');
    expect(merged).toBe(original + '\nfix the crash');
    expect(mergeQueryPlanTaskContext(original, original)).toBe(original);
    expect(mergeQueryPlanTaskContext('x'.repeat(4000), 'extra')).toBe('x'.repeat(4000));
    expect(buildRuleQueryPlan('locate initialization', merged).anchors).toContain('products/phone/EntryAbility.ets');
  });

  it('does not inject framework prose as lexical search seeds', () => {
    const plan = buildRuleQueryPlan('启动相机 CameraPicker', '显示相机选择入口');
    expect(plan.canonicalQuery).toBe('启动相机 CameraPicker\n显示相机选择入口');
    expect(plan.searchTerms.map(term => term.toLowerCase())).not.toContain('code');
    const proposal = { ...overview(), intent: 'general', canonicalQuery: 'CameraPicker',
      steps: [{ id: '1', query: 'CameraPicker', intent: 'general', anchors: ['CameraPicker'], dependsOn: [] }] };
    const model = validateModelQueryPlan(proposal, plan, { ...options(), taskContext: plan.taskContext });
    expect(compileQueryPlanStep(model, model.steps[0]!).canonicalQuery).not.toMatch(/code evidence|Retrieval wording|Original query constraints/);
    expect(model.steps[0]!.id).toBe('1');
  });

  it('normalizes one bounded serializable context while retaining the original query', () => {
    expect(normalizeQueryPlanTaskContext('  ')).toBeUndefined();
    expect(normalizeQueryPlanTaskContext(' x ')).toBe('x');
    expect(normalizeQueryPlanTaskContext('a'.repeat(5000))).toHaveLength(4000);
    const plan = buildRuleQueryPlan(query, taskContext);
    expect(plan.originalQuery).toBe(query);
    expect(plan.taskContext).toBe(taskContext);
    expect(plan.canonicalQuery).toContain(taskContext);
    expect(structuredClone(plan)).toEqual(plan);
    expect(buildRuleQueryPlan(query)).not.toHaveProperty('taskContext');
  });

  it('sends the current query and bounded task, never conflating either with evidence', async () => {
    const fetcher = configured();
    const plan = await planQuery(query, { ...options(), taskContext });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(JSON.parse(body.messages[1].content)).toEqual({ query, taskContext });
    expect(body.messages[0].content).toContain('not source evidence');
    expect(plan.originalQuery).toBe(query);
    expect(plan.taskContext).toBe(taskContext);
    expect(plan.canonicalQuery).toContain(taskContext);
    expect(plan.route).not.toBe('project');
    const compiled = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(compiled.taskContext).toBe(taskContext);
  });

  it('retains task constraints separately from each dependent retrieval focus', () => {
    const proposal = { ...overview(), canonicalQuery: query, intent: 'general', steps: [
      { id: 'entry', query: 'sharing entry', intent: 'general', anchors: [], searchTerms: ['sharing', 'entry'], dependsOn: [] },
      { id: 'target', query: 'selected target', intent: 'general', anchors: [], searchTerms: ['selected', 'target'], dependsOn: ['entry'] },
    ] };
    const plan = validateModelQueryPlan(proposal, buildRuleQueryPlan(query), { ...options(), taskContext });
    for (const step of plan.steps) {
      const compiled = compileQueryPlanStep(plan, step);
      expect(compiled.originalQuery).toBe(query);
      expect(compiled.taskContext).toBe(taskContext);
      expect(compiled.canonicalQuery).toBe(step.query);
      expect(compiled.canonicalQuery).not.toContain(taskContext);
    }
  });

  it('accepts user-supplied context identifiers only as search hints, not invented names', () => {
    const proposal = { ...overview(), canonicalQuery: 'PhoneSharing', intent: 'general', anchors: ['PhoneSharing'] };
    const plan = validateModelQueryPlan(proposal, buildRuleQueryPlan(query), {
      ...options(), taskContext: 'Update PhoneSharing in the phone product only',
    });
    expect(plan.anchors).toContain('PhoneSharing');
    expect(() => validateModelQueryPlan({ ...proposal, anchors: ['InventedSharing'] }, buildRuleQueryPlan(query), {
      ...options(), taskContext,
    })).toThrow('unverified_anchor');
  });

  it('retains context when provider configuration is absent', async () => {
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'llm');
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', '');
    const plan = await planQuery(query, { ...options(), taskContext });
    expect(plan.source).toBe('rules');
    expect(plan.taskContext).toBe(taskContext);
    expect(plan.canonicalQuery).toContain(taskContext);
  });

  it('preserves quoted UI literals through provider failure using the original language', async () => {
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'llm');
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', '');
    const plan = await planQuery('点击“账户设置”后白屏', { ...options(), taskContext: '修复「资料管理」入口，保持 "profile" 文案' });
    expect(plan.source).toBe('rules');
    expect(plan.literalTexts).toEqual(['账户设置', '资料管理', 'profile']);
    expect(compileQueryPlanStep(plan, plan.steps[0]!).literalTexts).toEqual(plan.literalTexts);
  });

  it('keeps single-quoted Chinese labels embedded in prose without treating contractions as labels', () => {
    const query = "恢复'酒店位置'入口; don't replace the user's wording";
    expect(buildRuleQueryPlan(query).literalTexts).toEqual(['酒店位置']);
    const p = { ...overview(), intent: 'general', canonicalQuery: 'existing hotel location entry',
      searchTerms: ['hotel', 'location'], steps: [{ id: 's1', query: 'existing location entry', intent: 'general',
        anchors: [], searchTerms: ['hotel', 'location'], dependsOn: [] }] };
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(query), options());
    expect(compileQueryPlanStep(plan, plan.steps[0]!).literalTexts).toEqual(['酒店位置']);
  });

  it('does not expand the shared model-input budget when task context is added', async () => {
    const fetcher = configured();
    const plan = await planQuery(query.repeat(70), { ...options(), taskContext: 'scope '.repeat(800) });
    expect(plan.telemetry.fallbackReason).toBe('input_too_long');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('bounded step retrieval focus', () => {
  const question = 'Find the catalog list and then inspect its selection flow';
  const scope = 'Only inspect products/desktop; exclude archived products and keep sorting unchanged.';
  const focused = () => ({ canonicalQuery: question, intent: 'general', anchors: [] as string[],
    searchTerms: ['catalog', 'selection', 'sorting'], confidence: 0.9, steps: [
      { id: 'list', query: 'locate catalog list container', intent: 'general', anchors: [] as string[],
        searchTerms: ['catalog', 'list container'], dependsOn: [] },
      { id: 'selection', query: 'locate selection handler', intent: 'general', anchors: [] as string[],
        searchTerms: ['selection', 'handler'], dependsOn: ['list'] },
    ] });

  it('does not repeat the whole request or sibling terms in each step', () => {
    const plan = validateModelQueryPlan(focused(), buildRuleQueryPlan(question, scope), options());
    expect(plan.steps[0]!.query).toBe('locate catalog list container');
    expect(plan.steps[0]!.searchTerms).toEqual(['catalog', 'list container']);
    const step = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(step.originalQuery).toBe(question);
    expect(step.taskContext).toBe(scope);
    expect(step.canonicalQuery).not.toContain(question);
    expect(step.canonicalQuery).not.toContain(scope);
    expect(step.searchTerms).not.toContain('selection');
    expect(step.searchTerms).not.toContain('sorting');
    expect(step.searchTerms).toContain('list container');
  });

  it('puts verified predecessors into general retrieval text without copying parent hints', () => {
    const plan = validateModelQueryPlan(focused(), buildRuleQueryPlan(question, scope), options());
    const step = compileQueryPlanStep(plan, plan.steps[1]!, ['CatalogList']);
    expect(step.canonicalQuery).toContain('CatalogList');
    expect(step.anchors).toContain('CatalogList');
    expect(step.searchTerms).toContain('CatalogList');
    // Catalog can legitimately be derived from the bound CatalogList symbol;
    // unrelated parent-only terms must not leak into this step.
    expect(step.searchTerms).not.toContain('sorting');
    expect(step.originalQuery).toBe(question);
    expect(step.taskContext).toBe(scope);
  });

  it('demotes unverified prose anchors but retains exact indexed Unicode identifiers', () => {
    const p = focused();
    p.anchors = ['catalog list', '目录列表'];
    p.steps[0]!.anchors = ['catalog list', '目录列表', '真实中文组件'];
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(question + ' 目录列表'), {
      ...options(), validateAnchor: name => name === '真实中文组件',
    });
    expect(plan.anchors).not.toContain('catalog list');
    expect(plan.anchors).not.toContain('目录列表');
    expect(plan.searchTerms).toEqual(expect.arrayContaining(['catalog list', '目录列表']));
    expect(plan.steps[0]!.anchors).toEqual(['真实中文组件']);
    expect(plan.steps[0]!.searchTerms).toEqual(expect.arrayContaining(['catalog list', '目录列表']));
  });

  it('keeps supplied code-shaped mentions as hints without certifying their existence', () => {
    const p = focused();
    p.steps[0]!.anchors = ['CatalogList', 'list container'];
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan('Find CatalogList'), {
      ...options(), validateAnchor: () => false,
    });
    expect(plan.steps[0]!.anchors).toEqual(['CatalogList']);
    expect(plan.steps[0]!.searchTerms).toContain('list container');
  });

  it('rejects invented code names hidden in a step search term', () => {
    const p = focused();
    p.steps[0]!.searchTerms.push('InventedSecretManager');
    expect(() => validateModelQueryPlan(p, buildRuleQueryPlan(question), options())).toThrow('unverified_anchor');
  });

  it('recovers old seedless step shapes from the user query, never generated prose', () => {
    const p = focused();
    const steps = p.steps.map(({ searchTerms: _terms, ...step }) => step);
    const plan = validateModelQueryPlan({ ...p, steps }, buildRuleQueryPlan(question), options());
    const step = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(step.canonicalQuery).toBe(question);
    expect(step.searchTerms).not.toContain('locate');
    expect(step.searchTerms).not.toContain('sorting');
  });

  it('keeps rules-only compilation compatible with its original scoped text', () => {
    const plan = buildRuleQueryPlan(question, scope);
    expect(compileQueryPlanStep(plan, plan.steps[0]!).canonicalQuery).toBe(plan.canonicalQuery);
  });

  it('bounds optional per-step terms without increasing step limits', () => {
    const p = focused();
    p.steps[0]!.searchTerms = Array.from({ length: 25 }, (_, i) => `term ${i}`);
    expect(() => validateModelQueryPlan(p, buildRuleQueryPlan(question), options())).toThrow('invalid_plan');
  });

  it('preserves the aggregate anchor proposal bound even for natural-language hints', () => {
    const p = focused();
    p.anchors = Array.from({ length: 16 }, (_, i) => `top concept ${i}`);
    p.steps[0]!.anchors = Array.from({ length: 16 }, (_, i) => `step concept ${i}`);
    p.steps[1]!.anchors = ['one more concept'];
    expect(() => validateModelQueryPlan(p, buildRuleQueryPlan(question), options())).toThrow('unverified_anchor');
  });
});

describe('grounded planner retrieval contract', () => {
  const proposal = () => ({
    canonicalQuery: 'existing account preferences', intent: 'general', anchors: [] as string[],
    searchTerms: ['account', 'preferences'], literalTexts: ['账户设置'], sourceScope: 'local', confidence: 0.9,
    steps: [{ id: 's1', query: 'locate the account settings entry', intent: 'general', anchors: [] as string[],
      searchTerms: ['account', 'preferences'], literalTexts: ['账户设置'], sourceScope: 'local', dependsOn: [] }],
  });
  const question = '点击“账户设置”后白屏，检查入口及跳转';

  it.each(['locate', 'find', 'inspect', 'investigate', 'follow'])('never promotes the planner verb %s into an exact seed', (verb) => {
    const p = proposal();
    p.steps[0]!.query = `${verb} the account settings entry`;
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(question), {
      ...options(), validateAnchor: name => name === verb,
    });
    const compiled = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(compiled.canonicalQuery).toBe('account preferences 账户设置');
    expect(compiled.searchTerms).toEqual(['account', 'preferences', '账户设置']);
    expect(compiled.anchors).not.toContain(verb);
    expect(compiled.literalTexts).toEqual(['账户设置']);
    expect(compiled.sourceScope).toBe('local');
    expect(compiled.originalQuery).toBe(question);
  });

  it('retains original-language labels independently of translated terms and dependent focus', () => {
    const p = proposal();
    p.steps.push({ ...p.steps[0]!, id: 's2', query: 'click routing', searchTerms: ['routing'],
      literalTexts: [], dependsOn: ['s1'] });
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(question), options());
    expect(compileQueryPlanStep(plan, plan.steps[0]!).literalTexts).toEqual(['账户设置']);
    const second = compileQueryPlanStep(plan, plan.steps[1]!, ['SettingsButton']);
    expect(second.literalTexts).toEqual([]);
    expect(second.anchors).toEqual(['SettingsButton']);
    expect(second.canonicalQuery).not.toContain('账户设置');
  });

  it('rejects a translated/invented UI label absent from the original request', () => {
    const p = proposal();
    p.steps[0]!.literalTexts = ['Account settings'];
    expect(() => validateModelQueryPlan(p, buildRuleQueryPlan(question), options())).toThrow('unverified_literal');
  });

  it.each(['hotel/restaurant', 'read/write'])('does not reject natural-language slash alternatives: %s', alternatives => {
    const p = proposal();
    p.canonicalQuery = `existing ${alternatives} settings`;
    p.steps[0]!.query = p.canonicalQuery;
    p.steps[0]!.searchTerms = [alternatives, 'settings'];
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(question), options());
    const compiled = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(plan.source).toBe('llm');
    expect(compiled.anchors).not.toContain(alternatives);
    expect(compiled.searchTerms).toEqual(expect.arrayContaining(alternatives.split('/')));
  });

  it.each(['FooService/doThing.ets', 'src/widgets/invented.ts', 'InventedSettingsManager'])('rejects invented code anchors even in planner prose: %s', anchor => {
    const p = proposal();
    p.steps[0]!.query = `existing ${anchor} settings`;
    expect(() => validateModelQueryPlan(p, buildRuleQueryPlan(question), options())).toThrow('unverified_anchor');
  });

  it('does not treat an unverified lowercase slash expression as an exact path anchor', () => {
    const p = proposal();
    p.steps[0]!.anchors = ['widgets/settings'];
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(question), options());
    expect(plan.steps[0]!.anchors).toEqual([]);
    expect(plan.steps[0]!.searchTerms).toEqual(['account', 'preferences']);
  });

  it('discards generated prose misplaced into the exact-anchor field', () => {
    const p = proposal();
    p.steps[0]!.anchors = ['locate the entry', 'inspect wiring'];
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(question), options());
    const compiled = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(compiled.anchors).toEqual([]);
    expect(compiled.searchTerms).toEqual(['account', 'preferences', '账户设置']);
  });

  it.each([
    ['incoming_references', 'usages'], ['registration_sites', 'usages'],
    ['outgoing_calls', 'flow'], ['module_imports', 'modules'], ['module_cycles', 'modules'],
  ])('compiles explicit %s relation without guessing from prose', (relation, intent) => {
    const p = proposal();
    const step = { ...p.steps[0]!, relation, intent: 'modules' };
    const plan = validateModelQueryPlan({ ...p, relation, steps: [step] }, buildRuleQueryPlan(question), options());
    const compiled = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(plan.intent).toBe(intent);
    expect(compiled.intent).toBe(intent);
    expect(compiled.relation).toBe(relation);
    if (relation === 'registration_sites' || relation === 'incoming_references') {
      expect(compiled.route).toBe('usages');
      expect(compiled.canonicalQuery).not.toMatch(/module|cycle/);
    }
    if (relation === 'module_imports') expect(compiled.canonicalQuery).not.toContain('cycle');
    if (relation === 'module_cycles') expect(compiled.canonicalQuery).toContain('cycles');
  });

  it('preserves explicit SDK scope per step without applying it to its local sibling', () => {
    const p = proposal();
    p.steps.push({ ...p.steps[0]!, id: 's2', sourceScope: 'sdk', literalTexts: [], dependsOn: ['s1'] });
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(question), options());
    expect(compileQueryPlanStep(plan, plan.steps[0]!).sourceScope).toBe('local');
    expect(compileQueryPlanStep(plan, plan.steps[1]!).sourceScope).toBe('sdk');
  });

  it.each([
    { sourceScope: 'remote' }, { relation: 'any_dependency' },
  ])('rejects invalid typed retrieval fields: %j', invalid => {
    expect(() => validateModelQueryPlan({ ...proposal(), ...invalid }, buildRuleQueryPlan(question), options()))
      .toThrow('invalid_plan');
  });

  it('bounds legacy aggregate terms without rejecting a valid focused step', () => {
    const p = proposal();
    p.searchTerms = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(question), options());
    expect(plan.searchTerms).toHaveLength(6);
    expect(plan.steps[0]!.searchTerms).toEqual(['account', 'preferences']);
    p.steps[0]!.searchTerms = p.searchTerms;
    expect(() => validateModelQueryPlan(p, buildRuleQueryPlan(question), options())).toThrow('invalid_plan');
    p.steps[0]!.searchTerms = ['locate all existing account settings entries'];
    expect(() => validateModelQueryPlan(p, buildRuleQueryPlan(question), options())).toThrow('invalid_plan');
    p.steps[0]!.searchTerms = ['account', 'preferences'];
    p.searchTerms = ['locate all existing account settings entries', 'account'];
    expect(validateModelQueryPlan(p, buildRuleQueryPlan(question), options()).searchTerms).toEqual(['account']);
  });

  it('asks the same bounded provider call for typed concepts, literals and relationship direction', async () => {
    const fetcher = configured(proposal());
    await planQuery(question, { ...options(), taskContext: 'Repair the account settings entry' });
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    const system = request.messages[0].content;
    expect(system).toContain('NOT a search seed');
    expect(system).toContain('2–6 concise concepts');
    expect(system).toContain('at most three words');
    expect(system).toContain('literalTexts');
    expect(system).toContain('registration_sites');
    expect(request).toMatchObject({ temperature: 0, max_tokens: 900, stream: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
