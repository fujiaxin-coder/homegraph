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

/** Spec 0042 B — path-only Harmony resource inventory (no parse, no edges). */
export interface HarmonyResourceInventory {
  stringJson: string[];
  rawfiles: string[];
  mediaDirs: Array<{ dir: string; countsByExt: Record<string, number> }>;
  /** Spec 0048 — form_config.json / shortcuts_config.json paths. */
  capabilityProfiles: string[];
  unindexedDirs: Array<{ path: string; reason: string }>;
  truncated: boolean;
}

const RESOURCE_WALK_MAX_DEPTH = 14;
const RESOURCE_DIR_BUDGET = 4000;
const RESOURCE_STRING_CAP = 24;
const RESOURCE_RAWFILE_CAP = 40;
const RESOURCE_MEDIA_DIR_CAP = 24;
const RESOURCE_UNINDEXED_CAP = 16;
const RESOURCE_CAPABILITY_CAP = 16;
const RESOURCE_CONFIG_BASENAMES = new Set([
  'shortcuts_config.json',
  'form_config.json',
]);

/**
 * Bounded walk: whitelist paths under `resources/…` plus package dirs with zero
 * indexed sources. Does not read JSON bodies or media bytes.
 */
export function scanHarmonyResourceInventory(
  projectRoot: string,
  options?: { indexedPaths?: Iterable<string> },
): HarmonyResourceInventory {
  const rootAbs = path.resolve(projectRoot);
  const out: HarmonyResourceInventory = {
    stringJson: [],
    rawfiles: [],
    mediaDirs: [],
    capabilityProfiles: [],
    unindexedDirs: [],
    truncated: false,
  };
  if (!fs.existsSync(rootAbs)) return out;

  const indexed = new Set<string>();
  for (const p of options?.indexedPaths ?? []) {
    indexed.add(p.replace(/\\/g, '/'));
  }
  const mediaCounts = new Map<string, Record<string, number>>();
  const packageDirs = new Map<string, { hasOhpm: boolean; hasModule: boolean }>();

  const queue: Array<{ abs: string; depth: number }> = [{ abs: rootAbs, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const { abs, depth } = queue.shift()!;
    if (++visited > RESOURCE_DIR_BUDGET) {
      out.truncated = true;
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = path.join(abs, e.name);
      const rel = path.relative(rootAbs, child).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (depth >= RESOURCE_WALK_MAX_DEPTH) continue;
        if (e.name.startsWith('.') || SKELETON_SKIP_DIRS.has(e.name)) continue;
        queue.push({ abs: child, depth: depth + 1 });
        continue;
      }
      if (!e.isFile() || !rel || rel.startsWith('..')) continue;

      if (/(?:^|\/)resources\/(?:[^/]+\/)*element\/string\.json$/i.test(rel)) {
        if (out.stringJson.length < RESOURCE_STRING_CAP) out.stringJson.push(rel);
        else out.truncated = true;
        continue;
      }
      if (/(?:^|\/)resources\/(?:[^/]+\/)*rawfile\//i.test(rel)) {
        if (out.rawfiles.length < RESOURCE_RAWFILE_CAP) out.rawfiles.push(rel);
        else out.truncated = true;
        continue;
      }
      const mediaMatch = rel.match(/^(.*?\/resources\/(?:[^/]+\/)*(?:base\/)?media)\/[^/]+$/i);
      if (mediaMatch) {
        const dir = mediaMatch[1]!.replace(/\\/g, '/');
        const ext = path.extname(rel).slice(1).toLowerCase() || 'bin';
        const counts = mediaCounts.get(dir) ?? {};
        counts[ext] = (counts[ext] ?? 0) + 1;
        mediaCounts.set(dir, counts);
        continue;
      }
      const base = rel.split('/').pop()?.toLowerCase() ?? '';
      if (RESOURCE_CONFIG_BASENAMES.has(base)) {
        if (out.capabilityProfiles.length < RESOURCE_CAPABILITY_CAP) {
          if (!out.capabilityProfiles.includes(rel)) out.capabilityProfiles.push(rel);
        } else {
          out.truncated = true;
        }
        continue;
      }
      if (base === 'oh-package.json5' || base === 'module.json5') {
        const dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        const cur = packageDirs.get(dirRel) ?? { hasOhpm: false, hasModule: false };
        if (base === 'oh-package.json5') cur.hasOhpm = true;
        else cur.hasModule = true;
        packageDirs.set(dirRel, cur);
      }
    }
  }

  for (const [dir, counts] of [...mediaCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (out.mediaDirs.length >= RESOURCE_MEDIA_DIR_CAP) {
      out.truncated = true;
      break;
    }
    out.mediaDirs.push({ dir, countsByExt: counts });
  }
  out.stringJson.sort((a, b) => a.localeCompare(b));
  out.rawfiles.sort((a, b) => a.localeCompare(b));
  out.capabilityProfiles.sort((a, b) => a.localeCompare(b));

  // Unindexed package/module dirs: on disk but no indexed source under them.
  for (const [dirRel, flags] of [...packageDirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (out.unindexedDirs.length >= RESOURCE_UNINDEXED_CAP) {
      out.truncated = true;
      break;
    }
    if (!dirRel) continue; // project root always "indexed" via map
    const prefix = `${dirRel}/`;
    const hasIndexed = [...indexed].some((p) => p === dirRel || p.startsWith(prefix));
    if (hasIndexed) continue;
    // Skip pure resource-only package markers under resources/ (not a module root).
    if (/(?:^|\/)resources\//i.test(dirRel)) continue;
    const reason = flags.hasOhpm
      ? 'oh-package.json5 present; 0 indexed source files'
      : 'module.json5 present; 0 indexed source files';
    out.unindexedDirs.push({ path: dirRel, reason });
  }

  return out;
}

/** Markdown section for Spec 0042 B (empty string when nothing to show). */
export function formatHarmonyResourceInventory(inv: HarmonyResourceInventory): string {
  const lines: string[] = [];
  const hasResources =
    inv.stringJson.length > 0
    || inv.rawfiles.length > 0
    || inv.mediaDirs.length > 0
    || inv.capabilityProfiles.length > 0;
  if (hasResources) {
    lines.push('### HarmonyOS resources');
    if (inv.stringJson.length) {
      const shown = inv.stringJson.slice(0, 12);
      lines.push(
        `- string.json (${inv.stringJson.length}): ${shown.map((p) => `\`${p}\``).join(', ')}`
          + (inv.stringJson.length > shown.length ? `, +${inv.stringJson.length - shown.length} more` : ''),
      );
    }
    if (inv.capabilityProfiles.length) {
      const shown = inv.capabilityProfiles.slice(0, 12);
      lines.push(
        `- capability profiles (${inv.capabilityProfiles.length}): ${shown.map((p) => `\`${p}\``).join(', ')}`
          + (inv.capabilityProfiles.length > shown.length
            ? `, +${inv.capabilityProfiles.length - shown.length} more`
            : ''),
      );
    }
    if (inv.rawfiles.length) {
      const shown = inv.rawfiles.slice(0, 12);
      lines.push(
        `- rawfile (${inv.rawfiles.length}): ${shown.map((p) => `\`${p}\``).join(', ')}`
          + (inv.rawfiles.length > shown.length ? `, +${inv.rawfiles.length - shown.length} more` : ''),
      );
    }
    for (const m of inv.mediaDirs.slice(0, 8)) {
      const counts = Object.entries(m.countsByExt)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ext, n]) => `${ext}=${n}`)
        .join(', ');
      lines.push(`- media: \`${m.dir}\`${counts ? ` (${counts})` : ''}`);
    }
    if (inv.mediaDirs.length > 8) {
      lines.push(`- media: … +${inv.mediaDirs.length - 8} more dirs`);
    }
  }
  if (inv.unindexedDirs.length) {
    if (lines.length) lines.push('');
    lines.push('### On disk, not in graph');
    for (const u of inv.unindexedDirs) {
      lines.push(`- \`${u.path}/\` (${u.reason})`);
    }
  }
  if (inv.truncated) {
    lines.push('');
    lines.push('_resource inventory truncated (bounded walk)_');
  }
  return lines.join('\n');
}

function readOhpmLocalDeps(manifestAbs: string, cap = 8): string[] {
  try {
    const text = fs.readFileSync(manifestAbs, 'utf-8');
    let deps: Record<string, unknown> | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const parsed = require('jsonc-parser').parse(text) as {
        dependencies?: Record<string, unknown>;
      } | null;
      deps = parsed?.dependencies;
    } catch {
      deps = undefined;
    }
    if (!deps || typeof deps !== 'object') return [];
    const out: string[] = [];
    for (const [name, ver] of Object.entries(deps)) {
      if (out.length >= cap) break;
      if (typeof ver !== 'string') continue;
      if (!/^(file:|\.\.?\/)/i.test(ver.trim())) continue;
      out.push(`\`${name}\` (${ver.trim()})`);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Spec 0048 §4 — module roster with oh-package name + local file: deps.
 */
export function formatHarmonyModuleRoster(
  projectRoot: string,
  modules: Array<{ name: string; rootPath: string; kind: string; fileCount: number }>,
  maxRows = 24,
): string {
  const rows: string[] = [];
  for (const m of modules) {
    if (rows.length >= maxRows) break;
    if (m.kind === 'root' && !m.rootPath) continue;
    const rootLabel = m.rootPath || '.';
    const ohpmAbs = path.join(projectRoot, m.rootPath || '.', OHPM_MANIFEST);
    const pkg = readOhpmName(ohpmAbs);
    const localDeps = readOhpmLocalDeps(ohpmAbs);
    let line = `- \`${m.name}\` (\`${rootLabel}\`) · ${m.kind} · ${m.fileCount} files`;
    if (pkg) line += ` · oh-package \`${pkg}\``;
    if (localDeps.length) line += ` · deps: ${localDeps.join(', ')}`;
    rows.push(line);
  }
  if (rows.length === 0) return '';
  return ['### Module roster', ...rows].join('\n');
}

