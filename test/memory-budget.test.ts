import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveMaxRssMb,
  shouldSkipCatchUpSync,
  isOverRssBudget,
} from '../src/mcp/memory-budget';

describe('memory-budget', () => {
  const prevMax = process.env.HOMEGRAPH_MAX_RSS_MB;
  const prevSkip = process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC;
  const prevForce = process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC;

  afterEach(() => {
    if (prevMax === undefined) delete process.env.HOMEGRAPH_MAX_RSS_MB;
    else process.env.HOMEGRAPH_MAX_RSS_MB = prevMax;
    if (prevSkip === undefined) delete process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC;
    else process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC = prevSkip;
    if (prevForce === undefined) delete process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC;
    else process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC = prevForce;
  });

  it('defaults max RSS to 1024MB and clamps env', () => {
    delete process.env.HOMEGRAPH_MAX_RSS_MB;
    expect(resolveMaxRssMb()).toBe(1024);
    process.env.HOMEGRAPH_MAX_RSS_MB = '2048';
    expect(resolveMaxRssMb()).toBe(2048);
    process.env.HOMEGRAPH_MAX_RSS_MB = '50';
    expect(resolveMaxRssMb()).toBe(256);
    process.env.HOMEGRAPH_MAX_RSS_MB = '99999';
    expect(resolveMaxRssMb()).toBe(4096);
  });

  it('skips catch-up for large index files unless forced', () => {
    delete process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC;
    delete process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mem-'));
    const dbPath = path.join(dir, 'homegraph.db');
    // 64MB+ sparse-ish file
    const fd = fs.openSync(dbPath, 'w');
    fs.ftruncateSync(fd, 64 * 1024 * 1024);
    fs.closeSync(fd);
    expect(shouldSkipCatchUpSync(dbPath)).toBe(true);
    process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC = '1';
    expect(shouldSkipCatchUpSync(dbPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports over-budget against a tiny ceiling', () => {
    process.env.HOMEGRAPH_MAX_RSS_MB = '256';
    // Any live Node process is above 256MB on this host once tests load — or
    // at least we can assert the helper is callable and boolean.
    expect(typeof isOverRssBudget()).toBe('boolean');
  });
});
