/**
 * Cheap “is this root worth creating a HomeGraph index?” probe (Spec 0049).
 *
 * Used by MCP auto-init to avoid writing `.homegraph/` into empty workspaces
 * (e.g. DevEco Code task dirs before `devecocli create`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSourceFile } from '../extraction/grammars';
import { isHomeGraphDataDir } from '../directory';

const HARMONY_PROFILE = 'build-profile.json5';

/** Dirs skipped during the bounded source walk (names only). */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'oh_modules',
  '.git',
  '.hvigor',
  '.preview',
  '.cxx',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'Pods',
  'DerivedData',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.gradle',
  'obj',
]);

const DEFAULT_MAX_DIRS = 4000;
const DEFAULT_MAX_DEPTH = 8;

/**
 * True when `root` already looks like a project HomeGraph should index.
 * Short-circuits on root `build-profile.json5`, else bounded BFS for any
 * {@link isSourceFile} hit. Ignores `.homegraph*` and common build/vendor dirs.
 */
export function isIndexableRoot(
  rootDir: string,
  opts?: { maxDirs?: number; maxDepth?: number }
): boolean {
  const root = path.resolve(rootDir);
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;

  if (fs.existsSync(path.join(root, HARMONY_PROFILE))) return true;

  const maxDirs = opts?.maxDirs ?? DEFAULT_MAX_DIRS;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let dirsSeen = 0;

  while (queue.length > 0 && dirsSeen < maxDirs) {
    const { dir, depth } = queue.shift()!;
    dirsSeen += 1;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const name = ent.name;
      if (name === '.' || name === '..') continue;
      if (isHomeGraphDataDir(name) || SKIP_DIR_NAMES.has(name)) continue;

      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        if (depth + 1 <= maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (ent.isFile() && isSourceFile(full)) return true;
    }
  }

  return false;
}

/**
 * Parse `HOMEGRAPH_DEFER_PROBE_MS`. Default **60000**.
 * `0` disables the timer (tool-call kick only). Invalid → default.
 * Clamp: 0, or 1000ms … 10min.
 */
export function parseDeferProbeMs(raw: string | undefined): number {
  if (raw === undefined || !raw.trim()) return 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 60_000;
  if (n === 0) return 0;
  if (n < 1000 || n > 10 * 60 * 1000) return 60_000;
  return n;
}
