/**
 * Minimal repro for V8 turboshaft WASM Zone OOM with tree-sitter grammars.
 *
 * Scenario (Node ≥24, including Node 25):
 *   1. Load a large grammar WASM (vendored COBOL ≈16MB is enough alone).
 *   2. Parse repeatedly so the module becomes hot and V8's background job
 *      runs the turboshaft *optimizing* WASM compiler.
 *   3. Without `--liftoff-only`, the process aborts with
 *      `Fatal process out of memory: Zone` (V8 internal arena — not JS heap).
 *
 * Mere `Language.load` without hot parse does NOT trigger it (lazy compile
 * stays on Liftoff). `--no-wasm-tier-up` / `--no-wasm-dynamic-tiering` do NOT
 * prevent it — only `--liftoff-only` does.
 *
 * Usage (from repo root):
 *   node test/fixtures/wasm-zone-oom-harness.cjs            # expect Zone OOM on Node ≥24
 *   node --liftoff-only test/fixtures/wasm-zone-oom-harness.cjs  # expect OK
 *   LOAD_ONLY=1 node test/fixtures/wasm-zone-oom-harness.cjs     # load without parse → OK
 */
'use strict';

const path = require('path');
const { Parser, Language } = require('web-tree-sitter');

const ROOT = path.resolve(__dirname, '../..');
const COBOL_WASM = path.join(ROOT, 'src/extraction/wasm/tree-sitter-cobol.wasm');

async function main() {
  await Parser.init();
  const language = await Language.load(COBOL_WASM);

  if (process.env.LOAD_ONLY === '1') {
    process.stdout.write('LOAD_OK\n');
    return;
  }

  const parser = new Parser();
  parser.setLanguage(language);
  // Non-COBOL-looking source is fine: we only need to execute enough WASM
  // to make the optimizing tier kick in on a background compile job.
  const src = 'function foo(x) { return x * 2; }\n'.repeat(200);
  const rounds = Number(process.env.ROUNDS || 50);
  for (let i = 0; i < rounds; i++) {
    parser.parse(src);
  }
  process.stdout.write('OK\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
