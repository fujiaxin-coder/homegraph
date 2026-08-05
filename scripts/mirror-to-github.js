#!/usr/bin/env node
'use strict';
//
// Mirror the current branch to GitHub (the secondary remote).
//
// The canonical origin is GitCode (gitcode.com/ProgramAnalysis/homegraph.git).
// GitHub (github.com/fujiaxin-coder/homegraph) is the mirror that runs the
// Release CI. This script pushes the current branch to `github` so the GitHub
// Actions workflow can see the latest code.
//
// Implemented in Node (not bash) so it runs identically on Windows / macOS /
// Linux — the dev machine is Windows, where `bash` goes through WSL and
// `set -o pipefail` isn't available, breaking the shell version.
//
// Usage:
//   node scripts/mirror-to-github.js              # push current branch
//   node scripts/mirror-to-github.js main         # push a specific branch
//   node scripts/mirror-to-github.js --init       # first-time mirror: push all refs
//
const { execSync } = require('child_process');

const REMOTE = 'github';
const arg = process.argv[2];

function git(args, opts = {}) {
  return execSync(`git ${args}`, { stdio: opts.stdio || 'pipe', encoding: 'utf8' }).trim();
}

function hasRemote(name) {
  try {
    git(`remote get-url ${name}`);
    return true;
  } catch {
    return false;
  }
}

if (!hasRemote(REMOTE)) {
  console.error(`[mirror] remote '${REMOTE}' is not configured.`);
  console.error(`[mirror] add it with:  git remote add github https://github.com/fujiaxin-coder/homegraph.git`);
  process.exit(1);
}

if (arg === '--init') {
  console.log(`[mirror] initial mirror: pushing all refs to ${REMOTE}`);
  try {
    execSync(`git push ${REMOTE} --mirror`, { stdio: 'inherit' });
    console.log(`[mirror] done: all refs → ${REMOTE}`);
  } catch {
    process.exit(1);
  }
  process.exit(0);
}

const branch = arg || git('rev-parse --abbrev-ref HEAD');
console.log(`[mirror] pushing ${branch} to ${REMOTE}`);
try {
  execSync(`git push ${REMOTE} ${branch}`, { stdio: 'inherit' });
  console.log(`[mirror] done: ${branch} → ${REMOTE}`);
} catch {
  process.exit(1);
}
