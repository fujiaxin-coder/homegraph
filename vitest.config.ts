import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['__tests__/evaluation/**'],
    /**
     * The suite spawns real CLI/MCP processes that call the Node-version guard;
     * set this so tests run on whatever Node the contributor has installed.
     * CI on Node 22/23 is unaffected — the guard doesn't fire there.
     */
    env: {
      HOMEGRAPH_ALLOW_UNSAFE_NODE: '1',
      /**
       * The suite spawns real CLI/MCP processes; without this they would write
       * telemetry state into the contributor's real ~/.homegraph and count test
       * tool calls as real usage. The telemetry unit tests are unaffected —
       * they inject their own `env` via the Telemetry constructor.
       */
      HOMEGRAPH_TELEMETRY: '0',
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
