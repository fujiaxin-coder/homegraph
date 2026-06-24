/**
 * CodeBuddy target.
 *
 * CodeBuddy (Tencent Cloud AI coding assistant) uses the standard
 * `{ mcpServers: { ... } }` JSON shape with explicit `type: "stdio"`.
 *
 * Config file resolution (per CodeBuddy docs):
 *   - global: `~/.codebuddy/.mcp.json` → `~/.codebuddy/mcp.json`
 *             → `~/.codebuddy.json` (writes highest-priority path)
 *   - local:  `<project>/.mcp.json` → `<project>/mcp.json`
 *
 * Like Cursor, CodeBuddy may launch MCP servers with a cwd that isn't
 * the workspace root, so we inject `--path` into args.
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
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function mcpJsonPath(loc: Location): string {
  if (loc === 'global') {
    const dir = path.join(os.homedir(), '.codebuddy');
    const preferred = path.join(dir, '.mcp.json');
    const legacy1 = path.join(dir, 'mcp.json');
    const legacy2 = path.join(os.homedir(), '.codebuddy.json');
    if (fs.existsSync(preferred)) return preferred;
    if (fs.existsSync(legacy1)) return legacy1;
    if (fs.existsSync(legacy2)) return legacy2;
    return preferred;
  }
  const preferred = path.join(process.cwd(), '.mcp.json');
  const legacy = path.join(process.cwd(), 'mcp.json');
  if (fs.existsSync(preferred)) return preferred;
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

function buildCodebuddyMcpConfig(loc: Location): { type: string; command: string; args: string[] } {
  const base = getMcpServerConfig();
  const pathArg = loc === 'local' ? process.cwd() : '${workspaceFolder}';
  return { ...base, args: [...base.args, '--path', pathArg] };
}

class CodebuddyTarget implements AgentTarget {
  readonly id = 'codebuddy' as const;
  readonly displayName = 'CodeBuddy';
  readonly docsUrl = 'https://www.codebuddy.ai/docs';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.homegraph;
    const installed = loc === 'global'
      ? fs.existsSync(path.join(os.homedir(), '.codebuddy'))
        || fs.existsSync(path.join(os.homedir(), '.codebuddy.json'))
      : fs.existsSync(path.join(process.cwd(), '.mcp.json'))
        || fs.existsSync(path.join(process.cwd(), 'mcp.json'));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc)],
      notes: ['Restart CodeBuddy for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.homegraph) {
      delete config.mcpServers.homegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }
    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { homegraph: buildCodebuddyMcpConfig(loc) } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.homegraph;
  const after = buildCodebuddyMcpConfig(loc);

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before
    ? 'updated'
    : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.homegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const codebuddyTarget: AgentTarget = new CodebuddyTarget();
