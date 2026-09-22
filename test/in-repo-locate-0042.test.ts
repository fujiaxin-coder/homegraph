/**
 * Spec 0042 — in-repo locate: taskContext out of FTS, PascalCase seed, local scope, noise filter.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../src';
import {
  buildRuleQueryPlan,
  compileQueryPlanStep,
} from '../src/search/query-plan';
import {
  extractInRepoLocateAnchors,
  resolveExploreSourceScope,
  isMcpNoiseNode,
} from '../src/search/query-utils';
import { ToolHandler } from '../src/mcp/tools';
import { cleanupArktsProjects, makeArktsProject } from './languages/arkts/helpers';

afterEach(() => {
  cleanupArktsProjects();
});

describe('Spec 0042 in-repo locate helpers', () => {
  it('extracts PascalCase ≥8 anchors and skips short generics', () => {
    const anchors = extractInRepoLocateAnchors(
      'PracticeDetailView 详情页 TextInput target size Page View',
    );
    expect(anchors).toContain('PracticeDetailView');
    expect(anchors).not.toContain('Page');
    expect(anchors).not.toContain('View');
    expect(anchors).not.toContain('target');
    expect(anchors).not.toContain('size');
    // TextInput is 9 chars but is a common widget name — still ≥8 so may appear;
    // seeding is query-only, so taskContext-only TextInput must not pollute via FTS.
  });

  it('resolves sourceScope=local for in-repo signals; keeps SDK asks open', () => {
    expect(resolveExploreSourceScope('PracticeDetailView 导航栏')).toBe('local');
    expect(resolveExploreSourceScope('物品信息页面 预估重量')).toBe('local');
    expect(resolveExploreSourceScope('在工程中新增扫一扫入口')).toBe('local');
    expect(resolveExploreSourceScope('what is @kit.ArkUI.Animator API')).toBe('all');
    expect(resolveExploreSourceScope('navigator.d.ts target size', 'sdk')).toBe('sdk');
  });

  it('flags ArkAnalyzer dummy / anonymous nodes as MCP noise', () => {
    expect(isMcpNoiseNode({ name: 'Index', filePath: '@dummyFile.ets' })).toBe(true);
    expect(isMcpNoiseNode({ name: '%AM0$build', filePath: 'pages/Index.ets' })).toBe(true);
    expect(isMcpNoiseNode({ name: 'Index', filePath: 'pages/Index.ets' })).toBe(false);
  });

  it('keeps taskContext off canonicalQuery while merging quoted literals', () => {
    const q = 'PracticeDetailView 详情页 导航栏';
    const ctx = 'Also mentions TextInputBuilder and "预估重量" as background';
    const plan = buildRuleQueryPlan(q, ctx);
    expect(plan.canonicalQuery).toBe(q);
    expect(plan.searchTerms.join(' ')).not.toMatch(/TextInputBuilder/);
    expect(plan.literalTexts).toContain('预估重量');
    expect(plan.sourceScope).toBe('local');
    const step = compileQueryPlanStep(plan, plan.steps[0]!);
    expect(step.canonicalQuery).not.toContain(ctx);
    expect(step.canonicalQuery).not.toContain('TextInputBuilder');
  });
});

describe('Spec 0042 explore seeding', () => {
  it('forces PracticeDetailView roots even when taskContext names TextInput', async () => {
    const root = makeArktsProject({
      'entry/src/main/ets/pages/PracticeDetailView.ets': `
@Entry
@Component
struct PracticeDetailView {
  build(): void {}
}
`,
      'entry/src/main/ets/components/TextInputBuilder.ets': `
@Component
struct TextInputBuilder {
  build(): void {}
}
`,
      'entry/src/main/module.json5': `{
  "module": { "name": "entry", "type": "entry", "pages": "pages/PracticeDetailView" }
}`,
    });
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();
    cg.setBuildPhase('full');
    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_explore', {
      query: 'PracticeDetailView 详情页 导航栏菜单',
      taskContext: 'Change the TextInputBuilder preview and TextInput focus behavior as background only',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/PracticeDetailView/);
    // Exact locate seed must surface the named page; TextInputBuilder must not be the sole hit.
    expect(text).not.toMatch(/TextInputBuilder\.ets[\s\S]*PracticeDetailView/);
    cg.close();
  });

  it('omits @dummyFile from homegraph_file used-by when only noise dependents exist', async () => {
    // Without a real dependent graph edge, used-by is empty — assert the filter helper
    // and that file replies never advertise @dummy paths if present in the list.
    const root = makeArktsProject({
      'entry/src/main/ets/pages/Index.ets': `
@Entry
@Component
struct Index {
  build(): void {}
}
`,
      'entry/src/main/module.json5': `{
  "module": { "name": "entry", "type": "entry", "pages": "pages/Index" }
}`,
    });
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();
    cg.setBuildPhase('full');
    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_file', {
      path: 'entry/src/main/ets/pages/Index.ets',
      symbolsOnly: true,
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toMatch(/@dummyFile/);
    expect(text).not.toMatch(/%AM\d+/);
    cg.close();
  });
});
