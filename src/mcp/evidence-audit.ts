import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { validatePathWithinRoot } from '../utils';

/** Opt-in local evidence only, never an answer cache. Logging cannot break retrieval. */
export function recordEvidencePack(projectRoot: string, input: unknown, output: unknown): 'written' | 'disabled' | 'limit' | 'unavailable' {
  if (process.env.HOMEGRAPH_ARKTS_EVIDENCE_LOG !== '1') return 'disabled';
  let fd: number | undefined;
  try {
    const target = validatePathWithinRoot(projectRoot, '.homegraph/evidence-packs.jsonl');
    if (!target) return 'unavailable';
    const record = Buffer.from(JSON.stringify({ id: randomUUID(), time: new Date().toISOString(),
      stage: 'arkts_pack_before_host_wrapping', version: 1, input, output }) + '\n');
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0), 0o600);
    if (!fstatSync(fd).isFile()) return 'unavailable';
    if (fstatSync(fd).size + record.length > 16 * 1024 * 1024) return 'limit';
    let at = 0;
    while (at < record.length) { const written = writeSync(fd, record, at); if (!written) return 'unavailable'; at += written; }
    return 'written';
  } catch { return 'unavailable'; }
  finally { if (fd !== undefined) closeSync(fd); }
}
