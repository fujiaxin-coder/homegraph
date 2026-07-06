#!/usr/bin/env node
/**
 * Build and optionally publish homegraph-ohos-api-db-<version> (one npm package per API version).
 *
 * Usage:
 *   node scripts/ohos-sdk-publish.mjs <zip-or-dir> [version] [--dry-run] [--no-publish]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  resolveOhosSdkInput,
  ohosApiDbFilename,
  ohosApiDbPackageName,
  indexOhosApiDb,
} from '../dist/extraction/languages/arkts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) flags.add(arg);
    else positional.push(arg);
  }
  return {
    input: positional[0] ?? '',
    version: positional[1] ?? '',
    dryRun: flags.has('--dry-run'),
    noPublish: flags.has('--no-publish'),
  };
}

function buildNpmPackage(version, dbPath, outDir) {
  const dbName = ohosApiDbFilename(version);
  const pkgName = ohosApiDbPackageName(version);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'scripts'), { recursive: true });
  fs.copyFileSync(dbPath, path.join(outDir, dbName));

  const postinstall = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const dbName = ${JSON.stringify(dbName)};
const src = path.join(__dirname, '..', dbName);
const dest = path.join(os.homedir(), '.homegraph', 'api', dbName);
if (!fs.existsSync(src)) process.exit(0);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
`;
  fs.writeFileSync(path.join(outDir, 'scripts', 'postinstall.js'), postinstall, { mode: 0o755 });
  fs.writeFileSync(
    path.join(outDir, 'package.json'),
    JSON.stringify(
      {
        name: pkgName,
        version: '1.0.0',
        description: `Prebuilt HomeGraph OHOS API database for SDK ${version}`,
        license: 'MIT',
        files: [dbName, 'scripts/postinstall.js'],
        scripts: { postinstall: 'node scripts/postinstall.js' },
        homegraph: { ohosApiVersion: version, dbFile: dbName },
      },
      null,
      2
    ) + '\n'
  );
  return pkgName;
}

const { input, version, dryRun, noPublish } = parseArgs(process.argv);
if (!input) {
  console.error('Usage: node scripts/ohos-sdk-publish.mjs <zip-or-dir> [version] [--dry-run] [--no-publish]');
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'dist/extraction/languages/arkts.js'))) {
  console.error('[ohos-sdk-publish] dist not built — run npm run build first');
  process.exit(1);
}

const resolved = resolveOhosSdkInput({
  inputPath: path.resolve(input),
  versionOverride: version || undefined,
});

const dbPath = path.join(
  fs.mkdtempSync(path.join(path.dirname(resolved.sdkHome), '.hg-ohos-pack-')),
  ohosApiDbFilename(resolved.version)
);
const pkgDir = path.join(path.dirname(dbPath), 'npm-package');

try {
  process.stderr.write(`[ohos-sdk-publish] indexing ${resolved.version} …\n`);
  const result = await indexOhosApiDb({
    sdkHome: resolved.sdkHome,
    version: resolved.version,
    outputPath: dbPath,
    onProgress: (p) => {
      if (p.phase === 'arkts-batch') {
        const label = p.subphase === 'scene' ? 'Scene' : 'Persist';
        process.stderr.write(`\r${label}: ${p.current}/${p.total}`.padEnd(40));
      }
    },
  });
  process.stderr.write('\n');
  if (!result.success) {
    for (const err of result.errors.filter((e) => e.severity === 'error')) console.error(err.message);
    process.exit(1);
  }

  const pkgName = buildNpmPackage(resolved.version, dbPath, pkgDir);
  console.log(`[ohos-sdk-publish] package: ${pkgName} → ${pkgDir} (${result.nodesCreated} nodes)`);

  if (dryRun || noPublish) {
    console.log('[ohos-sdk-publish] skipping npm publish');
    process.exit(0);
  }
  if (!process.env.NPM_TOKEN) {
    console.error('[ohos-sdk-publish] NPM_TOKEN not set — package built, not published');
    process.exit(0);
  }

  const { execFileSync } = await import('child_process');
  execFileSync('npm', ['publish', '--access', 'public'], { cwd: pkgDir, stdio: 'inherit' });
  console.log(`[ohos-sdk-publish] published ${pkgName}`);
} finally {
  resolved.cleanup?.();
}
