/**
 * Fast project map — module boundaries + source-file inventory (no symbols/edges).
 *
 * Used by MCP auto-init (seconds-scale) and `homegraph_project` so agents get an
 * engineering overview before the full index finishes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { scanDirectory } from '../extraction';
import { detectLanguage } from '../extraction/grammars';
import {
  listHarmonyProjectModules,
  normalizeHarmonyModuleSrcPath,
  type HarmonyModuleRef,
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

  const harmony = listHarmonyProjectModulesLoose(projectRoot);
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

function listHarmonyProjectModulesLoose(projectRoot: string): HarmonyModuleRef[] {
  const strict = listHarmonyProjectModules(projectRoot);
  if (strict.length > 0) return strict;

  // Real DevEco `build-profile.json5` often uses unquoted keys; the strict
  // parser only strips comments/trailing commas. Quote bare keys and retry.
  const profilePath = path.join(projectRoot, 'build-profile.json5');
  if (!fs.existsSync(profilePath)) return [];
  let raw: unknown;
  try {
    const text = fs.readFileSync(profilePath, 'utf-8');
    const stripped = text
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":');
    raw = JSON.parse(stripped);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const modules = (raw as { modules?: unknown }).modules;
  if (!Array.isArray(modules)) return [];
  const out: HarmonyModuleRef[] = [];
  for (const entry of modules) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as { name?: unknown; srcPath?: unknown };
    if (typeof rec.name !== 'string' || typeof rec.srcPath !== 'string') continue;
    const srcPath = normalizeHarmonyModuleSrcPath(rec.srcPath);
    if (!srcPath) continue;
    out.push({ name: rec.name, srcPath });
  }
  return out;
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parsed = require('jsonc-parser').parse(fs.readFileSync(manifestAbs, 'utf-8')) as {
      name?: unknown;
    } | null;
    return typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
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
