/**
 * Extractor-level tests for ArkUI migrate index enrichment (spec 0007).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import { bindExtractionContext, resetExtractionContext } from '../../../src/extraction/context';
import { ArkTSExtractor, resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import { ToolHandler } from '../../../src/mcp/tools';
import { cleanupArktsProjects, makeArktsProject, mockArktsQueries } from './helpers';
import type { Edge } from '../../../src/types';

const MIGRATE_FIXTURE = {
  'ParentPage.ets': `
@Observed
class Profile {
  @Track name: string = 'n'
}

@Entry
@Component
struct ParentPage {
  @State count: number = 10
  @Provide('theme') theme: string = 'dark'
  @State profile: Profile = new Profile()
  @StorageLink('globalCount') globalCount: number = 0

  aboutToAppear(): void {
    AppStorage.setOrCreate('globalTheme', 'dark')
  }

  build() {
    Column() {
      ChildComp({ count: this.count, theme: this.theme })
    }
  }
}

@Component
struct ChildComp {
  @Prop count: number
  @Consume('theme') theme: string
  build() {
    Text(\`\${this.count} \${this.theme}\`)
  }
}
`,
};

const TWO_WAY_FIXTURE = {
  'LinkPage.ets': `
@Entry
@Component
struct LinkPage {
  @State value: number = 1
  build() {
    LinkedChild({ value: this.value })
  }
}

@Component
struct LinkedChild {
  @Link value: number
  build() {
    Text(\`\${this.value}\`)
  }
}
`,
};

function viewTreeEdges(edges: Edge[]): Edge[] {
  return edges.filter((e) => e.metadata?.synthesizedBy === 'viewtree');
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

describe('languages/arkts migrate index enrichment', () => {
  it('encodes Provide arg and emits Prop transfer with passageType', () => {
    const root = makeArktsProject(MIGRATE_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('ParentPage.ets', '').extract();
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);

    const theme = result.nodes.find(
      (n) => n.name === 'theme' && n.decorators?.some((d) => d.startsWith('Provide'))
    );
    expect(theme?.decorators).toEqual(expect.arrayContaining(['Provide', 'Provide@theme']));

    const propEdge = viewTreeEdges(result.edges).find(
      (e) => e.metadata?.via === 'Prop' && e.metadata?.passageType
    );
    expect(propEdge?.metadata?.passageType).toBe('state_variable_ref');
    expect(propEdge?.metadata?.valueType).toBeDefined();
    expect(typeof propEdge?.metadata?.forcesMigration).toBe('boolean');

    const observed = result.nodes.find(
      (n) => n.name === 'Profile' && n.decorators?.includes('Observed')
    );
    expect(observed).toBeDefined();

    const obsRef = result.edges.find((e) => e.metadata?.via === 'observed-ref');
    expect(obsRef).toBeDefined();

    const storageEdge = result.edges.find(
      (e) => e.metadata?.via === 'storage-api' && e.metadata?.key === 'globalTheme'
    );
    expect(storageEdge).toBeDefined();
  });

  it('marks @Link transfers with passage metadata', () => {
    const root = makeArktsProject(TWO_WAY_FIXTURE);
    bindExtractionContext(root, mockArktsQueries() as never);
    const result = new ArkTSExtractor('LinkPage.ets', '').extract();
    const linkEdge = viewTreeEdges(result.edges).find((e) => e.metadata?.via === 'Link');
    expect(linkEdge).toBeDefined();
    expect(linkEdge?.metadata?.passageType).toBe('state_variable_ref');
  });

  it('getArkUIMigrateSnapshot + MCP tool return one-shot JSON', async () => {
    const root = makeArktsProject(MIGRATE_FIXTURE);
    const cg = HomeGraph.initSync(root);
    try {
      await cg.indexAll();
      const snap = cg.getArkUIMigrateSnapshot('ParentPage');
      expect(snap.schemaVersion).toBe(1);
      expect(snap.scope.resolved).toBe('component');
      expect(snap.components[0]?.name).toBe('ParentPage');
      const themeVar = snap.components[0]?.stateVars.find((s) => s.name === 'theme');
      expect(themeVar?.decorator).toBe('Provide');
      expect(themeVar?.decoratorArg).toBe('theme');
      expect(snap.dataPassages.length).toBeGreaterThan(0);
      expect(snap.keyChannels.some((k) => k.key === 'theme')).toBe(true);
      expect(snap.keyChannels.some((k) => k.key === 'globalTheme')).toBe(true);
      expect(snap.observedClasses.some((o) => o.name === 'Profile')).toBe(true);

      const handler = new ToolHandler(cg);
      const res = await handler.execute('homegraph_arkui_migrate', { scope: 'ParentPage' });
      expect(res.isError).toBeFalsy();
      const text = res.content[0]!.text as string;
      const parsed = JSON.parse(text);
      expect(parsed.components[0].name).toBe('ParentPage');
    } finally {
      cg.close();
    }
  });
});
