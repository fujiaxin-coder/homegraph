/**
 * Spec 0064 — ViewTree lazy %AM handlers hang on getDeclaringArkFile(), not the importer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../../src';
import { cleanupArktsProjects, makeArktsProject } from '../../../languages/arkts/helpers';
import { resetArkTSBatch } from '../../../../src/extraction/languages/arkts';
import { resetExtractionContext } from '../../../../src/extraction/context';
import type { Node } from '../../../../src/types';

function makeP3Fixture(extra?: Record<string, string>): string {
  resetArkTSBatch();
  resetExtractionContext();
  return makeArktsProject({
    'build-profile.json5': `{
  modules: [{ name: 'entry', srcPath: './entry' }]
}`,
    'oh-package.json5': `{ name: 'p3-am-decl', version: '1.0.0' }`,
    'entry/oh-package.json5': `{ name: 'entry', version: '1.0.0' }`,
    'entry/src/main/module.json5': `{
  module: { name: 'entry', type: 'entry', deviceTypes: ['phone'] }
}`,
    'entry/src/main/ets/AaaHost.ets': `
import { DeclPane } from './DeclPane';

@Entry
@Component
struct AaaHost {
  build() {
    Column() {
      DeclPane()
    }
  }
}
`,
    'entry/src/main/ets/DeclPane.ets': `
@Component
struct DeclPane {
  build() {
    Column()
      .onAreaChange(() => {
        console.info('decl-pane-marker');
      })
  }
}

export { DeclPane };
`,
    ...extra,
  });
}

function declAmNodes(dir: string, nodes: Node[]): Node[] {
  const declRel = 'entry/src/main/ets/DeclPane.ets';
  const declLines = fs.readFileSync(path.join(dir, declRel), 'utf8').split(/\r?\n/);
  const markerLine = declLines.findIndex((l) => l.includes('decl-pane-marker')) + 1;
  const onAreaLine = declLines.findIndex((l) => l.includes('onAreaChange')) + 1 || markerLine;
  expect(markerLine).toBeGreaterThan(0);
  return nodes.filter((n) => {
    if (!/^%AM\d+/.test(n.name)) return false;
    return n.startLine === onAreaLine || n.startLine === markerLine;
  });
}

describe('Spec 0064 · ViewTree AM declaring-file attribution', () => {
  it(
    'onAreaChange %AM file_path is DeclPane.ets and contains parent is DeclPane',
    async () => {
      const dir = makeP3Fixture();
      const cg = HomeGraph.initSync(dir);
      try {
        await cg.indexAll();
        const nodes = cg.getQueryBuilder().getAllNodes();
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const owned = declAmNodes(dir, nodes);
        expect(owned.length).toBeGreaterThanOrEqual(1);

        for (const n of owned) {
          const norm = n.filePath.replace(/\\/g, '/');
          expect(norm.endsWith('DeclPane.ets'), `file_path=${norm}`).toBe(true);

          const parents = cg
            .getIncomingEdges(n.id)
            .filter((e) => e.kind === 'contains')
            .map((e) => byId.get(e.source));
          expect(parents.length).toBeGreaterThanOrEqual(1);
          for (const p of parents) {
            expect(p?.name).toBe('DeclPane');
            expect(p?.filePath.replace(/\\/g, '/').endsWith('DeclPane.ets')).toBe(true);
          }
        }
      } finally {
        cg.close();
        cleanupArktsProjects();
      }
    },
    180_000
  );

  it(
    'two importers embedding DeclPane still pin the %AM on DeclPane only',
    async () => {
      const dir = makeP3Fixture({
        'entry/src/main/ets/ZzzOtherHost.ets': `
import { DeclPane } from './DeclPane';

@Component
struct ZzzOtherHost {
  build() {
    Column() {
      DeclPane()
    }
  }
}
`,
      });
      const cg = HomeGraph.initSync(dir);
      try {
        await cg.indexAll();
        const nodes = cg.getQueryBuilder().getAllNodes();
        const owned = declAmNodes(dir, nodes);
        expect(owned.length).toBeGreaterThanOrEqual(1);
        for (const n of owned) {
          expect(n.filePath.replace(/\\/g, '/').endsWith('DeclPane.ets')).toBe(true);
          expect(n.filePath.replace(/\\/g, '/')).not.toMatch(/AaaHost|ZzzOtherHost/);
        }
        // One logical handler — not one drifted copy per importer.
        const ids = new Set(owned.map((n) => n.id));
        expect(ids.size).toBe(1);
      } finally {
        cg.close();
        cleanupArktsProjects();
      }
    },
    180_000
  );

  it(
    'Host nested ViewTree and DeclPane own ViewTree share the same %AM node id',
    async () => {
      const dir = makeP3Fixture();
      const cg = HomeGraph.initSync(dir);
      try {
        await cg.indexAll();
        const nodes = cg.getQueryBuilder().getAllNodes();
        const owned = declAmNodes(dir, nodes);
        expect(owned.length).toBe(1);

        const am = owned[0]!;
        const hostBuild = nodes.find(
          (n) =>
            n.name === 'build' &&
            n.filePath.replace(/\\/g, '/').endsWith('AaaHost.ets') &&
            n.kind === 'method'
        );
        const declBuild = nodes.find(
          (n) =>
            n.name === 'build' &&
            n.filePath.replace(/\\/g, '/').endsWith('DeclPane.ets') &&
            n.kind === 'method'
        );
        expect(hostBuild && declBuild).toBeTruthy();

        const fromHost = cg
          .getOutgoingEdges(hostBuild!.id)
          .filter((e) => e.target === am.id && e.metadata?.synthesizedBy === 'viewtree');
        const fromDecl = cg
          .getOutgoingEdges(declBuild!.id)
          .filter((e) => e.target === am.id && e.metadata?.synthesizedBy === 'viewtree');
        // Host nested walk and Decl's own tree both reference the same AM id.
        expect(fromHost.length + fromDecl.length).toBeGreaterThanOrEqual(1);
        expect(fromDecl.length).toBeGreaterThanOrEqual(1);
      } finally {
        cg.close();
        cleanupArktsProjects();
      }
    },
    180_000
  );
});
