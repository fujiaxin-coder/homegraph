import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordEvidencePack } from '../src/mcp/evidence-audit';

describe('opt-in evidence audit', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-audit-')); fs.mkdirSync(path.join(root, '.homegraph')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  it('is off by default and labels the capture stage when enabled', () => {
    vi.stubEnv('HOMEGRAPH_ARKTS_EVIDENCE_LOG', '0');
    expect(recordEvidencePack(root, {}, {})).toBe('disabled');
    vi.stubEnv('HOMEGRAPH_ARKTS_EVIDENCE_LOG', '1');
    expect(recordEvidencePack(root, { query: 'public' }, { text: 'source', metadata: { gaps: [] } })).toBe('written');
    const row = JSON.parse(fs.readFileSync(path.join(root, '.homegraph/evidence-packs.jsonl'), 'utf8'));
    expect(row.stage).toBe('arkts_pack_before_host_wrapping'); expect(row.output.text).toBe('source');
  });
  it('stops at the log limit without breaking retrieval', () => {
    vi.stubEnv('HOMEGRAPH_ARKTS_EVIDENCE_LOG', '1');
    const file = path.join(root, '.homegraph/evidence-packs.jsonl'); fs.writeFileSync(file, ''); fs.truncateSync(file, 16 * 1024 * 1024);
    expect(recordEvidencePack(root, {}, {})).toBe('limit'); expect(fs.statSync(file).size).toBe(16 * 1024 * 1024);
  });
  it.runIf(process.platform !== 'win32')('does not follow a log symlink outside the repository', () => {
    vi.stubEnv('HOMEGRAPH_ARKTS_EVIDENCE_LOG', '1');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-audit-outside-'));
    try {
      const file = path.join(outside, 'private'); fs.writeFileSync(file, 'untouched');
      fs.symlinkSync(file, path.join(root, '.homegraph/evidence-packs.jsonl'));
      expect(recordEvidencePack(root, {}, {})).toBe('unavailable'); expect(fs.readFileSync(file, 'utf8')).toBe('untouched');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
