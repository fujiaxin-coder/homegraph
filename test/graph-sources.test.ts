/**
 * Spec 0005 — graph sources switch (`--sources` / HOMEGRAPH_SOURCES).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseGraphSourcesMode,
  resolveGraphSources,
  graphSourceFlags,
  applyGraphSourcesToEnv,
  GRAPH_SOURCES_ENV,
  graphSourcesDisabledGuidance,
} from '../src/graph-sources';
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonSocketCandidates,
} from '../src/mcp/daemon-paths';
import { QueryBuilder } from '../src/db/queries';
import { DatabaseConnection } from '../src/db';
import { createDirectory } from '../src/directory';

const ORIG_ENV = process.env[GRAPH_SOURCES_ENV];

afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env[GRAPH_SOURCES_ENV];
  else process.env[GRAPH_SOURCES_ENV] = ORIG_ENV;
});

describe('parseGraphSourcesMode / resolveGraphSources', () => {
  it('defaults to both when unset', () => {
    delete process.env[GRAPH_SOURCES_ENV];
    expect(resolveGraphSources()).toBe('both');
    expect(resolveGraphSources(undefined, {})).toBe('both');
  });

  it('accepts both|project|sdk|none (case-insensitive)', () => {
    expect(parseGraphSourcesMode('BOTH')).toBe('both');
    expect(parseGraphSourcesMode('Project')).toBe('project');
    expect(parseGraphSourcesMode('sdk')).toBe('sdk');
    expect(parseGraphSourcesMode('none')).toBe('none');
  });

  it('throws on invalid values', () => {
    expect(() => parseGraphSourcesMode('all')).toThrow(/Invalid graph sources/);
  });

  it('CLI/explicit wins over env', () => {
    process.env[GRAPH_SOURCES_ENV] = 'sdk';
    expect(resolveGraphSources('project')).toBe('project');
    expect(resolveGraphSources(undefined)).toBe('sdk');
  });

  it('maps modes to flags', () => {
    expect(graphSourceFlags('both')).toEqual({
      project: true,
      sdk: true,
      openProjectDb: true,
    });
    expect(graphSourceFlags('project')).toEqual({
      project: true,
      sdk: false,
      openProjectDb: true,
    });
    expect(graphSourceFlags('sdk')).toEqual({
      project: false,
      sdk: true,
      openProjectDb: true,
    });
    expect(graphSourceFlags('none')).toEqual({
      project: false,
      sdk: false,
      openProjectDb: false,
    });
  });

  it('applyGraphSourcesToEnv stamps HOMEGRAPH_SOURCES', () => {
    applyGraphSourcesToEnv('sdk');
    expect(process.env[GRAPH_SOURCES_ENV]).toBe('sdk');
  });

  it('guidance mentions the mode and env name', () => {
    const text = graphSourcesDisabledGuidance('none');
    expect(text).toContain('none');
    expect(text).toContain(GRAPH_SOURCES_ENV);
  });
});

describe('daemon paths isolate non-both sources', () => {
  const root = path.join(os.tmpdir(), 'homegraph-sources-daemon-root');

  it('both keeps historical daemon.pid / daemon.sock names', () => {
    delete process.env[GRAPH_SOURCES_ENV];
    const pid = getDaemonPidPath(root, 'both');
    expect(path.basename(pid)).toBe('daemon.pid');
    if (process.platform !== 'win32') {
      const sock = getDaemonSocketPath(root, 'both');
      expect(sock.includes('daemon.sock')).toBe(true);
    }
  });

  it('sdk uses distinct pid and socket identity from both', () => {
    const bothPid = getDaemonPidPath(root, 'both');
    const sdkPid = getDaemonPidPath(root, 'sdk');
    expect(sdkPid).not.toBe(bothPid);
    expect(path.basename(sdkPid)).toBe('daemon-sdk.pid');

    const bothSock = getDaemonSocketPath(root, 'both');
    const sdkSock = getDaemonSocketPath(root, 'sdk');
    expect(sdkSock).not.toBe(bothSock);

    const bothCands = getDaemonSocketCandidates(root, 'both');
    const sdkCands = getDaemonSocketCandidates(root, 'sdk');
    expect(bothCands[0]).not.toBe(sdkCands[0]);
  });
});

describe('QueryBuilder includeProjectNodes', () => {
  it('skips project nodes when includeProjectNodes is false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-qb-sources-'));
    createDirectory(tmp);
    const dbPath = path.join(tmp, '.homegraph', 'homegraph.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const q = new QueryBuilder(conn.getDb());
    q.insertNode({
      id: 'n1',
      kind: 'function',
      name: 'onlyInProject',
      qualifiedName: 'onlyInProject',
      filePath: 'src/a.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 2,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });

    expect(q.getNodesByName('onlyInProject')).toHaveLength(1);
    q.setIncludeProjectNodes(false);
    expect(q.getNodesByName('onlyInProject')).toHaveLength(0);
    expect(q.searchNodes('onlyInProject')).toHaveLength(0);

    conn.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('HomeGraph.open respects sources', () => {
  it('refuses open when sources=none', async () => {
    const HomeGraph = (await import('../src/index')).default;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sources-none-'));
    try {
      await expect(HomeGraph.open(tmp, { sources: 'none' })).rejects.toThrow(/sources are "none"/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('open with sources=project skips SDK attach', async () => {
    const HomeGraph = (await import('../src/index')).default;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-sources-project-'));
    try {
      fs.writeFileSync(path.join(tmp, 'a.ts'), 'export function foo() {}\n');
      const cg = HomeGraph.initSync(tmp);
      await cg.indexAll();
      cg.close();

      const opened = await HomeGraph.open(tmp, { sources: 'project' });
      expect(opened.getGraphSources()).toBe('project');
      // Project symbols still resolvable.
      expect(opened.searchNodes('foo').some((r) => r.node.name === 'foo')).toBe(true);
      opened.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
