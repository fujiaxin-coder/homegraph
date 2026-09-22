/**
 * Spec 0043 — bound MCP default root soft-pins mismatched `projectPath`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import HomeGraph from '../src/index';
import { ToolHandler, __setLoadHomeGraphForTests } from '../src/mcp/tools';
import {
  BOUND_PROJECT_PATH_PIN_MARKER,
  formatBoundProjectPathPinNotice,
} from '../src/mcp/index-availability';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';

function getText(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('bound projectPath soft-pin (spec 0043)', () => {
  let boundDir: string;
  let otherDir: string;
  let parentDir: string;
  let boundCg: HomeGraph;
  let otherCg: HomeGraph;

  beforeEach(async () => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-0043-'));
    boundDir = path.join(parentDir, 'bound');
    otherDir = path.join(parentDir, 'other');
    fs.mkdirSync(boundDir);
    fs.mkdirSync(otherDir);
    fs.mkdirSync(path.join(boundDir, 'src'));
    fs.mkdirSync(path.join(otherDir, 'src'));
    fs.writeFileSync(
      path.join(boundDir, 'src', 'bound.ts'),
      'export function boundOnlySymbol(): number { return 1; }\n',
    );
    fs.writeFileSync(
      path.join(otherDir, 'src', 'other.ts'),
      'export function otherOnlySymbol(): number { return 2; }\n',
    );

    boundCg = await HomeGraph.init(boundDir, { index: true });
    otherCg = await HomeGraph.init(otherDir, { index: true });
    __setLoadHomeGraphForTests(HomeGraph);
  });

  afterEach(() => {
    __setLoadHomeGraphForTests(null);
    try { boundCg.close(); } catch { /* ignore */ }
    try { otherCg.close(); } catch { /* ignore */ }
    if (fs.existsSync(parentDir)) fs.rmSync(parentDir, { recursive: true, force: true });
  });

  it('formatBoundProjectPathPinNotice names bound root and ignored path', () => {
    const text = formatBoundProjectPathPinNotice({
      boundRoot: '/bound',
      requestedPath: '/other',
      resolvedRoot: '/other',
    });
    expect(text).toContain(BOUND_PROJECT_PATH_PIN_MARKER);
    expect(text).toContain('`/bound`');
    expect(text).toContain('Ignoring projectPath=`/other`');
    expect(text).toContain('resolves to `/other`');
    expect(text).toContain('bound project root only');
  });

  it('SERVER_INSTRUCTIONS mention mismatched projectPath soft-pin', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/mismatched `projectPath`/i);
  });

  it('with a bound default, projectPath to a sibling index stays on the bound graph + notice', async () => {
    const handler = new ToolHandler(boundCg);
    const openSpy = vi.spyOn(HomeGraph, 'openSync');
    try {
      const result = await handler.execute('homegraph_search', {
        query: 'boundOnlySymbol',
        projectPath: otherDir,
      });
      expect(result.isError).not.toBe(true);
      const text = getText(result);
      expect(text).toContain(BOUND_PROJECT_PATH_PIN_MARKER);
      expect(text).toContain(path.resolve(boundCg.getProjectRoot()));
      expect(text).toMatch(/Ignoring projectPath=/);
      expect(text).toContain('boundOnlySymbol');
      expect(text).not.toContain('otherOnlySymbol');
      expect(openSpy).not.toHaveBeenCalled();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolved = (handler as any).getHomeGraph(otherDir);
      expect(resolved).toBe(boundCg);
    } finally {
      openSpy.mockRestore();
      try { handler.closeAll(); } catch { /* ignore */ }
    }
  });

  it('projectPath under the bound root does not emit a pin notice', async () => {
    const handler = new ToolHandler(boundCg);
    try {
      const nested = path.join(boundDir, 'src', 'does-not-exist-yet');
      const result = await handler.execute('homegraph_search', {
        query: 'boundOnlySymbol',
        projectPath: nested,
      });
      expect(result.isError).not.toBe(true);
      const text = getText(result);
      expect(text).not.toContain(BOUND_PROJECT_PATH_PIN_MARKER);
      expect(text).toContain('boundOnlySymbol');
    } finally {
      try { handler.closeAll(); } catch { /* ignore */ }
    }
  });

  it('without a default HomeGraph, projectPath still opens the other index', async () => {
    const handler = new ToolHandler(null);
    try {
      const result = await handler.execute('homegraph_search', {
        query: 'otherOnlySymbol',
        projectPath: otherDir,
      });
      expect(result.isError).not.toBe(true);
      const text = getText(result);
      expect(text).not.toContain(BOUND_PROJECT_PATH_PIN_MARKER);
      expect(text).toContain('otherOnlySymbol');
      expect(text).not.toContain('boundOnlySymbol');
    } finally {
      try { handler.closeAll(); } catch { /* ignore */ }
    }
  });

  it('parent-of-bound path that does not resolve to the bound root is soft-pinned', async () => {
    const handler = new ToolHandler(boundCg);
    try {
      const result = await handler.execute('homegraph_search', {
        query: 'boundOnlySymbol',
        projectPath: parentDir,
      });
      expect(result.isError).not.toBe(true);
      const text = getText(result);
      expect(text).toContain(BOUND_PROJECT_PATH_PIN_MARKER);
      expect(text).toContain('boundOnlySymbol');
    } finally {
      try { handler.closeAll(); } catch { /* ignore */ }
    }
  });
});
