/**
 * Fast project map — module boundaries + source-file inventory (no symbols/edges).
 *
 * Used by MCP auto-init (seconds-scale) and `homegraph_project` so agents get an
 * engineering overview before the full index finishes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { scanDirectory } from '../extraction';
import { detectLanguage, isHarmonyRouteProfileJson } from '../extraction/grammars';
import {
  listHarmonyProjectModules,
} from '../extraction/languages/arkts';
import { loadExtensionOverrides } from '../project-config';
import { loadWorkspacePackages } from '../resolution/workspace-packages';

export type BuildPhase = 'none' | 'building_fast' | 'fast' | 'indexing' | 'full';

export interface ProjectModuleDraft {
  id: string;
  name: string;
  /** Project-relative POSIX path; empty string = project root catch-all. */
  rootPath: string;
  kind: string;
}

export interface ProjectModuleFileDraft {
  moduleId: string;
  path: string;
  language: string;
}

export interface BuiltProjectMap {
  modules: Array<ProjectModuleDraft & { fileCount: number }>;
  files: ProjectModuleFileDraft[];
  durationMs: number;
}

const ROOT_MODULE_ID = '__root__';

const OHPM_MANIFEST = 'oh-package.json5';
const OHPM_WALK_MAX_DEPTH = 6;
const OHPM_WALK_DIR_BUDGET = 8000;
const OHPM_SKIP_DIRS = new Set([
  'node_modules',
  'oh_modules',
  '.git',
  '.homegraph',
  '.hvigor',
  '.preview',
  'build',
  'dist',
  'out',
]);

/**
 * Discover modules + assign every indexable source file to the longest-matching
 * module root. Prefer Harmony `build-profile.json5` modules when present.
 */
export function buildProjectMapScan(projectRoot: string): BuiltProjectMap {
  const t0 = Date.now();
  const resolved = path.resolve(projectRoot);
  const modules = discoverModules(resolved);
  const overrides = loadExtensionOverrides(resolved);
  const filesRel = scanDirectory(resolved);
  const fileRows: ProjectModuleFileDraft[] = [];
  const counts = new Map<string, number>();

  for (const rel of filesRel) {
    const mod = assignModule(rel, modules);
    const language = detectLanguage(rel, undefined, overrides);
    fileRows.push({ moduleId: mod.id, path: rel, language });
    counts.set(mod.id, (counts.get(mod.id) ?? 0) + 1);
  }

  return {
    modules: modules.map((m) => ({
      ...m,
      fileCount: counts.get(m.id) ?? 0,
    })),
    files: fileRows,
    durationMs: Date.now() - t0,
  };
}

function discoverModules(projectRoot: string): ProjectModuleDraft[] {
  const byId = new Map<string, ProjectModuleDraft>();

  const ensure = (draft: ProjectModuleDraft): void => {
    if (!byId.has(draft.id)) byId.set(draft.id, draft);
  };

  // Always have a root catch-all for files outside named modules.
  ensure({
    id: ROOT_MODULE_ID,
    name: path.basename(projectRoot) || 'root',
    rootPath: '',
    kind: 'root',
  });

  // Same parser as ArkTS dirty-module mapping (Spec 0034): bare keys + single quotes.
  const harmony = listHarmonyProjectModules(projectRoot);
  if (harmony.length > 0) {
    for (const m of harmony) {
      ensure({
        id: moduleIdForPath(m.srcPath),
        name: m.name,
        rootPath: m.srcPath,
        kind: 'harmony',
      });
    }
    return [...byId.values()];
  }

  for (const m of discoverOhpmPackages(projectRoot)) {
    ensure(m);
  }

  const ws = loadWorkspacePackages(projectRoot);
  if (ws) {
    for (const [name, dir] of ws.byName) {
      const rootPath = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
      ensure({
        id: moduleIdForPath(rootPath),
        name,
        rootPath,
        kind: 'workspace',
      });
    }
  }

  return [...byId.values()];
}

function discoverOhpmPackages(projectRoot: string): ProjectModuleDraft[] {
  const out: ProjectModuleDraft[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!;
    if (++visited > OHPM_WALK_DIR_BUDGET) break;
    const abs = path.join(projectRoot, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth >= OHPM_WALK_MAX_DEPTH) continue;
        if (e.name.startsWith('.') || OHPM_SKIP_DIRS.has(e.name)) continue;
        queue.push({ rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 });
        continue;
      }
      if (e.name !== OHPM_MANIFEST) continue;
      const pkgName = readOhpmName(path.join(abs, e.name));
      const rootPath = rel.replace(/\\/g, '/');
      // Skip the synthetic root duplicate when root itself has oh-package.json5 —
      // root catch-all already covers it; named modules are subdirs.
      if (!rootPath) continue;
      out.push({
        id: moduleIdForPath(rootPath),
        name: pkgName || path.basename(rootPath),
        rootPath,
        kind: 'ohpm',
      });
    }
  }
  return out;
}

