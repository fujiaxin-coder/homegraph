/**
 * Addon registry file I/O — read/write `${getHomeGraphDir(repoRoot)}/addons.json`.
 *
 * The registry is a small standalone file, deliberately separate from the
 * spec feature's `configs.json`, so the top-level `homegraph addon` command
 * never touches spec configuration. Writes are atomic (tmp file + rename).
 *
 * @module addons/registry
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../errors';
import { getHomeGraphDir } from '../directory';
import { AddonRegistry, AddonRegistryEntry } from './types';

/** Registry file name relative to the HomeGraph data dir. */
const REGISTRY_FILE = 'addons.json';

/** Absolute path of the registry file for a repository. */
export function registryFilePath(repoRoot: string): string {
  return path.join(getHomeGraphDir(repoRoot), REGISTRY_FILE);
}

function isValidEntry(value: unknown): value is AddonRegistryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    entry.name.length > 0 &&
    typeof entry.version === 'string' &&
    typeof entry.enabled === 'boolean'
  );
}

/**
 * Read the registry. A missing file yields an empty registry (the first
 * `install` may be the very first addon operation); a corrupt file is
 * ignored with a warning and treated as empty.
 */
export function readRegistry(repoRoot: string): AddonRegistry {
  const file = registryFilePath(repoRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { addons: [] };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value must be an object');
    }
    const rawAddons = (parsed as { addons?: unknown }).addons;
    if (!Array.isArray(rawAddons)) return { addons: [] };
    return { addons: rawAddons.filter(isValidEntry) };
  } catch (err) {
    logWarn(`Ignoring ${file}: not a valid addon registry`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return { addons: [] };
  }
}

/**
 * Atomically write the registry (tmp file + rename). Creates the HomeGraph
 * data directory if needed.
 */
export function writeRegistry(repoRoot: string, registry: AddonRegistry): void {
  const file = registryFilePath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * Insert or replace an entry by name (re-install updates version/enabled,
 * preserving the position).
 */
export function upsertEntry(repoRoot: string, entry: AddonRegistryEntry): void {
  const registry = readRegistry(repoRoot);
  const index = registry.addons.findIndex((e) => e.name === entry.name);
  if (index >= 0) {
    registry.addons[index] = entry;
  } else {
    registry.addons.push(entry);
  }
  writeRegistry(repoRoot, registry);
}

/**
 * Remove an entry by name. Returns `false` when the name was not registered.
 */
export function removeEntry(repoRoot: string, name: string): boolean {
  const registry = readRegistry(repoRoot);
  const next = registry.addons.filter((e) => e.name !== name);
  if (next.length === registry.addons.length) return false;
  writeRegistry(repoRoot, { addons: next });
  return true;
}

/**
 * Toggle the `enabled` flag of an entry. Returns `false` when the name was
 * not registered.
 */
export function setEntryEnabled(
  repoRoot: string,
  name: string,
  enabled: boolean,
): boolean {
  const registry = readRegistry(repoRoot);
  const entry = registry.addons.find((e) => e.name === name);
  if (!entry) return false;
  entry.enabled = enabled;
  writeRegistry(repoRoot, registry);
  return true;
}
