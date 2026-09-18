import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { preferHarmonySerialIndexing } from '../../../src/extraction/languages/arkts';

const tmpRoots: string[] = [];

afterEach(() => {
  delete process.env.HOMEGRAPH_HARMONY_SERIAL;
  for (const root of tmpRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeRoot(withProfile: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-harmony-serial-'));
  tmpRoots.push(root);
  if (withProfile) {
    fs.writeFileSync(path.join(root, 'build-profile.json5'), '{ modules: [] }\n', 'utf-8');
  }
  return root;
}

describe('preferHarmonySerialIndexing', () => {
  it('defaults to true when build-profile.json5 exists', () => {
    delete process.env.HOMEGRAPH_HARMONY_SERIAL;
    expect(preferHarmonySerialIndexing(makeRoot(true))).toBe(true);
    expect(preferHarmonySerialIndexing(makeRoot(false))).toBe(false);
  });

  it('HOMEGRAPH_HARMONY_SERIAL=0 disables even with profile', () => {
    process.env.HOMEGRAPH_HARMONY_SERIAL = '0';
    expect(preferHarmonySerialIndexing(makeRoot(true))).toBe(false);
  });

  it('HOMEGRAPH_HARMONY_SERIAL=1 forces even without profile', () => {
    process.env.HOMEGRAPH_HARMONY_SERIAL = '1';
    expect(preferHarmonySerialIndexing(makeRoot(false))).toBe(true);
  });
});
