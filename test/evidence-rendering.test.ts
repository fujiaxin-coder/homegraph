import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import HomeGraph from '../src/index';
import { ToolHandler, reconcilePartialAnswerNow } from '../src/mcp/tools';
import { canonicalSourceDeclarations, neutralRetrievalGuidance, trimEvidenceAtLine } from '../src/mcp/evidence-rendering';
import { buildRuleQueryPlan, compileQueryPlanStep, type QueryPlan } from '../src/search/query-plan';
import type { Node } from '../src/types';
import { EXPLORE_EMISSION_KEY } from '../src/mcp/explore-session-state';
import { findLiteralEvidence } from '../src/search/literal-evidence';

describe('retrieval guidance preserves source', () => {
  it('does not rewrite source strings when removing a premature task close', () => {
    const code = '```ts\nconst message = "ANSWER NOW";\n// do not read this value.\n```';
    const text = '**Partial locator**\n' + code + '\n> **Explore complete — ANSWER NOW.**';
    const result = neutralRetrievalGuidance(reconcilePartialAnswerNow(text));
    expect(result).toContain(code);
    expect(result).toContain('continue the requested edits');
    expect(result).not.toContain('Explore complete — ANSWER NOW');
  });

  it('combines two parser roles but retains real overloads at different locations', () => {
    const node = { id: 'a', name: 'WifiItem', kind: 'struct', filePath: 'ui.ets', startLine: 10 } as Node;
    const nodes = canonicalSourceDeclarations([node, { ...node, id: 'b', kind: 'component' },
      { ...node, id: 'c', startLine: 30 }, { ...node, id: 'd', filePath: 'other.ets' }]);
    expect(nodes.map(n => n.id)).toEqual(['b', 'c', 'd']);
  });

  it('never cuts a code line and calls incomplete evidence partial', () => {
    const result = trimEvidenceAtLine('```ts\nconst a = 1;\n' + 'x'.repeat(500), 190);
    expect(result).toContain('const a = 1;\n```');
    expect(result).toContain('Partial source');
    expect(result).not.toContain('xxxx');
    expect(result.length).toBeLessThanOrEqual(190);
  });
});

describe('typed evidence renders source and preserves relation direction', () => {
  let root: string;
  let graph: HomeGraph;
  let handler: ToolHandler;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-evidence-output-'));
    vi.stubEnv('HOMEGRAPH_MCP_CACHE', '0');
    vi.stubEnv('HOMEGRAPH_QUERY_PLANNER', 'off');
  });
  afterEach(() => {
    graph?.destroy(); fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  });
  async function index(files: Record<string, string>) {
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
    }
    graph = HomeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    await graph.indexAll(); graph.setBuildPhase('full'); handler = new ToolHandler(graph);
  }
  async function execute(plan: QueryPlan) {
    return (handler as any).executeQueryPlan({ projectPath: root }, plan);
  }

  it('renders a resource/UI witness even when the UI has no indexed symbol', async () => {
    await index({
      'entry/src/main/resources/base/element/string.json': '{"string":[{"name":"verify_entry","value":"选择验证"}]}',
      'entry/src/main/ets/pages/Index.ets': "Button($r('app.string.verify_entry')).onClick(() => openVerification())",
      'other.ts': 'export function unrelated() { return 1; }',
    });
    const plan: QueryPlan = { ...buildRuleQueryPlan('选择验证'), source: 'llm', sourceScope: 'local',
      literalTexts: ['选择验证'], anchors: [], searchTerms: ['verification'],
      steps: [{ id: 's1', query: 'verification entry', intent: 'general', anchors: [],
        searchTerms: ['verification'], literalTexts: ['选择验证'], sourceScope: 'local', dependsOn: [] }] };
    const result = await execute(plan);
    const text = result.content[0].text;
    expect(text).toContain('verify_entry'); expect(text).toContain('openVerification()');
    expect(text).not.toContain('ANSWER NOW');
    expect(result[EXPLORE_EMISSION_KEY].evidenceStatus).toBe('partial');
  });

  it('gets registration references for a removal rather than a cycle survey', async () => {
    await index({ 'picker.ts': 'export function PhotoPicker() { return 1; }',
      'registry.ts': "import { PhotoPicker } from './picker';\nexport const registry = [PhotoPicker];" });
    const base = { ...buildRuleQueryPlan('remove PhotoPicker'), source: 'llm' as const };
    const plan = compileQueryPlanStep(base, { id: 's1', query: 'registration references', intent: 'modules',
      anchors: ['PhotoPicker'], relation: 'registration_sites', searchTerms: [], dependsOn: [] });
    const result = await execute(plan);
    expect(result.content[0].text).toContain('registry.ts');
    expect(result.content[0].text).not.toContain('circular');
  });

  it('discovers literal source before an unanchored reference survey and retains the missing obligation', async () => {
    await index({ 'entry.ts': 'export function ShippingForm() { return "总体积"; }' });
    const base = { ...buildRuleQueryPlan('remove 总体积'), source: 'llm' as const };
    const plan = compileQueryPlanStep(base, { id: 's1', query: 'volume references', intent: 'usages',
      anchors: [], relation: 'incoming_references', searchTerms: ['volume'], literalTexts: ['总体积'],
      sourceScope: 'local', dependsOn: [] });
    const result = await execute(plan);
    expect(result.content[0].text).toContain('ShippingForm');
    expect(result.content[0].text).not.toContain('No survey ran');
    expect(result[EXPLORE_EMISSION_KEY].evidenceStatus).toBe('partial');
    expect(result[EXPLORE_EMISSION_KEY].uncoveredObligations).toContain('incoming_references');
  });

  it('keeps fresh literal text but does not bind a stale indexed declaration', async () => {
    await index({ 'label.ts': 'export function OldEntry() { return "选择验证"; }' });
    fs.writeFileSync(path.join(root, 'label.ts'), 'export function NewEntry() { return "选择验证"; }');
    const literalEvidence = findLiteralEvidence(root, { literalTexts: ['选择验证'] });
    const rendered = (handler as any).renderLiteralSource(graph, { literalEvidence });
    expect(rendered.text).toContain('NewEntry');
    expect(rendered.nodes).toEqual([]);
  });

  it('does not run cycle analysis for a directed import request', async () => {
    await index({ 'feature/a.ts': "import { b } from '../common/b';\nexport const a = b;", 'common/b.ts': 'export const b = 1;' });
    const cycle = vi.spyOn(graph, 'findCircularDependencies');
    const base = { ...buildRuleQueryPlan('feature imports'), source: 'llm' as const };
    const plan = compileQueryPlanStep(base, { id: 's1', query: 'feature import edges', intent: 'modules',
      anchors: ['feature'], relation: 'module_imports', searchTerms: [], dependsOn: [] });
    const result = await execute(plan);
    expect(result.content[0].text).toContain('imports →'); expect(cycle).not.toHaveBeenCalled();
  });
});
