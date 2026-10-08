/**
 * HOMEGRAPH_MCP_SHORT_TOOL_NAMES — product hosts that prefix tools with the
 * MCP server name (DevEco Code → `homegraph_` + name) opt in so tools/list
 * exposes short names (`explore`) and tools/call accepts both short and
 * canonical (`homegraph_explore`) forms.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HomeGraph } from '../src';
import {
  ToolHandler,
  canonicalizeMcpToolName,
  getStaticTools,
  shortMcpToolNamesEnabled,
} from '../src/mcp/tools';
import { removeTempDir } from './helpers/fs';

const SHORT = 'HOMEGRAPH_MCP_SHORT_TOOL_NAMES';
const ALLOW = 'HOMEGRAPH_MCP_TOOLS';
const BIN = path.resolve(__dirname, '../dist/bin/homegraph.js');

/** Same formula DevEco uses: sanitize(clientName) + "_" + sanitize(mcpTool.name). */
function hostPrefixedToolName(clientName: string, mcpToolName: string): string {
  const sanitize = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitize(clientName) + '_' + sanitize(mcpToolName);
}

describe('HOMEGRAPH_MCP_SHORT_TOOL_NAMES', () => {
  const prevShort = process.env[SHORT];
  const prevAllow = process.env[ALLOW];
  afterEach(() => {
    if (prevShort === undefined) delete process.env[SHORT];
    else process.env[SHORT] = prevShort;
    if (prevAllow === undefined) delete process.env[ALLOW];
    else process.env[ALLOW] = prevAllow;
  });

  it('shortMcpToolNamesEnabled is off by default', () => {
    delete process.env[SHORT];
    expect(shortMcpToolNamesEnabled()).toBe(false);
  });

  it('shortMcpToolNamesEnabled accepts 1/true/yes', () => {
    process.env[SHORT] = '1';
    expect(shortMcpToolNamesEnabled()).toBe(true);
    process.env[SHORT] = 'true';
    expect(shortMcpToolNamesEnabled()).toBe(true);
    process.env[SHORT] = 'yes';
    expect(shortMcpToolNamesEnabled()).toBe(true);
  });

  it('canonicalizeMcpToolName maps short → homegraph_* and leaves long names', () => {
    expect(canonicalizeMcpToolName('explore')).toBe('homegraph_explore');
    expect(canonicalizeMcpToolName('project')).toBe('homegraph_project');
    expect(canonicalizeMcpToolName('homegraph_explore')).toBe('homegraph_explore');
    expect(canonicalizeMcpToolName('not_a_tool')).toBe('not_a_tool');
  });

  it('tools/list keeps homegraph_* names when short mode is off', () => {
    delete process.env[SHORT];
    delete process.env[ALLOW];
    expect(new ToolHandler(null).getTools().map((t) => t.name).sort()).toEqual([
      'homegraph_explore',
      'homegraph_project',
    ]);
    expect(getStaticTools().map((t) => t.name).sort()).toEqual([
      'homegraph_explore',
      'homegraph_project',
    ]);
  });

  it('tools/list exposes short names when short mode is on', () => {
    process.env[SHORT] = '1';
    delete process.env[ALLOW];
    expect(new ToolHandler(null).getTools().map((t) => t.name).sort()).toEqual([
      'explore',
      'project',
    ]);
    expect(getStaticTools().map((t) => t.name).sort()).toEqual(['explore', 'project']);
  });

  it('DevEco-style host prefix on short names yields homegraph_explore (not doubled)', () => {
    process.env[SHORT] = '1';
    delete process.env[ALLOW];
    const listed = new ToolHandler(null).getTools().map((t) => t.name);
    expect(listed).toContain('explore');
    expect(listed).not.toContain('homegraph_explore');
    const visible = listed.map((n) => hostPrefixedToolName('homegraph', n));
    expect(visible).toContain('homegraph_explore');
    expect(visible).toContain('homegraph_project');
    expect(visible.some((n) => n.includes('homegraph_homegraph_'))).toBe(false);
  });

  it('without short mode, DevEco-style host prefix doubles homegraph_', () => {
    delete process.env[SHORT];
    delete process.env[ALLOW];
    const listed = new ToolHandler(null).getTools().map((t) => t.name);
    const visible = listed.map((n) => hostPrefixedToolName('homegraph', n));
    expect(visible).toContain('homegraph_homegraph_explore');
  });

  it('short list names still mark projectPath required when no default project', () => {
    process.env[SHORT] = '1';
    const explore = new ToolHandler(null).getTools().find((t) => t.name === 'explore')!;
    expect(explore.inputSchema.required).toContain('projectPath');
    expect(explore.inputSchema.properties.projectPath!.description).toMatch(/^Required\./);
  });

  it('execute accepts short names and canonical names', async () => {
    process.env[SHORT] = '1';
    process.env[ALLOW] = 'explore';
    const handler = new ToolHandler(null);
    const viaShort = await handler.execute('explore', { query: 'anything' });
    const viaLong = await handler.execute('homegraph_explore', { query: 'anything' });
    // No default project → same success-shaped guidance either way.
    expect(viaShort.isError).toBeUndefined();
    expect(viaLong.isError).toBeUndefined();
    expect(viaShort.content[0]!.text).toMatch(/No HomeGraph project is loaded/);
    expect(viaLong.content[0]!.text).toMatch(/No HomeGraph project is loaded/);
  });

  it('short-name execute against an indexed project returns real results', async () => {
    process.env[SHORT] = '1';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-short-exec-'));
    try {
      fs.writeFileSync(
        path.join(tempDir, 'pay.ts'),
        'export function processPayment(amount: number): boolean { return amount > 0; }\n',
      );
      const cg = await HomeGraph.init(tempDir, { index: true });
      try {
        const res = await new ToolHandler(cg).execute('explore', { query: 'processPayment' });
        expect(res.isError).toBeUndefined();
        expect(res.content[0]!.text).toMatch(/processPayment/);
        expect(res.content[0]!.text).not.toMatch(/No HomeGraph project is loaded/);
      } finally {
        cg.close();
      }
    } finally {
      removeTempDir(tempDir);
    }
  });
});

