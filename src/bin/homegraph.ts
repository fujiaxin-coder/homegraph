#!/usr/bin/env node
/**
 * HomeGraph CLI
 *
 * Command-line interface for HomeGraph code intelligence.
 *
 * Usage:
 *   homegraph                    Run interactive installer (when no args)
 *   homegraph install            Run interactive installer
 *   homegraph uninstall          Remove HomeGraph from your agents
 *   homegraph init [path]        Initialize HomeGraph in a project
 *   homegraph uninit [path]      Remove HomeGraph from a project
 *   homegraph index [path]       Index all files in the project
 *   homegraph sync [path]        Sync changes since last index
 *   homegraph status [path]      Show index status
 *   homegraph query <search>     Search for symbols
 *   homegraph files [options]    Show project file structure
 *   homegraph context <task>     Build context for a task
 *   homegraph callers <symbol>   Find what calls a function/method
 *   homegraph callees <symbol>   Find what a function/method calls
 *   homegraph impact <symbol>    Analyze what code is affected by changing a symbol
 *   homegraph index-api <tools>   Build OHOS API db from command-line-tools
 *   homegraph upgrade [version]  Update HomeGraph to the latest release
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { SPEC_DATA_DIR, readMeta } from '../spec/utils';
import { createMineConfig } from '../spec/config';
import { getHomeGraphDir, isInitialized, unsafeIndexRootReason, findNearestHomeGraphRoot, planFrontload, hasStructuralKeyword, extractCodeTokens } from '../directory';
import { detectWorktreeIndexMismatch, worktreeMismatchWarning } from '../sync/worktree';
import { createShimmerProgress } from '../ui/shimmer-progress';
import { getGlyphs } from '../ui/glyphs';

import { buildNodeTooOldBanner, MIN_NODE_MAJOR } from './node-version-check';
import { installFatalHandlers } from './fatal-handler';
import { relaunchWithWasmRuntimeFlagsIfNeeded } from '../extraction/wasm-runtime-flags';
import { installCommandSupervision } from './command-supervision';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { registerAddonCommands } from './addon-commands';
// Lazy-load heavy modules (HomeGraph, runInstaller) to keep CLI startup fast.
async function loadHomeGraph(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m${getGlyphs().err}\x1b[0m Failed to load HomeGraph modules.`);
    console.error(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Try reinstalling with: npm install -g homegraph\n');
    process.exit(1);
  }
}

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

// Enforce the supported Node floor. `engines` in package.json only *warns* on
// install (unless engine-strict), so hard-block here to actually keep users off
// unsupported versions. See package.json `engines` and ./node-version-check.
// Node ≥22 WASM Zone OOM is mitigated by --liftoff-only relaunch below — not by
// blocking majors (Node 25+ is supported when that flag is applied).
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(buildNodeTooOldBanner(nodeVersion) + '\n');
  if (!process.env.HOMEGRAPH_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // Override active — banner shown for visibility, continuing.
}

// Re-exec with V8's `--liftoff-only` if it isn't already set, so tree-sitter's
// large WASM grammars never hit the turboshaft Zone OOM (`Fatal process out of
// memory: Zone`) on Node >= 22. No-op under the bundled launcher, which already
// passes the flag. Must run before any grammar (in the parse worker, which
// inherits this process's flags) is compiled. See ../extraction/wasm-runtime-flags.
relaunchWithWasmRuntimeFlagsIfNeeded(__filename);

// Last-resort fatal handlers: log a bounded line and exit non-zero. A fault
// that reaches here escaped every boundary, so the process is in an undefined
// state — keeping it alive is what let the detached MCP daemon orphan and pin a
// CPU core with no recovery (#799, #850). Installed before the command branch
// so it also covers a synchronous throw during startup. See ./fatal-handler.
installFatalHandlers();

// Check if running with no arguments - run installer
if (process.argv.length === 2) {
  import('../installer').then(({ runInstaller }) =>
    runInstaller()
  ).catch((err) => {
    console.error('Installation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // Normal CLI flow
  main();
}

function main() {

const program = new Command();

// Version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

// Make the version trivial to reach. commander's `.version()` (below) wires up
// `--version` and `-V`; intercept the spellings it can't — lowercase `-v` and
// single-dash `-version` — before any parsing. (commander's version short flag
// is the capital `-V`, and its parser rejects a multi-character single-dash
// flag.) The bare `homegraph version` subcommand is registered further down so
// the affordance also shows up in `homegraph --help`.
const firstArg = process.argv[2];
if (firstArg === '-v' || firstArg === '-version') {
  console.log(packageJson.version);
  return;
}

// =============================================================================
// ANSI Color Helpers (avoid chalk ESM issues)
// =============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

const chalk = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,
};

program
  .name('homegraph')
  .description('Code intelligence and knowledge graph for any codebase')
  .version(packageJson.version);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve project path from argument or current directory
 * Walks up parent directories to find nearest initialized HomeGraph project
 * (must have .homegraph/homegraph.db, not just .homegraph/lessons.db)
 */
function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  // If exact path is initialized (has homegraph.db), use it
  if (isInitialized(absolutePath)) {
    return absolutePath;
  }

  // Walk up to find nearest parent with HomeGraph initialized
  // Note: findNearestHomeGraphRoot finds any .homegraph folder, but we need one with homegraph.db
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (isInitialized(current)) {
      return current;
    }
  }

  // Not found - return original path (will fail later with helpful error)
  return absolutePath;
}

/**
 * Resolve the project root for spec operations by walking up from a path
 * looking for `${SPEC_DATA_DIR}/meta.json` or `${SPEC_DATA_DIR}/commit4spec.db`.
 * Falls back to the starting path when neither marker is found (callers
 * handle the not-found case).
 */
function resolveSpecProjectPath(pathArg?: string): string {
  const startPath = path.resolve(pathArg || process.cwd());

  // Direct hit
  const checkDirs = [
    `${SPEC_DATA_DIR}/meta.json`,
    `${SPEC_DATA_DIR}/commit4spec.db`,
  ];
  for (const check of checkDirs) {
    if (fs.existsSync(path.join(startPath, check))) return startPath;
  }

  // Walk up
  let current = startPath;
  const root = path.parse(current).root;
  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    for (const check of checkDirs) {
      if (fs.existsSync(path.join(current, check))) return current;
    }
  }

  return startPath; // fallback — callers handle not-found
}

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

// Shimmer progress renderer (runs in a worker thread for smooth animation)
// Imported at top of file from '../ui/shimmer-progress'

/**
 * Create a plain-text progress callback for --verbose mode.
 * No animations, no ANSI tricks — just timestamped lines to stdout.
 */
function createVerboseProgress(): (progress: { phase: string; current: number; total: number; currentFile?: string }) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (progress.phase !== lastPhase) {
      lastPhase = progress.phase;
      lastPct = -1;
      console.log(`[${elapsed}s] Phase: ${progress.phase}`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * 100);
      // Log every 5% to keep output manageable
      if (pct >= lastPct + 5 || progress.current === progress.total) {
        lastPct = pct;
        console.log(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${progress.currentFile ? ` ${getGlyphs().dash} ${progress.currentFile}` : ''}`);
      }
    } else if (progress.current > 0) {
      // Scanning phase (no total yet) — log periodically
      if (progress.current % 1000 === 0 || progress.current === 1) {
        console.log(`[${elapsed}s]   ${formatNumber(progress.current)} files found`);
      }
    }
  };
}

/**
 * Print success message
 */
function success(message: string): void {
  console.log(chalk.green(getGlyphs().ok) + ' ' + message);
}

/**
 * Print error message
 */
function error(message: string): void {
  console.error(chalk.red(getGlyphs().err) + ' ' + message);
}

/**
 * Print info message
 */
function info(message: string): void {
  console.log(chalk.blue(getGlyphs().info) + ' ' + message);
}

/**
 * Print warning message
 */
function warn(message: string): void {
  console.log(chalk.yellow(getGlyphs().warn) + ' ' + message);
}

type IndexResult = {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
};

/**
 * Print indexing results using clack log methods
 */
function printIndexResult(clack: typeof import('@clack/prompts'), result: IndexResult, projectPath?: string): void {
  const hasErrors = result.filesErrored > 0;

  // Surface non-file-level failures (e.g. lock-acquisition failure
  // when another indexer is running) before the file-count branches.
  // Without this the CLI falls through to "No files found to index",
  // which is actively misleading — the index DID run, it just couldn't
  // get the lock.
  //
  // If success is false but no severity:'error' entry exists in
  // `result.errors` (degenerate case — shouldn't happen in practice
  // but worth guarding because the result shape is plumbed through
  // multiple call sites), fall back to a generic message rather than
  // continuing to the misleading "No files found" branch or throwing.
  if (!result.success && !hasErrors && result.filesIndexed === 0) {
    const generic = result.errors.find((e) => e.severity === 'error');
    clack.log.error(generic?.message ?? `Indexing failed ${getGlyphs().dash} no further details available`);
    return;
  }

  if (result.filesIndexed > 0) {
    if (hasErrors) {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`);
    } else {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
    }
    clack.log.info(`${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`);
  } else if (hasErrors) {
    clack.log.error(`Indexing failed ${getGlyphs().dash} all ${formatNumber(result.filesErrored)} files had errors`);
  } else {
    clack.log.warn('No files found to index');
  }

  if (hasErrors) {
    const errorsByCode = new Map<string, number>();
    for (const err of result.errors) {
      if (err.severity === 'error') {
        const code = err.code || 'unknown';
        errorsByCode.set(code, (errorsByCode.get(code) || 0) + 1);
      }
    }

    const codeLabels: Record<string, string> = {
      parse_error: 'files failed to parse',
      read_error: 'files could not be read',
      size_exceeded: 'files exceeded size limit',
      path_traversal: 'blocked paths',
      unsupported_language: 'unsupported language',
      parser_error: 'parser initialization failures',
    };

    const breakdown = Array.from(errorsByCode)
      .map(([code, count]) => `${formatNumber(count)} ${codeLabels[code] || code}`)
      .join('\n');
    clack.note(breakdown, 'Error breakdown');

    if (projectPath) {
      writeErrorLog(projectPath, result.errors);
      clack.log.info('See .homegraph/errors.log for details');
    }

    if (result.filesIndexed > 0) {
      clack.log.info(`The index is fully usable ${getGlyphs().dash} only the failed files are missing.`);
    }
  } else if (projectPath) {
    const logPath = path.join(getHomeGraphDir(projectPath), 'errors.log');
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  }

  const ohosApiWarnings = result.errors.filter(
    (e) => e.severity === 'warning' && e.code?.startsWith('ohos_api_')
  );
  if (ohosApiWarnings.length > 0) {
    clack.log.warn('OHOS SDK API db not attached — project index is complete; explore uses project code only.');
    clack.note(ohosApiWarnings.map((e) => e.message).join('\n'), 'OHOS API notice');
  }

  const arktsDegraded = result.errors.filter((e) => e.code === 'arkts_degraded');
  if (arktsDegraded.length > 0) {
    clack.log.warn('ArkTS index quality notice — see details below.');
    clack.note(
      `${arktsDegraded[0]!.message}\n\n` +
        'ArkTS Scene builds run in-process by default (fastest). If the indexer\n' +
        'exits with a Windows stack overflow on a huge repo, opt into the isolated\n' +
        'worker: HOMEGRAPH_ARKTS_ISOLATED=1 (optional HOMEGRAPH_ARKTS_STACK_SIZES_KB).',
      'ArkTS quality notice'
    );
  }
}

/**
 * Write detailed error log to .homegraph/errors.log
 */
function writeErrorLog(projectPath: string, errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>): void {
  const cgDir = getHomeGraphDir(projectPath);
  if (!fs.existsSync(cgDir)) return;

  const logPath = path.join(cgDir, 'errors.log');

  // Group errors by file path
  const errorsByFile = new Map<string, Array<{ message: string; code?: string }>>();
  const noFileErrors: Array<{ message: string; code?: string }> = [];

  for (const err of errors) {
    if (err.severity !== 'error') continue;
    if (err.filePath) {
      let list = errorsByFile.get(err.filePath);
      if (!list) {
        list = [];
        errorsByFile.set(err.filePath, list);
      }
      list.push({ message: err.message, code: err.code });
    } else {
      noFileErrors.push({ message: err.message, code: err.code });
    }
  }

  const lines: string[] = [
    `HomeGraph Error Log - ${new Date().toISOString()}`,
    `${errorsByFile.size} files with errors`,
    '',
  ];

  for (const [filePath, fileErrors] of errorsByFile) {
    for (const err of fileErrors) {
      lines.push(`${filePath}: ${err.message}`);
    }
  }

  for (const err of noFileErrors) {
    lines.push(err.message);
  }

  fs.writeFileSync(logPath, lines.join('\n') + '\n');
}

