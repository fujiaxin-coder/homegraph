import { type StdioOptions } from 'child_process';

/** Shared options for all `execFileSync` Git calls across the spec module. */
export function gitExecOptions(repoPath: string) {
  const stdio: StdioOptions = ['ignore', 'pipe', 'ignore'];
  return {
    cwd: repoPath,
    encoding: 'utf8' as const,
    stdio,
    windowsHide: true,
  };
}