function readOhpmName(manifestAbs: string): string | null {
  try {
    const text = fs.readFileSync(manifestAbs, 'utf-8');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const parsed = require('jsonc-parser').parse(text) as { name?: unknown } | null;
      if (typeof parsed?.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    } catch {
      /* regex */
    }
    const m =
      text.match(/["']name["']\s*:\s*["']([^"']+)["']/) ||
      text.match(/name\s*:\s*["']([^"']+)["']/);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function moduleIdForPath(rootPath: string): string {
  if (!rootPath) return ROOT_MODULE_ID;
  // Stable, path-based id (filesystem-safe).
  return rootPath.replace(/[^a-zA-Z0-9._/-]/g, '_');
}

function assignModule(fileRel: string, modules: ProjectModuleDraft[]): ProjectModuleDraft {
  const file = fileRel.replace(/\\/g, '/');
  let best: ProjectModuleDraft | null = null;
  for (const m of modules) {
    if (!m.rootPath) continue; // root catch-all last
    if (file === m.rootPath || file.startsWith(`${m.rootPath}/`)) {
      if (!best || m.rootPath.length > best.rootPath.length) best = m;
    }
  }
  if (best) return best;
  return modules.find((m) => m.id === ROOT_MODULE_ID) ?? modules[0]!;
}

export function parseBuildPhase(raw: string | null | undefined): BuildPhase | null {
  if (
    raw === 'none' ||
    raw === 'building_fast' ||
    raw === 'fast' ||
    raw === 'indexing' ||
    raw === 'full'
  ) {
    return raw;
  }
  return null;
}

const SKELETON_SKIP_DIRS = new Set([
  'node_modules',
  'oh_modules',
  '.git',
  '.homegraph',
  '.hvigor',
  '.preview',
  'build',
  'dist',
  'out',
  '.cxx',
]);

const ROUTE_PROFILE_WALK_MAX_DEPTH = 8;
const ROUTE_PROFILE_DIR_BUDGET = 400;
const ROUTE_PROFILE_CAP_PER_MODULE = 8;

/**
 * Spec 0040 — optional bundleName/name from app.json5 (AppScope or root).
 * Best-effort; returns null on missing/parse failure.
 */
export function readHarmonyAppBundleName(projectRoot: string): string | null {
  for (const rel of ['AppScope/app.json5', 'app.json5']) {
    const abs = path.join(projectRoot, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const text = fs.readFileSync(abs, 'utf-8');
      let bundle: string | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const parsed = require('jsonc-parser').parse(text) as {
          app?: { bundleName?: unknown };
          bundleName?: unknown;
          name?: unknown;
        } | null;
        if (parsed?.app && typeof parsed.app.bundleName === 'string' && parsed.app.bundleName.trim()) {
          bundle = parsed.app.bundleName.trim();
        } else if (typeof parsed?.bundleName === 'string' && parsed.bundleName.trim()) {
          bundle = parsed.bundleName.trim();
        } else if (typeof parsed?.name === 'string' && parsed.name.trim()) {
          bundle = parsed.name.trim();
        }
      } catch {
        /* regex fallback below */
      }
      if (!bundle) {
        const m =
          text.match(/["']bundleName["']\s*:\s*["']([^"']+)["']/) ||
          text.match(/bundleName\s*:\s*["']([^"']+)["']/);
        if (m?.[1]) bundle = m[1];
      }
      if (bundle) return bundle;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Spec 0040 — project-relative paths to Spec 0039 route profile JSON under a module root.
 */
export function listHarmonyRouteProfilesUnderModule(
  projectRoot: string,
  moduleRootPath: string,
  cap = ROUTE_PROFILE_CAP_PER_MODULE,
): string[] {
  const rootAbs = path.resolve(projectRoot);
  const modAbs = moduleRootPath
    ? path.resolve(projectRoot, moduleRootPath)
    : rootAbs;
  if (!fs.existsSync(modAbs)) return [];

  const found: string[] = [];
  const queue: Array<{ abs: string; depth: number }> = [{ abs: modAbs, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && found.length < cap) {
    const { abs, depth } = queue.shift()!;
    if (++visited > ROUTE_PROFILE_DIR_BUDGET) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (found.length >= cap) break;
      const child = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (depth >= ROUTE_PROFILE_WALK_MAX_DEPTH) continue;
        if (e.name.startsWith('.') || SKELETON_SKIP_DIRS.has(e.name)) continue;
        queue.push({ abs: child, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(rootAbs, child).replace(/\\/g, '/');
      if (isHarmonyRouteProfileJson(rel)) found.push(rel);
    }
  }
  return found.sort();
}

/** Spec 0040 — oh-package name at module root, if any. */
export function readModuleOhPackageName(
  projectRoot: string,
  moduleRootPath: string,
): string | null {
  const abs = path.join(projectRoot, moduleRootPath || '.', OHPM_MANIFEST);
  return readOhpmName(abs);
}
