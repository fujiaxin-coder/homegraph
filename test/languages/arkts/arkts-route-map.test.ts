/**
 * Spec 0039 — Harmony route_map / router_map / main_pages indexing + edges.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import {
  isHarmonyRouteProfileJson,
  isSourceFile,
  detectLanguage,
} from '../../../src/extraction/grammars';
import {
  parseHarmonyRouterMap,
  parseHarmonyMainPages,
  resolveHarmonyPageSourcePath,
  harmonyModuleRootFromProfile,
} from '../../../src/resolution/frameworks/arkts-entry';
import { formatHarmonyRegistrationSources, ToolHandler } from '../../../src/mcp/tools';
import { cleanupArktsProjects, makeArktsProject } from './helpers';

afterEach(() => {
  cleanupArktsProjects();
});

const ROUTE_MAP_FIXTURE = {
  'feature/demo/src/main/resources/base/profile/route_map.json': `{
  "routerMap": [
    {
      "name": "DemoPage",
      "pageSourceFile": "src/main/ets/pages/DemoPage.ets",
      "buildFunction": "DemoPageBuilder"
    }
  ]
}`,
  'feature/demo/src/main/ets/pages/DemoPage.ets': `
@Component
export struct DemoPage {
  build(): void {}
}

@Builder
export function DemoPageBuilder() {
  DemoPage();
}
`,
  'entry/src/main/resources/base/profile/main_pages.json': `{
  "src": [
    "pages/Index"
  ]
}`,
  'entry/src/main/ets/pages/Index.ets': `
@Entry
@Component
struct Index {
  build(): void {}
}
`,
  'entry/src/main/module.json5': `{
  "module": {
    "name": "entry",
    "type": "entry",
    "pages": "$profile:main_pages"
  }
}`,
};

describe('Spec 0039 harmony route profiles', () => {
  it('allowlists only route_map / router_map / main_pages basenames', () => {
    expect(isHarmonyRouteProfileJson('a/route_map.json')).toBe(true);
    expect(isHarmonyRouteProfileJson('a/router_map.json')).toBe(true);
    expect(isHarmonyRouteProfileJson('a/main_pages.json')).toBe(true);
    expect(isHarmonyRouteProfileJson('a/string.json')).toBe(false);
    expect(isSourceFile('feature/x/src/main/resources/base/profile/route_map.json')).toBe(true);
    expect(isSourceFile('rawfile/foo.json')).toBe(false);
    expect(detectLanguage('x/route_map.json')).toBe('yaml');
  });

  it('parses routerMap and main_pages; resolves pageSourceFile to module root', () => {
    const entries = parseHarmonyRouterMap(ROUTE_MAP_FIXTURE['feature/demo/src/main/resources/base/profile/route_map.json']!);
    expect(entries).toEqual([
      {
        name: 'DemoPage',
        pageSourceFile: 'src/main/ets/pages/DemoPage.ets',
        buildFunction: 'DemoPageBuilder',
      },
    ]);
    expect(parseHarmonyMainPages(ROUTE_MAP_FIXTURE['entry/src/main/resources/base/profile/main_pages.json']!)).toEqual([
      'pages/Index',
    ]);
    expect(harmonyModuleRootFromProfile('feature/demo/src/main/resources/base/profile/route_map.json')).toBe(
      'feature/demo'
    );
    expect(
      resolveHarmonyPageSourcePath(
        'feature/demo/src/main/resources/base/profile/route_map.json',
        'src/main/ets/pages/DemoPage.ets'
      )
    ).toBe('feature/demo/src/main/ets/pages/DemoPage.ets');
  });

  it('indexes route_map routes with edges to page/builder and registeredAt', async () => {
      const root = makeArktsProject(ROUTE_MAP_FIXTURE);
      const cg = HomeGraph.initSync(root);
      await cg.indexAll();

      const routes = cg.getNodesByKind('route');
      const demo = routes.find((r) => r.name === 'DemoPage' && r.filePath.includes('route_map.json'));
      expect(demo).toBeDefined();
      expect(demo!.signature).toContain('pageSourceFile=');
      expect(demo!.signature).toContain('buildFunction=DemoPageBuilder');

      const outs = cg.getOutgoingEdges(demo!.id);
      const targets = outs.map((e) => cg.getNode(e.target));
      expect(targets.some((n) => n && (n.name === 'DemoPage' || n.name === 'DemoPageBuilder'))).toBe(
        true
      );
      const marked = outs.find((e) => (e.metadata as { synthesizedBy?: string })?.synthesizedBy === 'arkts-route-map');
      expect(marked).toBeDefined();
      expect(marked!.provenance).toBe('heuristic');
      expect(String((marked!.metadata as { registeredAt?: string }).registeredAt)).toMatch(
        /route_map\.json:\d+/
      );

      const mainPage = routes.find((r) => r.name === 'pages/Index' && r.filePath.includes('main_pages.json'));
      expect(mainPage).toBeDefined();

      const reg = formatHarmonyRegistrationSources(cg);
      expect(reg).toContain('Registration sources');
      expect(reg).toContain('route_map.json');
      expect(reg).toContain('DemoPage');

      cg.close();
    });

  it('explore query mentioning route_map prepends Registration sources', async () => {
      const root = makeArktsProject(ROUTE_MAP_FIXTURE);
      const cg = HomeGraph.initSync(root);
      await cg.indexAll();
      cg.setBuildPhase('full');
      const handler = new ToolHandler(cg);
      const res = await handler.execute('homegraph_explore', {
        query: 'route_map.json DemoPage registration',
      });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain('Registration sources');
      expect(text).toMatch(/route_map\.json/);
      // Idempotent marker once
      expect(text.split('**Registration sources**').length - 1).toBe(1);
      cg.close();
    });
});
