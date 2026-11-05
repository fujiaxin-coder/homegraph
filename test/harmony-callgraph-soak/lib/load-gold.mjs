import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLD = path.resolve(HERE, '..', 'gold');

const BUCKET_FILES = [
  'A-cross-module.json',
  'B-non-rta-helper.json',
  'C-fanout.json',
  'D-same-module.json',
  'E-lifecycle-ui.json',
  'F-import-heritage.json',
  'G-hg-heuristic.json',
];

function readEdges(file) {
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(doc.edges) ? doc.edges : [];
}

export function loadGold() {
  const must = [];
  const mustNot = [];
  const byBucket = {};
  for (const name of BUCKET_FILES) {
    const bucket = name[0];
    const m = readEdges(path.join(GOLD, 'must', name));
    const n = readEdges(path.join(GOLD, 'must-not', name));
    byBucket[bucket] = { must: m, mustNot: n };
    must.push(...m);
    mustNot.push(...n);
  }
  return { must, mustNot, byBucket, files: BUCKET_FILES };
}

export function activeOnly(edges) {
  return edges.filter((e) => (e.status || 'active') === 'active');
}

export function deferredOnly(edges) {
  return edges.filter((e) => e.status === 'deferred');
}
