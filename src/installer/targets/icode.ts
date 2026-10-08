/**
 * iCode target.
 *
 * iCode (product name) ships as the Python package `chrys`; agent profiles
 * are individual YAML files, one per profile, under `~/.chrys/agents/`
 * (macOS/Linux) or `%APPDATA%\chrys\agents\` (Windows). Each profile is a
 * complete agent definition carrying a `tools.mcp` list of MCP server
 * configs.
 *
 * iCode has NO project-local config concept — this target is global-only.
 *
 * Install (synchronous, non-interactive — no per-profile prompt):
 *   1. Every EXISTING user profile under `~/.chrys/agents/*.yaml|yml` gets
 *      the homegraph MCP entry injected in place — a surgical line edit
 *      that preserves sibling MCP servers and every other section.
 *   2. Built-in agents (Code / QA / Explore / General) are discovered from
 *      the installed iCode runtime
 *      (`.../site-packages/chrys/service/profiles/agents/builtins/`). A
 *      built-in with no user profile of the same name gets a "shadow"
 *      profile written to `~/.chrys/agents/<name>.yaml`: the built-in's
 *      FULL content plus the homegraph entry. (iCode's own override rule:
 *      a user profile with a built-in's name REPLACES the built-in
 *      entirely, so the copy must be complete.)
 *      If the runtime can't be located, install degrades to editing
 *      existing profiles only and returns manual guidance in `notes` — it
 *      never throws.
 *
 * Uninstall strips the homegraph entry from every user profile that
 * carries it (shadow files are left as plain built-in copies), matching
 * the other targets' "remove only what install wrote" contract.
 *
 * No instructions file is written (#529/#704) — guidance ships in the MCP
 * `initialize` response, which iCode injects into system reminders by
 * default (`expose_instructions: true`).
 *
 * NOTE: unlike the codegraph fork, this target must NOT suppress the
 * "install the CLI on PATH" step in `src/installer/index.ts` — the MCP
 * command is the `homegraph` Node CLI, which iCode (a Python app) does not
 * bundle.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import { atomicWriteFileSync, getMcpServerConfig } from './shared';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function configDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'chrys');
  }
  return path.join(os.homedir(), '.chrys');
}

function agentsDir(): string {
  return path.join(configDir(), 'agents');
}

// ---------------------------------------------------------------------------
// iCode runtime roots — where the PyApp installation (and its builtins) live
// ---------------------------------------------------------------------------

function icodeRuntimeRoots(): string[] {
  const roots: string[] = [];

  // Custom override (mirrors the PyApp install dir for the `chrys` project).
  const envOverride = process.env.PYAPP_INSTALL_DIR_ICODE;
  if (envOverride) {
    roots.push(path.resolve(envOverride.replace(/^~/, os.homedir())));
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    roots.push(path.join(localAppData, 'pyapp', 'data', 'chrys'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'pyapp', 'chrys'));
  } else {
    const xdgData = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
    roots.push(path.join(xdgData, 'pyapp', 'chrys'));
  }

  return roots;
}

/** Walk a directory tree looking for a chain of path segments. */
function findSubdirs(root: string, segments: string[]): string[] {
  if (segments.length === 0) return fs.existsSync(root) ? [root] : [];
  const head = segments[0]!;
  const tail = segments.slice(1);
  const current = path.join(root, head);
  if (tail.length === 0) return fs.existsSync(current) ? [current] : [];

  // 'site-packages' can sit at an arbitrary depth — search recursively.
  if (head === 'site-packages') {
    const results: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === 'site-packages') results.push(...findSubdirs(full, tail));
        else stack.push(full);
      }
    }
    return results;
  }

  return findSubdirs(current, tail);
}

function parseVersion(segment: string): number[] | null {
  const nums: number[] = [];
  for (const p of segment.split('.')) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums.length > 0 ? nums : null;
}

function versionFromPath(p: string): number[] {
  let current = path.dirname(p);
  while (current !== path.dirname(current)) {
    const v = parseVersion(path.basename(current));
    if (v) return v;
    current = path.dirname(current);
  }
  return [];
}

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Built-in agent discovery (from the installed runtime)
// ---------------------------------------------------------------------------

const BUILTIN_SEARCH = ['site-packages', 'chrys', 'service', 'profiles', 'agents', 'builtins'];

