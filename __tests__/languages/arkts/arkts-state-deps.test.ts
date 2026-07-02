import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import { ToolHandler } from '../../../src/mcp/tools';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import {
  stateTransferViaForField,
  stateDecoratorKinds,
} from '../../../src/extraction/languages/arkts';
import { buildSceneConfigFromProject, Scene, ArkField } from 'arkanalyzer';
import type { Edge, Node } from '../../../src/types';
import { cleanupArktsProjects, makeArktsProject, mockArktsQueries, nodeByName } from './helpers';

const PROP_FIXTURE = {
  'ParentPage.ets': `
@Entry @Component struct ParentPage {
  @State count: number = 10
  build() { CountDownComponent({ count: this.count }) }
}
@Component struct CountDownComponent {
  @Prop count: number
  build() { Text(\`\${this.count}\`) }
}
`,
};

const LINK_FIXTURE = {
  'ParentPage.ets': `
@Entry @Component struct ParentPage {
  @State count: number = 10
  build() { CountDownComponent({ count: this.count }) }
}
@Component struct CountDownComponent {
  @Link count: number
  build() { Text(\`\${this.count}\`) }
}
`,
};

function viewTreeEdges(edges: Edge[]): Edge[] {
  return edges.filter((e) => e.metadata?.synthesizedBy === 'viewtree');
}

function edgeBetween(
  edges: Edge[],
  fromName: string,
  toName: string,
  nodes: Node[],
  via: string
): Edge | undefined {
  const fromIds = new Set(nodes.filter((n) => n.name === fromName).map((n) => n.id));
  const toIds = new Set(nodes.filter((n) => n.name === toName).map((n) => n.id));
  return viewTreeEdges(edges).find((e) => fromIds.has(e.source) && toIds.has(e.target) && e.metadata?.via === via);
}

function fieldFromScene(root: string, className: string, fieldName: string): ArkField {
  const scene = new Scene();
  scene.buildSceneFromProjectDir(
    buildSceneConfigFromProject(root, process.env.OHOS_SDK_HOME, {
      supportFileExts: ['.ets'],
      enableMethodBodyBuild: true,
    })
  );
  scene.inferTypes();
  const cls = [...scene.getClasses()].find((c) => c.getName() === className);
  const field = cls?.getFieldWithName(fieldName);
  if (!field) throw new Error(`field ${className}.${fieldName} not found`);
  return field;
}

let prevOffloadDisable: string | undefined;
beforeAll(() => {
  prevOffloadDisable = process.env.HOMEGRAPH_OFFLOAD_DISABLE;
  process.env.HOMEGRAPH_OFFLOAD_DISABLE = '1';
});
afterAll(() => {
  if (prevOffloadDisable === undefined) delete process.env.HOMEGRAPH_OFFLOAD_DISABLE;
  else process.env.HOMEGRAPH_OFFLOAD_DISABLE = prevOffloadDisable;
});

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

describe('languages/arkts state dependency graph', () => {
  it('classifies @Prop as one-way and @Link as two-way from arkanalyzer decorators', () => {
    const root = makeArktsProject(PROP_FIXTURE);
    const propField = fieldFromScene(root, 'CountDownComponent', 'count');
    const linkRoot = makeArktsProject(LINK_FIXTURE);
    const linkField = fieldFromScene(linkRoot, 'CountDownComponent', 'count');

    expect(stateDecoratorKinds(propField)).toEqual(['Prop']);
    expect(stateTransferViaForField(propField)).toBe('Prop');
    expect(stateDecoratorKinds(linkField)).toEqual(['Link']);
    expect(stateTransferViaForField(linkField)).toBe('Link');
  });

  it('indexes @Prop parent→child transfer with via=Prop and field markers', () => {
    const root = makeArktsProject(PROP_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('ParentPage.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const edge = edgeBetween(result.edges, 'count', 'count', result.nodes, 'Prop');
    expect(edge).toBeDefined();

    const parentField = result.nodes.find((n) => n.name === 'count' && n.decorators?.includes('State'));
    const childFields = result.nodes.filter((n) => n.name === 'count' && n.decorators?.includes('Prop'));
    expect(parentField).toBeDefined();
    expect(childFields.length).toBe(1);

    expect(viewTreeEdges(result.edges).some((e) => e.metadata?.via === 'prop-transfer')).toBe(false);
    expect(viewTreeEdges(result.edges).some((e) => e.metadata?.via === 'Prop')).toBe(true);
  });

  it('indexes @Link parent→child transfer with via=Link', () => {
    const root = makeArktsProject(LINK_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('ParentPage.ets', '').extract();

    const edge = edgeBetween(result.edges, 'count', 'count', result.nodes, 'Link');
    expect(edge).toBeDefined();
  });

  it('connects parent @State field to child @Prop in explore Flow', async () => {
    const root = makeArktsProject(PROP_FIXTURE);
    const cg = HomeGraph.initSync(root);
    await cg.indexAll();

    const handler = new ToolHandler(cg);
    const res = await handler.execute('homegraph_explore', {
      query: 'ParentPage.count CountDownComponent.count build',
    });
    const text = res.content[0]!.text as string;

    expect(text).toContain('**Dynamic-dispatch links among your symbols**');
    expect(text).toMatch(/count → count.*state: @Prop one-way/);
  });
});
