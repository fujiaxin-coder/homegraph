/**
 * Shared detection helpers for coding-agent adapters.
 *
 * Detection philosophy mirrors src/installer/targets (cheap filesystem
 * checks, never spawn the agent), with one crucial difference: installer
 * targets detect WHERE to install hooks (a config directory is a fine
 * signal), while adapters detect WHETHER the agent can run — and an
 * uninstalled agent leaves its config directory behind. Detection must
 * therefore key on executable files only: the binary on PATH, or a
 * well-known install path with the executable bit set.
 *
 * @module spec/llm/agents/detect-utils
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Check whether `binary` resolves to an existing file on PATH.
 *
 * Scans PATH directories directly instead of shelling out to `which` —
 * no child process, no platform-specific locator quirks. Executable-bit
 * verification is POSIX-only; on Windows existence is sufficient.
 */
export function isOnPath(binary: string): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;

  const candidates = process.platform === 'win32'
    ? [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`]
    : [binary];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      if (isExecutable(path.join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * Check whether `fullPath` exists and is executable (POSIX) or simply
 * exists (Windows). Used for well-known install locations of agents that
 * are installed but not on PATH.
 */
export function isExecutable(fullPath: string): boolean {
  try {
    fs.accessSync(fullPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
