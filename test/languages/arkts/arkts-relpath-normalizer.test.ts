/**
 * Spec 0011 — ArkTS rel-path normalizer: one realpath(root) + hot-path strip.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createArkRelPathNormalizer } from '../../../src/extraction/languages/arkts';

const tempDirs: string[] = [];

function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ark-rel-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore cleanup races on Windows
    }
  }
});

describe('createArkRelPathNormalizer', () => {
  it('strips a file under the project root to a posix relative path', () => {
    const root = makeTempProject({ 'src/main/ets/pages/Index.ets': 'export struct Index {}' });
    const norm = createArkRelPathNormalizer(root);
    const abs = path.join(norm.rootDir, 'src', 'main', 'ets', 'pages', 'Index.ets');
    expect(norm.normalize(abs)).toBe('src/main/ets/pages/Index.ets');
  });

  it('canonicalizes root once so unresolved mkdtemp roots still match realpath files', () => {
    const root = makeTempProject({ 'a.ets': 'export const x = 1;' });
    const resolvedRoot = fs.realpathSync(root);
    const absResolved = path.join(resolvedRoot, 'a.ets');
    const norm = createArkRelPathNormalizer(root);
    expect(norm.rootDir).toBe(resolvedRoot);
    expect(norm.normalize(absResolved)).toBe('a.ets');
  });

  it('returns stable cached results for repeated abs strings', () => {
    const root = makeTempProject({ 'pkg/foo.ets': 'export const y = 2;' });
    const norm = createArkRelPathNormalizer(root);
    const abs = path.join(norm.rootDir, 'pkg', 'foo.ets');
    expect(norm.normalize(abs)).toBe('pkg/foo.ets');
    expect(norm.normalize(abs)).toBe('pkg/foo.ets');
  });

  it.runIf(process.platform === 'darwin')(
    'slow-path realpaths /var abs when root was canonicalized to /private/var',
    () => {
      const root = makeTempProject({ 'b.ets': 'export const z = 3;' });
      const resolvedRoot = fs.realpathSync(root);
      // Only meaningful when mkdtemp left an unresolved /var form.
      if (root === resolvedRoot) return;
      const norm = createArkRelPathNormalizer(root);
      expect(norm.rootDir).toBe(resolvedRoot);
      // Unresolved abs does not string-prefix the canonical root.
      const unresolvedAbs = path.join(root, 'b.ets');
      expect(path.normalize(unresolvedAbs).startsWith(path.normalize(norm.rootDir))).toBe(false);
      expect(norm.normalize(unresolvedAbs)).toBe('b.ets');
      // Cache: second call still correct.
      expect(norm.normalize(unresolvedAbs)).toBe('b.ets');
    }
  );
});
