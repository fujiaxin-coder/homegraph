/**
 * Spec 0045 — ArkUI child-component + named-nav edge synthesis.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../src';
import { cleanupArktsProjects, makeArktsProject } from './languages/arkts/helpers';

afterEach(() => {
  cleanupArktsProjects();
});

function synthBy(e: { metadata?: unknown }, name: string): boolean {
  return (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === name;
}

describe('Spec 0045 arkui-child + arkui-named-nav', () => {
  it('bridges parent build() → child @Component (arkui-child)', async () => {
    const dir = makeArktsProject({
      'pages/CartPage.ets': `
@Component
struct ShoppingCart {
  build() {
    Text('items')
  }
}

@Component
struct CartPage {
  build() {
    ShoppingCart()
  }
}
`,
    });

    const cg = await HomeGraph.init(dir, { index: true });
    try {
      const structs = cg.getNodesByKind('struct');
      const builds = cg.getNodesByKind('method').filter((n) => n.name === 'build');
      const child = structs.find((n) => n.name === 'ShoppingCart');
      const build = builds.find((n) => {
        // CartPage's build — prefer the one that is not ShoppingCart's build.
        const q = (n.qualifiedName || '').toLowerCase();
        return q.includes('cartpage') || (!q.includes('shoppingcart') && builds.length > 1);
      }) ?? builds.find((n) => n.startLine > (child?.startLine ?? 0));
      expect(child).toBeTruthy();
      expect(build).toBeTruthy();
      const allChildEdges = builds.flatMap((b) =>
        cg.getOutgoingEdges(b.id).filter((e) => synthBy(e, 'arkui-child')),
      );
      expect(allChildEdges.some((e) => e.target === child!.id)).toBe(true);
      expect(
        allChildEdges.filter((e) => (e.metadata as { via?: string })?.via === 'Column'),
      ).toHaveLength(0);
    } finally {
      cg.close();
    }
  });

  it('does not bridge ambiguous same-name components across folders', async () => {
    const dir = makeArktsProject({
      'host/Host.ets': `
@Component
struct Host {
  build() {
    Card()
  }
}
`,
      'mod1/Card.ets': `
@Component
struct Card {
  build() { Text('a') }
}
`,
      'mod2/Card.ets': `
@Component
struct Card {
  build() { Text('b') }
}
`,
    });

    const cg = await HomeGraph.init(dir, { index: true });
    try {
      const build = cg.getNodesByKind('method').find(
        (n) => n.name === 'build' && n.filePath.replace(/\\/g, '/').includes('Host'),
      );
      expect(build).toBeTruthy();
      const cardEdges = cg.getOutgoingEdges(build!.id).filter(
        (e) => synthBy(e, 'arkui-child') && (e.metadata as { via?: string })?.via === 'Card',
      );
      expect(cardEdges).toHaveLength(0);
    } finally {
      cg.close();
    }
  });

  it('bridges pushPathByName literal → route_map route (arkui-named-nav)', async () => {
    const dir = makeArktsProject({
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
      'feature/demo/src/main/ets/pages/Home.ets': `
@Entry
@Component
struct Home {
  openDemo(): void {
    this.pathStack.pushPathByName('DemoPage');
  }

  build() {
    Button('go').onClick(() => this.openDemo())
  }
}
`,
      'feature/demo/src/main/module.json5': `{
  "module": {
    "name": "demo",
    "type": "feature",
    "routerMap": "$profile:route_map"
  }
}`,
    });

    const cg = await HomeGraph.init(dir, { index: true });
    try {
      const openDemo = cg.getNodesByKind('method').find((n) => n.name === 'openDemo');
      const route = cg.getNodesByKind('route').find((n) => n.name === 'DemoPage');
      expect(openDemo).toBeTruthy();
      expect(route).toBeTruthy();
      const bridged = cg.getOutgoingEdges(openDemo!.id).filter(
        (e) => e.target === route!.id && synthBy(e, 'arkui-named-nav'),
      );
      expect(bridged.length).toBeGreaterThanOrEqual(1);
    } finally {
      cg.close();
    }
  });

  it('ignores non-literal pushPathByName', async () => {
    const dir = makeArktsProject({
      'feature/demo/src/main/resources/base/profile/route_map.json': `{
  "routerMap": [
    { "name": "DemoPage", "pageSourceFile": "src/main/ets/pages/DemoPage.ets", "buildFunction": "DemoPageBuilder" }
  ]
}`,
      'feature/demo/src/main/ets/pages/DemoPage.ets': `
@Component
export struct DemoPage { build(): void {} }
@Builder
export function DemoPageBuilder() { DemoPage(); }
`,
      'feature/demo/src/main/ets/pages/Home.ets': `
@Entry
@Component
struct Home {
  openDemo(name: string): void {
    this.pathStack.pushPathByName(name);
  }
  build() {}
}
`,
      'feature/demo/src/main/module.json5': `{
  "module": { "name": "demo", "type": "feature", "routerMap": "$profile:route_map" }
}`,
    });

    const cg = await HomeGraph.init(dir, { index: true });
    try {
      const openDemo = cg.getNodesByKind('method').find((n) => n.name === 'openDemo');
      expect(openDemo).toBeTruthy();
      const bridged = cg.getOutgoingEdges(openDemo!.id).filter((e) => synthBy(e, 'arkui-named-nav'));
      expect(bridged).toHaveLength(0);
    } finally {
      cg.close();
    }
  });
});
