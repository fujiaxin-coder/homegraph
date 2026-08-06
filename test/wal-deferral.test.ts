/**
 * WAL checkpoint deferral during bulk indexing (#1231).
 *
 * The default 1000-page wal_autocheckpoint re-writes hot pages into the main
 * DB over and over during a bulk index (~95% of all disk I/O on slow
 * storage). indexAll defers auto-checkpointing for the whole run, a
 * WalCheckpointValve bounds WAL growth via off-thread PASSIVE checkpoints,
 * and the interval is restored afterwards. These tests pin the DB helpers,
 * the valve's trigger/dedupe/backpressure logic, and the end-to-end indexAll
 * behavior (identical graph with and without deferral; interval restored).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { WalCheckpointValve, resolveWalValveMb } from '../src/db/wal-valve';
import HomeGraph from '../src/index';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-wal-deferral-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function openDb(): DatabaseConnection {
  return DatabaseConnection.initialize(path.join(tmpDir, 'test.db'));
}

/** Grow the WAL: with autocheckpoint off, every commit appends and nothing folds back. */
function writeRows(db: DatabaseConnection, rows: number): void {
  const raw = db.getDb();
  raw.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, blob TEXT)');
  const stmt = raw.prepare('INSERT INTO t (blob) VALUES (?)');
  for (let i = 0; i < rows; i++) stmt.run('x'.repeat(4096));
}

describe('resolveWalValveMb', () => {
  it('honors a positive numeric override and falls back otherwise', () => {
    expect(resolveWalValveMb('64')).toBe(64);
    expect(resolveWalValveMb('64.9')).toBe(64);
    expect(resolveWalValveMb(undefined)).toBe(256);
    expect(resolveWalValveMb('')).toBe(256);
    expect(resolveWalValveMb('abc')).toBe(256);
    expect(resolveWalValveMb('0')).toBe(256);
    expect(resolveWalValveMb('-5')).toBe(256);
  });
});

describe('DatabaseConnection WAL helpers', () => {
  it('reads and writes the wal_autocheckpoint interval', () => {
    const db = openDb();
    expect(db.getWalAutocheckpoint()).toBe(1000); // SQLite default
    db.setWalAutocheckpoint(0);
    expect(db.getWalAutocheckpoint()).toBe(0);
    db.setWalAutocheckpoint(1000);
    expect(db.getWalAutocheckpoint()).toBe(1000);
    db.close();
  });

  it('reports WAL size that grows with deferred commits', () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    const before = db.getWalSizeBytes();
    writeRows(db, 200);
    expect(db.getWalSizeBytes()).toBeGreaterThan(before);
    db.close();
  });

  it('checkpointWalPassive backfills the WAL from a worker connection and reports the result', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    const res = await db.checkpointWalPassive();
    // Backfill moves the committed pages into the main DB file…
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore);
    // …and reports a full backfill (idle DB: every WAL frame checkpointed).
    expect(res).not.toBeNull();
    expect(res!.busy).toBe(0);
    expect(res!.log).toBeGreaterThan(0);
    expect(res!.checkpointed).toBe(res!.log);
    db.close();
  });
});

describe('WalCheckpointValve', () => {
  it('check() fires an off-thread checkpoint once growth passes the soft threshold', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500); // WAL well past a ~10-byte threshold
    const valve = new WalCheckpointValve(db, 0.00001); // ~10 bytes soft
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    valve.check();
    await valve.drain();
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore);
    db.close();
  });

  it('advances its baseline on a full backfill — no infinite retrigger (at most one truncate park)', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 0.00001);
    valve.check();
    await valve.drain();
    const first = valve.backpressure();
    if (first) await first;
    expect(db.getWalSizeBytes()).toBe(0);
    expect(valve.backpressure()).toBeNull();
    valve.check();
    await valve.drain();
    expect(valve.backpressure()).toBeNull();
    db.close();
  });

  it('does not fire below the soft threshold', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 5);
    const valve = new WalCheckpointValve(db, 1024); // 1GB soft — never reached
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    valve.check();
    await valve.drain();
    expect(fs.statSync(dbFile).size).toBe(mainSizeBefore);
    db.close();
  });

  it('backpressure() is null under the hard cap and a promise above it', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const relaxed = new WalCheckpointValve(db, 1024);
    expect(relaxed.backpressure()).toBeNull();
    const strict = new WalCheckpointValve(db, 0.0000001); // hard cap ~0.4 bytes
    const bp = strict.backpressure();
    expect(bp).toBeInstanceOf(Promise);
    await bp;
    await strict.drain();
    db.close();
  });

  it('foldNow() backfills everything at a phase boundary and resets growth', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 1024); // thresholds never reached on their own
    const dbFile = path.join(tmpDir, 'test.db');
    const mainSizeBefore = fs.statSync(dbFile).size;
    await valve.foldNow();
    expect(fs.statSync(dbFile).size).toBeGreaterThan(mainSizeBefore); // pages backfilled
    expect(valve.backpressure()).toBeNull(); // baseline advanced — growth is zero
    await valve.foldNow(); // second fold is a no-op (growth 0), must not spin
    db.close();
  });

  it('dedupes concurrent fires into one in-flight checkpoint', () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 500);
    const valve = new WalCheckpointValve(db, 0.00001);
    valve.check();
    const first = valve.backpressure();
    const second = valve.backpressure();
    expect(second).toBe(first); // same in-flight promise, not a second worker
    db.close();
    return first ?? undefined;
  });
});

