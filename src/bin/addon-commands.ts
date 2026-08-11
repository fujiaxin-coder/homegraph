/**
 * HomeGraph addon command group (`homegraph addon …`).
 *
 * Top-level (sibling of `spec`) because the addon store is repository-level
 * generic infrastructure, not spec-feature state: the registry lives in
 * `.homegraph/addons.json`, separate from the spec feature's configs.json.
 *
 * Repo resolution walks up to the git work-tree root (`git rev-parse
 * --show-toplevel`), falling back to the given path itself when not inside
 * a git repo — the same "fall back to start path" behavior as
 * `resolveSpecProjectPath`.
 *
 * @module bin/addon-commands
 */

import { Command } from 'commander';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { importESM } from '../addons/dynamic-import';

/** Minimal logger surface — injected by the CLI so homegraph.ts owns styling. */
export interface AddonLog {
  success(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** npm package name validation (scoped or unscoped, lower-case per npm rules). */
const PKG_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Resolve the repository root for addon operations: the git work-tree root
 * containing `startPath`, or `startPath` itself when not inside a repo.
 */
function resolveAddonRoot(startPath: string): string {
  const resolved = path.resolve(startPath);
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolved,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (topLevel) return topLevel;
  } catch {
    // Not a git work tree — use the path as-is.
  }
  return resolved;
}

async function confirm(
  _log: AddonLog,
  message: string,
  yes: boolean,
): Promise<boolean> {
  if (yes || !process.stdin.isTTY) return true;
  const clack = (await importESM('@clack/prompts')) as typeof import('@clack/prompts');
  const answer = await clack.confirm({ message });
  return answer === true;
}

/**
 * Register the `addon` command group on the top-level program.
 */
export function registerAddonCommands(program: Command, log: AddonLog): void {
  const addonCommand = program
    .command('addon')
    .description('Manage HomeGraph addons (plugins that enrich spec-mine prompts)');

  addonCommand
    .command('init <name>')
    .description('Scaffold a new addon package')
    .option('--path <dir>', 'Directory to create the addon in', '.')
    .option('--lang <js|ts>', 'Scaffold language (js is published as-is; ts builds to dist/)', 'js')
    .action(async (name: string, options: { path?: string; lang?: string }) => {
      try {
        if (!PKG_NAME_RE.test(name)) {
          log.error(`Invalid addon package name: "${name}"`);
          process.exit(1);
        }
        const lang = options.lang === 'ts' ? 'ts' : 'js';
        const parentDir = path.resolve(options.path || '.');
        const { createAddonScaffold } = await import('../addons/init-template');
        const created = createAddonScaffold(name, parentDir, lang);
        log.success(`Addon scaffold created at ${path.join(parentDir, name)}`);
        log.info(`Created: ${created.map((f) => path.basename(f)).join(', ')}`);
        if (lang === 'ts') {
          log.info('TypeScript scaffold: cd into it, run "npm i -D homegraph" then "npm run build".');
        }
        log.info('Implement enrich() (see examples/jira.mjs), then install with:');
        log.info(`  homegraph addon install ${path.join(parentDir, name)}`);
      } catch (err) {
        log.error(`Scaffold failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  addonCommand
    .command('install <pkg>')
    .description('Install an addon package and register it for runtime loading')
    .option('-p, --path <path>', 'Repository root')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--no-enable', 'Install but do not enable (enable later with "addon enable")')
    .action(async (pkg: string, options: { path?: string; yes?: boolean; enable?: boolean }) => {
      try {
        const repoRoot = resolveAddonRoot(options.path || process.cwd());
        const { resolvePackageName, installAddon } = await import('../addons/manager');
        const { readRegistry } = await import('../addons/registry');

        const preResolvedName = resolvePackageName(pkg);
        const isUpdate = preResolvedName
          ? readRegistry(repoRoot).addons.some((e) => e.name === preResolvedName)
          : false;

        if (!isUpdate) {
          const ok = await confirm(
            log,
            `Install addon "${pkg}" and register it for this repository?`,
            !!options.yes,
          );
          if (!ok) process.exit(1);
        }

        const result = await installAddon(repoRoot, pkg, {
          enable: options.enable !== false,
          name: preResolvedName ?? undefined,
        });
        log.success(
          `${isUpdate ? 'Updated' : 'Installed'} ${result.name}@${result.version}` +
            ` (${options.enable !== false ? 'enabled' : 'disabled'})`,
        );
        log.info(`Registry: .homegraph/addons.json — loaded by the next "spec mine" run.`);
      } catch (err) {
        log.error(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  addonCommand
    .command('list')
    .description('List registered addons')
    .option('-p, --path <path>', 'Repository root')
    .action(async (options: { path?: string }) => {
      const repoRoot = resolveAddonRoot(options.path || process.cwd());
      const { listAddons } = await import('../addons/manager');
      const addons = listAddons(repoRoot);
      if (addons.length === 0) {
        log.info('No addons registered. Install one with: homegraph addon install <pkg>');
        return;
      }
      log.info('NAME  VERSION  ENABLED  STATUS');
      for (const addon of addons) {
        log.info(
          `${addon.name.padEnd(30)} ${addon.version.padEnd(8)} ` +
            `${(addon.enabled ? 'yes' : 'no').padEnd(5)} ${addon.installed ? 'installed' : 'missing'}`,
        );
      }
    });

  addonCommand
    .command('remove <name>')
    .description('Unregister an addon (use --purge to also delete its files)')
    .option('-p, --path <path>', 'Repository root')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--purge', 'Also delete the installed files')
    .action(async (name: string, options: { path?: string; yes?: boolean; purge?: boolean }) => {
      try {
        const repoRoot = resolveAddonRoot(options.path || process.cwd());
        const { readRegistry } = await import('../addons/registry');
        const { removeAddon } = await import('../addons/manager');

        const entry = readRegistry(repoRoot).addons.find((e) => e.name === name);
        if (!entry) {
          log.error(`Addon not registered: ${name}`);
          log.info('Run "homegraph addon list" to see registered addons.');
          process.exit(1);
        }

        if (entry.enabled) {
          const ok = await confirm(
            log,
            `Remove enabled addon ${name}@${entry.version}?`,
            !!options.yes,
          );
          if (!ok) process.exit(1);
        }

        if (removeAddon(repoRoot, name, { purge: !!options.purge })) {
          log.success(`Removed ${name}${options.purge ? ' (files purged)' : ''}`);
        }
      } catch (err) {
        log.error(`Remove failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  addonCommand
    .command('enable <name>')
    .description('Enable a registered addon')
    .option('-p, --path <path>', 'Repository root')
    .action(async (name: string, options: { path?: string }) => {
      const repoRoot = resolveAddonRoot(options.path || process.cwd());
      const { setEntryEnabled } = await import('../addons/registry');
      if (!setEntryEnabled(repoRoot, name, true)) {
        log.error(`Addon not registered: ${name}`);
        process.exit(1);
      }
      log.success(`Enabled ${name}`);
    });

  addonCommand
    .command('disable <name>')
    .description('Disable a registered addon (keep it installed)')
    .option('-p, --path <path>', 'Repository root')
    .action(async (name: string, options: { path?: string }) => {
      const repoRoot = resolveAddonRoot(options.path || process.cwd());
      const { setEntryEnabled } = await import('../addons/registry');
      if (!setEntryEnabled(repoRoot, name, false)) {
        log.error(`Addon not registered: ${name}`);
        process.exit(1);
      }
      log.success(`Disabled ${name}`);
    });

  addonCommand
    .command('update [name]')
    .description('Update registered addon(s) — default: latest within the recorded range; --latest: newest published version')
    .option('-p, --path <path>', 'Repository root')
    .option('-l, --latest', 'Update to the newest published version (registry packages only)')
    .action(async (name: string | undefined, options: { path?: string; latest?: boolean }) => {
      try {
        const repoRoot = resolveAddonRoot(options.path || process.cwd());
        const { updateAddon } = await import('../addons/manager');
        const results = await updateAddon(repoRoot, name, { latest: !!options.latest });
        const changed = results.filter((r) => r.from !== r.to);
        const unchanged = results.filter((r) => r.from === r.to);
        if (changed.length > 0) {
          log.success(
            `Updated: ${changed.map((r) => `${r.name}@${r.from} -> ${r.to}`).join(', ')}`,
          );
        }
        if (unchanged.length > 0) {
          log.info(
            `Already up to date: ${unchanged.map((r) => `${r.name}@${r.to}`).join(', ')}`,
          );
        }
        if (changed.length === 0 && unchanged.length === 0) {
          log.info(name ? `No update performed for ${name}` : 'No registered addons to update.');
        }
      } catch (err) {
        log.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
