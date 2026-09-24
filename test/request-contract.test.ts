import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuleQueryPlan, compileQueryPlanStep, planQuery } from '../src/search/query-plan';
import { validateModelQueryPlan } from '../src/search/query-plan-provider';
import { validateRequestContract, type RequestContract } from '../src/search/request-contract';
import { buildMcpQueryCacheKey } from '../src/mcp/query-cache';
const query = '在“账户设置”页面禁用“保存”，新按钮显示“继续提交”。';
const contract: RequestContract = { targets: [
  { id: 'page', text: '账户设置', role: 'page', presence: 'existing', objectKind: 'ui' },
  { id: 'save', text: '保存', role: 'literal', presence: 'existing', objectKind: 'ui' },
  { id: 'new', text: '继续提交', role: 'literal', presence: 'requested' },
], obligations: [{ id: 'enabled', text: '禁用“保存”', kind: 'enabled', targetId: 'save' }] };
const proposal = () => ({ canonicalQuery: '账户 设置 保存', intent: 'general', confidence: 0.9, anchors: [], searchTerms: ['保存'],
  literalTexts: [], requestContract: contract, steps: [{ id: 'find', query: '保存', intent: 'general', anchors: [], literalTexts: [], dependsOn: [] }] });
const options = () => ({ deadlineAt: Date.now() + 15000 });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('grounded request contract', () => {
  it('preserves original quotes despite empty planner arrays and binds behavior to a target', () => {
    const plan = validateModelQueryPlan(proposal(), buildRuleQueryPlan(query), options());
    expect(plan.requestContract).toEqual(contract);
    expect(compileQueryPlanStep(plan, plan.steps[0]!).literalTexts).toEqual(['账户设置', '保存', '继续提交']);
  });
  it('keeps dependent helper queries free of global UI labels', () => {
    const plan = validateModelQueryPlan(proposal(), buildRuleQueryPlan(query), options());
    const next = { id: 'follow', query: 'follow', intent: 'flow' as const, anchors: [], dependsOn: ['find'] };
    plan.steps.push(next);
    const compiled = compileQueryPlanStep(plan, next, ['Store.save']);
    expect(compiled.literalTexts).toEqual([]);
    expect(compiled.anchors).toContain('Store.save');
    expect(compiled.requestContract).toEqual(contract);
  });
  it.each([
    { ...contract, targets: [{ ...contract.targets[0], text: '虚构页面' }] },
    { ...contract, hiddenExpectedAnswer: 'unsupported' },
    { ...contract, targets: Array(7).fill(contract.targets[0]) },
    { ...contract, targets: [{ ...contract.targets[0], objectKind: 'android' }] },
    { ...contract, targets: [{ ...contract.targets[0], presence: 'must_pass' }] },
    { ...contract, obligations: [{ ...contract.obligations[0], targetId: 'missing' }] },
    { ...contract, obligations: [{ ...contract.obligations[0], id: 'page' }] },
  ])('rejects malformed or invented request assertions', value => {
    expect(() => validateRequestContract(value, query)).toThrow('invalid_request_contract');
  });
  it('rejects invented literals even when original literals fill the search cap', () => {
    const many = '“第一条”“第二条”“第三条”“第四条”“第五条”“第六条”“第七条”“第八条”';
    expect(() => validateModelQueryPlan({ ...proposal(), requestContract: undefined, literalTexts: ['不存在'] }, buildRuleQueryPlan(many), options()))
      .toThrow('unverified_literal');
  });
  it('accepts old provider output and treats new text absence conservatively', () => {
    const plan = validateModelQueryPlan({ ...proposal(), requestContract: undefined }, buildRuleQueryPlan(query), options());
    expect(plan.requestContract?.targets.every(t => t.presence === 'requested')).toBe(true);
  });
  it('falls back after one invalid planner request, without asking a repair model', async () => {
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'llm'); vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_URL', 'https://planner.invalid/v1');
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', 'fixture'); vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_MODEL', 'fixture');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...proposal(), requestContract: { ...contract, targets: [{ ...contract.targets[0], text: 'invented' }] } }) } }] })));
    vi.stubGlobal('fetch', fetcher);
    const plan = await planQuery(query, options());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(plan.source).toBe('rules'); expect(plan.telemetry.fallbackReason).toBe('invalid_request_contract');
  });
  it('isolates contract and ablation semantics in cache keys', () => {
    const plan = buildRuleQueryPlan(query);
    const key = (value: unknown) => buildMcpQueryCacheKey('homegraph_explore', { query, __homegraphQueryPlan: value }, 3);
    const base = key(plan);
    expect(key({ ...plan, requestContract: contract })).not.toBe(base);
    vi.stubEnv('HOMEGRAPH_ACCURACY_TARGETS', '0'); expect(key(plan)).not.toBe(base);
    const ablated = key(plan); vi.stubEnv('HOMEGRAPH_ACCURACY_COVERAGE', '0'); expect(key(plan)).not.toBe(ablated);
    expect(key({ ...plan, requestContract: { targets: [{ ...contract.targets[0], text: 'invented' }], obligations: [] } })).toBe(key(undefined));
  });
});
