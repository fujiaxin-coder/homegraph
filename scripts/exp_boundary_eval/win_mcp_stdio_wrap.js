#!/usr/bin/env node
/**
 * Windows MCP launcher: spawn homegraph with windowsHide while keeping stdio
 * connected to DevEco (pythonw + Python subprocess breaks JSON-RPC pipes).
 *
 * Usage: node win_mcp_stdio_wrap.js [--stack-size=N] homegraph.js serve mcp --path <repo>
 */
'use strict';

const cp = require('child_process');

const node = process.env.HOMEGRAPH_NODE || process.execPath;
const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('usage: node win_mcp_stdio_wrap.js [--stack-size=N] homegraph.js …\n');
  process.exit(2);
}

const child = cp.spawn(node, args, {
  stdio: 'inherit',
  windowsHide: true,
  env: process.env,
});

child.on('error', (err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