interface BuiltinProfile {
  name: string;
  sourcePath: string;
  /** Where the user-facing shadow file would go (~/.chrys/agents/<name>.yaml). */
  userPath: string;
  content: string;
}

function discoverBuiltins(): BuiltinProfile[] {
  const seen = new Set<string>();
  const results: BuiltinProfile[] = [];
  const userAgentDir = agentsDir();

  for (const root of icodeRuntimeRoots()) {
    const builtinDirs = findSubdirs(root, BUILTIN_SEARCH);
    if (builtinDirs.length === 0) continue;

    // Newest version + highest mtime first.
    builtinDirs.sort((a, b) => {
      const va = versionFromPath(a);
      const vb = versionFromPath(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (vb[i] ?? 0) - (va[i] ?? 0);
        if (d !== 0) return d;
      }
      return mtimeOf(b) - mtimeOf(a);
    });

    for (const dir of builtinDirs) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== '.yaml' && ext !== '.yml') continue;
        const name = path.basename(entry.name, ext);
        if (seen.has(name)) continue;
        seen.add(name);
        const sourcePath = path.join(dir, entry.name);
        const content = readText(sourcePath);
        if (!content) continue;
        results.push({
          name,
          sourcePath,
          userPath: path.join(userAgentDir, `${name}.yaml`),
          content,
        });
      }
      // Only the highest-priority runtime that has YAML files wins.
      if (results.length > 0) break;
    }
    if (results.length > 0) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Unified profile discovery — user-created + un-shadowed built-ins
// ---------------------------------------------------------------------------

interface DiscoveredProfile {
  name: string;
  source: 'user' | 'builtin';
  /** Absolute path in ~/.chrys/agents/ (may not exist yet for builtins). */
  userPath: string;
  content: string;
}

