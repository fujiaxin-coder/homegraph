/**
 * Spec 0055 — Windows watcher events that only touch NTFS last-access time
 * are not pending edits.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher, isAccessTimeOnlyChange } from '../src/sync/watcher';

describe('isAccessTimeOnlyChange', () => {
  const disk = { size: 12, mtimeMs: 1_700_000_000_123.9 };
  const indexed = { size: 12, modifiedAt: 1_700_000_000_123.2 };

  it('is true only on Windows when size and mtime still match', () => {
    expect(isAccessTimeOnlyChange('win32', disk, indexed)).toBe(true);
    expect(isAccessTimeOnlyChange('darwin', disk, indexed)).toBe(false);
    expect(isAccessTimeOnlyChange('linux', disk, indexed)).toBe(false);
  });

  it('is false when the file is new, gone, or its bytes changed', () => {
    expect(isAccessTimeOnlyChange('win32', disk, null)).toBe(false);
    expect(isAccessTimeOnlyChange('win32', null, indexed)).toBe(false);
    expect(isAccessTimeOnlyChange('win32', { ...disk, size: 13 }, indexed)).toBe(false);
    expect(isAccessTimeOnlyChange('win32', { ...disk, mtimeMs: disk.mtimeMs + 2000 }, indexed)).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('Windows watcher drops access-time events', () => {
  async function withFile(run: (dir: string, rel: string, stat: fs.Stats) => Promise<void> | void): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-atime-'));
    const rel = 'src/index.ts';
    fs.mkdirSync(path.join(dir, 'src'));
    const abs = path.join(dir, 'src', 'index.ts');
    fs.writeFileSync(abs, 'export const x = 1;\n');
    try {
      await run(dir, rel, fs.statSync(abs));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does not mark or sync a file whose size and mtime still match the index', async () => {
    await withFile(async (dir, rel, stat) => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 1 });
      const watcher = new FileWatcher(dir, syncFn, {
        inertForTests: true,
        debounceMs: 30,
        indexedFingerprint: () => ({ size: stat.size, modifiedAt: stat.mtimeMs }),
      });
      watcher.start();
      // The file was only read. The watcher still receives `change` on Windows
      // when NTFS updates last-access time; size and mtime stay as indexed.
      watcher.ingestEventForTests(rel);
      await new Promise((r) => setTimeout(r, 80));
      expect(watcher.getPendingFiles()).toEqual([]);
      expect(syncFn).not.toHaveBeenCalled();
      watcher.stop();
    });
  });

  it('keeps a real write, an unindexed path, and a deletion', async () => {
    await withFile((dir, rel, stat) => {
      const abs = path.join(dir, rel);
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 1 });
      const indexed = new Map<string, { size: number; modifiedAt: number }>([
        [rel, { size: stat.size, modifiedAt: stat.mtimeMs }],
      ]);
      const watcher = new FileWatcher(dir, syncFn, {
        inertForTests: true,
        debounceMs: 60_000,
        indexedFingerprint: (p) => indexed.get(p) ?? null,
      });
      watcher.start();

      fs.writeFileSync(abs, 'export const x = 2;\n');
      watcher.ingestEventForTests(rel);
      expect(watcher.getPendingFiles().map((f) => f.path)).toEqual([rel]);

      watcher.ingestEventForTests('src/new.ts');
      fs.writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const y = 1;\n');
      expect(watcher.getPendingFiles().map((f) => f.path).sort()).toEqual(['src/index.ts', 'src/new.ts']);

      fs.unlinkSync(abs);
      watcher.ingestEventForTests(rel);
      expect(watcher.getPendingFiles().some((f) => f.path === rel)).toBe(true);
      watcher.stop();
    });
  });
});
