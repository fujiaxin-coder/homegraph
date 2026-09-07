import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuleQueryPlan, compileQueryPlanStep, planQuery } from '../src/search/query-plan';
import { validateModelQueryPlan } from '../src/search/query-plan-provider';

const QUESTION = 'Explain how items are loaded, then find every place the selection operation is reused';
const options = () => ({ deadlineAt: Date.now() + 15000, validateAnchor: (v: string) => ['loadItems', 'selectItem'].includes(v) });
const proposal = () => ({ canonicalQuery: QUESTION, intent: 'general', anchors: [], searchTerms: ['items', 'selection'], confidence: 0.9,
  steps: [{ id: 'locate', query: 'loadItems selectItem', intent: 'flow', anchors: [], dependsOn: [] },
    { id: 'usage', query: 'where used', intent: 'usages', anchors: [], dependsOn: ['locate'] }] });

function configured(body: unknown = proposal()) {
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'llm');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_URL', 'https://planner.test.invalid/v1');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_MODEL', 'fixture');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', 'secret-fixture');
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }],
    usage: { prompt_tokens: 30, completion_tokens: 40 } }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('query planner contracts', () => {
  it('keeps deterministic query text unchanged and serializable', () => {
    for (const query of ['COLOR_MODE_DARK', 'startJob finishJob', 'native/renderer NAPI exports', QUESTION]) {
      const plan = buildRuleQueryPlan(query);
      expect(plan.originalQuery).toBe(query);
      expect(plan.canonicalQuery).toBe(query);
      expect(structuredClone(plan)).toEqual(plan);
    }
  });
  it('does not contact a provider in rules/off mode or for exact queries', async () => {
    const fetcher = configured();
    for (const mode of ['rules', 'off']) {
      vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', mode);
      expect((await planQuery(QUESTION, options())).source).toBe('rules');
    }
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'llm');
    await planQuery('COLOR_MODE_DARK', options());
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends one question-only request and records all returned usage', async () => {
    const fetcher = configured();
    const plan = await planQuery(QUESTION, options());
    expect(plan.source).toBe('llm');
    expect(plan.canonicalQuery).toContain(QUESTION);
    expect(plan.telemetry).toMatchObject({ inputTokens: 30, outputTokens: 40 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = (fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(JSON.parse(String(request.body)).messages[1].content).toBe(QUESTION);
    const system = JSON.parse(String(request.body)).messages[0].content;
    expect(system).toContain('Do not plan code edits, deletions, builds, tests or validation runs');
    expect(system).toContain('at most THREE steps');
    expect(request.redirect).toBe('error');
    expect(JSON.stringify(plan)).not.toContain('secret-fixture');
  });
  it('requests English retrieval wording in the existing planner call without changing budgets', async () => {
    const fetcher = configured();
    await planQuery(QUESTION, options());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = (fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1];
    const payload = JSON.parse(String(request.body));
    const system = payload.messages[0].content;
    expect(system).toContain('Write each step query in English');
    expect(system).toContain('short lowercase English words');
    expect(system).toContain('including non-English identifiers');
    expect(system).toContain('do not translate them or invent compound code names');
    expect(system).not.toContain('optionally English');
    expect(payload).toMatchObject({ temperature: 0, max_tokens: 900, stream: false });
    expect(payload.messages[1].content).toBe(QUESTION);
  });
  it('keeps Chinese identifiers and exact paths while compiling English step terms', async () => {
    const query = '定位 商品加载器 的缓存路径，然后查看调用位置';
    const taskContext = '只涉及 products/tablet/cache.ts；不要改手机端。';
    const stepQuery = 'locate 商品加载器 cache in products/tablet/cache.ts excluding phone code';
    const fetcher = configured({ canonicalQuery: stepQuery, intent: 'general',
      anchors: ['商品加载器'], searchTerms: ['cache', 'loader'], confidence: 0.9,
      steps: [{ id: 'locate', query: stepQuery, intent: 'general', anchors: ['商品加载器'],
        searchTerms: ['cache', 'loader'], dependsOn: [] }] });
    const plan = await planQuery(query, { ...options(), taskContext,
      validateAnchor: (name) => name === '商品加载器' });
    expect(plan.source).toBe('llm');
    expect(plan.originalQuery).toBe(query);
    expect(plan.taskContext).toBe(taskContext);
    const compiled = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(compiled.canonicalQuery).toBe('商品加载器 products/tablet/cache.ts cache loader');
    expect(compiled.searchTerms).not.toContain('locate');
    expect(compiled.canonicalQuery).not.toContain('excluding phone code');
    expect(compiled.anchors).toContain('商品加载器');
    expect(compiled.searchTerms).toEqual(expect.arrayContaining(['cache', 'loader']));
    const request = (fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(JSON.parse(JSON.parse(String(request.body)).messages[1].content)).toEqual({ query, taskContext });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    'Notification组件下架及引用清理',
    'Alert入口初始化失败原因分析',
    '首页数据源和Alert注册位置',
    'alert_config.json module.json5 metadata reference',
    'Find Alert',
  ])('plans scoped natural-language tasks even when a shape route matches: %s', async (query) => {
    const fetcher = configured({ canonicalQuery: query, intent: 'general', anchors: [], searchTerms: [], confidence: 0.9,
      steps: [{ id: 'locate', query, intent: 'general', anchors: [], dependsOn: [] }] });
    const taskContext = 'Update the phone alert feature and remove stale registrations; keep wearable unchanged.';
    const local = buildRuleQueryPlan(query, taskContext);
    const plan = await planQuery(query, { ...options(), taskContext });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(plan.source).toBe('llm');
    expect(plan.telemetry.decision).toEqual({ eligible: true, reason: 'task_context_requires_planning', ruleRoute: local.route });
    expect(plan.taskContext).toBe(taskContext);
  });
  it.each(['COLOR_MODE_DARK', 'AlertController.onStart', 'src/alerts/AlertController.ts', 'loadItems selectItem', 'AlertComponent struct'])
    ('keeps exact symbol/path bags cheap despite complex task context: %s', async (query) => {
      const fetcher = configured();
      const plan = await planQuery(query, { ...options(), taskContext: QUESTION });
      expect(fetcher).not.toHaveBeenCalled();
      expect(plan.telemetry.decision).toMatchObject({ eligible: false, reason: 'exact_symbol_or_path' });
    });
  it.each(['rules', 'off'])('records disabled planning without requests in %s mode', async (mode) => {
    const fetcher = configured();
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', mode);
    const plan = await planQuery('Notification组件下架及引用清理', { ...options(), taskContext: QUESTION });
    expect(fetcher).not.toHaveBeenCalled();
    expect(plan.telemetry.decision).toMatchObject({ eligible: false, reason: 'planner_disabled' });
  });
  it('retains eligibility diagnostics when an eligible request fails before fetching', async () => {
    const fetcher = configured();
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', '');
    const plan = await planQuery('Notification组件下架及引用清理', { ...options(), taskContext: QUESTION });
    expect(fetcher).not.toHaveBeenCalled();
    expect(plan.telemetry).toMatchObject({ requestCount: 0, fallbackReason: 'missing_configuration',
      decision: { eligible: true, reason: 'task_context_requires_planning' } });
  });
  it('keeps shape routing cheap when no original task context is supplied', async () => {
    const fetcher = configured();
    const plan = await planQuery('Alert入口初始化失败原因分析', options());
    expect(fetcher).not.toHaveBeenCalled();
    expect(plan.telemetry.decision).toMatchObject({ eligible: false, reason: 'focused_query' });
  });
  it.each(['git history of AlertComponent', 'check official documentation only'])
    ('does not plan a builtin-only query merely because task context exists: %s', async (query) => {
      const fetcher = configured();
      const plan = await planQuery(query, { ...options(), taskContext: QUESTION });
      expect(fetcher).not.toHaveBeenCalled();
      expect(plan.telemetry.decision).toMatchObject({ eligible: false, reason: 'builtin_tool' });
    });
  it('binds dependencies from index-resolved anchors without another model call', () => {
    const plan = validateModelQueryPlan(proposal(), buildRuleQueryPlan(QUESTION), options());
    const compiled = compileQueryPlanStep(plan, plan.steps[1]!, ['selectItem']);
    expect(compiled.route).toBe('usages');
    expect(compiled.anchors).toContain('selectItem');
    expect(compiled.canonicalQuery).toContain('selectItem');
    expect(compiled.originalQuery).toBe(QUESTION);
  });
  it.each(['missing_configuration', 'invalid_configuration'])('does not fetch on %s', async (reason) => {
    const fetcher = configured();
    if (reason === 'missing_configuration') vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', '');
    else vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_URL', 'https://user:secret@planner.test.invalid/v1');
    const plan = await planQuery(QUESTION, options());
    expect(plan.telemetry.fallbackReason).toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed on fabricated names hidden in rewrite text', async () => {
    configured({ ...proposal(), canonicalQuery: 'Find InventedSecretManager' });
    const plan = await planQuery(QUESTION, options());
    expect(plan.source).toBe('rules');
    expect(plan.telemetry.fallbackReason).toBe('unverified_anchor');
    expect(plan.telemetry.inputTokens).toBe(30);
    expect(plan.canonicalQuery).toBe(QUESTION);
  });
  it('reports an oversized model workflow instead of truncating or retrying it', async () => {
    const p = proposal();
    p.steps = Array.from({ length: 5 }, (_, i) => ({ ...p.steps[0], id: `s${i + 1}` }));
    const fetcher = configured(p);
    const plan = await planQuery(QUESTION, options());
    expect(plan.source).toBe('rules');
    expect(plan.telemetry).toMatchObject({ requestCount: 1, inputTokens: 30, outputTokens: 40,
      fallbackReason: 'invalid_plan_step_count', decision: { eligible: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['cyclic', 'forward', 'too_many', 'unknown_intent', 'low_confidence'])('rejects %s plans', (kind) => {
    const p: any = proposal();
    if (kind === 'cyclic') p.steps[0].dependsOn = ['locate'];
    if (kind === 'forward') p.steps[0].dependsOn = ['usage'];
    if (kind === 'too_many') p.steps.push({ ...p.steps[0], id: 'third' }, { ...p.steps[0], id: 'fourth' });
    if (kind === 'unknown_intent') p.intent = 'shell';
    if (kind === 'low_confidence') p.confidence = 0.3;
    expect(() => validateModelQueryPlan(p, buildRuleQueryPlan(QUESTION), options())).toThrow();
  });
  it('keeps original single-step constraints verbatim outside lexical retrieval text', () => {
    const query = 'Trace loadItems to selectItem; exclude tests and do not change native code';
    const p = { ...proposal(), canonicalQuery: 'loadItems selectItem', anchors: ['loadItems', 'selectItem'],
      steps: [{ ...proposal().steps[0], query: 'loadItems selectItem' }] };
    const plan = validateModelQueryPlan(p, buildRuleQueryPlan(query), options());
    const compiled = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(compiled.originalQuery).toBe(query);
    expect(compiled.canonicalQuery).toContain('loadItems selectItem');
    expect(compiled.canonicalQuery).not.toContain('exclude tests');
  });
  it('times out an unresponsive provider without retrying or leaking errors', async () => {
    configured();
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_TIMEOUT_MS', '100');
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetcher);
    const plan = await planQuery(QUESTION, options());
    expect(plan.source).toBe('rules');
    expect(plan.telemetry.fallbackReason).toBe('planning_timeout');
    expect(plan.telemetry.requestCount).toBe(1);
    expect(plan.telemetry.inputTokens).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['http', 'json', 'oversize'])('falls back for %s response without echoing provider payload', async (kind) => {
    configured();
    vi.stubGlobal('fetch', vi.fn(async () => kind === 'http'
      ? new Response('secret-fixture', { status: 401 }) : kind === 'json'
        ? new Response('secret-fixture') : new Response('x'.repeat(70 * 1024))));
    const plan = await planQuery(QUESTION, options());
    expect(plan.source).toBe('rules');
    expect(plan.telemetry.fallbackReason).toBeTruthy();
    expect(JSON.stringify(plan)).not.toContain('secret-fixture');
  });
  it('does not fetch when the shared deadline is exhausted', async () => {
    const fetcher = configured();
    const plan = await planQuery(QUESTION, { deadlineAt: Date.now() - 1 });
    expect(plan.telemetry.fallbackReason).toBe('deadline_exhausted');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['5000', 15000, 5000],
    ['10000', 15000, 10000],
    ['60000', 15000, 10000],
    ['10000', 7000, 6000],
  ])('bounds configured planning %s within the shared deadline %i', async (configuredMs, remainingMs, expectedMs) => {
    configured();
    vi.useFakeTimers();
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_TIMEOUT_MS', configuredMs);
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetcher);
    let settled = false;
    const pending = planQuery(QUESTION, { deadlineAt: Date.now() + remainingMs })
      .then(plan => { settled = true; return plan; });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(expectedMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).telemetry.fallbackReason).toBe('planning_timeout');
  });
  it('reserves retrieval time instead of spending the last second on planning', async () => {
    const fetcher = configured();
    const plan = await planQuery(QUESTION, { deadlineAt: Date.now() + 1000 });
    expect(plan.telemetry.fallbackReason).toBe('deadline_exhausted');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