// =============================================================================
// Commands
// =============================================================================

/**
 * homegraph init [path]
 */
program
  .command('init [path]')
  .description('Initialize HomeGraph in a project directory and build the initial index')
  .option('-i, --index', 'Deprecated: indexing now runs by default; flag accepted for backward compatibility')
  .option('-f, --force', 'Initialize even if the path looks like your home directory or a filesystem root')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { index?: boolean; force?: boolean; verbose?: boolean }) => {
    const projectPath = path.resolve(pathArg || process.cwd());
    const clack = await importESM('@clack/prompts');

    clack.intro('Initializing HomeGraph');

    try {
      // Refuse to index your home directory / a filesystem root — it pulls in
      // caches, other projects, and your whole tree (a multi-GB index + watcher
      // churn, and on pre-1.0 macOS a machine-crashing fd blowup, #845).
      const unsafe = unsafeIndexRootReason(projectPath);
      if (unsafe && !options.force) {
        clack.log.error(`Refusing to initialize in ${projectPath} — it looks like ${unsafe}.`);
        clack.log.info('Run this inside a specific project directory, or pass --force if you really mean to index everything under it.');
        clack.outro('');
        process.exitCode = 1;
        return;
      }

      if (isInitialized(projectPath)) {
        clack.log.warn(`Already initialized in ${projectPath}`);
        clack.log.info('Use "homegraph index" to re-index or "homegraph sync" to update');
        try {
          const { offerWatchFallback } = await import('../installer');
          await offerWatchFallback(clack, projectPath);
        } catch { /* non-fatal */ }
        clack.outro('');
        return;
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.init(projectPath, { index: false });
      clack.log.success(`Initialized in ${projectPath}`);

      // Indexing runs by default now. The legacy -i/--index flag is still
      // accepted (so existing muscle memory and scripts don't break) but is a
      // no-op — initializing always builds the initial index.
      // Supervise the index: self-terminate if orphaned or wedged (#999).
      const supervision = installCommandSupervision('init');
      let result: IndexResult;
      try {
        if (options.verbose) {
          result = await cg.indexAll({
            onProgress: createVerboseProgress(),
            verbose: true,
          });
        } else {
          process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
          const progress = createShimmerProgress();
          result = await cg.indexAll({
            onProgress: progress.onProgress,
          });
          await progress.stop();
        }
      } finally {
        supervision.stop();
      }
      printIndexResult(clack, result, projectPath);

      try {
        const { offerWatchFallback } = await import('../installer');
        await offerWatchFallback(clack, projectPath);
      } catch { /* non-fatal */ }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      clack.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph uninit [path]
 */
program
  .command('uninit [path]')
  .description('Remove HomeGraph from a project (deletes .homegraph/ directory)')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        warn(`HomeGraph is not initialized in ${projectPath}`);
        return;
      }

      if (!options.force) {
        // Confirm with user
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow(`${getGlyphs().warn} This will permanently delete all HomeGraph data. Continue? (y/N) `),
            resolve
          );
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          info('Cancelled');
          return;
        }
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = HomeGraph.openSync(projectPath);
      cg.uninitialize();

      // Clean up any git sync hooks we installed (no-op if none / not a repo).
      try {
        const { removeGitSyncHook } = await import('../sync/git-hooks');
        const removed = removeGitSyncHook(projectPath);
        if (removed.installed.length > 0) {
          info(`Removed git ${removed.installed.join(', ')} sync hook${removed.installed.length > 1 ? 's' : ''}`);
        }
      } catch { /* non-fatal */ }

      success(`Removed HomeGraph from ${projectPath}`);
    } catch (err) {
      error(`Failed to uninitialize: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph index [path]
 */
program
  .command('index [path]')
  .description('Rebuild the full index from scratch (same result as a fresh init)')
  .option('-f, --force', 'Index even if the path looks like your home directory or a filesystem root')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      // Don't (re)index your home directory / a filesystem root (#845). --force
      // doubles as the override.
      const unsafe = unsafeIndexRootReason(projectPath);
      if (unsafe && !options.force) {
        error(`Refusing to index ${projectPath} — it looks like ${unsafe}. Pass --force to override.`);
        process.exit(1);
      }

      if (!isInitialized(projectPath)) {
        error(`HomeGraph not initialized in ${projectPath}`);
        info('Run "homegraph init" first');
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      // `index` is a FULL re-index — identical to a fresh `init`. RECREATE the
      // database from scratch (discard .homegraph/homegraph.db + its WAL) rather
      // than opening the old graph and DELETE-ing every row. The clear-then-index
      // approach reported "0 nodes" without the clear (#874); the recreate keeps
      // that fixed AND avoids the failure mode where, on a large or pre-fix
      // poisoned index, the per-row FTS delete churn wedged the main thread long
      // enough to trip the liveness watchdog before scanning even began (#1067).
      // recreate() hands back a fresh, empty instance — no clear() needed. For
      // fast incremental updates use `sync`.
      const cg = await HomeGraph.recreate(projectPath);

      // Supervise the indexer: self-terminate if orphaned (parent shim killed)
      // or if the main thread wedges — neither was guarded on this path (#999).
      const supervision = installCommandSupervision('index');
      try {
        if (options.quiet) {
          // Quiet mode: no UI, just run against the freshly-recreated graph.
          const result = await cg.indexAll();
          if (!result.success) process.exit(1);
          cg.destroy();
          return;
        }

        const clack = await importESM('@clack/prompts');
        clack.intro('Indexing project');

        let result: IndexResult;

        if (options.verbose) {
          result = await cg.indexAll({
            onProgress: createVerboseProgress(),
            verbose: true,
          });
        } else {
          process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
          const progress = createShimmerProgress();
          result = await cg.indexAll({
            onProgress: progress.onProgress,
          });
          await progress.stop();
        }

        printIndexResult(clack, result, projectPath);

        if (!result.success) {
          process.exit(1);
        }

        clack.outro('Done');
        cg.destroy();
      } finally {
        supervision.stop();
      }
    } catch (err) {
      error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph sync [path]
 */
program
  .command('sync [path]')
  .description('Sync changes since last index')
  .option('-q, --quiet', 'Suppress output (for git hooks)')
  .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        if (!options.quiet) {
          error(`HomeGraph not initialized in ${projectPath}`);
        }
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath, { sources: 'both' });

      if (options.quiet) {
        await cg.sync();
        cg.destroy();
        return;
      }

      const clack = await importESM('@clack/prompts');
      clack.intro('Syncing HomeGraph');

      process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
      const progress = createShimmerProgress();

      const result = await cg.sync({
        onProgress: progress.onProgress,
      });

      await progress.stop();

      const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

      if (totalChanges === 0) {
        clack.log.info('Already up to date');
      } else {
        clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
        const details: string[] = [];
        if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
        if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
        if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
        clack.log.info(`${details.join(', ')} ${getGlyphs().dash} ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
      }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      if (!options.quiet) {
        error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

/**
 * homegraph status [path]
 */
program
  .command('status [path]')
  .description('Show index status and statistics')
  .option('-j, --json', 'Output as JSON')
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);
    // The directory the user actually ran from, before walking up to the index
    // root. Used to detect when the resolved index lives in a different git
    // working tree (e.g. a nested worktree borrowing the main checkout's index).
    const startPath = path.resolve(pathArg || process.cwd());
    const worktreeMismatch = detectWorktreeIndexMismatch(startPath, projectPath);

    try {
      if (!isInitialized(projectPath)) {
        if (options.json) {
          console.log(JSON.stringify({
            initialized: false,
            version: packageJson.version,
            projectPath,
            indexPath: getHomeGraphDir(projectPath),
            lastIndexed: null,
          }));
          return;
        }
        console.log(chalk.bold('\nHomeGraph Status\n'));
        info(`Project: ${projectPath}`);
        warn('Not initialized');
        info('Run "homegraph init" to initialize');
        return;
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles();
      const backend = cg.getBackend();
      const journalMode = cg.getJournalMode();

      const buildInfo = cg.getIndexBuildInfo();
      const reindexRecommended = cg.isIndexStale();
      const indexState = cg.getIndexState();
      const ohosApi = cg.getOhosApiBinding();

      // JSON output mode
      if (options.json) {
        const lastIndexedMs = cg.getLastIndexedAt();
        console.log(JSON.stringify({
          initialized: true,
          version: packageJson.version,
          projectPath,
          indexPath: getHomeGraphDir(projectPath),
          lastIndexed: lastIndexedMs != null ? new Date(lastIndexedMs).toISOString() : null,
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          dbSizeBytes: stats.dbSizeBytes,
          walSizeBytes: stats.walSizeBytes,
          backend,
          journalMode,
          nodesByKind: stats.nodesByKind,
          languages: Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([lang]) => lang),
          pendingChanges: {
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
          },
          worktreeMismatch: worktreeMismatch
            ? { worktreeRoot: worktreeMismatch.worktreeRoot, indexRoot: worktreeMismatch.indexRoot }
            : null,
          ohosApi: ohosApi
            ? { version: ohosApi.version, packageName: ohosApi.packageName, dbPath: ohosApi.dbPath }
            : null,
          graphSources: cg.getGraphSources(),
          index: {
            state: indexState,
            builtWithVersion: buildInfo.version,
            builtWithExtractionVersion: buildInfo.extractionVersion,
            currentExtractionVersion: EXTRACTION_VERSION,
            reindexRecommended,
          },
        }));
        cg.destroy();
        return;
      }

      console.log(chalk.bold('\nHomeGraph Status\n'));

      // Project info
      console.log(chalk.cyan('Project:'), projectPath);
      if (worktreeMismatch) {
        warn(worktreeMismatchWarning(worktreeMismatch));
      }
      console.log();

      // Index stats
      console.log(chalk.bold('Index Statistics:'));
      console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
      console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
      console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
      console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      // Surface the WAL sidecar (#1431): a WAL that dwarfs the DB at rest is
      // the killed-session leak — invisible before this line, it only showed
      // up as a mysteriously full disk. open() above already kicked off the
      // automatic heal for the oversized case.
      if (stats.walSizeBytes > 0) {
        const { WAL_HEAL_THRESHOLD_BYTES } = await import('../db/index');
        const oversized = stats.walSizeBytes > Math.max(WAL_HEAL_THRESHOLD_BYTES, stats.dbSizeBytes);
        const walLabel = `${(stats.walSizeBytes / 1024 / 1024).toFixed(2)} MB`;
        console.log(`  WAL Size:  ${oversized ? chalk.yellow(walLabel) : walLabel}`);
        if (oversized) {
          warn('The write-ahead log is larger than the database — killed sessions left it behind. It is reclaimed automatically on open; if it persists across runs, another live HomeGraph process is holding it.');
        }
      }
      // Prefer node:sqlite → better-sqlite3; wasm is last-resort (no WAL).
      const backendLabel =
        backend === 'node-sqlite' ? chalk.green('node-sqlite')
        : backend === 'native' ? chalk.green('native (better-sqlite3)')
        : chalk.yellow(
            `wasm ${getGlyphs().dash} slower fallback; use Node 22.5+ or \`npm rebuild better-sqlite3\``
          );
      console.log(`  Backend:   ${backendLabel}`);
      const journalLabel = journalMode === 'wal'
        ? chalk.green('wal')
        : chalk.yellow(`${journalMode || 'unknown'} ${getGlyphs().dash} WAL inactive; reads can block on writes`);
      console.log(`  Journal:   ${journalLabel}`);
      console.log(`  Sources:   ${cg.getGraphSources()} (project index / OHOS SDK API)`);
      console.log();

      // Node breakdown
      console.log(chalk.bold('Nodes by Kind:'));
      const nodesByKind = Object.entries(stats.nodesByKind)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [kind, count] of nodesByKind) {
        console.log(`  ${kind.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Language breakdown
      console.log(chalk.bold('Files by Language:'));
      const filesByLang = Object.entries(stats.filesByLanguage)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [lang, count] of filesByLang) {
        console.log(`  ${lang.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      if (ohosApi) {
        console.log(chalk.bold('OHOS API Database:'));
        console.log(`  Version:   ${ohosApi.version}`);
        console.log(`  Package:   ${ohosApi.packageName}`);
        console.log(`  DB:        ${ohosApi.dbPath}`);
        console.log();
      }

      // Pending changes
      const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
      if (totalChanges > 0) {
        console.log(chalk.bold('Pending Changes:'));
        if (changes.added.length > 0) {
          console.log(`  Added:     ${changes.added.length} files`);
        }
        if (changes.modified.length > 0) {
          console.log(`  Modified:  ${changes.modified.length} files`);
        }
        if (changes.removed.length > 0) {
          console.log(`  Removed:   ${changes.removed.length} files`);
        }
        info('Run "homegraph sync" to update the index');
      } else {
        success('Index is up to date');
      }
      console.log();

      // Re-index hint: the index was built by an older engine than the one now
      // running, so a rebuild would add data a migration can't backfill.
      if (reindexRecommended) {
        const builtWith = buildInfo.version ? `v${buildInfo.version.replace(/^v/, '')}` : 'an earlier version';
        warn(`Index was built by ${builtWith}; re-index to pick up this engine's improvements.`);
        info('Run "homegraph index" (full rebuild) or "homegraph sync"');
        console.log();
      }

      cg.destroy();
    } catch (err) {
      error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph query <search>
 */
program
  .command('query <search>')
  .description('Search for symbols in the codebase')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, etc.)')
  .option('-j, --json', 'Output as JSON')
  .action(async (search: string, options: { path?: string; limit?: string; kind?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);

      const limit = parseInt(options.limit || '10', 10);
      const rawResults = cg.searchNodes(search, {
        limit,
        kinds: options.kind ? [options.kind as any] : undefined,
      });

      // Mirror the MCP search down-rank so the CLI also surfaces the
      // hand-written implementation before protobuf/gRPC scaffolding
      // when both share a name. See extraction/generated-detection.ts.
      const { isGeneratedFile } = await import('../extraction/generated-detection');
      const results = [...rawResults].sort((a, b) => {
        const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
        const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
        return aGen - bGen;
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (results.length === 0) {
          info(`No results found for "${search}"`);
        } else {
          console.log(chalk.bold(`\nSearch Results for "${search}":\n`));

          // Results arrive already ranked by relevance, so the order conveys
          // it. We don't print the raw score: it's an unbounded BM25/FTS value
          // (relative-ranking only), and the old `(score * 100)%` rendered it
          // as nonsensical percentages like "12042%" (#1045). The MCP search
          // tool likewise shows no score. Raw `score` stays in --json output.
          for (const result of results) {
            const node = result.node;
            const location = `${node.filePath}:${node.startLine}`;

            console.log(
              chalk.cyan(node.kind.padEnd(12)) +
              chalk.white(node.name)
            );
            console.log(chalk.dim(`  ${location}`));
            if (node.signature) {
              console.log(chalk.dim(`  ${node.signature}`));
            }
            console.log();
          }
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph explore <query...>
 *
 * The CLI face of the MCP homegraph_explore tool — same handler, same
 * output (source of the relevant symbols grouped by file + the call path
 * among them). Exists so agents WITHOUT the MCP tools — Task-tool
 * subagents (which don't inherit MCP tools, #704) and non-MCP harnesses —
 * can reach the graph through a plain shell command.
 */
program
  .command('explore <query...>')
  .description('Explore an area: relevant symbols\' source + call paths in one shot (same output as the homegraph_explore MCP tool)')
  .option('-p, --path <path>', 'Project path')
  .option('--max-files <number>', 'Maximum number of files to include source from')
  .action(async (queryParts: string[], options: { path?: string; maxFiles?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph isn't available here — no .homegraph/ index exists in ${projectPath}. If you are an AI agent: continue with your usual tools; indexing is the user's decision, do not run it yourself. (The project owner can enable HomeGraph with 'homegraph init'.)`);
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(cg);

      const args: Record<string, unknown> = { query: queryParts.join(' ') };
      if (options.maxFiles) args.maxFiles = parseInt(options.maxFiles, 10);
      const result = await handler.execute('homegraph_explore', args);

      console.log(result.content[0]?.text ?? '');
      cg.destroy();
      if (result.isError) process.exit(1);
    } catch (err) {
      error(`Explore failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph prompt-hook  (hidden)
 *
 * A Claude Code `UserPromptSubmit` hook entry point. Reads `{prompt, cwd}` JSON
 * on stdin; for a structural/flow/impact prompt it runs `homegraph_explore` on
 * the indexed project and prints the result to stdout, which Claude injects into
 * the agent's context — so the agent's reflex grep/read has nothing left to find
 * and reliably uses HomeGraph (the adoption problem). Installed by the installer
 * into Claude's settings.json (opt-in, default-yes).
 *
 * LOAD-BEARING: this must NEVER break the user's prompt. Every failure path —
 * kill-switch, non-structural prompt, no index, engine error — exits 0 with no
 * output. The only effect is additive context when it can confidently provide it.
 */
program
  .command('prompt-hook', { hidden: true })
  .description('Claude UserPromptSubmit hook: inject HomeGraph context for structural prompts (reads {prompt,cwd} JSON on stdin)')
  .action(async () => {
    try {
      // Kill-switch: lets a user disable the nudge without uninstalling /
      // editing settings.json (CI, low-power machines, personal preference).
      if (process.env.HOMEGRAPH_NO_PROMPT_HOOK === '1' || process.env.HOMEGRAPH_PROMPT_HOOK === '0') return;
      if (process.stdin.isTTY) return; // invoked by hand, no piped payload

      const raw = await new Promise<string>((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
      });

      let input: { prompt?: string; cwd?: string } = {};
      try { input = JSON.parse(raw); } catch { return; }
      const prompt = String(input.prompt || '');

      // Gate: only structural / flow / impact / where-how prompts get context, so
      // every other prompt ("fix this typo") stays a zero-cost no-op. Language-aware
      // (English + CJK keywords, plus code-shaped tokens) so it fires for non-English
      // prompts too (issue #994). A keyword fires on its own; a code-token is only a
      // CANDIDATE — verified against the graph below, so a tech brand ("JavaScript")
      // that looks like a symbol but isn't one here doesn't inject spurious context.
      const keyworded = hasStructuralKeyword(prompt);
      const codeTokens = keyworded ? [] : extractCodeTokens(prompt);
      if (!keyworded && codeTokens.length === 0) return;

      // Decide what to inject, shaped by WHERE the index(es) are: the nearest
      // indexed ancestor of cwd, or — when cwd is an un-indexed workspace root
      // whose indexed project(s) live in sub-dirs (the monorepo case, #964) —
      // the sub-project the prompt points at, plus a `projectPath` nudge for any
      // others. Without the down-scan the hook injected nothing at a monorepo
      // root (it only walked up), so the validated adoption lever never fired
      // exactly where the agent most needs it.
      const plan = planFrontload(String(input.cwd || process.cwd()), prompt);
      if (!plan.exploreRoot && plan.nudgeProjects.length === 0) return; // nothing reachable — the agent's normal tools apply

      // A "pass projectPath" line for indexed sub-projects we did NOT front-load.
      // Follow-up homegraph_explore calls against a sub-project (cwd isn't its
      // index root) need an explicit projectPath, so spell it out.
      const nudge = (projects: string[], lead: string): string =>
        `${lead}\n${projects.map((p) => `  - projectPath: "${p}"`).join('\n')}\n`;

      if (plan.exploreRoot) {
        const { default: HomeGraph } = await loadHomeGraph();
        const cg = await HomeGraph.open(plan.exploreRoot);
        try {
          // Code-token-only prompt: require that at least one token is a REAL symbol
          // in THIS index before front-loading. Without it, a brand name or common
          // word that merely looks like code ("JavaScript", "GitHub") would run
          // explore and inject ~16KB of low-relevance context (issue #994 follow-up).
          // A keyword-bearing prompt skips this — the keyword is signal enough.
          if (!keyworded && !codeTokens.some((t) => cg.getNodesByName(t).length > 0)) return;
          const { ToolHandler } = await import('../mcp/tools');
          const handler = new ToolHandler(cg);
          const result = await handler.execute('homegraph_explore', { query: prompt });
          const text = result.content[0]?.text ?? '';
          if (!result.isError && text.trim()) {
            // Cap the injection so a large-repo explore can't flood the prompt.
            const MAX = 16000;
            const body = text.length > MAX ? `${text.slice(0, MAX)}\n…(truncated; call homegraph_explore for the rest)` : text;
            // For a front-loaded SUB-project, a follow-up explore needs its path.
            const more = plan.viaSubScan
              ? `call homegraph_explore with projectPath: "${plan.exploreRoot}" for more`
              : 'call homegraph_explore for more';
            const others = plan.nudgeProjects.length
              ? `\n${nudge(plan.nudgeProjects, 'Other indexed projects in this workspace — pass projectPath to query them:')}`
              : '';
            process.stdout.write(
              `<homegraph_context note="Structural context from HomeGraph for this prompt — treat returned source as already read; ${more}.">\n${body}${others}\n</homegraph_context>\n`,
            );
          }
        } finally {
          cg.destroy();
        }
      } else {
        // Several indexed sub-projects, none a clear match — don't guess; tell
        // the agent they exist and how to query one.
        process.stdout.write(
          `<homegraph_context note="HomeGraph is available for this workspace's indexed sub-projects — query one by passing projectPath to homegraph_explore.">\n` +
          nudge(plan.nudgeProjects, "This workspace's HomeGraph indexes live in sub-projects. To use HomeGraph, call homegraph_explore with the projectPath of the relevant one:") +
          `</homegraph_context>\n`,
        );
      }
    } catch {
      // Degradable by contract: never surface an error to the prompt pipeline.
    }
  });

/**
 * homegraph node [name]
 *
 * The CLI face of the MCP homegraph_node tool: one symbol's source +
 * caller/callee trail, or a whole file with line numbers + dependents
 * (Read-parity). Same subagent/non-MCP rationale as `explore`.
 *
 * `name` is OPTIONAL because `--file` (file-read mode) carries no symbol —
 * a required `<name>` made `codegraph node -f <file>` unreachable (#1044).
 */
program
  .command('node [name]')
  .description('One symbol\'s source + caller/callee trail, or read a file with line numbers + dependents (same output as the homegraph_node MCP tool)')
  .option('-p, --path <path>', 'Project path')
  .option('-f, --file <file>', 'Treat as file mode (or disambiguate a symbol to this file)')
  .option('--offset <number>', 'File mode: 1-based start line')
  .option('--limit <number>', 'File mode: maximum lines')
  .option('--symbols-only', 'File mode: just the symbol map + dependents')
  .action(async (name: string | undefined, options: { path?: string; file?: string; offset?: string; limit?: string; symbolsOnly?: boolean }) => {
    // Need a symbol (positional) OR a file (--file / a path-like positional).
    // With [name] optional, a bare `codegraph node` reaches here with neither
    // and must be told what to pass, rather than crashing downstream.
    if (!name && !options.file) {
      error("Pass a symbol name (e.g. 'codegraph node parseToken') or a file (e.g. 'codegraph node -f src/auth.ts', or 'codegraph node src/auth.ts').");
      process.exit(1);
    }

    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph isn't available here — no .homegraph/ index exists in ${projectPath}. If you are an AI agent: continue with your usual tools; indexing is the user's decision, do not run it yourself. (The project owner can enable HomeGraph with 'homegraph init'.)`);
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(cg);

      // A name with a path separator is a file read; otherwise a symbol
      // (use --file for basename-only file reads or to pin an overload).
      // Both separators: Windows users type src\auth\session.ts. Symbols
      // never contain either ('/' isn't an identifier char anywhere we
      // index; C++ scope is '::', JS members '.').
      const args: Record<string, unknown> = {};
      if (options.file) {
        args.file = options.file;
        if (name && name !== options.file) args.symbol = name;
      } else if (name && (name.includes('/') || name.includes('\\'))) {
        args.file = name.replace(/\\/g, '/');
      } else if (name) {
        args.symbol = name;
        args.includeCode = true;
      }
      if (options.offset) args.offset = parseInt(options.offset, 10);
      if (options.limit) args.limit = parseInt(options.limit, 10);
      if (options.symbolsOnly) args.symbolsOnly = true;

      const result = await handler.execute('homegraph_node', args);

      console.log(result.content[0]?.text ?? '');
      cg.destroy();
      if (result.isError) process.exit(1);
    } catch (err) {
      error(`Node lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph files [path]
 */
program
  .command('files')
  .description('Show project file structure from the index')
  .option('-p, --path <path>', 'Project path')
  .option('--filter <dir>', 'Filter to files under this directory')
  .option('--pattern <glob>', 'Filter files matching this glob pattern')
  .option('--format <format>', 'Output format (tree, flat, grouped)', 'tree')
  .option('--max-depth <number>', 'Maximum directory depth for tree format')
  .option('--no-metadata', 'Hide file metadata (language, symbol count)')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    filter?: string;
    pattern?: string;
    format?: string;
    maxDepth?: string;
    metadata?: boolean;
    json?: boolean;
  }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);
      let files = cg.getFiles();

      if (files.length === 0) {
        info('No files indexed. Run "homegraph index" first.');
        cg.destroy();
        return;
      }

      // Filter by path prefix
      if (options.filter) {
        const filter = options.filter;
        files = files.filter(f => f.path.startsWith(filter) || f.path.startsWith('./' + filter));
      }

      // Filter by glob pattern
      if (options.pattern) {
        const regex = globToRegex(options.pattern);
        files = files.filter(f => regex.test(f.path));
      }

      if (files.length === 0) {
        info('No files found matching the criteria.');
        cg.destroy();
        return;
      }

      // JSON output
      if (options.json) {
        const output = files.map(f => ({
          path: f.path,
          language: f.language,
          nodeCount: f.nodeCount,
          size: f.size,
        }));
        console.log(JSON.stringify(output, null, 2));
        cg.destroy();
        return;
      }

      const includeMetadata = options.metadata !== false;
      const format = options.format || 'tree';
      const maxDepth = options.maxDepth ? parseInt(options.maxDepth, 10) : undefined;

      // Format output
      switch (format) {
        case 'flat':
          console.log(chalk.bold(`\nFiles (${files.length}):\n`));
          for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
            if (includeMetadata) {
              console.log(`  ${file.path} ${chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`)}`);
            } else {
              console.log(`  ${file.path}`);
            }
          }
          break;

        case 'grouped':
          console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
          const byLang = new Map<string, typeof files>();
          for (const file of files) {
            const existing = byLang.get(file.language) || [];
            existing.push(file);
            byLang.set(file.language, existing);
          }
          const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
          for (const [lang, langFiles] of sortedLangs) {
            console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
            for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
              if (includeMetadata) {
                console.log(`  ${file.path} ${chalk.dim(`(${file.nodeCount} symbols)`)}`);
              } else {
                console.log(`  ${file.path}`);
              }
            }
            console.log();
          }
          break;

        case 'tree':
        default:
          console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
          printFileTree(files, includeMetadata, maxDepth, chalk);
          break;
      }

      console.log();
      cg.destroy();
    } catch (err) {
      error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * Normalize a user-supplied file path to the project-relative, forward-slash
 * form HomeGraph stores in the index. Accepts an absolute path, a `./`-prefixed
 * path, or Windows back-slashes; an empty string when the input is blank. Used
 * by `homegraph affected` so `./src/x.ts`, `/abs/repo/src/x.ts`, and
 * `src/x.ts` all match the same indexed file. (#825)
 */
function normalizeIndexPath(filePath: string, projectPath: string): string {
  let f = filePath.trim();
  if (!f) return '';
  if (path.isAbsolute(f)) f = path.relative(projectPath, f);
  // Collapse `.`/`..` segments, then force forward slashes and drop a leading
  // `./` (path.normalize already strips it on POSIX; explicit for Windows).
  f = path.normalize(f).replace(/\\/g, '/').replace(/^\.\//, '');
  return f;
}

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(escaped);
}

/**
 * Print files as a tree
 */
function printFileTree(
  files: { path: string; language: string; nodeCount: number }[],
  includeMetadata: boolean,
  maxDepth: number | undefined,
  chalk: { dim: (s: string) => string; cyan: (s: string) => string }
): void {
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  }

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const glyphs = getGlyphs();
    const connector = isLast ? glyphs.treeLast : glyphs.treeBranch;
    const childPrefix = isLast ? '    ' : glyphs.treePipe;

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
      }
      console.log(line);
    }

    const children = [...node.children.values()];
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);
}

/**
 * homegraph daemon — interactive manager for the background daemons. Arrow keys
 * to pick one (the current project's daemon floats to the top, auto-selected),
 * enter to stop it. Falls back to a plain list when output isn't a TTY.
 */
program
  .command('daemon')
  .aliases(['daemons'])
  .description('Manage running HomeGraph background daemons — pick one and press enter to stop it')
  .action(async () => {
    const { listDaemons, stopDaemonAt, stopAllDaemons } = await import('../mcp/daemon-registry');
    const { runDaemonPicker } = await import('../mcp/daemon-manager');

    const daemons = listDaemons();
    if (daemons.length === 0) {
      info('No HomeGraph daemons running.');
      return;
    }

    // No TTY (piped / CI / non-interactive) — can't do arrow-key selection, so
    // just print what's running instead of crashing on a prompt with no input.
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      for (const d of daemons) {
        console.log(`pid ${d.pid}  v${d.version}  up ${formatDuration(Date.now() - d.startedAt)}  ${d.root}`);
      }
      return;
    }

    // The current project's daemon floats to the top and is pre-selected.
    let cwdRoot: string | null = null;
    const found = findNearestHomeGraphRoot(process.cwd());
    if (found) { try { cwdRoot = fs.realpathSync(found); } catch { cwdRoot = found; } }

    const clack = await importESM('@clack/prompts');
    clack.intro('HomeGraph daemons');
    await runDaemonPicker({
      list: listDaemons,
      stop: stopDaemonAt,
      stopAll: stopAllDaemons,
      cwdRoot,
      now: () => Date.now(),
      select: (opts) => clack.select(opts),
      isCancel: (v) => clack.isCancel(v),
      note: (m) => clack.log.success(m),
      done: (m) => clack.outro(m),
    });
  });

/**
 * homegraph serve / homegraph serve mcp
 *
 * Preferred: `homegraph serve mcp`
 * Legacy (still supported): `homegraph serve --mcp`
 *
 * Hidden from `--help`: this is the stdio entry point an AI agent launches
 * for itself (the installer wires it into every agent's MCP config), not a
 * command a human runs. It still works when invoked — hiding only removes it
 * from the listing. See the interactive-TTY guard in `runServeMcp`, which
 * explains this to anyone who runs it by hand.
 */
async function runServeMcp(options: {
  path?: string;
  watch?: boolean;
  sources?: string;
  autoInit?: boolean;
}): Promise<void> {
  const projectPath = options.path ? resolveProjectPath(options.path) : undefined;

  // Commander sets watch=false when --no-watch is passed. Route it through
  // the same env-var chokepoint the watcher and MCP server already honor.
  if (options.watch === false) {
    process.env.HOMEGRAPH_NO_WATCH = '1';
  }

  // Product hosts (DevEco Code) pass --auto-init so unindexed workspaces get
  // .homegraph/ + background index + watch without a separate `homegraph init`.
  if (options.autoInit) {
    process.env.HOMEGRAPH_AUTO_INIT = '1';
  }

  // Spec 0005: resolve --sources over HOMEGRAPH_SOURCES, then stamp env so
  // detached daemons and in-process opens share the same mode.
  const { resolveGraphSources, applyGraphSourcesToEnv, GRAPH_SOURCES_MODES } =
    await import('../graph-sources');
  try {
    const mode = resolveGraphSources(options.sources);
    applyGraphSourcesToEnv(mode);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    error(`Valid values: ${GRAPH_SOURCES_MODES.join(', ')}`);
    process.exit(1);
  }

  // The stdio MCP server an AI agent launches for itself — not a command to
  // run by hand. A human in a terminal would otherwise see it hang waiting
  // for JSON-RPC on stdin. The agent's pipe and the detached daemon both
  // have a non-TTY stdin, so this only ever fires for a person who typed it.
  if (process.stdin.isTTY && !process.env.HOMEGRAPH_DAEMON_INTERNAL) {
    console.error(chalk.bold('\nHomeGraph MCP server\n'));
    console.error("This is the MCP server your AI agent (Claude Code, Cursor, Codex, opencode, …)");
    console.error("starts automatically — you don't run it yourself.");
    console.error(`\nIt's already wired up by ${chalk.cyan('homegraph install')}. To check on things:`);
    console.error(`  ${chalk.cyan('homegraph status')}   ${chalk.dim('— is this project indexed and healthy?')}`);
    console.error(`  ${chalk.cyan('homegraph daemon')}   ${chalk.dim('— list or stop background MCP servers')}`);
    console.error(chalk.dim('\n(Running it directly only does something when an MCP client drives it over stdin.)'));
    return;
  }

  const { MCPServer } = await import('../mcp/index');
  const server = new MCPServer(projectPath);
  await server.start();
}

function printServeUsage(): void {
  // Use stderr so stdout stays clean for any piped/stdio usage.
  console.error(chalk.bold('\nHomeGraph MCP Server\n'));
  console.error(chalk.blue(getGlyphs().info) + ' Start with: ' + chalk.cyan('homegraph serve mcp'));
  console.error(chalk.dim('  (legacy alias also works: homegraph serve --mcp)'));
  console.error('\nTo use with Claude Code, add to your MCP configuration:');
  console.error(chalk.dim(`
{
  "mcpServers": {
    "homegraph": {
      "command": "homegraph",
      "args": ["serve", "mcp"]
    }
  }
}
`));
  console.error('Optional: --sources both|project|sdk|none (or HOMEGRAPH_SOURCES) to limit project vs OHOS SDK graphs.');
  console.error('Available tools:');
  console.error(chalk.cyan('  homegraph_explore') + '   - Primary: source of the relevant symbols for any question');
  console.error(chalk.cyan('  homegraph_search') + '    - Search for code symbols');
  console.error(chalk.cyan('  homegraph_callers') + '   - Find callers of a symbol');
  console.error(chalk.cyan('  homegraph_callees') + '   - Find what a symbol calls');
  console.error(chalk.cyan('  homegraph_impact') + '    - Analyze impact of changes');
  console.error(chalk.cyan('  homegraph_node') + '      - Get symbol details');
  console.error(chalk.cyan('  homegraph_files') + '     - Get project file structure');
  console.error(chalk.cyan('  homegraph_status') + '    - Get index status');
}

// IMPORTANT: keep `mcp` as an argument (not a nested Commander subcommand).
// Nested `serve.command('mcp')` + a parent `-p/--path` made Commander 14 drop
 // `--path` on `serve mcp --path <repo>` — the daemon then keyed off cwd, so
// prewarm/eval looked "timed out" while a useless daemon bound the wrong root.
// `spawnDetachedDaemon` also invokes `serve mcp --path <root>`; that path must
// stick. Legacy `serve --mcp` stays supported.
program
  .command('serve', { hidden: true })
  .description('Start HomeGraph protocol servers for AI assistants')
  .argument('[mode]', 'Run as MCP server (stdio transport)', undefined)
  .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
  .option('--mcp', 'Legacy alias for `serve mcp` (stdio MCP server)')
  .option('--no-watch', 'Disable the file watcher (no auto-sync; useful on slow filesystems like WSL2 /mnt drives)')
  .option('--auto-init', 'If no .homegraph/ exists, create it and index in the background (for product hosts)')
  .option(
    '--sources <mode>',
    'Graph sources for MCP queries: both|project|sdk|none (default both; env HOMEGRAPH_SOURCES)'
  )
  .action(async (mode: string | undefined, options: {
    path?: string;
    mcp?: boolean;
    watch?: boolean;
    sources?: string;
    autoInit?: boolean;
  }) => {
    try {
      if (mode === 'mcp' || options.mcp) {
        await runServeMcp(options);
      } else {
        printServeUsage();
      }
    } catch (err) {
      error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph unlock [path]
 */
program
  .command('unlock [path]')
  .description('Remove a stale lock file that is blocking indexing')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph not initialized in ${projectPath}`);
        return;
      }

      const lockPath = path.join(getHomeGraphDir(projectPath), 'homegraph.lock');

      if (!fs.existsSync(lockPath)) {
        info(`No lock file found ${getGlyphs().dash} nothing to do`);
        return;
      }

      fs.unlinkSync(lockPath);
      success('Removed lock file. You can now run indexing again.');
    } catch (err) {
      error(`Failed to remove lock: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph callers <symbol>
 *
 * CLI parity with the MCP graph tools (homegraph_callers/callees/impact) so the
 * traversal queries work in scripts, CI, and git hooks without a running MCP
 * server.
 */
program
  .command('callers <symbol>')
  .description('Find all functions/methods that call a specific symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);
      const limit = parseInt(options.limit || '20', 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      const seen = new Set<string>();
      const allCallers: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        for (const c of cg.getCallers(match.node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallers.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      // Fallback: if exact filter removed everything, use the top match
      if (allCallers.length === 0 && matches[0]) {
        for (const c of cg.getCallers(matches[0].node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallers.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      const limited = allCallers.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({ symbol, callers: limited }, null, 2));
      } else if (limited.length === 0) {
        info(`No callers found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nCallers of "${symbol}" (${limited.length}):\n`));
        for (const node of limited) {
          const loc = node.startLine ? `:${node.startLine}` : '';
          console.log(
            chalk.cyan(node.kind.padEnd(12)) +
            chalk.white(node.name)
          );
          console.log(chalk.dim(`  ${node.filePath}${loc}`));
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`callers failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph callees <symbol>
 */
program
  .command('callees <symbol>')
  .description('Find all functions/methods that a specific symbol calls')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);
      const limit = parseInt(options.limit || '20', 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      const seen = new Set<string>();
      const allCallees: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        for (const c of cg.getCallees(match.node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallees.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      if (allCallees.length === 0 && matches[0]) {
        for (const c of cg.getCallees(matches[0].node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallees.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      const limited = allCallees.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({ symbol, callees: limited }, null, 2));
      } else if (limited.length === 0) {
        info(`No callees found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nCallees of "${symbol}" (${limited.length}):\n`));
        for (const node of limited) {
          const loc = node.startLine ? `:${node.startLine}` : '';
          console.log(
            chalk.cyan(node.kind.padEnd(12)) +
            chalk.white(node.name)
          );
          console.log(chalk.dim(`  ${node.filePath}${loc}`));
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`callees failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph impact <symbol>
 */
program
  .command('impact <symbol>')
  .description('Analyze what code is affected by changing a symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-d, --depth <number>', 'Traversal depth', '2')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; depth?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);
      const depth = Math.min(Math.max(parseInt(options.depth || '2', 10), 1), 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      // Merge impact subgraphs across all exact-matching symbols
      const mergedNodes = new Map<string, { name: string; kind: string; filePath: string; startLine?: number }>();
      const seenEdges = new Set<string>();
      let edgeCount = 0;

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        const impact = cg.getImpactRadius(match.node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            edgeCount++;
          }
        }
      }

      // Fallback to top match if exact filter removed everything
      if (mergedNodes.size === 0 && matches[0]) {
        const impact = cg.getImpactRadius(matches[0].node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        edgeCount = impact.edges.length;
      }

      if (options.json) {
        console.log(JSON.stringify({
          symbol,
          depth,
          nodeCount: mergedNodes.size,
          edgeCount,
          affected: Array.from(mergedNodes.values()),
        }, null, 2));
      } else if (mergedNodes.size === 0) {
        info(`No affected symbols found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nImpact of changing "${symbol}" — ${mergedNodes.size} affected symbols:\n`));

        // Group by file
        const byFile = new Map<string, Array<{ name: string; kind: string; startLine?: number }>>();
        for (const node of mergedNodes.values()) {
          const list = byFile.get(node.filePath) || [];
          list.push({ name: node.name, kind: node.kind, startLine: node.startLine });
          byFile.set(node.filePath, list);
        }

        for (const [file, nodes] of byFile) {
          console.log(chalk.cyan(file));
          for (const node of nodes) {
            const loc = node.startLine ? `:${node.startLine}` : '';
            console.log(`  ${chalk.dim(node.kind.padEnd(12))}${node.name}${chalk.dim(loc)}`);
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`impact failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph affected [files...]
 *
 * Find test files affected by the given source files.
 * Traces dependency edges transitively to find test files that depend on changed code.
 *
 * Usage:
 *   git diff --name-only | homegraph affected --stdin
 *   homegraph affected src/lib/components/Editor.svelte src/routes/+page.svelte
 */
program
  .command('affected [files...]')
  .description('Find test files affected by changed source files')
  .option('-p, --path <path>', 'Project path')
  .option('--stdin', 'Read file list from stdin (one per line)')
  .option('-d, --depth <number>', 'Max dependency traversal depth', '5')
  .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only output file paths, no decoration')
  .action(async (fileArgs: string[], options: { path?: string; stdin?: boolean; depth?: string; filter?: string; json?: boolean; quiet?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`HomeGraph not initialized in ${projectPath}`);
        process.exit(1);
      }

      // Collect changed files from args or stdin
      let changedFiles: string[] = [...(fileArgs || [])];

      if (options.stdin) {
        const stdinData = fs.readFileSync(0, 'utf-8');
        const stdinFiles = stdinData.split('\n').map(f => f.trim()).filter(Boolean);
        changedFiles.push(...stdinFiles);
      }

      // Normalize inputs to the project-relative, forward-slash form the index
      // stores. Without this, `affected ./src/x.ts`, an absolute path (what a
      // wrapping script often passes), or a Windows back-slash path silently
      // matches nothing and reports 0 affected tests. (#825)
      changedFiles = changedFiles
        .map((f) => normalizeIndexPath(f, projectPath))
        .filter(Boolean);

      if (changedFiles.length === 0) {
        if (!options.quiet) info('No files provided. Use file arguments or --stdin.');
        process.exit(0);
      }

      const { default: HomeGraph } = await loadHomeGraph();
      const cg = await HomeGraph.open(projectPath);
      const maxDepth = parseInt(options.depth || '5', 10);

      // Common test file patterns
      const defaultTestPatterns = [
        /\.spec\./,
        /\.test\./,
        /\/__tests__\//,
        /\/tests?\//,
        /\/e2e\//,
        /\/spec\//,
      ];

      // Custom filter pattern
      let customFilter: RegExp | null = null;
      if (options.filter) {
        // Convert glob to regex: ** → .+, * → [^/]*, . → \.
        const regex = options.filter
          .replace(/[+[\]{}()^$|\\]/g, '\\$&')
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.+')
          .replace(/\*/g, '[^/]*');
        customFilter = new RegExp(regex);
      }

      function isTestFile(filePath: string): boolean {
        if (customFilter) return customFilter.test(filePath);
        return defaultTestPatterns.some(p => p.test(filePath));
      }

      // BFS to find all transitive dependents of changed files, filtered to test files
      const affectedTests = new Set<string>();
      const allDependents = new Set<string>();

      for (const file of changedFiles) {
        // If the changed file is itself a test file, include it
        if (isTestFile(file)) {
          affectedTests.add(file);
          continue;
        }

        // BFS through dependents
        const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
        const visited = new Set<string>();
        visited.add(file);

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth >= maxDepth) continue;

          const dependents = cg.getFileDependents(current.file);
          for (const dep of dependents) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            allDependents.add(dep);

            if (isTestFile(dep)) {
              affectedTests.add(dep);
            } else {
              queue.push({ file: dep, depth: current.depth + 1 });
            }
          }
        }
      }

      const sortedTests = Array.from(affectedTests).sort();

      // Output
      if (options.json) {
        console.log(JSON.stringify({
          changedFiles,
          affectedTests: sortedTests,
          totalDependentsTraversed: allDependents.size,
        }, null, 2));
      } else if (options.quiet) {
        for (const t of sortedTests) console.log(t);
      } else {
        if (sortedTests.length === 0) {
          info('No test files affected by the changed files.');
        } else {
          console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
          for (const t of sortedTests) {
            console.log('  ' + chalk.cyan(t));
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Affected analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph install
 */
program
  .command('install')
  .description('Install homegraph MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, DevEco Code, CodeBuddy, Hermes Agent)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
  .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=auto, auto-allow on')
  .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code only)')
  .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
    permissions?: boolean;
    printConfig?: string;
  }) => {
    if (opts.printConfig) {
      const { getTarget, listTargetIds } = await import('../installer/targets/registry');
      const target = getTarget(opts.printConfig);
      if (!target) {
        const known = listTargetIds().join(', ');
        error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
        process.exit(1);
      }
      const loc = (opts.location === 'local' ? 'local' : 'global') as 'global' | 'local';
      process.stdout.write(target.printConfig(loc));
      return;
    }

    const { runInstallerWithOptions } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      // Commander's `--no-permissions` makes `opts.permissions === false`;
      // omitting the flag leaves it `true` (the positive-form default).
      // We MUST treat the default-true as "user did not override — let
      // the orchestrator prompt" and only forward an explicit `false`
      // (or `true` when --yes implies it). Otherwise the auto-allow
      // prompt is silently skipped on every interactive run.
      const explicitNoPermissions = opts.permissions === false;
      const autoAllow: boolean | undefined = explicitNoPermissions
        ? false
        : opts.yes
          ? true
          : undefined;

      await runInstallerWithOptions({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        autoAllow,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * homegraph uninstall
 *
 * Inverse of `install`. Removes the homegraph MCP server entry,
 * instructions block, and permissions from every agent (or a
 * `--target` subset). Prompts global-vs-local when not given. Does NOT
 * delete the `.homegraph/` index — that's `homegraph uninit`.
 */
program
  .command('uninstall')
  .description('Remove homegraph from your agents (Claude Code, Cursor, Codex CLI, opencode, DevEco Code, CodeBuddy, Hermes Agent)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "all". Default: all')
  .option('-l, --location <where>', 'Uninstall location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=all')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
  }) => {
    const { runUninstaller } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      await runUninstaller({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// =============================================================================
// Spec commands (Commit4Spec knowledge graph)
// =============================================================================

const specCommand = program
  .command('spec')
  .description('Manage spec knowledge graph (build, mine, search, self-evolve)');

/**
 * homegraph spec build
 */
specCommand
  .command('build')
  .description('Build spec knowledge graph from scanned Git history')
  .option('-p, --path <path>', 'Path to the repository')
  .option('--spec-dir <path>', 'Path to the .spec directory')
  .option('-v, --verbose', 'Show detailed output')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    specDir?: string;
    verbose?: boolean;
    json?: boolean;
  }) => {
    try {
      const repoPath = path.resolve(options.path || process.cwd());
      const specStoragePath = path.resolve(repoPath, options.specDir || '.spec');

      const { createDatabase } = await import('../db/sqlite-adapter');
      const { runBuildPipeline } = await import('../spec/build/pipeline');
      const { isGitRepo } = await import('../spec/git');
      const { resolveDbPath } = await import('../spec/utils');
      const { createBuildProgressHandler } = await import('../spec/ui');

      const dbPath = resolveDbPath(repoPath);

      if (!isGitRepo(repoPath)) {
        error(`Not a git repository: ${repoPath}`);
        process.exit(1);
      }

      if (options.verbose) {
        info(`Repository: ${repoPath}`);
        info(`Spec storage: ${specStoragePath}`);
        info(`Database: ${dbPath}`);
      }

      // Progress reporting (mirrors `spec mine`):
      // - JSON mode: no progress output (only final JSON).
      // - Verbose mode: plain-text lines with timestamps.
      // - TTY (default): ANSI progress bar with phase + item details.
      // - Pipe / non-TTY: fall back to verbose (5 % stepping).
      const onProgress = options.json
        ? undefined
        : createBuildProgressHandler(
            options.verbose ? 'verbose' : process.stdout.isTTY ? 'bar' : 'verbose',
          );

      const { db } = createDatabase(dbPath);
      const result = runBuildPipeline(repoPath, specStoragePath, db, onProgress);

      if (result.upToDate) {
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          info('Spec knowledge graph is up to date — nothing to build.');
        }
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        info(`Specs found: ${result.specsFound}`);
        info(`Commits found: ${result.commitsFound}`);
        info(`Fragments: ${result.fragmentsFound}`);
        info(`Relations: ${result.relationsCreated}`);
        info(`Total entries: ${result.totalEntries}`);
        info(`Skipped: ${result.skippedEntries.length}`);

        if (result.skippedEntries.length > 0) {
          for (const entry of result.skippedEntries) {
            warn(`${entry.specId}: ${entry.reason}`);
          }
        }
      }
    } catch (err) {
      error(`Mining failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph spec mine
 *
 * Mine design specs from Git history using AST analysis and LLM
 */
specCommand
  .command('mine')
  .description('Mine design specs from Git history using AST analysis and LLM')
  .option('-p, --path <path>', 'Path to the repository')
  .option('--limit <number>', 'Maximum commits to scan', '100')
  .option('--output <path>', 'Output directory for generated specs', '.spec')
  .option('--threshold <number>', 'Clustering similarity threshold (0-1)', '0.25')
  .option('--max-cluster <number>', 'Maximum number of clusters', '10')
  .option('--template <path>', 'Path to a spec template markdown file')
  .option('--skip-llm', 'Skip LLM generation — only output clusters')
  .option('-v, --verbose', 'Show detailed output')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    limit?: string;
    output?: string;
    threshold?: string;
    maxCluster?: string;
    template?: string;
    skipLlm?: boolean;
    verbose?: boolean;
    json?: boolean;
  }) => {
    try {
      const repoPath = path.resolve(options.path || process.cwd());

      const { isGitRepo } = await import('../spec/git');
      const { loadSpecConfig } = await import('../spec/config');
      const { runMinePipeline } = await import('../spec/mine/pipeline');
      const { createDatabase } = await import('../db/sqlite-adapter');
      const { resolveDbPath } = await import('../spec/utils');
      const { createMineProgressHandler } = await import('../spec/ui');

      if (!isGitRepo(repoPath)) {
        error(`Not a git repository: ${repoPath}`);
        process.exit(1);
      }

      // Parse numeric options
      const limit = parseInt(options.limit || '100', 10);
      if (isNaN(limit) || limit < 1 || limit > 1000) {
        error('--limit must be an integer between 1 and 1000');
        process.exit(1);
      }

      const threshold = parseFloat(options.threshold || '0.25');
      if (isNaN(threshold) || threshold < 0 || threshold > 1) {
        error('--threshold must be a number between 0 and 1');
        process.exit(1);
      }

      const maxCluster = parseInt(options.maxCluster || '10', 10);
      if (isNaN(maxCluster) || maxCluster < 1 || maxCluster > 50) {
        error('--max-cluster must be an integer between 1 and 50');
        process.exit(1);
      }

      // Resolve output directory: if meta.json exists, reuse its specStoragePath;
      // otherwise fall back to --output option, then default '.spec'.
      // All paths are resolved relative to repoPath so that relative values
      // (e.g. '.spec', or a relative specStoragePath from meta.json) are
      // anchored correctly regardless of cwd; absolute paths pass through unchanged.
      const existingMeta = readMeta(repoPath);
      const outputDir = existingMeta
        ? path.resolve(repoPath, existingMeta.specStoragePath)
        : path.resolve(repoPath, options.output || '.spec');

      // Load spec config for LLM setup
      const specConfig = loadSpecConfig(repoPath);
      const llmConfig = specConfig.llm;
      const { resolveAgent } = await import('../spec/llm/agents');
      const codingAgent = options.skipLlm ? null : resolveAgent();

      if (!options.skipLlm && !llmConfig && !codingAgent) {
        info(
          'No coding agent (Claude Code / Codex / DevEco Code) detected and no LLM configuration found.\n' +
          'Set up "llm" in .homegraph/commit4spec/configs.json.\n' +
          '\n' +
          'All available options (fields marked * are required):\n' +
          '{\n' +
          '  "llm": {\n' +
          '    "provider":     "openai",          // * "openai" or "anthropic"\n' +
          '    "apiKey":       "sk-...",          // * API key string (plain text)\n' +
          '    "apiKeyEnv":   "OPENAI_API_KEY",   //   or read from env var (takes precedence)\n' +
          '    "model":        "gpt-4o",          // * model name (e.g. gpt-4o, claude-3-5-sonnet)\n' +
          '    "baseUrl":      "https://...",     //   custom endpoint (proxies / local models)\n' +
          '    "temperature":  0.2,               //   creativity control (default: 0.2)\n' +
          '    "maxTokens":    20000              //   max output tokens (default: 20000)\n' +
          '  }\n' +
          '}\n' +
          '\n' +
          'Continuing with --skip-llm (clustering only).',
        );
      } else if (!options.skipLlm && !llmConfig && codingAgent) {
        info(`Using ${codingAgent.displayName} (headless) for spec generation — no LLM configuration needed.`);
      } else if (!options.skipLlm && llmConfig && codingAgent) {
        info(`Using ${codingAgent.displayName} (headless) for spec generation — configured LLM is kept as fallback.`);
      }

      const mineConfig = createMineConfig(
        {
          limit,
          threshold,
          maxCluster,
          outputDir,
          template: options.template,
          skipLlm: !!options.skipLlm,
        },
        !!llmConfig || codingAgent !== null,
      );

      if (options.verbose) {
        info(`Repository: ${repoPath}`);
        info(`Limit: ${limit === 100 ? '100 (default)' : limit}`);
        info(`Threshold: ${threshold}`);
        info(`Max clusters: ${maxCluster}`);
        info(`Output: ${outputDir}`);
        info(`Skip LLM: ${mineConfig.skipLlm}`);
        if (options.template) {
          info(`Template: ${options.template}`);
        }
      }

      // Open knowledge graph database for persistence
      let db: import('../db/sqlite-adapter').SqliteDatabase | undefined;
      try {
        const dbPath = resolveDbPath(repoPath);
        const created = createDatabase(dbPath);
        db = created.db;
      } catch (err) {
        // Non-fatal — spec generation and file output still work without DB
        if (options.verbose) {
          warn(`Failed to open commit4spec.db: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Wire up progress reporting.
      // - JSON mode: no progress output (only final JSON).
      // - Verbose mode: plain-text lines with timestamps.
      // - TTY (default): ANSI progress bar with phase + item details.
      // - Pipe / non-TTY: fall back to verbose (5 % stepping).
      let onProgress: import('../spec/ui').ProgressCallback | undefined;
      if (!options.json) {
        onProgress = createMineProgressHandler(
          options.verbose ? 'verbose' : process.stdout.isTTY ? 'bar' : 'verbose',
        );
      }

      let result: any;
      try {
        result = await runMinePipeline(repoPath, mineConfig, llmConfig, db, onProgress);
      } finally {
        // Close database even if pipeline throws
        try { db?.close(); } catch { /* best effort */ }
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        success(
          `Scanned ${result.commitsScanned} commits, ` +
          `${result.changesFound} with structural changes, ` +
          `${result.clusters} clusters found.`,
        );
        if (result.specsGenerated > 0) {
          success(
            `${result.specsGenerated} specs generated in ${outputDir}/`,
          );
        }
        if (result.specsWritten > 0) {
          info(`${result.specsWritten} spec(s), ${result.commitsWritten} commit(s), ${result.fragmentsWritten} fragment(s) written to commit4spec.db`);
        }
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            warn(err);
          }
        }
      }
    } catch (err) {
      error(`Reverse pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph spec match <text>
 */
specCommand
  .command('match <text>')
  .description('Search the spec knowledge graph for a term or phrase')
  .option('-p, --path <path>', 'Path to the repository')
  .option('--top-k <number>', 'Number of results to return', '5')
  .option('--no-fragments', 'Exclude code fragments from results')
  .option('-j, --json', 'Output as JSON')
  .action(async (text: string, options: {
    path?: string;
    topK?: string;
    fragments?: boolean;
    json?: boolean;
  }) => {
    let db: import('../db/sqlite-adapter').SqliteDatabase | undefined;
    try {
      const repoPath = resolveSpecProjectPath(options.path);

      const { createDatabase } = await import('../db/sqlite-adapter');
      const { resolveDbPath, computeBudgetProfile } = await import('../spec/utils');
      const { searchAndGetContext } = await import('../spec/graph/queries');

      const dbPath = resolveDbPath(repoPath);

      if (!fs.existsSync(dbPath)) {
        error(`Database not found at ${dbPath}. Run 'homegraph spec build/mine' first.`);
        process.exit(1);
      }

      const created = createDatabase(dbPath);
      db = created.db;

      const topK = Math.max(1, Math.min(parseInt(options.topK || '5', 10) || 5, 50));
      const includeFragments = options.fragments !== false;

      const contexts = searchAndGetContext(db, text, topK, includeFragments);

      if (contexts.length === 0) {
        info('No specs matched your query.');
        return;
      }

      const profile = computeBudgetProfile(contexts.length);
      const results = contexts.map((ctx) => ({
        spec_id: ctx.spec.id,
        title: ctx.spec.title,
        subtitles: ctx.spec.subtitles,
        file_path: ctx.spec.filePath,
        commits: ctx.commits.map((c) => ({
          hash: c.commit.hash,
          message: c.commit.message,
          relation_type: c.relationType,
          fragments: c.fragments.map((f) => ({
            file_path: f.filePath,
            change_type: f.changeType,
            start_line: f.startLine,
            end_line: f.endLine,
            code_diff: f.codeDiff,
          })),
        })),
      }));

      if (options.json) {
        console.log(JSON.stringify({
          query: text.slice(0, 200),
          matched_count: contexts.length,
          results,
        }, null, 2));
      } else {
        console.log(chalk.bold(`\n${contexts.length} spec${contexts.length !== 1 ? 's' : ''} matched:\n`));
        for (const r of results) {
          console.log(chalk.bold(r.title));
          for (const commit of r.commits) {
            console.log(`  ${chalk.yellow(commit.hash.slice(0, 7))} ${commit.message.split('\n', 1)[0] ?? ''}`);
            if (includeFragments && commit.fragments && commit.fragments.length > 0) {
              for (const fragment of commit.fragments.slice(0, profile.maxFragments || 3)) {
                console.log(chalk.dim(`    ${fragment.file_path}:${fragment.start_line}-${fragment.end_line} [${fragment.change_type}]`));
              }
            }
          }
          console.log();
        }
      }
    } catch (err) {
      error(`Match failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      try { db?.close(); } catch { /* best effort */ }
    }
  });

/**
 * homegraph spec find <filePath>
 */
specCommand
  .command('find <filePath>')
  .description('Find specs related to the given file path via code-fragment matching')
  .option('-p, --path <path>', 'Path to the repository')
  .option('-j, --json', 'Output as JSON')
  .action(async (filePath: string, options: {
    path?: string;
    json?: boolean;
  }) => {
    let db: import('../db/sqlite-adapter').SqliteDatabase | undefined;
    try {
      const repoPath = resolveSpecProjectPath(options.path);

      const { createDatabase } = await import('../db/sqlite-adapter');
      const { resolveDbPath } = await import('../spec/utils');
      const { findSpecsByFilePath } = await import('../spec/graph/queries');

      const dbPath = resolveDbPath(repoPath);

      if (!fs.existsSync(dbPath)) {
        error(`Database not found at ${dbPath}. Run 'homegraph spec build/mine' first.`);
        process.exit(1);
      }

      const created = createDatabase(dbPath);
      db = created.db;

      const result = findSpecsByFilePath(db, filePath);

      if (options.json) {
        console.log(JSON.stringify({
          filePath,
          matched_count: result.matched_count,
          truncated: result.truncated,
          results: result.results,
        }, null, 2));
      } else {
        console.log(chalk.bold(`\n${result.matched_count} spec${result.matched_count !== 1 ? 's' : ''} matched for ${filePath}:\n`));
        for (const r of result.results) {
          console.log(
            `  ${chalk.cyan(r.id.padEnd(16))} ${r.title.padEnd(32)} ${chalk.green(r.status.padEnd(12))} v${r.version}  ${chalk.dim(r.filePath)}`,
          );
        }
        console.log();
        if (result.truncated) {
          console.log(chalk.yellow(`  ... and more (showing first ${result.matched_count} of >${result.matched_count} results)`));
          console.log();
        }
        if (result.matched_count === 0) {
          info(`No specs found for file path "${filePath}". Try a partial path (e.g. "src/auth" instead of "src/auth/login.ts").`);
        }
      }
    } catch (err) {
      error(`Find failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      try { db?.close(); } catch { /* best effort */ }
    }
  });

/**
 * homegraph spec trace <symbol>
 */
specCommand
  .command('trace <symbol>')
  .description('Trace a code symbol back to its associated design Specs')
  .option('-f, --file <path>', 'File path for symbol disambiguation')
  .option('-l, --line <number>', 'Line number for symbol disambiguation')
  .option('-p, --path <path>', 'Path to the repository')
  .option('--top-k <number>', 'Number of results to return', '10')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: {
    file?: string;
    line?: string;
    path?: string;
    topK?: string;
    json?: boolean;
  }) => {
    let db: import('../db/sqlite-adapter').SqliteDatabase | undefined;
    let cg: import('../index').HomeGraph | undefined;
    try {
      const repoPath = resolveSpecProjectPath(options.path);
      // isNaN check so --line 0 is handled correctly (parseInt('0') → 0 is falsy)
      const lineRaw = options.line !== undefined ? parseInt(options.line, 10) : NaN;
      const line = isNaN(lineRaw) ? undefined : lineRaw;

      // Open HomeGraph code index
      const { default: HomeGraph } = await import('../index');
      cg = await HomeGraph.open(repoPath);

      // Inline symbol resolution (mirrors findSymbolMatches in tools.ts)
      const isQualified = /[.\/]|::/.test(symbol);
      const { isGeneratedFile } = await import('../extraction/generated-detection');
      let nodes: Array<{ name: string; qualifiedName: string; kind: string; filePath: string; startLine: number; endLine: number }> = [];

      if (!isQualified) {
        const exact = cg.getNodesByName(symbol);
        if (exact.length > 0) {
          nodes = [...exact].sort((a, b) => (isGeneratedFile(a.filePath) ? 1 : 0) - (isGeneratedFile(b.filePath) ? 1 : 0));
        } else {
          const fuzzy = cg.searchNodes(symbol, { limit: 10 });
          if (fuzzy[0]) nodes = [fuzzy[0].node];
        }
      } else {
        let results = cg.searchNodes(symbol, { limit: 50 });
        if (results.length === 0) {
          const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
          const tail = parts[parts.length - 1];
          if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
        }

        // Rough matchesSymbol equivalent for CLI
        const exactMatches = results.filter((r) => {
          const n = r.node;
          if (n.name === symbol) return true;
          const fileBase = n.filePath.split('/').pop()?.replace(/\.[^.]+$/, '');
          if (fileBase === symbol) return true;
          const parts = symbol.split(/::|[./]/);
          if (parts[parts.length - 1] === n.name) {
            const firstPart = parts[0]!;
            if (n.qualifiedName.includes(firstPart)) return true;
            if (n.filePath.includes(firstPart)) return true;
            return parts.length === 1;
          }
          return false;
        });

        if (exactMatches.length > 0) {
          nodes = exactMatches
            .sort((a, b) => (isGeneratedFile(a.node.filePath) ? 1 : 0) - (isGeneratedFile(b.node.filePath) ? 1 : 0))
            .map((r) => r.node);
        }
      }

      if (nodes.length === 0) {
        console.log(chalk.yellow(`No code entities found for symbol "${symbol}".`));
        return;
      }

      // Disambiguate
      if (options.file) {
        // Use endsWith for precise file name matching (not substring matching)
        const filePattern = options.file!;
        nodes = nodes.filter((n) => n.filePath.endsWith(filePattern));
      }
      if (line !== undefined && nodes.length > 1) {
        const closest = nodes.reduce((best, n) => {
          const bestDist = Math.abs(best.startLine - line!) + Math.abs(best.endLine - line!);
          const curDist = Math.abs(n.startLine - line!) + Math.abs(n.endLine - line!);
          return curDist < bestDist ? n : best;
        });
        nodes = [closest];
      }

      const node = nodes[0];
      if (!node) {
        console.log(chalk.yellow(`Could not resolve symbol "${symbol}" to a specific code entity.`));
        return;
      }
      // Open Spec database
      const { createDatabase } = await import('../db/sqlite-adapter');
      const { resolveDbPath } = await import('../spec/utils');
      const { findSpecsByCodeSymbol } = await import('../spec/graph/queries');
      const { initSpecSchema, runSpecMigrations, getCurrentSpecVersion, CURRENT_SPEC_SCHEMA_VERSION } = await import('../spec/db/schema');

      const dbPath = resolveDbPath(repoPath);
      if (!fs.existsSync(dbPath)) {
        console.log(chalk.yellow(`Database not found at ${dbPath}. Run 'homegraph spec build/mine' first.`));
        return;
      }

      const created = createDatabase(dbPath);
      db = created.db;

      initSpecSchema(db);
      const currentVersion = getCurrentSpecVersion(db);
      if (currentVersion < CURRENT_SPEC_SCHEMA_VERSION) {
        runSpecMigrations(db, currentVersion);
      }

      const topKRaw = parseInt(options.topK || '10', 10);
      const topK = Math.max(1, Math.min(isNaN(topKRaw) ? 10 : topKRaw, 50));

      console.log(chalk.dim(`Resolved: ${node.name} (${node.kind}) in ${node.filePath}:${node.startLine}-${node.endLine}`));

      const result = findSpecsByCodeSymbol(db, {
        name: node.name,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
      }, topK);

      if (options.json) {
        console.log(JSON.stringify({
          symbol,
          entity: {
            name: node.name,
            qualifiedName: node.qualifiedName,
            kind: node.kind,
            filePath: node.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
          },
          matched_count: result.matches.length,
          total_candidates: result.totalCandidates,
          matches: result.matches.map((m) => ({
            spec_id: m.spec.id,
            title: m.spec.title,
            status: m.spec.status,
            version: m.spec.version,
            file_path: m.spec.filePath,
            score: Math.round(m.score * 1000) / 1000,
            score_detail: {
              file_path: Math.round(m.scoreDetail.filePathScore * 1000) / 1000,
              content: Math.round(m.scoreDetail.contentScore * 1000) / 1000,
              name: Math.round(m.scoreDetail.nameScore * 1000) / 1000,
              recency: Math.round(m.scoreDetail.recencyScore * 1000) / 1000,
              line_overlap: Math.round(m.scoreDetail.overlapScore * 1000) / 1000,
            },
            fragment_count: m.fragmentCount,
            commit_count: m.commitCount,
          })),
        }, null, 2));
      } else {
        console.log(chalk.bold(`\n${result.matches.length} spec${result.matches.length !== 1 ? 's' : ''} matched (${result.totalCandidates} candidates):\n`));
        for (const m of result.matches) {
          const scoreColor = m.score >= 0.7 ? chalk.green : m.score >= 0.4 ? chalk.yellow : chalk.red;
          console.log(`  ${chalk.cyan(m.spec.id.padEnd(14))} ${m.spec.title.padEnd(36)} ${scoreColor((m.score * 100).toFixed(1) + '%')}`);
          console.log(chalk.dim(`    fp=${m.scoreDetail.filePathScore.toFixed(2)} content=${m.scoreDetail.contentScore.toFixed(2)} name=${m.scoreDetail.nameScore.toFixed(2)} recency=${m.scoreDetail.recencyScore.toFixed(2)} overlap=${m.scoreDetail.overlapScore.toFixed(2)}`));
          console.log();
        }
        if (result.matches.length === 0) {
          info(`No Specs found for symbol "${symbol}". Try a more specific file path or check that specs have been mined for this project.`);
        }
      }

    } catch (err) {
      error(`Trace failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      try { await cg?.close(); } catch { /* best effort */ }
      try { db?.close(); } catch { /* best effort */ }
    }
  });

/**
 * homegraph spec stats
 */
specCommand
  .command('stats')
  .description('Show statistics about the spec knowledge graph')
  .option('-p, --path <path>', 'Path to the repository')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    json?: boolean;
  }) => {
    let db: import('../db/sqlite-adapter').SqliteDatabase | undefined;
    try {
      const repoPath = resolveSpecProjectPath(options.path);

      const { createDatabase } = await import('../db/sqlite-adapter');
      const { resolveDbPath } = await import('../spec/utils');
      const { getSpecStats } = await import('../spec/graph/queries');

      const dbPath = resolveDbPath(repoPath);

      if (!fs.existsSync(dbPath)) {
        error(`Database not found at ${dbPath}. Run 'homegraph spec build/mine' first.`);
        process.exit(1);
      }

      const created = createDatabase(dbPath);
      db = created.db;

      const stats = getSpecStats(db);

      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(chalk.bold('\nSpec Knowledge Graph Stats\n'));
        console.log(`  Specs:       ${chalk.cyan(String(stats.specCount))}`);
        console.log(`    Active:     ${chalk.green(String(stats.activeSpecCount))}`);
        console.log(`    Deprecated: ${chalk.yellow(String(stats.deprecatedSpecCount))}`);
        console.log(`  Commits:     ${stats.commitCount}`);
        console.log(`  Fragments:   ${stats.fragmentCount}`);
        console.log(`  Relations:   ${stats.relationCount}`);
        console.log();
        if (stats.specCount === 0) {
          info("No specs yet. Run 'homegraph spec build/mine' to build the knowledge graph.");
        }
      }
    } catch (err) {
      error(`Stats failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      try { db?.close(); } catch { /* best effort */ }
    }
  });

/**
 * homegraph spec evolve
 */
const evolveCommand = specCommand
  .command('evolve')
  .description('Self-evolve specs after code changes');

/**
 * homegraph spec evolve install
 */
evolveCommand
  .command('install')
  .description('Install a git post-commit hook that triggers spec evolution')
  .option('-p, --path <path>', 'Path to the repository')
  .option('-f, --force', 'Overwrite existing hook without prompting')
  .option(
    '-t, --commit-threshold <n>',
    'Number of pending commits to accumulate before triggering evolve',
    (v: string) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1) {
        error('--commit-threshold must be a positive integer');
        process.exit(1);
      }
      return n;
    },
    3
  )
  .action(async (options: { path?: string; force?: boolean; commitThreshold?: number }) => {
    try {
      const repoPath = resolveSpecProjectPath(options.path);
      const commitThreshold = options.commitThreshold ?? 3;

      const { isGitRepo } = await import('../spec/git');

      if (!isGitRepo(repoPath)) {
        error(`Not a git repository: ${repoPath}`);
        process.exit(1);
      }

      const { execFileSync } = await import('child_process');

      // Resolve the absolute path to homegraph so the hook works
      // regardless of PATH (matching Python's shutil.which("c4s")).
      let homegraphBin: string;
      try {
        homegraphBin = execFileSync('command', ['-v', 'homegraph'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        homegraphBin = '';
      }

      if (!homegraphBin) {
        error(
          'homegraph command not found in PATH.\n' +
            '  Make sure homegraph is installed globally: npm install -g homegraph'
        );
        process.exit(1);
      }

      const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();

      const resolvedHooksDir = path.isAbsolute(hooksDir)
        ? hooksDir
        : path.resolve(repoPath, hooksDir);

      fs.mkdirSync(resolvedHooksDir, { recursive: true });

      const hookPath = path.join(resolvedHooksDir, 'post-commit');

      if (fs.existsSync(hookPath) && !options.force) {
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow('A post-commit hook already exists. Overwrite? (y/N) '),
            resolve
          );
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          info('Cancelled');
          return;
        }
      }

      // Ensure logs directory
      fs.mkdirSync(path.join(repoPath, SPEC_DATA_DIR, 'logs'), { recursive: true });

      // Marker constants matching the git-hooks pattern
      const MARKER_BEGIN = '# >>> homegraph spec evolve hook >>>';
      const MARKER_END = '# <<< homegraph spec evolve hook <<<';

      const hookBlock = [
        MARKER_BEGIN,
        '# Triggers spec self-evolution after N commits have accumulated.',
        '# Default threshold: 3 commits (configurable via --commit-threshold).',
        '# Installed by: homegraph spec evolve install',
        `# Logs: ${SPEC_DATA_DIR}/logs/evolve-hook.log`,
        '',
        `THRESHOLD=${commitThreshold}`,
        `LOGS_DIR="${SPEC_DATA_DIR}/logs"`,
        `META_FILE="${SPEC_DATA_DIR}/meta.json"`,
        '',
        '# Ensure logs directory exists',
        'mkdir -p "$LOGS_DIR"',
        '',
        '# Read currentCommitID from meta.json',
        'if [ -f "$META_FILE" ]; then',
        '  CURRENT=$(sed -n \'s/.*"currentCommitID"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$META_FILE")',
        'else',
        '  echo "[$(date -Iseconds)] meta.json not found — run \'homegraph spec build\' or \'homegraph spec mine\' first" \\',
        '      >> "$LOGS_DIR"/evolve-hook.log',
        '  exit 0',
        'fi',
        '',
        '# Count pending commits since last evolved commit',
        'if [ -z "$CURRENT" ] || ! git rev-parse --quiet --verify "$CURRENT^{commit}" >/dev/null 2>&1; then',
        '  # First run or anchor commit no longer exists — trigger immediately',
        '  PENDING=$THRESHOLD',
        'else',
        '  PENDING=$(git rev-list --count "${CURRENT}..HEAD" 2>/dev/null || echo 0)',
        'fi',
        '',
        'if [ "$PENDING" -lt "$THRESHOLD" ]; then',
        '  echo "[$(date -Iseconds)] Pending: $PENDING/$THRESHOLD — skipping" \\',
        '      >> "$LOGS_DIR"/evolve-hook.log',
        '  exit 0',
        'fi',
        '',
        '# Threshold reached — trigger evolution (async, non-blocking)',
        '# Runtime guard: skip if homegraph is not available',
        `HOMEGRAPH_BIN="${homegraphBin}"`,
        'if [ -x "$HOMEGRAPH_BIN" ] || command -v homegraph >/dev/null 2>&1; then',
        '  "${HOMEGRAPH_BIN:-homegraph}" spec evolve process --path "$(pwd)" --json \\',
        `      >> "$LOGS_DIR"/evolve-hook.log 2>&1 &`,
        'fi',
        MARKER_END,
      ].join('\n');

      let content: string;

      if (fs.existsSync(hookPath)) {
        // Strip any prior marker block, then re-append the current one
        const existing = fs.readFileSync(hookPath, 'utf8');
        const lines = existing.split('\n');
        const kept: string[] = [];
        let inBlock = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === MARKER_BEGIN) { inBlock = true; continue; }
          if (trimmed === MARKER_END) { inBlock = false; continue; }
          if (!inBlock) kept.push(line);
        }
        const base = kept.join('\n').replace(/\s*$/, '');
        content = base.length > 0
          ? `${base}\n\n${hookBlock}\n`
          : `#!/bin/sh\n${hookBlock}\n`;
      } else {
        content = `#!/bin/sh\n${hookBlock}\n`;
      }

      fs.writeFileSync(hookPath, content);
      fs.chmodSync(hookPath, 0o755);

      success(`Post-commit hook installed at ${hookPath}`);
      info(`Threshold: ${commitThreshold} commit(s) — evolution triggers when pending commits reach this count`);
      info(`Logs written to ${SPEC_DATA_DIR}/logs/evolve-hook.log`);
    } catch (err) {
      error(`Hook install failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph spec evolve uninstall
 */
evolveCommand
  .command('uninstall')
  .description('Remove the git post-commit hook installed by spec evolve')
  .option('-p, --path <path>', 'Path to the repository')
  .action(async (options: { path?: string }) => {
    try {
      const repoPath = resolveSpecProjectPath(options.path);

      const { isGitRepo } = await import('../spec/git');

      if (!isGitRepo(repoPath)) {
        error(`Not a git repository: ${repoPath}`);
        process.exit(1);
      }

      const { execFileSync } = await import('child_process');

      const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();

      const resolvedHooksDir = path.isAbsolute(hooksDir)
        ? hooksDir
        : path.resolve(repoPath, hooksDir);

      const hookPath = path.join(resolvedHooksDir, 'post-commit');

      if (!fs.existsSync(hookPath)) {
        info('No post-commit hook found — nothing to uninstall.');
        return;
      }

      const MARKER_BEGIN = '# >>> homegraph spec evolve hook >>>';
      const MARKER_END = '# <<< homegraph spec evolve hook <<<';

      const existing = fs.readFileSync(hookPath, 'utf8');
      const lines = existing.split('\n');
      const kept: string[] = [];
      let inBlock = false;
      let removedBlock = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === MARKER_BEGIN) { inBlock = true; removedBlock = true; continue; }
        if (trimmed === MARKER_END) { inBlock = false; continue; }
        if (!inBlock) kept.push(line);
      }

      if (!removedBlock) {
        info('No homegraph spec evolve hook block found — nothing to uninstall.');
        return;
      }

      const remaining = kept.join('\n').trim();

      if (remaining.length === 0 || /^#!\/bin\/sh\s*$/.test(remaining)) {
        // Hook only contained our block (or just a shebang) — delete entirely
        fs.unlinkSync(hookPath);
        success(`Removed post-commit hook at ${hookPath}`);
      } else {
        fs.writeFileSync(hookPath, remaining + '\n');
        success(`Removed spec evolve hook block from ${hookPath} (user content preserved)`);
      }
    } catch (err) {
      error(`Hook uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * homegraph spec evolve process
 */
evolveCommand
  .command('process')
  .description('Process commits through the spec self-evolve pipeline since last evolve')
  .option('-p, --path <path>', 'Path to the repository')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    json?: boolean;
  }) => {
    let db: import('../db/sqlite-adapter').SqliteDatabase | undefined;
    try {
      const repoPath = resolveSpecProjectPath(options.path);

      const { createDatabase } = await import('../db/sqlite-adapter');
      const { resolveDbPath } = await import('../spec/utils');
      const { initSpecSchema } = await import('../spec/db/schema');
      const { loadSpecConfig } = await import('../spec/config');
      const { runEvolvePipeline } = await import('../spec/evolve/pipeline');
      const { isGitRepo } = await import('../spec/git');

      if (!isGitRepo(repoPath)) {
        error(`Not a git repository: ${repoPath}`);
        process.exit(1);
      }

      const dbPath = resolveDbPath(repoPath);

      const created = createDatabase(dbPath);
      db = created.db;
      initSpecSchema(db);

      const config = loadSpecConfig(repoPath);
      const { resolveAgent } = await import('../spec/llm/agents');
      const codingAgent = resolveAgent();
      if (!config.llm && !codingAgent) {
        warn('No coding agent (Claude Code / Codex / DevEco Code) detected and LLM not configured — phase 3 (LLM-based spec evolution) will be skipped.');
        warn('Phase 1 (commit-spec graph construction) will still run.');
        warn('Configure LLM in .homegraph/commit4spec/configs.json for full functionality:\n' +
          '{\n' +
          '  "llm": {\n' +
          '    "provider":     "openai",          // * "openai" or "anthropic"\n' +
          '    "apiKey":       "sk-...",          // * API key string (plain text)\n' +
          '    "apiKeyEnv":   "OPENAI_API_KEY",   //   or read from env var (takes precedence)\n' +
          '    "model":        "gpt-4o",          // * model name\n' +
          '    "baseUrl":      "https://...",     //   custom endpoint\n' +
          '    "temperature":  0.2,               //   creativity control (default: 0.2)\n' +
          '    "maxTokens":    20000              //   max output tokens (default: 20000)\n' +
          '  }\n' +
          '}');
      } else if (!config.llm && codingAgent) {
        info(`Using ${codingAgent.displayName} (headless) for phase 3 spec evolution — no LLM configuration needed.`);
      } else if (config.llm && codingAgent) {
        info(`Using ${codingAgent.displayName} (headless) for phase 3 spec evolution — configured LLM is kept as fallback.`);
      }

      const result = await runEvolvePipeline(repoPath, db, config);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.commitsScanned === 0) {
          console.log(chalk.green('No new commits to evolve.'));
          console.log(`Last evolved commit: ${result.fromCommit ? result.fromCommit.slice(0, 7) : 'none'}`);
          console.log(`Current HEAD: ${result.toCommit.slice(0, 7)}`);
        } else {
          console.log(chalk.bold(`Evolve complete: ${result.commitsScanned} commit(s) processed`));
          console.log(`Evolved to: ${result.toCommit.slice(0, 7)}`);
          if (result.metaUpdated) {
            console.log(chalk.green(`meta.json updated (currentCommitID = ${result.toCommit.slice(0, 7)})`));
          } else if (result.phaseOneFailures > 0) {
            console.log(chalk.yellow(`⚠ meta.json NOT updated — ${result.phaseOneFailures} commit(s) failed`));
          } else if (result.phaseOneSkipped > 0) {
            console.log(chalk.yellow('⚠ meta.json NOT updated — all commits were skipped (no Path A match, no LLM)'));
          } else {
            console.log(chalk.yellow('⚠ meta.json NOT updated'));
          }

          // Show per-commit summary
          for (const r of result.perCommitResults) {
            let prefix: string;
            if (r.phaseOneSkipped) {
              prefix = chalk.yellow('  ⚠');
            } else {
              prefix = r.matched ? chalk.green('  ✓') : chalk.red('  ✗');
            }
            console.log(`${prefix} ${r.commitHash.slice(0, 7)}`);
            if (r.phaseOneSkipped) {
              console.log(`    skipped: ${r.phaseOneSkipReason}`);
            }
            if (r.matchedSpecId) {
              console.log(`    Path A - GENERATE ${r.matchedSpecId}`);
            }
            for (const ev of r.evolvedSpecs) {
              console.log(`    ${ev.specId}: ${ev.action}`);
            }
          }

          // Aggregate summary
          const totalFragments = result.perCommitResults.reduce((s, r) => s + r.fragmentsInserted, 0);
          const totalRelations = result.perCommitResults.reduce((s, r) => s + r.relationsCreated, 0);
          if (result.phaseOneSkipped > 0) {
            console.log(
              chalk.yellow(
                `${result.phaseOneSkipped} commit(s) skipped — no LLM configured, did not match Path A`,
              ),
            );
          }
          if (result.phaseOneFailures > 0) {
            console.log(
              chalk.red(
                `${result.phaseOneFailures} commit(s) failed — see details above`,
              ),
            );
          }
          console.log(`Summary: fragments=${totalFragments}, relations=${totalRelations}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('No meta.json found')) {
        error("No meta.json found. Run 'homegraph spec build/mine' first.");
      } else {
        error(`Evolve failed: ${message}`);
      }
      process.exit(1);
    } finally {
      try { db?.close(); } catch { /* best effort */ }
    }
  });

// =============================================================================
// Addon commands (HomeGraph addon management)
// =============================================================================
registerAddonCommands(program, { success, info, warn, error });

/**
 * homegraph index-api <input> [version]
 * Build a standalone OHOS API database from command-line-tools SDK.
 */
program
  .command('index-api <input> [version]')
  .description('Index OpenHarmony SDK API declarations into a standalone SQLite db')
  .option('-o, --output <path>', 'Output database path')
  .option('-q, --quiet', 'Suppress progress output')
  .action(async (input: string, versionArg: string | undefined, options: { output?: string; quiet?: boolean }) => {
    try {
      const { resolveOhosSdkInput, ohosApiDbFilename, indexOhosApiDb } = await import(
        '../extraction/languages/arkts'
      );

      const resolved = resolveOhosSdkInput({
        inputPath: input,
        versionOverride: versionArg,
      });

      const outputPath =
        options.output ?? path.join(process.cwd(), ohosApiDbFilename(resolved.version));

      if (!options.quiet) {
        info(`SDK home: ${resolved.sdkHome}`);
        info(`API version: ${resolved.version}`);
        info(`Output: ${outputPath}`);
      }

      const result = await indexOhosApiDb({
        sdkHome: resolved.sdkHome,
        version: resolved.version,
        outputPath,
        onProgress: options.quiet
          ? undefined
          : (progress) => {
              if (progress.phase === 'arkts-batch') {
                const label = progress.subphase === 'scene' ? 'Scene' : 'Persist';
                process.stdout.write(
                  `\r${label}: ${progress.current}/${progress.total} ${progress.currentFile ?? ''}`.padEnd(80)
                );
              }
            },
      });

      resolved.cleanup?.();

      if (!options.quiet) {
        process.stdout.write('\n');
        if (result.success) {
          info(
            `Indexed ${result.filesIndexed} SDK files → ${result.nodesCreated} nodes, ${result.edgesCreated} edges (${result.durationMs}ms)`
          );
        } else {
          error('OHOS API indexing failed');
          for (const err of result.errors.filter((e) => e.severity === 'error')) {
            error(err.message);
          }
        }
      }

      if (!result.success) {
        process.exit(1);
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * homegraph upgrade [version]
 *
 * Self-update for npm-global / npx / source installs. A leftover standalone
 * bundle install is detected and refused (guide the user to `npm i -g`).
 * See ../upgrade for detection and per-method upgrade logic.
 */
program
  .command('upgrade [version]')
  .description('Update HomeGraph to the latest release (or a specific version)')
  .option('--check', 'Check whether an update is available without installing')
  .option('-f, --force', 'Reinstall even if already on the target version')
  .action(async (versionArg: string | undefined, options: { check?: boolean; force?: boolean }) => {
    const up = await import('../upgrade');
    const method = up.detectInstallMethod({
      filename: __filename,
      platform: process.platform,
      cwd: process.cwd(),
    });
    const pin = versionArg || process.env.HOMEGRAPH_VERSION || undefined;
    const code = await up.runUpgrade(
      { version: pin, check: options.check, force: options.force },
      {
        currentVersion: packageJson.version,
        method,
        resolveLatest: () => up.resolveLatestVersion(),
        run: up.defaultRun,
        capture: up.defaultCapture,
        hasCommand: up.hasCommand,
        log: (m: string) => console.log(m),
        warn: (m: string) => warn(m),
        error: (m: string) => error(m),
        platform: process.platform,
      }
    );
    process.exit(code);
  });

/**
 * homegraph version
 *
 * The bare-noun form of `--version`. commander already provides `--version`
 * and `-V`, and the `-v` / `-version` spellings are intercepted before parse
 * (see top of main). This subcommand makes `homegraph version` work and lists
 * the version affordance in `homegraph --help`.
 */
program
  .command('version')
  .description('Print the installed HomeGraph version (also: -v, --version)')
  .action(() => {
    console.log(packageJson.version);
  });

// Parse and run
program.parse();

} // end main()
