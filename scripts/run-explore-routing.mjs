#!/usr/bin/env node
/**
 * Whole-suite gate for explore routing — run this after any shape/routing change.
 *
 * Always:
 *   1. npm run build
 *   2. vitest test/explore-routing/routing.test.ts  (+ query-patterns)
 *
 * When HOMEGRAPH_PROBE_ROOT points at an indexed repo (e.g. scene_board_ext):
 *   3. vitest test/explore-routing/live-explore.test.ts
 *
 * Exit non-zero if anything fails — do not ship a fix that greened one probe
 * while regressing another.
 *
 * Usage (PowerShell):
 *   $env:HOMEGRAPH_PROBE_ROOT='D:\code\scene_board_ext'
 *   node scripts/run-explore-routing.mjs
 *
 * Or:
 *   npm run test:explore-routing
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probeRoot = (process.env.HOMEGRAPH_PROBE_ROOT || '').trim();

function run(label, command, args, env = {}) {
  console.log(`\n==== ${label} ====`);
  console.log(`> ${command} ${args.join(' ')}`);
  const r = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, HOMEGRAPH_WASM_RELAUNCHED: '1', ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${label} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

run('build', 'npm', ['run', 'build']);
run(
  'routing + query-patterns (always)',
  'npx',
  ['vitest', 'run', 'test/explore-routing/routing.test.ts', 'test/query-patterns.test.ts'],
);

if (probeRoot) {
  console.log(`\nLIVE probe root: ${probeRoot}`);
  run(
    'live explore corpus (size + mustContain)',
    'npx',
    ['vitest', 'run', 'test/explore-routing/live-explore.test.ts'],
    { HOMEGRAPH_PROBE_ROOT: probeRoot },
  );
} else {
  console.log(
    '\n(skip live) Set HOMEGRAPH_PROBE_ROOT to an indexed repo to also run size/kind probes.',
  );
  run(
    'live skipped placeholder',
    'npx',
    ['vitest', 'run', 'test/explore-routing/live-explore.test.ts'],
  );
}

console.log('\nOK — explore-routing suite green (routing' + (probeRoot ? ' + live' : '') + ').');
