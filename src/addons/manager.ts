/**
 * Addon install management (npm as the install engine).
 *
 * `npm install --prefix <addonsRoot>` handles all package mechanics —
 * resolution, integrity, transitive dependencies, local paths, git URLs —
 * so HomeGraph never reimplements package resolution. The registry records
 * the concrete resolved version (never the requested range) to prevent
 * silent drift.
 *
 * Version policy (v1 of the addon format):
 * - **No silent downgrades.** Re-installing a name that is already
 *   registered compares the target version against the installed one and
 *   refuses anything older — the user must `remove` first.
 * - **Upgrades preserve the previous version.** The installed package
 *   directory is renamed aside to a rollback backup before npm runs; a
 *   failed install/validation restores it, so a bad upgrade can never
 *   leave the store without the previous working copy.
 *
 * Both policies apply to registry packages and local-path packages alike
 * (a local-path "package" is a symlink npm manages; rename/restore is
 * symmetric). The one carve-out is the name-resolution fallback path
 * (git URLs etc., where the package name is only known *after* npm runs) —
 * it cannot gate or back up in advance.
 *
 * @module addons/manager
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { logWarn } from '../errors';
import { addonsRootDir, addonPkgDir } from './paths';
import { readRegistry, upsertEntry, removeEntry } from './registry';
import { validateAddonPackage } from './validate';
import { compareSemver } from './semver';
import { npmInvocation } from '../upgrade/index';
import { AddonRegistryEntry } from './types';

/** Result of a successful install. */
export interface InstallResult {
  name: string;
  version: string;
}

/** Options for `installAddon`. */
export interface InstallOptions {
  /** Whether the new entry starts enabled (default true). */
  enable: boolean;
  /** Pre-resolved package name (from `npm view`/local package.json). */
  name?: string;
}

/**
 * Run npm with the given arguments.
 *
 * On Windows `npm.cmd` cannot be spawned directly — CreateProcess rejects
 * `.cmd` files with EINVAL (since the CVE-2024-27980 hardening) — and
 * routing through cmd.exe re-quotes the command line, breaking arguments
 * that contain spaces (e.g. a repository path under a username with
 * spaces). Instead run npm's CLI entry with node.exe, which passes the
 * argument array through verbatim; falls back to the cmd.exe invocation
 * used by the upgrade path when npm-cli.js is absent.
 */
function runNpm(args: string[]): string {
  if (process.platform === 'win32') {
    const npmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    const { cmd, args: cmdArgs } = fs.existsSync(npmCli)
      ? { cmd: process.execPath, args: [npmCli, ...args] }
      : npmInvocation(process.platform, args);
    return execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Package identity + install source, resolved from an install spec. */
export interface PackageInfo {
  name: string;
  source: 'registry' | 'local';
}

/** Whether an install spec points at a local path (dir or tarball). */
export function isLocalPathSpec(spec: string): boolean {
  return (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    path.isAbsolute(spec) || // POSIX '/…' and Windows drive/UNC absolute paths
    spec.startsWith('file:')
  );
}

/**
 * Resolve the npm package name and install source for an install spec, or
 * `null` when neither a local package.json nor `npm view` yields a name.
 *
 * - Local paths (`./x`, `../x`, absolute, `file:`) → read package.json.
 * - Everything else (names, scoped names, ranges, dist-tags) → `npm view`.
 */
export function resolvePackageInfo(pkgSpec: string): PackageInfo | null {
  const spec = pkgSpec.trim();

  if (isLocalPathSpec(spec)) {
    const dir = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(path.resolve(dir), 'package.json'), 'utf-8'),
      ) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        return { name: pkg.name, source: 'local' };
      }
    } catch {
      // Fall through to npm view for the error path.
    }
  }

  try {
    const out = runNpm(['view', spec, 'name', '--json']);
    const parsed: unknown = JSON.parse(out.trim());
    if (typeof parsed === 'string' && parsed.length > 0) {
      return { name: parsed, source: 'registry' };
    }
  } catch {
    return null;
  }
  return null;
}

/** Package name only — compatibility shim over {@link resolvePackageInfo}. */
export function resolvePackageName(pkgSpec: string): string | null {
  return resolvePackageInfo(pkgSpec)?.name ?? null;
}

/**
 * Resolve the concrete version an install spec would install, used by the
 * version gate BEFORE npm touches the store. Local specs read package.json
 * (a missing version resolves to `'0.0.0'` — the same fallback
 * `validateAddonPackage` uses, so a versionless package is a genuine
 * downgrade target and correctly refused). Registry specs ask npm
 * (`npm view <spec> version` — bare specs resolve to the dist-tag).
 *
 * Returns `null` when a registry lookup fails (offline / unknown package):
 * the gate is then SKIPPED — unknown data never refuses an install, and npm
 * itself reports resolution errors.
 */
