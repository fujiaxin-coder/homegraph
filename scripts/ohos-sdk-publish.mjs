#!/usr/bin/env node
/**
 * Build and optionally publish homegraph-ohos-api-db-<sdkVersion>
 * (one npm package per OHOS SDK / API version).
 *
 * Usage:
 *   node scripts/ohos-sdk-publish.mjs <zip-or-dir> [sdkVersion]
 *     [--pkg-version <homegraphVersion>]
 *     [--dry-run] [--no-publish] [--skip-if-published]
 *
 * `--pkg-version` sets the npm package version (should match the HomeGraph
 * release that built the db). Defaults to this repo's package.json version.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
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
  let pkgVersion = '';
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pkg-version') {
      pkgVersion = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--')) flags.add(arg);
    else positional.push(arg);
  }
  return {
    input: positional[0] ?? '',
    sdkVersion: positional[1] ?? '',
    pkgVersion,
    dryRun: flags.has('--dry-run'),
    noPublish: flags.has('--no-publish'),
    skipIfPublished: flags.has('--skip-if-published'),
  };
}

function homegraphPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

function npmViewExists(pkgName, pkgVersion) {
  try {
    execFileSync('npm', ['view', `${pkgName}@${pkgVersion}`, 'version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function writeReadme(outDir, sdkVersion, pkgName, pkgVersion) {
  const body = `# ${pkgName}

Prebuilt HomeGraph OHOS / HarmonyOS API symbol database for DevEco SDK **${sdkVersion}**.

Install alongside HomeGraph so agents can query SDK APIs without indexing the full SDK locally. Built with HomeGraph **${pkgVersion}**. After install, \`postinstall\` copies the db into \`~/.homegraph/api/\`.
`;
  fs.writeFileSync(path.join(outDir, 'README.md'), body);
}

function buildNpmPackage(sdkVersion, dbPath, outDir, pkgVersion) {
  const dbName = ohosApiDbFilename(sdkVersion);
  const pkgName = ohosApiDbPackageName(sdkVersion);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'scripts'), { recursive: true });
  fs.copyFileSync(dbPath, path.join(outDir, dbName));
  writeReadme(outDir, sdkVersion, pkgName, pkgVersion);

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
        version: pkgVersion,
        description: `Prebuilt HomeGraph OHOS API database for SDK ${sdkVersion}`,
        license: 'MIT',
        files: [dbName, 'README.md', 'scripts/postinstall.js'],
        scripts: { postinstall: 'node scripts/postinstall.js' },
        homegraph: { ohosApiVersion: sdkVersion, dbFile: dbName, builtWith: pkgVersion },
      },
      null,
      2
    ) + '\n'
  );
  return pkgName;
}

const args = parseArgs(process.argv);
if (!args.input) {
  console.error(
    'Usage: node scripts/ohos-sdk-publish.mjs <zip-or-dir> [sdkVersion] [--pkg-version <v>] [--dry-run] [--no-publish] [--skip-if-published]'
  );
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'dist/extraction/languages/arkts.js'))) {
  console.error('[ohos-sdk-publish] dist not built — run npm run build first');
  process.exit(1);
}

const pkgVersion = args.pkgVersion || homegraphPackageVersion();
const resolved = resolveOhosSdkInput({
  inputPath: path.resolve(args.input),
  versionOverride: args.sdkVersion || undefined,
});
const pkgName = ohosApiDbPackageName(resolved.version);

if (args.skipIfPublished && npmViewExists(pkgName, pkgVersion)) {
  console.log(`[ohos-sdk-publish] skip ${pkgName}@${pkgVersion} (already on npm)`);
  resolved.cleanup?.();
  process.exit(0);
}

const workRoot = fs.mkdtempSync(path.join(path.dirname(resolved.sdkHome), '.hg-ohos-pack-'));
const dbPath = path.join(workRoot, ohosApiDbFilename(resolved.version));
const pkgDir = path.join(workRoot, 'npm-package');

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

  buildNpmPackage(resolved.version, dbPath, pkgDir, pkgVersion);
  console.log(
    `[ohos-sdk-publish] package: ${pkgName}@${pkgVersion} → ${pkgDir} (${result.nodesCreated} nodes)`
  );

  if (args.dryRun || args.noPublish) {
    console.log('[ohos-sdk-publish] skipping npm publish');
    process.exit(0);
  }

  const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (!token) {
    console.error('[ohos-sdk-publish] NODE_AUTH_TOKEN / NPM_TOKEN not set');
    process.exit(1);
  }

  // Temp package dirs sit outside the repo, so setup-node's root .npmrc is not visible.
  fs.writeFileSync(
    path.join(pkgDir, '.npmrc'),
    `//registry.npmjs.org/:_authToken=${token}\nalways-auth=true\n`
  );

  execFileSync('npm', ['publish', '--access', 'public'], {
    cwd: pkgDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_AUTH_TOKEN: token },
  });
  console.log(`[ohos-sdk-publish] published ${pkgName}@${pkgVersion}`);
} finally {
  resolved.cleanup?.();
}
