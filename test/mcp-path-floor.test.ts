/**
 * MCP --path floor regression tests (spec 0028).
 *
 * An MCP host that explicitly declares the project root (CLI --path, or a
 * client rootUri/workspaceFolders) must never have that declaration overridden
 * by a stray ancestor `.homegraph/`. The original incident: a session run at
 * `harness-bench/` created `harness-bench/.homegraph`; every later MCP server
 * spawned for nested bench projects walked up, adopted the whole harness repo
 * as its root, and its daemon OOM'd indexing hundreds of result directories
 * (48s, 3.5GB heap) while the server — killed 60s later by its liveness
 * watchdog — left every tool call hanging with `Connection closed`.
 *
 * The fix: the declared path is a *floor* — `findNearestHomeGraphRoot` stops
 * at it. Absent a declaration (bare `serve mcp`, CLI commands) the git-style
 * unbounded walk-up is preserved, so those code paths are behavior-identical.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HomeGraph } from '../src';
import { findNearestHomeGraphRoot } from '../src/directory';
import { killMcpChild, removeTempDir } from './helpers/fs';

const BIN = path.resolve(__dirname, '../dist/bin/homegraph.js');

function spawnServer(cwd: string, extraArgs: string[] = []): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, 'serve', 'mcp', '--no-watch', ...extraArgs], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
}

function collectMessages(child: ChildProcessWithoutNullStreams): Array<Record<string, any>> {
  const messages: Array<Record<string, any>> = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { messages.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    }
  });
  return messages;
}

function waitForMessage(
  messages: ReadonlyArray<Record<string, any>>,
  predicate: (m: Record<string, any>) => boolean,
  timeoutMs: number,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = messages.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out. Messages so far: ${JSON.stringify(messages)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function send(child: ChildProcessWithoutNullStreams, msg: object): void {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

const CLIENT_INFO = { name: 'test', version: '0.0.0' };

function toolResultText(m: Record<string, any>): string {
  const block = m?.result?.content?.find((c: any) => c.type === 'text');
  return block?.text ?? '';
}

/** A tiny but real indexed project — one TypeScript file, real SQLite. */
async function initIndexedProject(root: string): Promise<void> {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'marker.ts'),
    'export const WHO_AM_I = "indexed-project";\n',
  );
  await HomeGraph.init(root);
}

describe('findNearestHomeGraphRoot floor (spec 0028)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-floor-'));
  });
  afterEach(() => removeTempDir(dir));

  it('blocks adopting an ancestor .homegraph above the floor', () => {
    const ancestor = path.join(dir, 'harness-bench');
    const declared = path.join(ancestor, 'result', 'run', 'instance', 'project');
    fs.mkdirSync(declared, { recursive: true });
    fs.mkdirSync(path.join(ancestor, '.homegraph'));
    fs.writeFileSync(path.join(ancestor, '.homegraph', 'homegraph.db'), '');

    expect(findNearestHomeGraphRoot(declared)).toBe(ancestor); // old behavior
    expect(findNearestHomeGraphRoot(declared, declared)).toBeNull(); // floored
  });

  it('still finds an index between the start and the floor', () => {
    const floor = path.join(dir, 'workspace');
    const mid = path.join(floor, 'sub');
    const start = path.join(mid, 'leaf');
    fs.mkdirSync(start, { recursive: true });
    fs.mkdirSync(path.join(mid, '.homegraph'));
    fs.writeFileSync(path.join(mid, '.homegraph', 'homegraph.db'), '');

    expect(findNearestHomeGraphRoot(start, floor)).toBe(mid);
  });

  it('returns the floor itself when it carries the index', () => {
    const floor = path.join(dir, 'workspace');
    fs.mkdirSync(floor, { recursive: true });
    fs.mkdirSync(path.join(floor, '.homegraph'));
    fs.writeFileSync(path.join(floor, '.homegraph', 'homegraph.db'), '');

    expect(findNearestHomeGraphRoot(path.join(floor, 'sub'), floor)).toBe(floor);
  });

  it('ignores a floor that does not contain the start (misconfiguration)', () => {
    const a = path.join(dir, 'a');
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(path.join(a, 'nested'), { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.join(a, '.homegraph'));
    fs.writeFileSync(path.join(a, '.homegraph', 'homegraph.db'), '');

    expect(findNearestHomeGraphRoot(path.join(a, 'nested'), elsewhere)).toBe(a);
  });

  it('walks up unbounded when no floor is given (unchanged)', () => {
    const ancestor = path.join(dir, 'top');
    const deep = path.join(ancestor, 'x', 'y', 'z');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(ancestor, '.homegraph'));
    fs.writeFileSync(path.join(ancestor, '.homegraph', 'homegraph.db'), '');

    expect(findNearestHomeGraphRoot(deep)).toBe(ancestor);
  });
});

describe('MCP server --path floor against a poisoned ancestor (spec 0028)', () => {
  let ancestor: string;  // holds a REAL index — the "poison"
  let declared: string;  // nested host project — no index of its own
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(async () => {
    ancestor = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-poison-'));
    await initIndexedProject(ancestor);
    declared = path.join(ancestor, 'result', 'run', 'instance', 'project');
    fs.mkdirSync(declared, { recursive: true });
    fs.writeFileSync(path.join(declared, 'Entry.ts'), 'export const DECLARED = 1;\n');
  });

  afterEach(async () => {
    await killMcpChild(child);
    child = null;
    removeTempDir(ancestor);
  });

  it('a declared --path does not adopt the ancestor index', async () => {
    child = spawnServer(declared, ['--path', declared]);
    const messages = collectMessages(child);

    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: CLIENT_INFO } });
    await waitForMessage(messages, (m) => m.id === 1, 10_000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await waitForMessage(messages, (m) => m.id === 2, 10_000);
    const names = listed.result.tools.map((t: any) => t.name);
    expect(names).toContain('homegraph_project');

    // Without the floor this call would return the ancestor's module map.
    // With it, the declared root has no index → success-shaped guidance.
    send(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'homegraph_project', arguments: {} } });
    const result = await waitForMessage(messages, (m) => m.id === 3, 10_000);
    const text = toolResultText(result);
    expect(text).toContain('No HomeGraph project is loaded');
    expect(text).not.toContain('marker.ts');
  }, 30_000);

  it('auto-init lands on the declared root, not the poisoned ancestor', async () => {
    child = spawn( // NOTE: --auto-init mirrors the DevEco host's spawn exactly.
      process.execPath,
      [BIN, 'serve', 'mcp', '--path', declared, '--auto-init'],
      { cwd: declared, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOMEGRAPH_AUTO_INIT: '1' } },
    ) as ChildProcessWithoutNullStreams;
    const messages = collectMessages(child);

    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: CLIENT_INFO } });
    await waitForMessage(messages, (m) => m.id === 1, 10_000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // The incident's signature failure: .homegraph never appeared at the
    // project. It must now — created at the DECLARED root within seconds.
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(path.join(declared, '.homegraph', 'homegraph.db'))) {
      if (Date.now() > deadline) throw new Error('auto-init never created the declared root index');
      await new Promise((r) => setTimeout(r, 100));
    }

    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'homegraph_project', arguments: {} } });
    const result = await waitForMessage(messages, (m) => m.id === 2, 10_000);
    const text = toolResultText(result);
    expect(text).not.toContain('No HomeGraph project is loaded');
    expect(text).toContain('Entry.ts');      // the declared project's own file
    expect(text).not.toContain('marker.ts'); // the ancestor's file must not leak in
  }, 60_000);
});
