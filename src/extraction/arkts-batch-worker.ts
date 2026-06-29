/**
 * Isolated-process entry for full ArkTS batch indexing (Scene + RTA + persist).
 *
 * Spawned with an enlarged `--stack-size` so Photos-scale Scene builds do not
 * kill the parent indexer. Always uses enableMethodBodyBuild=true (no degrade).
 *
 * Usage: node [--stack-size=N] [--liftoff-only] arkts-batch-worker.js <rootDir> <dbPath> <triggerFile>
 */
import { relaunchWithWasmRuntimeFlagsIfNeeded } from './wasm-runtime-flags';

relaunchWithWasmRuntimeFlagsIfNeeded(__filename);

import { runIsolatedArkTSBatchEntry } from './languages/arkts';

const [rootDir, dbPath, triggerFile] = process.argv.slice(2);
if (!rootDir || !dbPath || !triggerFile) {
  process.stderr.write(
    'usage: arkts-batch-worker.js <rootDir> <dbPath> <triggerFile>\n'
  );
  process.exit(2);
}

try {
  runIsolatedArkTSBatchEntry(rootDir, dbPath, triggerFile);
  process.exit(0);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
