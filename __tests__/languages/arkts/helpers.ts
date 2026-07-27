import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Edge, Node } from '../../../src/types';

const tempDirs: string[] = [];

export function makeArktsProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ark-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

export function cleanupArktsProjects(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw err;
    }
  }
}

export function mockArktsQueries() {
  return {
    getFileByPath: () => undefined,
    deleteFile: () => {},
    insertNodes: () => {},
    insertEdges: () => {},
    insertUnresolvedRefsBatch: () => {},
    upsertFile: () => {},
    deleteArkTSCrossFileCallEdges: () => 0,
    getCrossFileIncomingEdgesWithTarget: () => [],
  };
}

export const ENTRY_FIXTURE = {
  'src/main/module.json5': `{
  "module": {
    "name": "entry",
    "type": "entry",
    "pages": "pages/Index",
    "abilities": [
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        "exported": true
      }
    ]
  }
}`,
  'src/main/ets/entryability/EntryAbility.ets': `
export default class EntryAbility {
  onCreate(want: Object, launchParam: Object): void {}

  onWindowStageCreate(windowStage: Object): void {
    windowStage.loadContent('pages/Index', (err: Object) => {});
  }
}
`,
  'src/main/ets/pages/Index.ets': `
@Entry
@Component
struct Index {
  aboutToAppear(): void {}

  build(): void {}
}
`,
};

export function nodeByName(nodes: Node[], name: string, kind?: Node['kind']): Node | undefined {
  return nodes.find((n) => n.name === name && (kind ? n.kind === kind : true));
}

export function hasEdgePath(
  edges: Edge[],
  nodeById: Map<string, Node>,
  names: string[]
): boolean {
  if (names.length < 2) return false;
  const idsForName = (name: string) =>
    [...nodeById.values()].filter((n) => n.name === name).map((n) => n.id);

  let frontier = new Set(idsForName(names[0]!));
  for (let i = 1; i < names.length; i++) {
    const nextName = names[i]!;
    const targets = new Set(idsForName(nextName));
    const next = new Set<string>();
    for (const e of edges) {
      if (frontier.has(e.source) && targets.has(e.target)) {
        next.add(e.target);
      }
    }
    if (next.size === 0) return false;
    frontier = next;
  }
  return true;
}
