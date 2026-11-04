import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK = path.resolve(HERE, '..', 'fixtures', 'photos.lock.json');

export function loadLock() {
  return JSON.parse(fs.readFileSync(LOCK, 'utf8'));
}

export function resolveProject({ project, workdir, skipClone }) {
  const lock = loadLock();
  if (project) {
    const p = path.resolve(project);
    if (!fs.existsSync(p)) throw new Error(`--project not found: ${p}`);
    return { root: p, lock, cloned: false };
  }
  if (skipClone && lock.localHint && fs.existsSync(lock.localHint)) {
    return { root: path.resolve(lock.localHint), lock, cloned: false };
  }
  const dest = path.resolve(workdir || path.join(HERE, '..', '.cache', 'applications_photos'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(path.join(dest, '.git'))) {
    console.error(`Cloning ${lock.url} → ${dest}`);
    execFileSync('git', ['clone', '--filter=blob:none', lock.url, dest], {
      stdio: 'inherit',
    });
  } else {
    console.error(`Fetching in ${dest}`);
    execFileSync('git', ['fetch', '--all'], { cwd: dest, stdio: 'inherit' });
  }
  execFileSync('git', ['checkout', '-f', lock.commit], { cwd: dest, stdio: 'inherit' });
  return { root: dest, lock, cloned: true };
}

export function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
