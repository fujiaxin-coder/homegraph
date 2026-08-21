import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shouldSkipCatchUpSync } from '../src/mcp/memory-budget';

describe('memory-budget (catch-up skip)', () => {
  const prevSkip = process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC;
  const prevForce = process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC;

  afterEach(() => {
    if (prevSkip === undefined) delete process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC;
    else process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC = prevSkip;
    if (prevForce === undefined) delete process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC;
    else process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC = prevForce;
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

  it('honors HOMEGRAPH_SKIP_CATCHUP_SYNC even for small/missing paths', () => {
    delete process.env.HOMEGRAPH_FORCE_CATCHUP_SYNC;
    process.env.HOMEGRAPH_SKIP_CATCHUP_SYNC = '1';
    expect(shouldSkipCatchUpSync(null)).toBe(true);
    expect(shouldSkipCatchUpSync('/no/such/homegraph.db')).toBe(true);
  });
});