function resolveTargetVersion(
  pkgSpec: string,
  source: 'registry' | 'local',
): string | null {
  if (source === 'local') {
    const spec = pkgSpec.trim();
    const dir = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(path.resolve(dir), 'package.json'), 'utf-8'),
      ) as { version?: unknown };
      return typeof pkg.version === 'string' && pkg.version.length > 0
        ? pkg.version
        : '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
  try {
    const out = runNpm(['view', pkgSpec.trim(), 'version', '--json']);
    const parsed: unknown = JSON.parse(out.trim());
    if (typeof parsed === 'string' && parsed.length > 0) return parsed;
  } catch {
    // fall through
  }
  return null;
}

/**
 * List top-level packages currently installed in the addons store
 * (`node_modules` one level deep, scoped packages two levels).
 */
function listTopLevelPackages(addonsRoot: string): Set<string> {
  const out = new Set<string>();
  const nodeModules = path.join(addonsRoot, 'node_modules');
  if (!fs.existsSync(nodeModules)) return out;

  for (const entry of fs.readdirSync(nodeModules)) {
    if (entry.startsWith('@')) {
      const scopedDir = path.join(nodeModules, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(scopedDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const sub of fs.readdirSync(scopedDir)) {
        out.add(`${entry}/${sub}`);
      }
    } else {
      out.add(entry);
    }
  }
  return out;
}

/**
 * Preserve an installed package before an upgrade by renaming it out of
 * `node_modules`. Returns the rollback backup root, or `null` when the
 * package directory is absent (nothing to preserve).
 *
 * Works for real directories and symlinks alike (npm links local-path
 * packages); the backup lives next to `node_modules` on the same filesystem,
 * so `renameSync` never crosses a mount boundary. On Windows the rename
 * target does not exist at call time, which is the case `renameSync` allows.
 */
function backupAddonPackage(addonsRoot: string, name: string): string | null {
  const src = path.join(addonsRoot, 'node_modules', name);
  if (!fs.existsSync(src)) return null;

  const backup = path.join(
    addonsRoot,
    `.rollback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(backup, { recursive: true });
  fs.renameSync(src, path.join(backup, path.basename(name)));
  return backup;
}

/**
 * Restore a backed-up package after a failed upgrade. Removes whatever
 * partial install npm left behind first (no-op when absent), then renames
 * the backup back. Failures here are warnings — the registry entry is never
 * touched by the caller, so the record keeps pointing at the previous
 * version even if the files cannot be recovered.
 */
function restoreAddonPackage(
  addonsRoot: string,
  name: string,
  backup: string | null,
): void {
  if (!backup) return;
  const dest = path.join(addonsRoot, 'node_modules', name);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(path.join(backup, path.basename(name)), dest);
    // The package moved back out; the backup dir is empty now.
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    // On failure the backup keeps its contents — leave it for manual recovery.
    logWarn(`Failed to restore addon ${name} from backup`, {
      backup,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Delete a rollback backup after a successful upgrade (best effort). */
function cleanupBackup(backup: string | null): void {
  if (!backup) return;
  try {
    fs.rmSync(backup, { recursive: true, force: true });
  } catch {
    // Best effort — stale backups are inert and named per-attempt.
  }
}

/**
 * Install an addon package and register it.
 *
 * Throws on failure (npm error, invalid addon, unresolvable name, or a
 * downgrade attempt against an installed version). The registry is written
 * only after validation succeeds. When re-installing an existing name
 * (upgrade), the previous files are preserved and restored on failure.
 */
export async function installAddon(
  repoRoot: string,
  pkgSpec: string,
  options: InstallOptions,
): Promise<InstallResult> {
  const addonsRoot = addonsRootDir(repoRoot);
  fs.mkdirSync(addonsRoot, { recursive: true });

  // Resolve identity + source from the spec. The CLI pre-resolves the name
  // (npm view / local package.json) and passes it via options.name to skip a
  // second resolution — but it must never override the SOURCE: a local-path
  // spec stays 'local' even when the name was pre-resolved, otherwise
  // `update --latest` would wrongly apply to a local-path addon.
  let info = resolvePackageInfo(pkgSpec);
  if (options.name) {
    info = { name: options.name, source: info?.source ?? 'registry' };
  }
  let name = info?.name ?? null;
  let source: 'registry' | 'local' = info?.source ?? 'registry';
  let backup: string | null = null;

  if (!name) {
    // Last resort (git URLs, tarballs without a resolvable name): install
    // first, then diff node_modules. Cannot gate or back up in advance.
    const before = listTopLevelPackages(addonsRoot);
    runNpm(['install', '--prefix', addonsRoot, '--no-audit', '--no-fund', pkgSpec]);
    const added = [...listTopLevelPackages(addonsRoot)].filter((p) => !before.has(p));
    if (added.length !== 1) {
      throw new Error(
        `Cannot resolve the installed package name for "${pkgSpec}" ` +
          `(${added.length} new package(s) detected). Install by name or a local path.`,
      );
    }
    name = added[0]!;
    source = 'registry';
  } else {
    // Version gate + upgrade backup, both before npm touches the store.
    const installed = readRegistry(repoRoot).addons.find((e) => e.name === name);
    if (installed) {
      const target = resolveTargetVersion(pkgSpec, source);
      // `null` = version could not be resolved (offline / unknown package):
      // skip the gate — unknown data never refuses an install.
      if (target !== null && compareSemver(target, installed.version) < 0) {
        throw new Error(
          `${name}@${target} is older than the installed ${name}@${installed.version} — ` +
            `remove it first ("homegraph addon remove ${name}") then install the older version`,
        );
      }
      backup = backupAddonPackage(addonsRoot, name);
    }
    try {
      runNpm(['install', '--prefix', addonsRoot, '--no-audit', '--no-fund', pkgSpec]);
    } catch (err) {
      restoreAddonPackage(addonsRoot, name, backup);
      throw err;
    }
  }

  const pkgDir = addonPkgDir(repoRoot, name);
  const validation = await validateAddonPackage(pkgDir);
  if (!validation.ok) {
    restoreAddonPackage(addonsRoot, name, backup);
    if (!backup) {
      // Fresh install with nothing to restore — uninstall the leftovers so
      // nothing half-installed lingers.
      try {
        runNpm(['uninstall', '--prefix', addonsRoot, '--no-audit', '--no-fund', name]);
      } catch {
        // Best effort — unregistered leftovers are inert (never loaded).
      }
    }
    throw new Error(`Installed package is not a valid HomeGraph addon: ${validation.reason}`);
  }

  cleanupBackup(backup);
  const version = validation.version!;
  upsertEntry(repoRoot, { name, version, enabled: options.enable, source });
  return { name, version };
}

/**
 * Unregister an addon, optionally deleting its files. Returns `false` when
 * the name was not registered.
 */
export function removeAddon(
  repoRoot: string,
  name: string,
  options: { purge: boolean },
): boolean {
  const removed = removeEntry(repoRoot, name);
  if (!removed) return false;

  if (options.purge) {
    try {
      runNpm(['uninstall', '--prefix', addonsRootDir(repoRoot), '--no-audit', '--no-fund', name]);
    } catch (err) {
      logWarn(`Failed to purge addon files for ${name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return true;
}

/**
 * List registered addons with their on-disk status (installed vs missing).
 */
export function listAddons(
  repoRoot: string,
): Array<AddonRegistryEntry & { installed: boolean }> {
  const registry = readRegistry(repoRoot);
  return registry.addons.map((entry) => ({
    ...entry,
    installed: fs.existsSync(
      path.join(addonPkgDir(repoRoot, entry.name), 'package.json'),
    ),
  }));
}

/** Options for `updateAddon`. */
export interface UpdateOptions {
  /**
   * Force the newest published version (`<name>@latest`, the registry
   * dist-tag) instead of the recorded range. Registry-package entries only —
   * local-path entries have no dist-tag and are rejected.
   */
  latest?: boolean;
}

/** Result of updating a single addon (`from === to` means no change). */
export interface UpdateResult {
  name: string;
  from: string;
  to: string;
}

/** npm spec for an update: bare name follows the recorded range, `@latest` forces the dist-tag. */
export function resolveUpdateSpec(name: string, latest: boolean): string {
  return latest ? `${name}@latest` : name;
}

/**
 * Update registered addon(s) to the latest version within the configured
 * range (re-running `npm install` on the registered name, then recording the
 * newly resolved version). Each update preserves the previous files and
 * restores them on failure, so a bad upgrade never loses the working copy.
 *
 * Returns the names+versions that were updated; entries whose validation
 * failed after install are logged and skipped (previous version kept).
 */
export async function updateAddon(
  repoRoot: string,
  name?: string,
  options: UpdateOptions = {},
): Promise<UpdateResult[]> {
  const registry = readRegistry(repoRoot);
  const targets = name
    ? registry.addons.filter((e) => e.name === name)
    : registry.addons;

  if (name && targets.length === 0) {
    throw new Error(`Addon not registered: ${name}`);
  }
  if (targets.length === 0) return [];

  const addonsRoot = addonsRootDir(repoRoot);
  fs.mkdirSync(addonsRoot, { recursive: true });

  const updated: UpdateResult[] = [];
  for (const entry of targets) {
    if (options.latest && entry.source !== 'registry') {
      throw new Error(
        `${entry.name} was installed from a local path — ` +
          `"update --latest" applies to registry packages only`,
      );
    }

    const backup = backupAddonPackage(addonsRoot, entry.name);
    const spec = resolveUpdateSpec(entry.name, !!options.latest);
    try {
      runNpm(['install', '--prefix', addonsRoot, '--no-audit', '--no-fund', spec]);
    } catch (err) {
      restoreAddonPackage(addonsRoot, entry.name, backup);
      throw err;
    }

    const validation = await validateAddonPackage(addonPkgDir(repoRoot, entry.name));
    if (!validation.ok) {
      restoreAddonPackage(addonsRoot, entry.name, backup);
      logWarn(`Addon ${entry.name} failed validation after update — keeping previous version`, {
        reason: validation.reason,
      });
      continue;
    }

    cleanupBackup(backup);
    const to = validation.version ?? entry.version;
    upsertEntry(repoRoot, { ...entry, version: to });
    updated.push({ name: entry.name, from: entry.version, to });
  }
  return updated;
}
