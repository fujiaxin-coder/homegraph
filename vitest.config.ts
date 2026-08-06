import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Cap both ends: Vitest 2 defaults minWorkers≈maxWorkers≈os.availableParallelism()
    // (28 here). Uncapped forks OOM with `Fatal process out of memory: Zone` on
    // Node 24/Windows; `--maxWorkers=N` alone leaves minWorkers high → Tinypool
    // "minThreads and maxThreads must not conflict".
    maxWorkers: 4,
    minWorkers: 1,
    // Vitest forks load tree-sitter WASM grammars. Without `--liftoff-only` on
    // the worker's node argv, Node ≥22 hits V8 turboshaft Zone OOM
    // (`Fatal process out of memory: Zone`) → "Worker exited unexpectedly"
    // (the suite's "Errors N" count). Forks accept this flag; worker_threads
    // reject it (ERR_WORKER_INVALID_EXEC_ARGV) — keep pool=forks.
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--liftoff-only', '--max-old-space-size=4096'],
      },
    },
    include: ['test/**/*.test.ts'],
    exclude: ['test/evaluation/**'],
    /**
     * The suite spawns real CLI/MCP processes that call the Node-version guard;
     * set this so tests run on whatever Node the contributor has installed.
     * CI on Node 22/23 is unaffected — the guard doesn't fire there.
     */
    env: {
      HOMEGRAPH_ALLOW_UNSAFE_NODE: '1',
      /**
       * Vitest loads the full HomeGraph + tree-sitter grammar set into one
       * long-lived process. The production MCP RSS ceiling (1024MB) is for
       * daemons serving a single project — trip it mid-suite and every later
       * tool call returns a success-shaped Partial, masking real assertions.
       * Raise the ceiling for the test process only.
       */
      HOMEGRAPH_MAX_RSS_MB: '4096',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
