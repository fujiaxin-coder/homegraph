/**
 * ArkUI commonEventManager + taskpool edge synthesis (P2).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import HomeGraph from '../src/index';

const HAS_SQLITE = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_SQLITE)('arkui-common-event + arkui-taskpool synthesizers', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges publish → createSubscriber on the same literal event', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-arkui-ce-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Pub.ets'),
      "import commonEventManager from '@ohos.commonEventManager';\n" +
        'export class Publisher {\n' +
        '  notifyScreenOff(): void {\n' +
        "    commonEventManager.publish({ event: 'usual.event.SCREEN_OFF' }, () => {});\n" +
        '  }\n' +
        '}\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Sub.ets'),
      "import commonEventManager from '@ohos.commonEventManager';\n" +
        'export class Listener {\n' +
        '  async watchScreen(): Promise<void> {\n' +
        "    const sub = await commonEventManager.createSubscriber({ events: ['usual.event.SCREEN_OFF'] });\n" +
        '    commonEventManager.subscribe(sub, (_err, _data) => {});\n' +
        '  }\n' +
        '}\n',
    );

    const cg = HomeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const pub = methods.find((n) => n.name === 'notifyScreenOff')!;
    const sub = methods.find((n) => n.name === 'watchScreen')!;
    expect(pub).toBeTruthy();
    expect(sub).toBeTruthy();
    const bridged = cg
      .getOutgoingEdges(pub.id)
      .filter(
        (e) =>
          e.target === sub.id
          && (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'arkui-common-event',
      );
    expect(bridged.length).toBeGreaterThanOrEqual(1);
    cg.destroy();
  });

  it('bridges taskpool.execute(Task(fn)) → named worker function', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-arkui-tp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Work.ets'),
      "import taskpool from '@ohos.taskpool';\n" +
        'function heavyJob(x: number): number {\n' +
        '  return x + 1;\n' +
        '}\n' +
        'export class Runner {\n' +
        '  runAsync(n: number): void {\n' +
        '    taskpool.execute(new taskpool.Task(heavyJob, n));\n' +
        '  }\n' +
        '}\n',
    );

    const cg = HomeGraph.initSync(tmpDir);
    await cg.indexAll();

    const runAsync = cg.getNodesByKind('method').find((n) => n.name === 'runAsync')!;
    const heavy = cg.getNodesByKind('function').find((n) => n.name === 'heavyJob')!;
    expect(runAsync).toBeTruthy();
    expect(heavy).toBeTruthy();
    const bridged = cg
      .getOutgoingEdges(runAsync.id)
      .filter(
        (e) =>
          e.target === heavy.id
          && (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'arkui-taskpool',
      );
    expect(bridged.length).toBeGreaterThanOrEqual(1);
    cg.destroy();
  });
});
