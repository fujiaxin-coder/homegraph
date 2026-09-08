import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import HomeGraph from '../src/index';
import { ToolHandler, type ToolResult } from '../src/mcp/tools';
import { buildRuleQueryPlan, type QueryPlan } from '../src/search/query-plan';
import { EXPLORE_EMISSION_KEY, EXPLORE_SESSION_VIEW_ARG, ExploreSessionState } from '../src/mcp/explore-session-state';

/** Real parser/index/render tests for Spec 0023. No provider or benchmark data.
 * Invoke the internal renderer deliberately: execute() strips the receipt on
 * the wire, while the plan executor needs to inspect it before that boundary.
 */
describe('query-plan source receipts match source actually rendered', () => {
  let root: string;
  let graph: HomeGraph;
  let handler: ToolHandler;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-plan-receipts-'));
    vi.stubEnv('HOMEGRAPH_EXPLORE_FULL_SOURCE', '1');
    vi.stubEnv('HOMEGRAPH_ADAPTIVE_EXPLORE', '1');
    vi.stubEnv('HOMEGRAPH_MCP_CACHE', '0');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No model calls in source receipt tests'); }));
  });

  afterEach(() => {
    graph?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function index(files: Record<string, string>) {
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    graph = HomeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    const indexed = await graph.indexAll();
    expect(indexed.success).toBe(true);
    graph.setBuildPhase('full');
    handler = new ToolHandler(graph);
  }

  async function render(query: string, extra: Record<string, unknown> = {}): Promise<ToolResult> {
    const plan: QueryPlan = { ...buildRuleQueryPlan(query), source: 'llm', intent: 'general', route: 'general' };
    return (handler as unknown as {
      handleExplore(args: Record<string, unknown>): Promise<ToolResult>;
    }).handleExplore({ query, maxFiles: 12, __homegraphQueryPlan: plan, ...extra });
  }

  function sourceSection(result: ToolResult, file: string): string {
    const text = result.content.map((part) => part.text).join('\n');
    const start = text.indexOf('**`' + file + '`**');
    if (start < 0) return '';
    const next = text.indexOf('\n**`', start + 1);
    return text.slice(start, next < 0 ? undefined : next);
  }

  it('does not bind signatures dropped by a signature-only skeleton', async () => {
    const methods = Array.from({ length: 36 }, (_, i) =>
      `  slot${String(i).padStart(2, '0')}(input: string): string { return input; }`).join('\n');
    const files: Record<string, string> = {
      'src/contract.ts': 'export interface Interceptor { intercept(input: string): string; }\n',
      'src/dispatcher.ts': [
        "import { LoggingInterceptor } from './logging';",
        'export function dispatch(): string { return proceed(); }',
        "export function proceed(): string { return new LoggingInterceptor().handleLogging(); }",
      ].join('\n'),
      'src/logging.ts': [
        "import { Interceptor } from './contract';",
        'export class LoggingInterceptor implements Interceptor {',
        "  handleLogging(): string { return this.intercept('on-spine'); }",
        '  intercept(input: string): string { return input; }',
        '}',
      ].join('\n'),
    };
    for (const name of ['Bridge', 'Cache', 'Retry']) {
      files[`src/${name.toLowerCase()}.ts`] = [
        "import { Interceptor } from './contract';",
        `export class ${name}Interceptor implements Interceptor {`,
        '  intercept(input: string): string { return input; }',
        methods,
        '}',
      ].join('\n');
    }
    await index(files);
    const result = await render('dispatch proceed handleLogging LoggingInterceptor BridgeInterceptor CacheInterceptor RetryInterceptor');
    const section = sourceSection(result, 'src/bridge.ts');
    expect(section, result.content[0].text).toContain('· skeleton (signatures only');
    expect(section).toContain('signatures elided');
    expect(section).toContain('slot00(');
    expect(section).not.toContain('slot35(');
    const receipts = result[EXPLORE_EMISSION_KEY]?.locatedNodes ?? [];
    const locatedBridge = receipts.filter((node) => node.filePath === 'src/bridge.ts');
    expect(locatedBridge.length).toBeGreaterThan(0);
    // Each promoted declaration must occur in the actual section, not merely
    // somewhere inside the old whole-file envelope used by session dedup.
    for (const node of locatedBridge) expect(section, node.qualifiedName).toContain(node.name);
    expect(locatedBridge.some((node) => node.name === 'slot35')).toBe(false);
  });

  it('does not create fresh bindings from a pointer to previously served source', async () => {
    await index({ 'src/pipeline.ts': [
      'export function receivePacket(): string {',
      '  return decodePacket();',
      '}',
      'export function decodePacket(): string {',
      "  const payload = 'complete source body';",
      '  return payload;',
      '}',
      '',
    ].join('\n') });
    const first = await render('receivePacket decodePacket');
    const firstEmission = first[EXPLORE_EMISSION_KEY];
    expect(firstEmission?.locatedNodes?.length).toBeGreaterThan(0);
    const session = new ExploreSessionState();
    session.record(firstEmission!);
    const second = await render('receivePacket decodePacket', { [EXPLORE_SESSION_VIEW_ARG]: { projects: session.snapshot() } });
    expect(second.content[0].text).toMatch(/already sent/i);
    expect(second[EXPLORE_EMISSION_KEY]?.sourceBytes).toBe(0);
    expect(second[EXPLORE_EMISSION_KEY]?.locatedNodes ?? []).toEqual([]);
  });

  it('does not bind an enclosing class whose declaration header is outside the source window', async () => {
    const padding = Array.from({ length: 330 }, (_, i) => `  // unrelated padding ${i}`).join('\n');
    await index({ 'src/container.ts': [
      'export class ShellContainer {',
      padding,
      '  loadState(): string { return this.renderState(); }',
      "  renderState(): string { return 'focused-member'; }",
      '}',
    ].join('\n') });
    const result = await render('loadState renderState');
    const section = sourceSection(result, 'src/container.ts');
    expect(section).toContain('loadState()');
    expect(section).toContain('renderState()');
    expect(section).not.toContain('export class ShellContainer');
    const names = result[EXPLORE_EMISSION_KEY]?.locatedNodes?.map((node) => node.name) ?? [];
    expect(names).toContain('loadState');
    expect(names).not.toContain('ShellContainer');
  });
});
