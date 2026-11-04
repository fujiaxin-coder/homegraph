#!/usr/bin/env node
/**
 * L2/L3 soak entry — one command, one report.
 *
 *   node test/harmony-callgraph-soak/run.mjs --project D:/code/applications_photos
 *   node test/harmony-callgraph-soak/run.mjs --project ... --skip-index
 *   node test/harmony-callgraph-soak/run.mjs --skip-clone   # uses photos.lock localHint
 *
 * Does NOT run under vitest / npm test.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveProject, gitHead } from './lib/clone.mjs';
import { indexProject, packageVersions } from './lib/index-project.mjs';
import { loadGold, activeOnly } from './lib/load-gold.mjs';
import { scoreL2 } from './lib/metrics-l2.mjs';
import { scoreL3, writeBaselineSuggestion, loadBaseline } from './lib/metrics-l3.mjs';
import { writeReport } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');

function parseArgs(argv) {
  const out = {
    project: null,
    skipClone: false,
    skipIndex: false,
    workdir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--skip-clone') out.skipClone = true;
    else if (a === '--skip-index') out.skipIndex = true;
    else if (a === '--workdir') out.workdir = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node run.mjs [--project <path>] [--skip-clone] [--skip-index]`);
    process.exit(0);
  }

  const { root, lock } = resolveProject({
    project: args.project,
    workdir: args.workdir,
    skipClone: args.skipClone || !args.project,
  });
  const head = gitHead(root);
  console.error(`Project: ${root}`);
  console.error(`HEAD: ${head} (lock ${lock.commit})`);
  if (head && head !== lock.commit) {
    console.error(
      `WARN: HEAD != lock commit. Gold assumes ${lock.commit}. Re-checkout or refresh gold.`
    );
  }

  const gold = loadGold();
  console.error(
    `Gold: must=${gold.must.length} must-not=${gold.mustNot.length}`
  );

  const indexed = await indexProject(root, { skipIndex: args.skipIndex });
  try {
    const l2 = scoreL2(indexed.edges, gold);
    const baseline = loadBaseline();
    const l3 = scoreL3(indexed.stats, baseline);
    const vers = packageVersions();

    const notes = [];
    if (!baseline) {
      const cand = writeBaselineSuggestion(OUT, indexed.stats, head || lock.commit);
      notes.push(
        `No L3 baseline yet — wrote candidate ${path.relative(HERE, cand)}. Review then copy to baseline/photos.stats.json.`
      );
    }
    if (head && head !== lock.commit) {
      notes.push('HEAD diverges from fixtures/photos.lock.json commit.');
    }
    notes.push(
      'Gold is source-proven JSON (not vitest). Set edge.status="deferred" to exclude from L2 scores while tracking a bug.'
    );

    const doc = {
      generatedAt: new Date().toISOString(),
      meta: {
        root,
        lockCommit: lock.commit,
        head,
        indexMs: indexed.meta.indexMs,
        mustCount: gold.must.length,
        mustNotCount: gold.mustNot.length,
        mustActive: activeOnly(gold.must).length,
        mustNotActive: activeOnly(gold.mustNot).length,
        ...vers,
      },
      l2,
      l3,
      graphStats: indexed.stats,
      notes,
    };

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(
      path.join(OUT, 'index-meta.json'),
      JSON.stringify({ ...indexed.meta, stats: indexed.stats, vers }, null, 2) + '\n'
    );
    const { mdPath, jsonPath } = writeReport(OUT, doc);
    console.error(`Report: ${mdPath}`);
    console.error(`JSON:   ${jsonPath}`);
    console.log(mdPath);

    // Non-zero if hard L2 collapse or L3 alerts — still a report tool, not CI unit test.
    const recall = l2.overall.must.recall ?? 1;
    const hold = l2.overall.mustNot.mustNotHoldRate ?? 1;
    if (recall < 0.5 || hold < 0.5 || (l3.alerts || []).some((a) => a.band === 'alert')) {
      process.exitCode = 2;
    }
  } finally {
    indexed.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
