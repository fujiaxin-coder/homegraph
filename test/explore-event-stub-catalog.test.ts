/**
 * Essential explore quality: empty Event→Manager never hard-ANSWER-NOWs;
 * stub-dominated compact softens; kit feature catalogs Skip HomeGraph.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('homegraph_explore — event / stub / sdk-catalog', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-esc-'));
    const src = path.join(testDir, 'src');
    const sdk = path.join(testDir, 'oh_modules', '@ohos', 'api');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(sdk, { recursive: true });

    // Unrelated project file — must not turn stub SceneSession into hard ANSWER NOW.
    fs.writeFileSync(
      path.join(src, 'Helper.ts'),
      `export class Helper { run() { return 1; } }\n`,
    );

    // SDK-style stub only for SceneSession (no in-repo impl).
    fs.writeFileSync(
      path.join(sdk, 'SceneSession.d.ts'),
      `export declare class SceneSession {
  on(type: string, cb: () => void): void;
}\n`,
    );

    cg = HomeGraph.initSync(testDir, {
      config: { include: ['**/*.{ts,d.ts}'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('empty Event→Manager survey is Partial locator, never hard ANSWER NOW', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: 'OrderEvent 定义的事件类型有哪些，各被 OrderMgr 分发给哪些 Manager 处理？',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/Partial locator/i);
    expect(text).not.toMatch(/Event→Manager survey complete\. \*\*ANSWER NOW\*\*/);
    expect(text).not.toMatch(/Files importing/);
  });

  it('Event survey lists enum members + handlers; ANSWER NOW when complete', async () => {
    fs.writeFileSync(
      path.join(testDir, 'src', 'OrderEvent.ts'),
      `export enum OrderEventKind {
  CREATED = 0,
  PAID = 1,
}
export type OrderEvent = OrderEventKind;
`,
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'OrderMgr.ts'),
      `import type { OrderEvent } from './OrderEvent';
export class OrderMgr {
  dispatch(ev: OrderEvent) { return ev; }
}
`,
    );
    await cg.indexFiles([
      path.join(testDir, 'src', 'OrderEvent.ts'),
      path.join(testDir, 'src', 'OrderMgr.ts'),
    ]);
    const res = await handler.execute('homegraph_explore', {
      query: 'OrderEvent 定义的事件类型有哪些，各被 OrderMgr 分发给哪些 Manager 处理？',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/Event enum members|CREATED|PAID/i);
    expect(text).toMatch(/OrderMgr|handler/i);
    expect(text).toMatch(/ANSWER NOW/);
    expect(text).not.toMatch(/0 event types \/ handlers indexed/);
  });

  it('stub-only SceneSession compact softens ANSWER NOW even with NL project seeds', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: 'SceneSession 状态机 foreground background 回调转换',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/Partial locator/i);
    expect(text).not.toMatch(/\*\*ANSWER NOW from this response\.\*\*/);
  });

  it('kit feature catalog returns Skip HomeGraph', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: '@kit.ArkTS的util模块有哪些功能',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/Skip HomeGraph/i);
    expect(text).toMatch(/feature or API catalog|SDK docs|capability lists|official/i);
    expect(text).not.toMatch(/Files importing/);
  });
});