function writeFixtureProject(): void {
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(
      path.join(tmpDir, 'src', `mod${i}.ts`),
      `export function fn${i}(x: number): number { return helper${i}(x) + ${i}; }\n` +
      `function helper${i}(x: number): number { return x * ${i}; }\n`
    );
  }
}

describe('indexAll WAL deferral end-to-end', () => {
  it.runIf(process.platform !== 'win32')(
    'produces the same graph with and without deferral, and restores the interval',
    async () => {
    writeFixtureProject();

    const hg1 = HomeGraph.initSync(tmpDir);
    const r1 = await hg1.indexAll();
    expect(r1.success).toBe(true);
    const conn1 = (hg1 as unknown as { db: DatabaseConnection }).db;
    expect(conn1.getWalAutocheckpoint()).toBe(1000);
    const counts1 = { nodes: r1.nodesCreated, edges: r1.edgesCreated };
    await hg1.close();

    fs.rmSync(path.join(tmpDir, '.homegraph'), { recursive: true, force: true });

    process.env.HOMEGRAPH_NO_WAL_DEFER = '1';
    try {
      const hg2 = HomeGraph.initSync(tmpDir);
      const r2 = await hg2.indexAll();
      expect(r2.success).toBe(true);
      expect({ nodes: r2.nodesCreated, edges: r2.edgesCreated }).toEqual(counts1);
      await hg2.close();
    } finally {
      delete process.env.HOMEGRAPH_NO_WAL_DEFER;
    }
  });
});

describe('checkpointWalTruncate (§7a.1 file containment)', () => {
  it('chops a fully-backfilled WAL file to zero', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 400);
    expect(db.getWalSizeBytes()).toBeGreaterThan(1024 * 1024);
    const res = await db.checkpointWalTruncate();
    expect(res).not.toBeNull();
    expect(res!.busy).toBe(0);
    expect(db.getWalSizeBytes()).toBe(0);
    db.close();
  });
});

describe('valve file-size trigger (§7a.1: backfilled WAL still grows the file)', () => {
  it('backpressure trips on file size alone once past the file cap, even with zero backlog', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 800);
    const valve = new WalCheckpointValve(db, 0.5);
    await valve.foldNow();
    expect(db.getWalSizeBytes()).toBe(0);
    db.close();
  });

  it('a fully-backfilled but oversized file is chopped at the barrier', async () => {
    const db = openDb();
    db.setWalAutocheckpoint(0);
    writeRows(db, 800);
    const before = db.getWalSizeBytes();
    expect(before).toBeGreaterThan(2 * 1024 * 1024);
    const valve = new WalCheckpointValve(db, 0.5);
    const bp = valve.backpressure();
    expect(bp).not.toBeNull();
    await bp;
    expect(db.getWalSizeBytes()).toBe(0);
    writeRows(db, 800);
    await valve.foldNow();
    writeRows(db, 100);
    const sizeTrigger = valve.backpressure();
    expect(sizeTrigger).not.toBeNull();
    await sizeTrigger;
    expect(db.getWalSizeBytes()).toBe(0);
    db.close();
  });
});

describe('resolveWalValveMb DB-size scaling (§7a.2 fold-tax reduction)', () => {
  it('scales soft cap ~dbSize/4 within [256, 2048]MB; env always wins', () => {
    const GB = 1024 * 1024 * 1024;
    expect(resolveWalValveMb(undefined, 100 * 1024 * 1024)).toBe(256);
    expect(resolveWalValveMb(undefined, 4.6 * GB)).toBe(1177);
    expect(resolveWalValveMb(undefined, 40 * GB)).toBe(2048);
    expect(resolveWalValveMb('64', 40 * GB)).toBe(64);
    expect(resolveWalValveMb(undefined, 0)).toBe(256);
  });
});
