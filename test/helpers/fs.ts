import * as fs from 'fs';
import type { ChildProcess } from 'child_process';

/** Best-effort temp dir removal — tolerates Windows SQLite/MCP file locks. */
export function removeTempDir(dir: string): void {
  if (!dir || !fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY') throw err;
  }
}

/** SIGKILL a spawned MCP child and wait briefly so handles release on Windows. */
export async function killMcpChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    setTimeout(resolve, 500);
  });
}
