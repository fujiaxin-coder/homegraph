/**
 * P3 — ViewTree lazy ensureMethodNode(handler, relativePath=importer) attributes
 * anonymous %AM handlers to the importer file instead of getDeclaringArkFile().
 * Fixture: AaaHost (sorts before DeclPane) embeds DeclPane; DeclPane owns
 * .onAreaChange(() => …). Desired: %AM file_path = DeclPane.ets.
 * Production fix deferred — fails while importer path wins.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import { cleanupArktsProjects, makeArktsProject } from '../../languages/arkts/helpers';
import { resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import { resetExtractionContext } from '../../../src/extraction/context';

describe('P3 ViewTree AM declaring-file attribution', () => {
  it(
    'anonymous onAreaChange on DeclPane is stored under DeclPane.ets, not AaaHost.ets',
    async () => {
      resetArkTSBatch();
      resetExtractionContext();
      // Multi-file module: AaaHost sorts before DeclPane so Host ViewTree walks
      // the nested DeclPane tree first and lazy-creates the %AM handler.
      const dir = makeArktsProject({
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
      });

      const cg = HomeGraph.initSync(dir);
      try {
        await cg.indexAll();
        const nodes = cg.getQueryBuilder().getAllNodes();
        const ams = nodes.filter((n) => /^%AM\d+/.test(n.name));

        // Locate the handler whose source line is DeclPane's onAreaChange body.
        const declRel = 'entry/src/main/ets/DeclPane.ets';
        const declLines = fs.readFileSync(path.join(dir, declRel), 'utf8').split(/\r?\n/);
        const markerLine = declLines.findIndex((l) => l.includes('decl-pane-marker')) + 1;
        expect(markerLine).toBeGreaterThan(0);
        // ArkAnalyzer usually attributes the anonymous method to the `.onAreaChange` line.
        const onAreaLine =
          declLines.findIndex((l) => l.includes('onAreaChange')) + 1 || markerLine;

        const driftedOrOwned = ams.filter((n) => {
          const abs = path.join(dir, n.filePath);
          if (!fs.existsSync(abs)) return false;
          // Match by startLine against DeclPane's onAreaChange / marker lines,
          // regardless of which file_path the node currently claims.
          return n.startLine === onAreaLine || n.startLine === markerLine;
        });

        expect(driftedOrOwned.length).toBeGreaterThanOrEqual(1);
        for (const n of driftedOrOwned) {
          const norm = n.filePath.replace(/\\/g, '/');
          expect(
            norm.endsWith('DeclPane.ets'),
            `AM ${n.name} @${n.startLine} file_path=${norm} (importer AaaHost is the bug)`
          ).toBe(true);
        }
      } finally {
        cg.close();
        cleanupArktsProjects();
      }
    },
    180_000
  );
});