describe('HOMEGRAPH_MCP_SHORT_TOOL_NAMES live MCP stdio', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  function spawnServer(shortNames: boolean): ChildProcessWithoutNullStreams {
    // Pin a clean tool surface — do not inherit a developer HOMEGRAPH_MCP_TOOLS=all.
    const env = { ...process.env };
    delete env.HOMEGRAPH_MCP_TOOLS;
    delete env.HOMEGRAPH_MCP_SHORT_TOOL_NAMES;
    env.HOMEGRAPH_NO_DAEMON = '1';
    env.HOMEGRAPH_WASM_RELAUNCHED = '1';
    if (shortNames) env.HOMEGRAPH_MCP_SHORT_TOOL_NAMES = '1';
    return spawn(process.execPath, [BIN, 'serve', 'mcp', '--path', tempDir], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }) as ChildProcessWithoutNullStreams;
  }

  function request(
    proc: ChildProcessWithoutNullStreams,
    msg: { id: number; method: string; params?: unknown },
    timeoutMs = 20000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        proc.stdout.off('data', onData);
        reject(new Error(`timeout waiting for response id=${msg.id}`));
      }, timeoutMs);
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.id === msg.id) {
              clearTimeout(timer);
              proc.stdout.off('data', onData);
              resolve(parsed);
              return;
            }
          } catch {
            /* ignore non-JSON */
          }
        }
      };
      proc.stdout.on('data', onData);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    });
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-short-mcp-'));
    fs.writeFileSync(
      path.join(tempDir, 'auth.ts'),
      'export function validateToken(t: string): boolean { return !!t; }\n',
    );
    const cg = await HomeGraph.init(tempDir, { index: true });
    cg.close();
  });

  afterEach(async () => {
    if (child) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      child = null;
    }
    removeTempDir(tempDir);
  });

  it('live tools/list + tools/call with SHORT=1 (DevEco shape)', async () => {
    expect(fs.existsSync(BIN)).toBe(true);
    child = spawnServer(true);
    await request(child, {
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'deveco-sim', version: '0.0.0' },
        rootUri: `file://${tempDir}`,
      },
    });

    const list = await request(child, { id: 1, method: 'tools/list' });
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['explore', 'project']);

    // Model-visible names after DevEco prefix — must not double.
    const hostNames = names.map((n) => hostPrefixedToolName('homegraph', n));
    expect(hostNames).toEqual(['homegraph_explore', 'homegraph_project']);

    // Host calls MCP with the listed name (short), same as convertTool.
    const call = await request(child, {
      id: 2,
      method: 'tools/call',
      params: { name: 'explore', arguments: { query: 'validateToken' } },
    });
    const result = call.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/validateToken/);

    // Long name still works if a client passes it.
    const callLong = await request(child, {
      id: 3,
      method: 'tools/call',
      params: { name: 'homegraph_explore', arguments: { query: 'validateToken' } },
    });
    const resultLong = callLong.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(resultLong.isError).toBeUndefined();
    expect(resultLong.content[0]!.text).toMatch(/validateToken/);
  });

  it('live tools/list without SHORT keeps homegraph_* (Cursor/Claude shape)', async () => {
    expect(fs.existsSync(BIN)).toBe(true);
    child = spawnServer(false);
    await request(child, {
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'cursor-sim', version: '0.0.0' },
        rootUri: `file://${tempDir}`,
      },
    });

    const list = await request(child, { id: 1, method: 'tools/list' });
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    expect(names).toEqual(['homegraph_explore', 'homegraph_project']);
  });
});
