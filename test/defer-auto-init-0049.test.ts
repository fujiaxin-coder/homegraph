/**
 * Spec 0049 — defer MCP auto-init on empty roots.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isInitialized, getHomeGraphDir } from '../src/directory';
import { MCPEngine, isIndexableRoot, parseDeferProbeMs } from '../src/mcp/engine';

describe('isIndexableRoot / parseDeferProbeMs (Spec 0049)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0049-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('empty dir is not indexable', () => {
    expect(isIndexableRoot(tempDir)).toBe(false);
  });

  it('only .homegraph noise is not indexable', () => {
    fs.mkdirSync(path.join(tempDir, '.homegraph'));
    fs.writeFileSync(path.join(tempDir, '.homegraph', 'note.txt'), 'x');
    expect(isIndexableRoot(tempDir)).toBe(false);
  });

  it('root build-profile.json5 is indexable', () => {
    fs.writeFileSync(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
    expect(isIndexableRoot(tempDir)).toBe(true);
  });

  it('source file under src is indexable', () => {
    fs.mkdirSync(path.join(tempDir, 'entry', 'src', 'main', 'ets'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'entry', 'src', 'main', 'ets', 'Index.ets'), 'export struct Index {}\n');
    expect(isIndexableRoot(tempDir)).toBe(true);
  });

  it('parseDeferProbeMs defaults and clamps', () => {
    expect(parseDeferProbeMs(undefined)).toBe(60_000);
    expect(parseDeferProbeMs('')).toBe(60_000);
    expect(parseDeferProbeMs('0')).toBe(0);
    expect(parseDeferProbeMs('15000')).toBe(15_000);
    expect(parseDeferProbeMs('500')).toBe(60_000);
    expect(parseDeferProbeMs('nope')).toBe(60_000);
  });
});

describe('MCPEngine deferred auto-init (Spec 0049)', () => {
  let tempDir: string;
  let engine: MCPEngine | null;
  const prevAuto = process.env.HOMEGRAPH_AUTO_INIT;
  const prevProbe = process.env.HOMEGRAPH_DEFER_PROBE_MS;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-0049-eng-'));
    process.env.HOMEGRAPH_AUTO_INIT = '1';
    // Disable timer — tests kick explicitly (avoids flaky waits).
    process.env.HOMEGRAPH_DEFER_PROBE_MS = '0';
    engine = null;
  });

  afterEach(() => {
    engine?.stop();
    engine = null;
    if (prevAuto === undefined) delete process.env.HOMEGRAPH_AUTO_INIT;
    else process.env.HOMEGRAPH_AUTO_INIT = prevAuto;
    if (prevProbe === undefined) delete process.env.HOMEGRAPH_DEFER_PROBE_MS;
    else process.env.HOMEGRAPH_DEFER_PROBE_MS = prevProbe;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('auto-init on empty root does not create .homegraph', async () => {
    engine = new MCPEngine({ watch: false });
    engine.setProjectPathHint(tempDir);
    await engine.ensureInitialized(tempDir, tempDir);

    expect(engine.isAutoInitDeferred()).toBe(true);
    expect(engine.hasDefaultHomeGraph()).toBe(false);
    expect(isInitialized(tempDir)).toBe(false);
    expect(fs.existsSync(getHomeGraphDir(tempDir))).toBe(false);
  });

  it('kickDeferredAutoInit creates index once sources appear', async () => {
    engine = new MCPEngine({ watch: false });
    engine.setProjectPathHint(tempDir);
    await engine.ensureInitialized(tempDir, tempDir);
    expect(engine.isAutoInitDeferred()).toBe(true);

    fs.writeFileSync(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
    fs.mkdirSync(path.join(tempDir, 'entry', 'src', 'main', 'ets'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'entry', 'src', 'main', 'ets', 'Index.ets'), 'export struct Index {}\n');

    const ok = await engine.kickDeferredAutoInit();
    expect(ok).toBe(true);
    expect(engine.hasDefaultHomeGraph()).toBe(true);
    expect(engine.isAutoInitDeferred()).toBe(false);
    expect(isInitialized(tempDir)).toBe(true);
  });
});