function discoverProfiles(): DiscoveredProfile[] {
  const result: DiscoveredProfile[] = [];
  const seen = new Set<string>();

  // 1. User-created profiles.
  const dir = agentsDir();
  if (fs.existsSync(dir)) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const ext = path.extname(f).toLowerCase();
        if (ext !== '.yaml' && ext !== '.yml') continue;
        const name = path.basename(f, ext);
        seen.add(name);
        const userPath = path.join(dir, f);
        result.push({ name, source: 'user', userPath, content: readText(userPath) });
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Built-ins not yet shadowed by a user profile.
  for (const b of discoverBuiltins()) {
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    result.push({ name: b.name, source: 'builtin', userPath: b.userPath, content: b.content });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function joinLines(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type LineRange = { start: number; end: number };

/** Find a top-level YAML key (zero indent). */
function topLevelRange(lines: string[], key: string): LineRange | null {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '') continue;
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Find a 2-space-indented child key within a parent range. */
function childRange(lines: string[], parent: LineRange, child: string): LineRange | null {
  const startPattern = new RegExp(`^  ${escapeRegExp(child)}:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = parent.end;
  for (let i = start + 1; i < parent.end; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    // List items ("  - name: ...") belong to the child; only a same-indent
    // mapping key terminates the range.
    if (/^  [A-Za-z_]/.test(line)) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') end--;
  return { start, end };
}

// ---------------------------------------------------------------------------
// HomeGraph MCP entry block
// ---------------------------------------------------------------------------

function renderHomeGraphMcpEntry(): string[] {
  const mcp = getMcpServerConfig();
  const lines: string[] = [
    '  - name: homegraph',
    '    transport: stdio',
    `    command: ${mcp.command}`,
    '    args:',
  ];
  for (const arg of mcp.args) lines.push(`    - ${arg}`);
  lines.push('    enabled: true');
  return lines;
}

function hasHomeGraphMcp(content: string): boolean {
  const lines = splitLines(content);
  const tools = topLevelRange(lines, 'tools');
  if (!tools) return false;
  const mcp = childRange(lines, tools, 'mcp');
  if (!mcp) return false;
  for (let i = mcp.start + 1; i < mcp.end; i++) {
    if (/^ {2,4}- name:\s*homegraph\b/.test(lines[i] ?? '')) return true;
  }
  return false;
}

function findMcpInsertPoint(lines: string[], mcpRange: LineRange): number {
  for (let i = mcpRange.end - 1; i > mcpRange.start; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if ((line.match(/^( *)/)?.[1] ?? '').length >= 4) return i;
  }
  return mcpRange.start;
}

function lastIndentedLine(lines: string[], parent: LineRange): number {
  for (let i = parent.end - 1; i > parent.start; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^  /.test(line)) return i;
  }
  return parent.start;
}

function insertAt(lines: string[], afterIdx: number, newLines: string[]): string {
  const result = [...lines];
  result.splice(afterIdx + 1, 0, ...newLines);
  return joinLines(result);
}

function addHomeGraphMcp(content: string): string {
  const lines = splitLines(content);
  const tools = topLevelRange(lines, 'tools');

  // Already present → no-op.
  if (tools) {
    const mcp = childRange(lines, tools, 'mcp');
    if (mcp && hasHomeGraphMcp(content)) return content;
  }

  const entry = renderHomeGraphMcpEntry();

  // No `tools:` section at all → append one.
  if (!tools) {
    return joinLines([...lines, '', 'tools:', '  mcp:', ...entry, '']);
  }

  const mcp = childRange(lines, tools, 'mcp');

  // `tools:` exists but no `mcp:` list → add `mcp:` after the last child.
  if (!mcp) {
    const insertAfter = lastIndentedLine(lines, tools);
    return insertAt(lines, insertAfter, ['  mcp:', ...entry, '']);
  }

  // `mcp:` exists → append the entry after the last mcp item.
  const insertAfter = findMcpInsertPoint(lines, mcp);
  return insertAt(lines, insertAfter, entry);
}

// ---------------------------------------------------------------------------
// Uninstall helpers
// ---------------------------------------------------------------------------

function findHomeGraphEntryRange(lines: string[], mcpRange: LineRange): LineRange | null {
  let entryStart = -1;
  for (let i = mcpRange.start + 1; i < mcpRange.end; i++) {
    if (/^ {2,4}- name:\s*homegraph\b/.test(lines[i] ?? '')) {
      entryStart = i;
      break;
    }
  }
  if (entryStart === -1) return null;

  let entryEnd = mcpRange.end;
  for (let i = entryStart + 1; i < mcpRange.end; i++) {
    if (/^ {2,4}- name:/.test(lines[i] ?? '')) {
      entryEnd = i;
      break;
    }
  }
  while (entryEnd > entryStart + 1 && (lines[entryEnd - 1] ?? '').trim() === '') entryEnd--;
  return { start: entryStart, end: entryEnd };
}

function stripLines(lines: string[], start: number, end: number): string {
  const result = [...lines];
  result.splice(start, end - start);
  const cleaned: string[] = [];
  let prevBlank = false;
  for (const line of result) {
    const isBlank = line.trim() === '';
    if (isBlank && prevBlank) continue;
    cleaned.push(line);
    prevBlank = isBlank;
  }
  return joinLines(cleaned);
}

function removeHomeGraphMcp(content: string): string {
  const lines = splitLines(content);
  const tools = topLevelRange(lines, 'tools');
  if (!tools) return content;
  const mcp = childRange(lines, tools, 'mcp');
  if (!mcp) return content;

  const entryRange = findHomeGraphEntryRange(lines, mcp);
  if (!entryRange) return content;

  const remaining = lines.slice(mcp.start + 1, mcp.end).some((l, i) => {
    const idx = mcp.start + 1 + i;
    if (idx >= entryRange.start && idx < entryRange.end) return false;
    return l.trim() !== '';
  });

  // Last entry in the mcp list → drop the whole `mcp:` block; else drop just
  // the entry, leaving siblings untouched.
  return remaining
    ? stripLines(lines, entryRange.start, entryRange.end)
    : stripLines(lines, mcp.start, mcp.end);
}

// ---------------------------------------------------------------------------
// Target implementation
// ---------------------------------------------------------------------------

class ICodeTarget implements AgentTarget {
  readonly id = 'icode' as const;
  readonly displayName = 'iCode';
  // No public docs URL known; left undefined rather than pointing somewhere wrong.

  /** iCode has no project-local config concept. */
  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    let installed = fs.existsSync(configDir());
    if (!installed) {
      for (const root of icodeRuntimeRoots()) {
        if (fs.existsSync(root)) {
          installed = true;
          break;
        }
      }
    }
    if (!installed) return { installed: false, alreadyConfigured: false };

    let alreadyConfigured = false;
    let firstPath: string | undefined;
    for (const p of discoverProfiles()) {
      if (hasHomeGraphMcp(p.content)) {
        alreadyConfigured = true;
        firstPath = p.userPath;
        break;
      }
    }
    return { installed, alreadyConfigured, configPath: firstPath ?? agentsDir() };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['iCode has no project-local config — re-run with --location=global.'],
      };
    }

    // Escape hatch: never create new shadow profiles for built-ins (still
    // edits existing user profiles).
    const skipBuiltins = process.env.HOMEGRAPH_ICODE_NO_BUILTINS === '1';
    const all = discoverProfiles();
    const profiles = skipBuiltins ? all.filter((p) => p.source === 'user') : all;
    const builtinsFound = discoverBuiltins().length > 0;

    if (profiles.length === 0) {
      return {
        files: [],
        notes: [
          fs.existsSync(configDir())
            ? 'No iCode agent profiles found. Run `icode` once to initialize the built-ins, then re-run `homegraph install --target icode`.'
            : 'iCode does not appear to be installed. Install iCode first, then re-run `homegraph install --target icode`.',
        ],
      };
    }

    const files: WriteResult['files'] = [];
    for (const prof of profiles) {
      if (prof.content.trim().length === 0) continue; // unreadable / empty
      if (hasHomeGraphMcp(prof.content)) {
        files.push({ path: prof.userPath, action: 'unchanged' });
        continue;
      }
      const after = addHomeGraphMcp(prof.content);
      const existed = fs.existsSync(prof.userPath);
      atomicWriteFileSync(prof.userPath, ensureTrailingNewline(after));
      files.push({ path: prof.userPath, action: existed ? 'updated' : 'created' });
    }

    const created = files.filter((f) => f.action === 'created').length;
    const updated = files.filter((f) => f.action === 'updated').length;
    const unchanged = files.filter((f) => f.action === 'unchanged').length;
    const notes: string[] = [];
    if (created > 0) {
      notes.push(`Created ${created} shadow profile(s) for built-in agents with homegraph MCP.`);
    }
    if (updated > 0) {
      notes.push(`Injected homegraph MCP server into ${updated} existing profile(s).`);
    }
    if (unchanged > 0) notes.push(`${unchanged} profile(s) already had homegraph configured.`);

    if (!builtinsFound) {
      // Degrade to manual guidance — never error.
      notes.push(
        'Could not locate the installed iCode runtime, so built-in agents (Code/QA/Explore/General) were not auto-configured. ' +
          'Add the block below to their YAML under ~/.chrys/agents/ manually (or set PYAPP_INSTALL_DIR_ICODE and re-run):\n' +
          renderHomeGraphMcpEntry().join('\n'),
      );
    }
    if (notes.length === 0) notes.push('Nothing was changed.');
    return { files, notes };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };

    const dir = agentsDir();
    if (!fs.existsSync(dir)) {
      return { files: [], notes: ['No iCode agent profiles found — nothing to uninstall.'] };
    }

    let userFiles: string[];
    try {
      userFiles = fs
        .readdirSync(dir)
        .filter((f) => /\.ya?ml$/i.test(f))
        .map((f) => path.join(dir, f))
        .sort();
    } catch {
      return { files: [], notes: ['No iCode agent profiles found — nothing to uninstall.'] };
    }

    const files: WriteResult['files'] = [];
    for (const profilePath of userFiles) {
      const before = readText(profilePath);
      if (!hasHomeGraphMcp(before)) {
        files.push({ path: profilePath, action: 'kept' });
        continue;
      }
      const after = removeHomeGraphMcp(before);
      atomicWriteFileSync(profilePath, ensureTrailingNewline(after));
      files.push({ path: profilePath, action: 'removed' });
    }

    const removed = files.filter((f) => f.action === 'removed').length;
    return {
      files,
      notes: [
        removed > 0
          ? `Removed homegraph MCP from ${removed} iCode profile(s).`
          : 'homegraph MCP was not configured in any iCode profile.',
      ],
    };
  }

  printConfig(_loc: Location): string {
    return [
      '# Add to each profile YAML under ~/.chrys/agents/',
      '# Find the "tools:" section, then add under a "mcp:" list:',
      '',
      ...renderHomeGraphMcpEntry(),
      '',
      '# Or install with: homegraph install --target icode',
      '',
    ].join('\n');
  }

  describePaths(_loc: Location): string[] {
    return discoverProfiles().map((p) => p.userPath);
  }
}

export const icodeTarget: AgentTarget = new ICodeTarget();
