/**
 * DevEco Code target.
 *
 * DevEco Code is Huawei's HarmonyOS AI coding assistant, built on
 * OpenCode. Config shape matches opencode's wrapper:
 *
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "homegraph": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * Config file resolution (per DevEco Code docs):
 *   - local:  `.deveco/deveco.jsonc` → `deveco.jsonc` (defaults to `.deveco/`)
 *   - global: `~/.config/deveco/deveco.jsonc` (XDG-style on EVERY platform,
 *             Windows included — DevEco uses the same `xdg-basedir` resolution
 *             as opencode, not `%APPDATA%`)
 *
 * Like Cursor, DevEco Code may launch MCP servers with a cwd that
 * isn't the workspace root, so we inject `--path` into the command
 * array.
 *
 * Early homegraph installs wrote the global entry to `%APPDATA%/deveco` on
 * Windows; DevEco never reads it. install/uninstall sweep stale entries
 * from that legacy location.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  jsonDeepEqual,
  removeMarkedSection,
} from './shared';
import {
  HOMEGRAPH_SECTION_END,
  HOMEGRAPH_SECTION_START,
} from '../instructions-template';

function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'deveco');
}

/**
 * Early installs wrote the global entry to `%APPDATA%/deveco` on Windows — a
 * dir DevEco never reads. Returns that legacy dir when it could hold stale
 * state (APPDATA set and resolving somewhere other than the real config dir).
 */
function legacyWindowsConfigDir(): string | null {
  const appData = process.env.APPDATA;
  if (!appData || !appData.trim()) return null;
  const legacy = path.join(appData, 'deveco');
  return path.resolve(legacy) === path.resolve(globalConfigDir()) ? null : legacy;
}

function configBaseDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : process.cwd();
}

function configPath(loc: Location): string {
  if (loc === 'global') {
    return path.join(globalConfigDir(), 'deveco.jsonc');
  }
  const dotDeveco = path.join(process.cwd(), '.deveco', 'deveco.jsonc');
  const root = path.join(process.cwd(), 'deveco.jsonc');
  if (fs.existsSync(dotDeveco)) return dotDeveco;
  if (fs.existsSync(root)) return root;
  return dotDeveco;
}

function instructionsPath(loc: Location): string {
  return path.join(configBaseDir(loc), 'AGENTS.md');
}

function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

function parseConfig(text: string): Record<string, any> {
  if (!text.trim()) return {};
  const errors: any[] = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, any>;
}

function getDevecoServerEntry(loc: Location): { type: string; command: string[]; enabled: boolean } {
  const pathArg = loc === 'local' ? process.cwd() : '${workspaceFolder}';
  return {
    type: 'local',
    command: ['homegraph', 'serve', 'mcp', '--path', pathArg],
    enabled: true,
  };
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

class DevecoTarget implements AgentTarget {
  readonly id = 'deveco' as const;
  readonly displayName = 'DevEco Code';
  readonly docsUrl = 'https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/deveco-code-overview';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcp?.homegraph;
    const legacy = legacyWindowsConfigDir();
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir()) || (!!legacy && fs.existsSync(legacy))
      : fs.existsSync(path.join(process.cwd(), '.deveco'))
        || fs.existsSync(path.join(process.cwd(), 'deveco.jsonc'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    const instrCleanup = removeInstructionsEntry(loc);
    if (instrCleanup.action === 'removed') files.push(instrCleanup);

    if (loc === 'global') files.push(...cleanupLegacyWindowsState());

    return {
      files,
      notes: ['Restart DevEco Code for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(removeMcpEntryAt(configPath(loc)));
    files.push(removeInstructionsEntry(loc));
    if (loc === 'global') files.push(...cleanupLegacyWindowsState());
    return { files };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { homegraph: getDevecoServerEntry(loc) },
    }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const existed = fs.existsSync(file);
  let text = readConfigText(file);

  if (!text.trim()) {
    text = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }

  const config = parseConfig(text);
  const before = config.mcp?.homegraph;
  const after = getDevecoServerEntry(loc);

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  if (!config.$schema) {
    const schemaEdits = modify(text, ['$schema'], 'https://opencode.ai/config.json', {
      formattingOptions: FORMATTING,
    });
    text = applyEdits(text, schemaEdits);
  }

  const edits = modify(text, ['mcp', 'homegraph'], after, {
    formattingOptions: FORMATTING,
  });
  const updated = applyEdits(text, edits);
  atomicWriteFileSync(file, updated);

  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeMcpEntryAt(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const text = readConfigText(file);
  const config = parseConfig(text);
  if (!config.mcp?.homegraph) return { path: file, action: 'not-found' };

  let edits = modify(text, ['mcp', 'homegraph'], undefined, {
    formattingOptions: FORMATTING,
  });
  let updated = applyEdits(text, edits);

  const afterParsed = parseConfig(updated);
  if (afterParsed.mcp && typeof afterParsed.mcp === 'object' &&
      Object.keys(afterParsed.mcp).length === 0) {
    edits = modify(updated, ['mcp'], undefined, { formattingOptions: FORMATTING });
    updated = applyEdits(updated, edits);
  }

  atomicWriteFileSync(file, updated);
  return { path: file, action: 'removed' };
}

function cleanupLegacyWindowsState(): WriteResult['files'] {
  const dir = legacyWindowsConfigDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const out: WriteResult['files'] = [];
  for (const name of ['deveco.jsonc', 'deveco.json']) {
    const res = removeMcpEntryAt(path.join(dir, name));
    if (res.action === 'removed') out.push(res);
  }
  const agents = path.join(dir, 'AGENTS.md');
  const action = removeMarkedSection(agents, HOMEGRAPH_SECTION_START, HOMEGRAPH_SECTION_END);
  if (action === 'removed') out.push({ path: agents, action });
  return out;
}

function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, HOMEGRAPH_SECTION_START, HOMEGRAPH_SECTION_END);
  return { path: file, action };
}

export const devecoTarget: AgentTarget = new DevecoTarget();
