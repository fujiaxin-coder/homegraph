#!/usr/bin/env node
/**
 * Copy runtime assets into dist/ after tsc (Spec 0031).
 *
 * - schema.sql (db + spec/db)
 * - vendored grammar WASM listed in src/extraction/vendored-wasm-files.json
 *   (not a blind readdir of src/extraction/wasm/)
 * - strip *.js.map / *.d.ts.map from dist so the published package has no debug maps
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmListPath = path.join(root, 'src/extraction/vendored-wasm-files.json');
const srcWasmDir = path.join(root, 'src/extraction/wasm');
const distWasmDir = path.join(root, 'dist/extraction/wasm');
const distDir = path.join(root, 'dist');

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

const wasmFiles = JSON.parse(fs.readFileSync(wasmListPath, 'utf8'));
if (!Array.isArray(wasmFiles) || wasmFiles.some((f) => typeof f !== 'string' || !f.endsWith('.wasm'))) {
  console.error(`copy-assets: ${wasmListPath} must be a JSON array of *.wasm filenames`);
  process.exit(1);
}

copyFile(path.join(root, 'src/db/schema.sql'), path.join(root, 'dist/db/schema.sql'));
copyFile(path.join(root, 'src/spec/db/schema.sql'), path.join(root, 'dist/spec/db/schema.sql'));

fs.mkdirSync(distWasmDir, { recursive: true });
for (const name of wasmFiles) {
  const from = path.join(srcWasmDir, name);
  if (!fs.existsSync(from)) {
    console.error(`copy-assets: missing vendored wasm ${from}`);
    process.exit(1);
  }
  copyFile(from, path.join(distWasmDir, name));
}

// Drop leftover unlisted wasm from a previous blind copy.
if (fs.existsSync(distWasmDir)) {
  for (const name of fs.readdirSync(distWasmDir)) {
    if (name.endsWith('.wasm') && !wasmFiles.includes(name)) {
      fs.rmSync(path.join(distWasmDir, name), { force: true });
    }
  }
}

function stripMaps(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      stripMaps(full);
      continue;
    }
    if (ent.name.endsWith('.js.map') || ent.name.endsWith('.d.ts.map')) {
      fs.rmSync(full, { force: true });
    }
  }
}

stripMaps(distDir);
