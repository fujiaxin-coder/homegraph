import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { vendoredWasmFilenames } from '../src/extraction/grammars';

const ROOT = path.join(__dirname, '..');
const LIST_PATH = path.join(ROOT, 'src/extraction/vendored-wasm-files.json');
const DIST_WASM = path.join(ROOT, 'dist/extraction/wasm');

describe('copy-assets vendored wasm list (Spec 0031)', () => {
  it('JSON list matches VENDORED_WASM_LANGS ∩ WASM_GRAMMAR_FILES', () => {
    const listed = (JSON.parse(fs.readFileSync(LIST_PATH, 'utf8')) as string[]).slice().sort();
    expect(listed).toEqual(vendoredWasmFilenames());
  });

  it('does not include tree-sitter-arkts.wasm', () => {
    const listed = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8')) as string[];
    expect(listed).not.toContain('tree-sitter-arkts.wasm');
  });

  it('does not copy unlisted wasm and strips source maps', () => {
    fs.mkdirSync(DIST_WASM, { recursive: true });
    const strayWasm = path.join(DIST_WASM, 'tree-sitter-arkts.wasm');
    const strayMap = path.join(ROOT, 'dist', '_0031-strip.js.map');
    fs.writeFileSync(strayWasm, 'not-a-grammar');
    fs.writeFileSync(strayMap, '{"version":3}');

    const result = spawnSync(process.execPath, ['scripts/copy-assets.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.existsSync(strayWasm)).toBe(false);
    expect(fs.existsSync(strayMap)).toBe(false);

    const listed = new Set(JSON.parse(fs.readFileSync(LIST_PATH, 'utf8')) as string[]);
    const onDisk = fs.readdirSync(DIST_WASM).filter((f) => f.endsWith('.wasm')).sort();
    expect(onDisk).toEqual([...listed].sort());
  });
});
