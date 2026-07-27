/**
 * Store worker — dedicated writer thread for the bulk-index store phase.
 *
 * During a fresh full index the main thread's biggest serial cost is executing
 * the per-file INSERT batches. This worker owns that work on its own SQLite
 * connection: the orchestrator posts one message per file (in file order) and
 * the worker applies them in arrival order, which preserves the #1015
 * insertion-order determinism exactly as if the main thread had run the same
 * calls. The main thread performs NO database access while the writer is
 * active (fresh-DB path only), so there is no cross-connection contention.
 *
 * Protocol (main → worker):
 *   {type:'open', dbPath, fastInit}  → open connection, reply {type:'ready'}
 *   {type:'bundle', bundle}          → apply one file's store bundle
 *   {type:'drain', id}               → reply {type:'drained', id}
 *   {type:'close'}                   → close DB and exit
 * Worker → main: {type:'ready'} | {type:'ack'} | {type:'drained', id} | {type:'error', message}
 */

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch {
  /* cache is best-effort */
}

import { parentPort } from 'worker_threads';
import { QueryBuilder } from '../db/queries';
import { createDatabase, SqliteDatabase } from '../db/sqlite-adapter';
import { type StoreBundle } from './store-writer';

if (!parentPort) {
  throw new Error('store-worker must be run as a worker thread');
}
const port = parentPort;

let db: SqliteDatabase | null = null;
let queries: QueryBuilder | null = null;

const STORE_TIMINGS = !!process.env.HOMEGRAPH_SYNTH_TIMINGS;
let storeNs = 0n;
let bundleCount = 0;

type InMessage =
  | { type: 'open'; dbPath: string; fastInit: boolean }
  | { type: 'bundle'; bundle: StoreBundle }
  | { type: 'drain'; id: number }
  | { type: 'close' };

port.on('message', (msg: InMessage) => {
  try {
    switch (msg.type) {
      case 'open': {
        const created = createDatabase(msg.dbPath);
        db = created.db;
        db.pragma('busy_timeout = 5000');
        db.pragma('foreign_keys = ON');
        if (msg.fastInit) {
          db.pragma('journal_mode = MEMORY');
          db.pragma('synchronous = OFF');
        } else {
          db.pragma('synchronous = NORMAL');
        }
        db.pragma('cache_size = -64000');
        db.pragma('temp_store = MEMORY');
        queries = new QueryBuilder(db);
        port.postMessage({ type: 'ready' });
        break;
      }
      case 'bundle': {
        if (!queries) throw new Error('store-worker: bundle before open');
        if (STORE_TIMINGS) {
          bundleCount++;
          const t0 = process.hrtime.bigint();
          queries.storeFileBundle(msg.bundle);
          storeNs += process.hrtime.bigint() - t0;
        } else {
          queries.storeFileBundle(msg.bundle);
        }
        port.postMessage({ type: 'ack' });
        break;
      }
      case 'drain': {
        port.postMessage({ type: 'drained', id: msg.id });
        break;
      }
      case 'close': {
        if (STORE_TIMINGS && bundleCount > 0) {
          console.error(
            `[store-timing] bundles=${bundleCount} store=${(Number(storeNs / 1_000_000n) / 1000).toFixed(2)}s`
          );
        }
        try {
          db?.close();
        } catch {
          /* already closed */
        }
        process.exit(0);
        break;
      }
    }
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
