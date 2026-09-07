import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import HomeGraph from '../src/index';
import { ToolHandler, getExploreOutputBudget, type ToolResult } from '../src/mcp/tools';
import { EXPLORE_EMISSION_KEY, ExploreSessionState } from '../src/mcp/explore-session-state';
import { QueryPool } from '../src/mcp/query-pool';

const QUESTION = 'Explain how items are loaded, then find every place the selection operation is reused';

function output(result: ToolResult): string {
  return result.content.map((part) => part.text).join('\n');
}

function modelPlan() {
  return {
    intent: 'general',
    canonicalQuery: QUESTION,
    anchors: [],
    searchTerms: ['items', 'selection'],
    confidence: 0.9,
    steps: [
      { id: 'locate', query: 'loadItems selectItem', intent: 'flow', anchors: [], dependsOn: [] },
      { id: 'usage', query: 'where used', intent: 'usages', anchors: [], dependsOn: ['locate'] },
    ],
  };
}

function installModelResponse(plan: unknown = modelPlan()) {
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'llm');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_URL', 'https://planner.test.invalid/v1');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_MODEL', 'fixture-planner');
  vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_API_KEY', 'fixture-secret-not-for-output');
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(plan) } }],
    usage: { prompt_tokens: 21, completion_tokens: 35, total_tokens: 56 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('structured query planning at the MCP boundary', () => {
  let tmp: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'rules');
    vi.stubEnv('HOMEGRAPH_MCP_CACHE', '0');
    vi.stubEnv('HOMEGRAPH_EXPLORE_SHAPE_ROUTING', '1');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-query-plan-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'items.ts'), [
      'export const ITEM_MODE_ACTIVE = 1;',
      'export function selectItem(items: string[]): string { return items[ITEM_MODE_ACTIVE]; }',
      'export function loadItems(): string { return selectItem(["inactive", "selected"]); }',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'src', 'consumer.ts'), [
      'import { ITEM_MODE_ACTIVE, selectItem } from "./items";',
      'export const activeMode = ITEM_MODE_ACTIVE;',
      'export function showItem(): string { return selectItem(["first", "second"]); }',
      '',
    ].join('\n'));
    cg = HomeGraph.initSync(tmp, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.setBuildPhase('full');
    handler = new ToolHandler(cg);
    // Any unintended request must fail locally, never contact a real provider.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    cg?.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(['rules', 'off', 'llm'])('preserves exact usage routing in %s mode without a model request', async (mode) => {
    const fetchMock = installModelResponse();
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', mode);
    const plannedFast = vi.spyOn(handler as any, 'tryPlannedFastPath');
    const deadlineDispatch = vi.spyOn(handler as any, 'runReadToolWithDeadline');
    const result = await handler.execute('homegraph_explore', { query: 'ITEM_MODE_ACTIVE' });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toContain('HomeGraph specialized route: usages');
    expect(output(result)).toContain('src/consumer.ts');
    expect(fetchMock).not.toHaveBeenCalled();
    if (mode !== 'off') expect(result._meta?.homegraphQueryPlan).toMatchObject({
      planningEligible: false, skip_reason: mode === 'llm' ? 'exact_symbol_or_path' : 'planner_disabled',
      ruleRoute: 'usages', modelRequests: 0,
    });
    if (mode !== 'off') expect(plannedFast).toHaveBeenCalledTimes(1);
    expect(deadlineDispatch).not.toHaveBeenCalled();
  });

  it('keeps post-request planning fallback off the main fast path and on the original deadline', async () => {
    const fetchMock = installModelResponse();
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER_TIMEOUT_MS', '10000');
    vi.stubEnv('CODEGRAPH_QUERY_BUSY_TIMEOUT_MS', '15000');
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    fetchMock.mockImplementation(async () => {
      clock.mockReturnValue(startedAt + 10000);
      throw new Error('fixture provider failure after planning time was spent');
    });
    const plannedFast = vi.spyOn(handler as any, 'tryPlannedFastPath').mockReturnValue({
      content: [{ type: 'text', text: 'Main-thread fast evidence' }],
    });
    const deadlineDispatch = vi.spyOn(handler as any, 'runReadToolWithDeadline');
    const workerDispatch = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Worker retrieval evidence' }],
    }));
    handler.setQueryPool({ healthy: true, run: workerDispatch } as unknown as QueryPool);
    try {
      const result = await handler.execute('homegraph_explore', { query: QUESTION });
      expect(result.isError).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(plannedFast).not.toHaveBeenCalled();
      expect(deadlineDispatch).toHaveBeenCalledTimes(1);
      expect(workerDispatch).toHaveBeenCalledTimes(1);
      const dispatchedArgs = deadlineDispatch.mock.calls[0]![1] as Record<string, any>;
      expect(dispatchedArgs.__homegraphQueryDeadlineAt).toBe(startedAt + 15000);
      expect(dispatchedArgs.__homegraphQueryDeadlineAt - Date.now()).toBe(5000);
      expect(dispatchedArgs.__homegraphQueryPlan).toMatchObject({
        source: 'rules', telemetry: { requestCount: 1, fallbackReason: 'provider_or_parse_error' },
      });
      expect(workerDispatch).toHaveBeenCalledWith('homegraph_explore', dispatchedArgs, expect.any(Object));
      expect(output(result)).toContain('Worker retrieval evidence');
    } finally { handler.setQueryPool(null); }
  });

  it('ignores client-injected plans, expired deadlines and forged index state', async () => {
    const result = await handler.execute('homegraph_explore', {
      query: 'ITEM_MODE_ACTIVE',
      __homegraphQueryPlan: {
        version: 1,
        source: 'llm',
        originalQuery: 'ITEM_MODE_ACTIVE',
        canonicalQuery: 'native/renderer NAPI exports',
        intent: 'native',
        route: 'native',
        anchors: ['InventedExport'],
        steps: [],
      },
      __homegraphQueryDeadlineAt: 1,
      __homegraphQueryIndexState: 'none:0',
    });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toContain('HomeGraph specialized route: usages');
    expect(output(result)).toContain('src/consumer.ts');
    expect(output(result)).not.toMatch(/InventedExport|specialized route: native|deadline exceeded/i);
  });

  it('passes bounded task context through the MCP boundary without exposing it in diagnostics', async () => {
    const fetchMock = installModelResponse();
    vi.stubEnv('HOMEGRAPH_QUERY_TASK_CONTEXT', 'Server task: keep wearable unchanged');
    const result = await handler.execute('homegraph_explore', {
      query: QUESTION,
      taskContext: 'Remove the phone selection action and its references; keep wearable unchanged',
    });
    expect(result.isError).toBeFalsy();
    expect(result._meta?.homegraphQueryPlan).toMatchObject({ hasTaskContext: true,
      planningEligible: true, planningReason: 'task_context_requires_planning', modelRequests: 1 });
    expect(result._meta?.homegraphQueryPlan).not.toHaveProperty('skip_reason', expect.any(String));
    expect(JSON.stringify(result._meta)).not.toContain('Server task:');
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[1].content).toContain('Remove the phone selection');
    expect(request.messages[1].content).toContain('Server task: keep wearable unchanged');
  });

  it.each(['fast', 'indexing'] as const)('gates %s with zero symbols before planning on both entry points', async (phase) => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-query-plan-empty-'));
    let emptyCg: HomeGraph | undefined;
    try {
      fs.writeFileSync(path.join(emptyDir, 'pending.ts'), 'export const pending = 1;\n');
      emptyCg = HomeGraph.initSync(emptyDir, { config: { include: ['**/*.ts'], exclude: [] } });
      emptyCg.buildProjectMap();
      emptyCg.setBuildPhase(phase);
      expect(emptyCg.getStats().nodeCount).toBe(0);
      const emptyHandler = new ToolHandler(emptyCg);
      const fetchMock = installModelResponse();
      for (const result of [
        await emptyHandler.execute('homegraph_explore', { query: QUESTION }),
        await emptyHandler.executeReadTool('homegraph_explore', { query: QUESTION }),
      ]) {
        expect(result.isError).toBeFalsy();
        expect(output(result)).toContain('homegraph_project');
        expect(output(result)).toMatch(/still building|preparing/i);
        expect(output(result)).not.toContain('ANSWER NOW');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      emptyCg?.destroy();
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('serves existing symbol evidence while a background reindex is in progress', async () => {
    cg.setBuildPhase('indexing');
    expect(cg.getStats().nodeCount).toBeGreaterThan(0);
    const result = await handler.execute('homegraph_explore', { query: 'ITEM_MODE_ACTIVE' });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toContain('HomeGraph specialized route: usages');
    expect(output(result)).toContain('src/consumer.ts');
    expect(output(result)).not.toContain('Full symbol index is still building');
  });

  it('executes dependent steps with real resolved anchors, one deadline and one session emission', async () => {
    const fetchMock = installModelResponse();
    const executeStep = (handler as any).executePlannedStep.bind(handler);
    const calls: Array<{ query: string; anchors: string[]; deadline: number }> = [];
    vi.spyOn(handler as any, 'executePlannedStep').mockImplementation(async (args: any, plan: any) => {
      calls.push({ query: plan.canonicalQuery, anchors: plan.anchors, deadline: args.__homegraphQueryDeadlineAt });
      return executeStep(args, plan);
    });
    const session = new ExploreSessionState();
    const result = await handler.execute('homegraph_explore', { query: QUESTION }, session);
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].anchors).toContain('selectItem');
    expect(calls[1].query).toContain('selectItem');
    expect(calls[0].deadline).toBeGreaterThan(0);
    expect(calls[1].deadline).toBe(calls[0].deadline);
    expect(output(result)).toContain('src/consumer.ts');
    expect(output(result)).not.toContain('ANSWER NOW');
    expect(session.forProject(cg.getProjectRoot()).callCount).toBe(1);
    const meta = (result as any)._meta.homegraphQueryPlan;
    expect(meta.source).toBe('llm');
    expect(meta.steps).toHaveLength(2);
    expect(meta.steps[0].resolvedAnchors).toContain('selectItem');
    expect(JSON.stringify(meta)).not.toContain('fixture-secret-not-for-output');
    expect(meta.durationMs).toBeGreaterThanOrEqual(meta.planningMs);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(JSON.stringify(requestBody)).not.toContain('export function');
    expect(JSON.stringify(requestBody)).not.toContain(tmp);
  });

  it('retains successful step evidence and reports partial when another step fails', async () => {
    installModelResponse();
    const executeStep = (handler as any).executePlannedStep.bind(handler);
    let calls = 0;
    vi.spyOn(handler as any, 'executePlannedStep').mockImplementation(async (args: any, plan: any) => {
      if (++calls === 2) throw new Error('fixture step failed');
      return executeStep(args, plan);
    });
    const result = await handler.execute('homegraph_explore', { query: QUESTION });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toContain('selectItem');
    expect(output(result)).toMatch(/partial/i);
    expect(output(result)).not.toContain('ANSWER NOW');
    expect((result as any)._meta.homegraphQueryPlan.steps).toHaveLength(2);
  });

  it('does not start the next step after the shared deadline has elapsed', async () => {
    installModelResponse();
    const executeStep = (handler as any).executePlannedStep.bind(handler);
    const spy = vi.spyOn(handler as any, 'executePlannedStep').mockImplementation(async (args: any, plan: any) => {
      const result = await executeStep(args, plan);
      vi.spyOn(Date, 'now').mockReturnValue(args.__homegraphQueryDeadlineAt + 1);
      return result;
    });
    const result = await handler.execute('homegraph_explore', { query: QUESTION });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(output(result)).toContain('selectItem');
    expect(output(result)).toMatch(/partial|deadline|budget/i);
    expect(output(result)).not.toContain('ANSWER NOW');
  });

  it('transfers one plan through the real worker without a second model request', async () => {
    const workerPath = path.resolve(__dirname, '../dist/mcp/query-worker.js');
    expect(fs.existsSync(workerPath), 'Run npm run build before worker integration tests').toBe(true);
    const fetchMock = installModelResponse();
    const pool = new QueryPool({ root: tmp, size: 1, createWorker: () => new Worker(workerPath, {
      workerData: { root: tmp }, env: { ...process.env, HOMEGRAPH_QUERY_PLANNER: 'off', HOMEGRAPH_QUERY_PLANNER_API_KEY: '' },
    }) });
    const dispatch = vi.spyOn(pool, 'run');
    handler.setQueryPool(pool);
    try {
      const result = await handler.execute('homegraph_explore', { query: QUESTION });
      expect(result.isError).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(output(result)).toContain('src/consumer.ts');
      expect((result._meta?.homegraphQueryPlan as any).steps).toHaveLength(2);
    } finally { handler.setQueryPool(null); await pool.destroy(); }
  }, 20000);

  it('bounds aggregate output and closes trimmed source fences', async () => {
    installModelResponse();
    vi.spyOn(handler as any, 'executePlannedStep').mockResolvedValue({ content: [{ type: 'text',
      text: '**Evidence**\n```ts\n' + 'selectItem();\n'.repeat(2500) + '```\n**ANSWER NOW**',
    }] });
    const result = await handler.execute('homegraph_explore', { query: QUESTION });
    expect(output(result).length).toBeLessThanOrEqual(getExploreOutputBudget(cg.getStats().fileCount).maxOutputChars);
    expect(output(result)).toContain('shared output budget');
    expect((output(result).match(/^```/gm)?.length ?? 0) % 2).toBe(0);
    expect(output(result)).not.toContain('ANSWER NOW');
  });

  it('skips a dependent step when its predecessor supplied no evidence', async () => {
    installModelResponse();
    const spy = vi.spyOn(handler as any, 'executePlannedStep').mockResolvedValue({
      content: [{ type: 'text', text: 'No relevant code found for this query' }],
    });
    const result = await handler.execute('homegraph_explore', { query: QUESTION });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((result._meta?.homegraphQueryPlan as any).steps[1].status).toBe('dependency_unresolved');
    expect(output(result)).toContain('predecessor supplied no resolved symbol anchors');
  });

  it('does not bind global fuzzy hits or input anchors from prose-only results', async () => {
    installModelResponse();
    const globalSearch = vi.spyOn(cg, 'searchNodes');
    const execute = vi.spyOn(handler as any, 'executePlannedStep').mockResolvedValue({
      content: [{ type: 'text', text: '**Partial locator** — selectItem is mentioned, but no source locations were returned.' }],
    });
    const result = await handler.execute('homegraph_explore', { query: QUESTION });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(globalSearch.mock.calls.filter(([query]) => String(query).includes(QUESTION))).toHaveLength(0);
    expect((result._meta?.homegraphQueryPlan as any).steps[0].resolvedAnchors).toEqual([]);
    expect((result._meta?.homegraphQueryPlan as any).steps[1].status).toBe('dependency_unresolved');
  });

  it('routes model general steps through planned hints rather than legacy fast seeds', async () => {
    installModelResponse({ ...modelPlan(), steps: [
      { id: 'locate', query: 'loadItems implementation mechanism', intent: 'general', anchors: ['loadItems'], dependsOn: [] },
    ] });
    const fast = vi.spyOn(handler as any, 'tryLightMechanismExplore');
    const find = vi.spyOn(cg, 'findRelevantContext');
    await handler.execute('homegraph_explore', { query: QUESTION });
    expect(fast).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalled();
    expect(find.mock.calls[0]?.[1]?.retrievalHints?.symbols).toContain('loadItems');
  });

  it('does not rebind an inherited node as a newly located dependent target', async () => {
    installModelResponse({ ...modelPlan(), steps: [
      { id: 'a', query: 'loadItems', intent: 'general', anchors: [], dependsOn: [] },
      { id: 'b', query: 'selected target', intent: 'general', anchors: [], searchTerms: ['selection', 'target'], dependsOn: ['a'] },
      { id: 'c', query: 'where used', intent: 'usages', anchors: [], dependsOn: ['b'] },
    ] });
    const node = cg.getNodesByName('loadItems')[0]!;
    const located = { id: node.id, name: node.name, qualifiedName: node.qualifiedName,
      filePath: node.filePath, startLine: node.startLine };
    const step = vi.spyOn(handler as any, 'executePlannedStep').mockResolvedValue({
      content: [{ type: 'text', text: `**Partial locator** — loadItems at src/items.ts:${node.startLine}` }],
      [EXPLORE_EMISSION_KEY]: { projectRoot: tmp, query: 'loadItems', files: [], sourceBytes: 0,
        responseBytes: 80, locatedNodes: [located] },
    });
    const result = await handler.execute('homegraph_explore', { query: QUESTION });
    expect(step).toHaveBeenCalledTimes(2);
    const diagnostics = (result._meta?.homegraphQueryPlan as any).steps;
    expect(diagnostics[0].locatedNodes[0]).toMatchObject(located);
    expect(diagnostics[1].locatedNodes).toEqual([]);
    expect(diagnostics[2].status).toBe('dependency_unresolved');
  });

  it('keeps bound location receipts visible when shared output trims child source', async () => {
    installModelResponse();
    const node = cg.getNodesByName('selectItem')[0]!;
    vi.spyOn(handler as any, 'executePlannedStep').mockResolvedValue({
      content: [{ type: 'text', text: '**Partial locator**\n```ts\n' + 'selectItem();\n'.repeat(2500) + '```' }],
      [EXPLORE_EMISSION_KEY]: { projectRoot: tmp, query: 'selectItem', files: [], sourceBytes: 0,
        responseBytes: 30000, locatedNodes: [{ id: node.id, name: node.name, qualifiedName: node.qualifiedName,
          filePath: node.filePath, startLine: node.startLine }] },
    });
    const result = await handler.execute('homegraph_explore', { query: QUESTION });
    const meta = (result._meta?.homegraphQueryPlan as any).steps;
    expect(meta[0].locatedNodes[0].id).toBe(node.id);
    expect(output(result)).toContain(`src/items.ts:${node.startLine}`);
    expect(output(result)).toContain('shared output budget');
    expect(output(result).length).toBeLessThanOrEqual(getExploreOutputBudget(cg.getStats().fileCount).maxOutputChars);
    expect((output(result).match(/^```/gm)?.length ?? 0) % 2).toBe(0);
    expect(result).not.toHaveProperty(EXPLORE_EMISSION_KEY);
  });

  it('does not label a pool deadline reply as successful step evidence', async () => {
    installModelResponse();
    vi.spyOn(handler as any, 'runReadToolWithDeadline').mockResolvedValue({
      content: [{ type: 'text', text: '**Partial locator** — query pool deadline exceeded.' }],
    });
    const result = await handler.execute('homegraph_explore', { query: QUESTION });
    expect((result._meta?.homegraphQueryPlan as any).steps[0].status).toBe('partial');
  });

  it('does not reinterpret a feature-specific file-listing as a whole-project map', async () => {
    const query = '有哪些与条目选择有关的文件？';
    const fetchMock = installModelResponse({ intent: 'overview', canonicalQuery: query, anchors: [],
      searchTerms: ['items'], confidence: 0.9,
      steps: [{ id: 'map', query: '工程模块文件概览', intent: 'overview', anchors: [], dependsOn: [] }],
    });
    const project = vi.spyOn(handler as any, 'handleProject');
    const result = await handler.execute('homegraph_explore', { query });
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(project).not.toHaveBeenCalled();
    expect((result._meta?.homegraphQueryPlan as any).intent).not.toBe('overview');
  });

  it('retains a project map for an explicit whole-project overview', async () => {
    const query = 'Show the whole project structure and module overview';
    installModelResponse({ intent: 'overview', canonicalQuery: query, anchors: [],
      searchTerms: [], confidence: 0.9,
      steps: [{ id: 'map', query, intent: 'overview', anchors: [], dependsOn: [] }],
    });
    const project = vi.spyOn(handler as any, 'handleProject');
    const result = await handler.execute('homegraph_explore', { query });
    expect(result.isError).toBeFalsy();
    expect(project).toHaveBeenCalledTimes(1);
    expect(output(result)).toContain('items.ts');
  });
});
