/**
 * Spec 0061 — CLI init/index/sync project-root resolution.
 *
 * Explicit path → literal directory (never walk-up).
 * No path → nearest build-profile.json5, else cwd.
 * Ancestor .homegraph must NOT hijack a nested Harmony project.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  findNearestHarmonyProjectRoot,
  resolveCliMutatingProjectRoot,
  isInitialized,
  getHomeGraphDir,
} from '../src/directory';

function touch(filePath: string, contents = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
}

/** Minimal "initialized" marker: .homegraph/homegraph.db (empty file is enough for isInitialized). */
function plantHomeGraphDb(projectRoot: string): void {
  const dir = getHomeGraphDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'homegraph.db'), '', 'utf-8');
}

describe('findNearestHarmonyProjectRoot (Spec 0061)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-harmony-root-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no build-profile.json5 exists on the ancestor chain', () => {
    const sub = path.join(tempDir, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findNearestHarmonyProjectRoot(sub)).toBeNull();
    expect(findNearestHarmonyProjectRoot(tempDir)).toBeNull();
  });

  it('returns the start directory when it itself has build-profile.json5', () => {
    touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
    expect(findNearestHarmonyProjectRoot(tempDir)).toBe(path.resolve(tempDir));
  });

  it('walks up from a nested subdirectory to the profile root', () => {
    touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
    const deep = path.join(tempDir, 'feature', 'foo', 'src', 'main', 'ets');
    fs.mkdirSync(deep, { recursive: true });
    expect(findNearestHarmonyProjectRoot(deep)).toBe(path.resolve(tempDir));
  });

  it('prefers the nearest profile when nested profiles exist', () => {
    touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
    const nestedApp = path.join(tempDir, 'apps', 'phone');
    touch(path.join(nestedApp, 'build-profile.json5'), '{ modules: [] }\n');
    const deep = path.join(nestedApp, 'entry', 'src');
    fs.mkdirSync(deep, { recursive: true });
    expect(findNearestHarmonyProjectRoot(deep)).toBe(path.resolve(nestedApp));
  });

  it('does not treat a sibling tree profile as a hit', () => {
    const left = path.join(tempDir, 'left');
    const right = path.join(tempDir, 'right', 'nested');
    touch(path.join(left, 'build-profile.json5'), '{ modules: [] }\n');
    fs.mkdirSync(right, { recursive: true });
    expect(findNearestHarmonyProjectRoot(right)).toBeNull();
  });
});

