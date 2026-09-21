/**
 * Spec 0041 — Harmony element/string.json lightweight FTS (no edges).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import {
  isHarmonyElementStringJson,
  isSourceFile,
  detectLanguage,
} from '../../../src/extraction/grammars';
import { parseHarmonyStringResources } from '../../../src/resolution/frameworks/arkts-entry';
import { formatHarmonyResourceHits, ToolHandler } from '../../../src/mcp/tools';
import { SERVER_INSTRUCTIONS } from '../../../src/mcp/server-instructions';
import { cleanupArktsProjects, makeArktsProject } from './helpers';

afterEach(() => {
  cleanupArktsProjects();
});

const STRING_JSON_FIXTURE = {
  'entry/src/main/resources/base/element/string.json': `{
  "string": [
    {
      "name": "submit_order",
      "value": "提交订单"
    },
    {
      "name": "share_description",
      "value": "分享描述"
    }
  ]
}`,
  'entry/src/main/module.json5': `{
  "module": {
    "name": "entry",
    "type": "entry",
    "pages": "pages/Index"
  }
}`,
  'entry/src/main/ets/pages/Index.ets': `
@Entry
@Component
struct Index {
  build(): void {
    Text($r('app.string.submit_order'))
  }
}
`,
  'rawfile/data.json': `{ "name": "noise", "value": "should not index" }`,
  'string.json': `{ "string": [{ "name": "root_noise", "value": "no" }] }`,
};

describe('Spec 0041 harmony element/string.json FTS', () => {
  it('allowlists only resources/**/element/string.json', () => {
    expect(isHarmonyElementStringJson('entry/src/main/resources/base/element/string.json')).toBe(true);
    expect(isHarmonyElementStringJson('feature/x/resources/zh_CN/element/string.json')).toBe(true);
    expect(isHarmonyElementStringJson('string.json')).toBe(false);
    expect(isHarmonyElementStringJson('rawfile/foo.json')).toBe(false);
    expect(isHarmonyElementStringJson('entry/src/main/resources/base/element/color.json')).toBe(false);
    expect(isSourceFile('entry/src/main/resources/base/element/string.json')).toBe(true);
    expect(isSourceFile('rawfile/foo.json')).toBe(false);
    expect(detectLanguage('entry/src/main/resources/base/element/string.json')).toBe('yaml');
  });

  it('parses name/value entries', () => {
    const entries = parseHarmonyStringResources(STRING_JSON_FIXTURE['entry/src/main/resources/base/element/string.json']!);
    expect(entries.map((e) => e.name).sort()).toEqual(['share_description', 'submit_order']);
    expect(entries.find((e) => e.name === 'submit_order')?.value).toBe('提交订单');
  });

  it('indexes constants with docstring values and no outgoing edges', async () => {
    const root = makeArktsProject(STRING_JSON_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();

    const constants = cg.getNodesByKind('constant')
      .filter((n) => isHarmonyElementStringJson(n.filePath));
    const submit = constants.find((n) => n.name === 'submit_order');
    expect(submit).toBeDefined();
    expect(submit!.docstring).toContain('提交订单');
    expect(submit!.qualifiedName).toBe('app.string.submit_order');
    expect(submit!.signature).toContain("$r('app.string.submit_order')");
    expect(cg.getOutgoingEdges(submit!.id)).toEqual([]);

    const hits = cg.searchNodes('提交订单');
    expect(hits.some((h) => h.node.name === 'submit_order')).toBe(true);

    const section = formatHarmonyResourceHits(cg, '提交订单 string.json');
    expect(section).toContain('Resource hits');
    expect(section).toContain('submit_order');
    expect(section).toMatch(/\$r\('app\.string\.submit_order'\)/);

    cg.close();
  });

  it('explore query with UI copy prepends Resource hits', async () => {
    const root = makeArktsProject(STRING_JSON_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();
    cg.setBuildPhase('full');
    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_explore', {
      query: '把按钮文案改成提交订单 string.json',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Resource hits');
    expect(text).toContain('submit_order');
    expect(text.split('**Resource hits**').length - 1).toBe(1);
    cg.close();
  });

  it('instructions describe searchable string.json without graph edges', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/element\/string\.json/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/no graph edges/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/not a HomeGraph graph feature yet/i);
  });
});
