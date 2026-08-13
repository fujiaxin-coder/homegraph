/**
 * homegraph_explore — Manager data-source section must not invent system
 * services from local cache helpers / anonymous `%AM*` graph names, and must
 * not hard ANSWER NOW without same-file `@ohos`/`@kit` imports.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('homegraph_explore — data-source section quality', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-ds-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });

    // Cache-layer Manager: no @ohos import — local helpers must NOT be "upstream services".
    fs.writeFileSync(
      path.join(src, 'BadgeManager.ts'),
      `export class BadgeManager {
  getAllBadge() { return this.cache; }
  updateBadgeNumber(n: number) { this.cache = n; this.refreshDesktopBadge(); }
  refreshDesktopBadge() { return this.cache; }
  private cache = 0;
}
`,
    );
    // Sibling writer that owns the system subscribe path.
    fs.writeFileSync(
      path.join(src, 'NumBadgeManager.ts'),
      `import notificationManager from '@ohos.notificationManager';
export class NumBadgeManager {
  onBadgeChanged() {
    notificationManager.getBadgeNumber();
    BadgeManagerRef.updateBadgeNumber(1);
  }
}
import { BadgeManager as BadgeManagerRef } from './BadgeManager';
`,
    );
    // Manager with a real same-file SDK import — hard ANSWER NOW is OK.
    fs.writeFileSync(
      path.join(src, 'NotifySubscribeManager.ts'),
      `import notificationSubscribe from '@ohos.notificationSubscribe';
export class NotifySubscribeManager {
  subscribe() { return notificationSubscribe.subscribe({} as never); }
}
`,
    );

    cg = HomeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('does not ANSWER NOW from local BadgeManager cache helpers', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: 'BadgeManager 角标数据来源于哪个系统服务',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/Data sources|Partial locator/i);
    expect(text).not.toMatch(/%AM\d+/);
    // Must not claim the cache helpers are the system service answer.
    expect(text).not.toMatch(
      /Data-source survey — \*\*\d+\*\* upstream symbol\(s\)\. \*\*ANSWER NOW\.\*\*/,
    );
    // Soft / partial framing when no same-file @ohos on BadgeManager.
    expect(text).toMatch(/Partial locator|narrow.*Grep|callers/i);
    // Sibling writers may surface via stem match when indexed.
    expect(text).toMatch(/Manager|Partial locator/i);
  });

  it('EN-rewritten badge source system service still hits data-source, not Service import dump', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: 'BadgeManager 应用图标角标数字 badge source system service',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/Data sources|Partial locator/i);
    expect(text).not.toMatch(/ServiceExtensionAbility/);
    expect(text).not.toMatch(/Found \d+ symbols across \d+ files/);
  });

  it('hard ANSWER NOW when Manager file imports @ohos', async () => {
    const res = await handler.execute('homegraph_explore', {
      query: 'NotifySubscribeManager 数据来源于哪个系统服务',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/@ohos\.notificationSubscribe|notificationSubscribe/);
    expect(text).toMatch(/ANSWER NOW/);
    expect(text).not.toMatch(/%AM\d+/);
  });

  it('bare BadgeManager compact softens ANSWER NOW without SDK imports', async () => {
    const res = await handler.execute('homegraph_explore', { query: 'BadgeManager' });
    const text = res.content[0].text;
    expect(text).not.toMatch(/%AM\d+/);
    // Either no fake upstream dump, or Partial locator — never "ANSWER NOW from upstream" on junk.
    expect(text).not.toMatch(
      /ANSWER NOW from upstream symbols above \(system `@ohos`\/`@kit` imports first\)/,
    );
    if (text.includes('Data sources')) {
      expect(text).toMatch(/Partial locator/);
    }
  });

  it('rewritten status/state source stays Partial even when Manager has @ohos', async () => {
    fs.writeFileSync(
      path.join(testDir, 'src', 'AccountManager.ts'),
      `import account from '@ohos.account.osAccount';
export class AccountManager {
  getState() { return account.getOsAccountConstants(); }
}
`,
    );
    await cg.indexFiles([path.join(testDir, 'src', 'AccountManager.ts')]);
    const res = await handler.execute('homegraph_explore', {
      query: 'AccountManager 账户状态变化 状态来源 account state change source',
    });
    const text = res.content[0].text;
    expect(text).toMatch(/Partial locator/i);
    expect(text).not.toMatch(/Data-source survey — \*\*\d+\*\* `@ohos`\/`@kit` import\(s\)\. \*\*ANSWER NOW\*\*/);
  });
});