describe('resolveCliMutatingProjectRoot (Spec 0061)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cli-mutate-root-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('explicit path argument (literal — never walk-up)', () => {
    it('resolves an absolute path as-is even when a parent has build-profile.json5', () => {
      touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
      const sub = path.join(tempDir, 'feature', 'widget');
      fs.mkdirSync(sub, { recursive: true });
      expect(resolveCliMutatingProjectRoot(sub, tempDir)).toBe(path.resolve(sub));
    });

    it('resolves a relative path against the injected cwd', () => {
      const sub = path.join(tempDir, 'feature', 'widget');
      fs.mkdirSync(sub, { recursive: true });
      touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
      expect(resolveCliMutatingProjectRoot('feature/widget', tempDir)).toBe(path.resolve(sub));
    });

    it('does not adopt an ancestor .homegraph when path is explicit', () => {
      plantHomeGraphDb(tempDir);
      const child = path.join(tempDir, 'scene_board_ext');
      fs.mkdirSync(child, { recursive: true });
      // Child is NOT initialized and has no profile — still literal.
      expect(resolveCliMutatingProjectRoot(child, child)).toBe(path.resolve(child));
      expect(isInitialized(resolveCliMutatingProjectRoot(child, child))).toBe(false);
      expect(isInitialized(tempDir)).toBe(true);
    });

    it('treats whitespace-only pathArg as omitted (falls through to discovery)', () => {
      touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
      const sub = path.join(tempDir, 'entry');
      fs.mkdirSync(sub, { recursive: true });
      expect(resolveCliMutatingProjectRoot('   ', sub)).toBe(path.resolve(tempDir));
      expect(resolveCliMutatingProjectRoot('', sub)).toBe(path.resolve(tempDir));
      expect(resolveCliMutatingProjectRoot(null, sub)).toBe(path.resolve(tempDir));
      expect(resolveCliMutatingProjectRoot(undefined, sub)).toBe(path.resolve(tempDir));
    });

    it('explicit path to a non-existent directory still resolves literally (callers handle missing)', () => {
      const missing = path.join(tempDir, 'does-not-exist-yet');
      expect(resolveCliMutatingProjectRoot(missing, tempDir)).toBe(path.resolve(missing));
      expect(resolveCliMutatingProjectRoot('does-not-exist-yet', tempDir)).toBe(path.resolve(missing));
    });
  });

  describe('omitted path (Harmony discovery from cwd)', () => {
    it('uses cwd when cwd itself has build-profile.json5', () => {
      touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
      expect(resolveCliMutatingProjectRoot(undefined, tempDir)).toBe(path.resolve(tempDir));
    });

    it('walks up from a nested cwd to the Harmony root', () => {
      touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
      const deep = path.join(tempDir, 'product', 'phone', 'src');
      fs.mkdirSync(deep, { recursive: true });
      expect(resolveCliMutatingProjectRoot(undefined, deep)).toBe(path.resolve(tempDir));
      expect(resolveCliMutatingProjectRoot(undefined, path.join(tempDir, 'product'))).toBe(
        path.resolve(tempDir)
      );
    });

    it('falls back to cwd when no build-profile.json5 exists on the chain', () => {
      const deep = path.join(tempDir, 'src', 'main');
      fs.mkdirSync(deep, { recursive: true });
      expect(resolveCliMutatingProjectRoot(undefined, deep)).toBe(path.resolve(deep));
    });

    it('ignores an ancestor .homegraph outside the Harmony root (harness hijack regression)', () => {
      // Layout mirrors the scene_board_ext / codegenie accident:
      //   harness/                 ← has .homegraph (wrong)
      //   harness/scene_board_ext/ ← has build-profile.json5 (correct)
      //   harness/scene_board_ext/feature/foo/  ← user cwd
      const harness = path.join(tempDir, 'harness');
      const app = path.join(harness, 'scene_board_ext');
      const cwd = path.join(app, 'feature', 'foo');
      fs.mkdirSync(cwd, { recursive: true });
      plantHomeGraphDb(harness);
      touch(path.join(app, 'build-profile.json5'), '{ modules: [] }\n');

      const resolved = resolveCliMutatingProjectRoot(undefined, cwd);
      expect(resolved).toBe(path.resolve(app));
      expect(resolved).not.toBe(path.resolve(harness));
      expect(isInitialized(harness)).toBe(true);
      expect(isInitialized(app)).toBe(false);
    });

    it('ignores ancestor .homegraph when there is no Harmony profile either (stay at cwd)', () => {
      const parent = path.join(tempDir, 'parent');
      const child = path.join(parent, 'child');
      fs.mkdirSync(child, { recursive: true });
      plantHomeGraphDb(parent);
      // Old resolveProjectPath would return parent; Spec 0061 must return child.
      expect(resolveCliMutatingProjectRoot(undefined, child)).toBe(path.resolve(child));
    });

    it('when Harmony root already has .homegraph, still resolves to that Harmony root', () => {
      touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
      plantHomeGraphDb(tempDir);
      const deep = path.join(tempDir, 'entry', 'src');
      fs.mkdirSync(deep, { recursive: true });
      expect(resolveCliMutatingProjectRoot(undefined, deep)).toBe(path.resolve(tempDir));
      expect(isInitialized(tempDir)).toBe(true);
    });

    it('nested Harmony apps: cwd under apps/A uses A, not monorepo parent profile', () => {
      touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
      const appA = path.join(tempDir, 'apps', 'A');
      touch(path.join(appA, 'build-profile.json5'), '{ modules: [] }\n');
      const cwd = path.join(appA, 'entry');
      fs.mkdirSync(cwd, { recursive: true });
      expect(resolveCliMutatingProjectRoot(undefined, cwd)).toBe(path.resolve(appA));
    });
  });

  describe('explicit vs omitted contrast (same tree)', () => {
    it('omitted path lifts to profile root; explicit subdir path stays put', () => {
      touch(path.join(tempDir, 'build-profile.json5'), '{ modules: [] }\n');
      const sub = path.join(tempDir, 'feature', 'x');
      fs.mkdirSync(sub, { recursive: true });

      expect(resolveCliMutatingProjectRoot(undefined, sub)).toBe(path.resolve(tempDir));
      expect(resolveCliMutatingProjectRoot(sub, os.tmpdir())).toBe(path.resolve(sub));
      expect(resolveCliMutatingProjectRoot('.', sub)).toBe(path.resolve(sub));
    });
  });
});
