#!/usr/bin/env node
/**
 * L2/L3 soak entry — one command, one report (+ call-graph-quality.json).
 *
 *   npm run soak:photos -- --project D:/code/applications_photos --skip-index
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveProject, gitHead } from './lib/clone.mjs';
import { indexProject, packageVersions } from './lib/index-project.mjs';
import { loadGold, activeOnly } from './lib/load-gold.mjs';
import { scoreL2 } from './lib/metrics-l2.mjs';
import {
  scoreL3,
  writeBaselineSuggestion,
  loadBaseline,
  installBaselineFromCandidate,
} from './lib/metrics-l3.mjs';
import { writeReport } from './lib/report.mjs';
import {
  goldCoverage,
  graphCoverage,
  coverageAlerts,
} from './lib/coverage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');

function parseArgs(argv) {
  const out = {
    project: null,
    skipClone: false,
    skipIndex: false,
    workdir: null,
    installBaseline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--skip-clone') out.skipClone = true;
    else if (a === '--skip-index') out.skipIndex = true;
    else if (a === '--workdir') out.workdir = argv[++i];
    else if (a === '--install-baseline') out.installBaseline = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      `Usage: node run.mjs [--project <path>] [--skip-clone] [--skip-index] [--install-baseline]`
    );
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

  const gold = loadGold();
  console.error(`Gold: must=${gold.must.length} must-not=${gold.mustNot.length}`);

  const indexed = await indexProject(root, { skipIndex: args.skipIndex });
  try {
    const l2 = scoreL2(indexed.edges, gold);
    let baseline = loadBaseline();
    const candPath = writeBaselineSuggestion(OUT, indexed.stats, head || lock.commit);
    if (!baseline && args.installBaseline) {
      installBaselineFromCandidate(candPath, head || lock.commit);
      baseline = loadBaseline();
      console.error('Installed baseline/photos.stats.json from candidate');
    }
    // Auto-install baseline once if missing (so L3 section is useful)
    if (!baseline) {
      installBaselineFromCandidate(candPath, head || lock.commit);
      baseline = loadBaseline();
      console.error('No baseline yet — installed current snapshot as baseline/photos.stats.json');
    }
    const l3 = scoreL3(indexed.stats, baseline);
    const vers = packageVersions();

    const goldMustCov = goldCoverage(gold.must);
    const goldMustNotCov = goldCoverage(gold.mustNot);
    const coverage = {
      goldMust: goldMustCov,
      goldMustNot: goldMustNotCov,
      graph: graphCoverage(indexed.stats),
      alerts: coverageAlerts(goldMustCov),
    };

    const notes = [];
    if (head && head !== lock.commit) {
      notes.push('HEAD diverges from fixtures/photos.lock.json commit.');
    }
    notes.push(
      'Gold uses label=true|false|unknown + evidence file:line. unknown/deferred excluded from P/R.'
    );
    notes.push(
      'Default KPIs score calls on arkanalyzer only; L2 provenance adds hg-heuristic and aa+hg-all arms for HomeGraph contribution.'
    );
    if (coverage.alerts.length) {
      notes.push(`Gold diversity floor alerts: ${coverage.alerts.length}`);
    }

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
      coverage,
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
    const { mdPath, jsonPath, htmlPath, qualityPath } = writeReport(OUT, doc);
    console.error(`Report:  ${mdPath}`);
    console.error(`HTML:    ${htmlPath}`);
    console.error(`JSON:    ${jsonPath}`);
    console.error(`Quality: ${qualityPath}`);
    console.log(htmlPath);

    const recallAll = l2.overallAll?.must?.recall ?? l2.overall?.must?.recall ?? 1;
    const violAll =
      l2.overallAll?.mustNot?.mustNotViolationRate ??
      l2.overall?.mustNot?.mustNotViolationRate ??
      0;
    if (
      recallAll < 0.5 ||
      violAll > 0.2 ||
      (l3.absoluteGuards || []).some((a) => a.band === 'alert')
    ) {
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
