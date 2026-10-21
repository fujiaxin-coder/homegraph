/**
 * Spec 0059: ArkTS cross-file import / heritage edges must persist
 * (not die in persistFileResult's same-file FK filter).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HomeGraph } from '../../../src';
import { resetExtractionContext } from '../../../src/extraction/context';
import { resetArkTSBatch } from '../../../src/extraction/languages/arkts';
import { cleanupArktsProjects, makeArktsProject } from './helpers';

afterEach(() => {
  resetArkTSBatch();
  resetExtractionContext();
  cleanupArktsProjects();
});

describe('languages/arkts cross-file import + heritage (Spec 0059)', () => {
  it(
    'persists import→file and cross-file extends edges',
    async () => {
      const root = makeArktsProject({
        'build-profile.json5': JSON.stringify({
          modules: [{ name: 'entry', srcPath: './entry' }],
        }),
        'entry/oh-package.json5': JSON.stringify({
          name: '@ohos/entry',
          version: '1.0.0',
        }),
        'entry/src/main/ets/Base.ets': `
export class Base {
  ping(): string {
    return 'pong';
  }
}
`,
        'entry/src/main/ets/Child.ets': `
import { Base } from './Base';

export class Child extends Base {
  use(): string {
    return this.ping();
  }
}
`,
        'entry/src/main/ets/Local.ets': `
export function localHelper(): number {
  return 1;
}
`,
        'entry/src/main/ets/UsesLocal.ets': `
import { localHelper } from './Local';

export function run(): number {
  return localHelper();
}
`,
      });

      const cg = HomeGraph.initSync(root);
      try {
        await cg.indexAll();

        const importNodes = cg.getNodesByKind('import');
        const fileNodes = cg.getNodesByKind('file');
        const fileByPath = new Map(fileNodes.map((n) => [n.filePath.replace(/\\/g, '/'), n]));

        const localFile = fileByPath.get('entry/src/main/ets/Local.ets');
        expect(localFile, 'Local.ets file node').toBeDefined();

        const relativeImport = importNodes.find(
          (n) =>
            n.filePath.replace(/\\/g, '/').endsWith('UsesLocal.ets') &&
            (n.signature === './Local' || n.name === 'localHelper')
        );
        expect(relativeImport, 'relative import node').toBeDefined();
        const relImportEdges = cg
          .getOutgoingEdges(relativeImport!.id)
          .filter((e) => e.kind === 'imports');
        expect(
          relImportEdges.some((e) => e.target === localFile!.id),
          'relative import → Local.ets file'
        ).toBe(true);

        const baseFile = fileByPath.get('entry/src/main/ets/Base.ets');
        expect(baseFile, 'Base.ets file node').toBeDefined();
        const baseImport = importNodes.find(
          (n) =>
            n.filePath.replace(/\\/g, '/').endsWith('Child.ets') &&
            (n.signature === './Base' || n.name === 'Base')
        );
        expect(baseImport, 'Child→Base import node').toBeDefined();
        const baseImportEdges = cg
          .getOutgoingEdges(baseImport!.id)
          .filter((e) => e.kind === 'imports');
        expect(
          baseImportEdges.some((e) => e.target === baseFile!.id),
          'Child import → Base.ets file'
        ).toBe(true);

        const classes = cg.getNodesByKind('class');
        const child = classes.find((n) => n.name === 'Child');
        const base = classes.find((n) => n.name === 'Base');
        expect(child).toBeDefined();
        expect(base).toBeDefined();
        expect(child!.filePath.replace(/\\/g, '/')).not.toBe(base!.filePath.replace(/\\/g, '/'));

        const extendsEdges = cg
          .getOutgoingEdges(child!.id)
          .filter((e) => e.kind === 'extends');
        expect(
          extendsEdges.some((e) => e.target === base!.id),
          'Child extends Base across files'
        ).toBe(true);
      } finally {
        cg.close();
      }
    },
    60_000
  );

  it(
    'does not name-match @State to an unrelated enum State',
    async () => {
      const root = makeArktsProject({
        'sample.ets': `
export enum State {
  Idle,
  Busy,
}

@Component
struct Demo {
  @State count: number = 0;

  build(): void {}
}
`,
      });

      const cg = HomeGraph.initSync(root);
      try {
        await cg.indexAll();
        const stateEnum = cg.getNodesByKind('enum').find((n) => n.name === 'State');
        expect(stateEnum).toBeDefined();
        const decoratesToEnum = cg
          .getIncomingEdges(stateEnum!.id)
          .filter((e) => e.kind === 'decorates');
        expect(decoratesToEnum, '@State must not link to enum State').toHaveLength(0);
      } finally {
        cg.close();
      }
    },
    60_000
  );
});
