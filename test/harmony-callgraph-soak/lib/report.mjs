import fs from 'fs';
import path from 'path';
import { renderHtml } from './report-html.mjs';

function pct(x) {
  if (x == null || Number.isNaN(x)) return 'n/a';
  return `${(x * 100).toFixed(1)}%`;
}

function pctMapTable(title, pack) {
  const lines = [`### ${title}`, '', `| key | count | share |`, `| --- | ---: | ---: |`];
  const entries = Object.entries(pack.by || {}).sort((a, b) => b[1].count - a[1].count);
  for (const [k, v] of entries) {
    lines.push(`| ${k} | ${v.count} | ${v.pct}% |`);
  }
  lines.push('', `Total: ${pack.total}`, '');
  return lines.join('\n');
}

function splitTable(title, map) {
  const lines = [
    `### ${title}`,
    '',
    `| key | G+ | hit | recall | G- | viol | viol-rate |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |`,
  ];
  for (const [k, v] of Object.entries(map || {})) {
    lines.push(
      `| ${k} | ${v.gPlus} | ${v.hitPlus} | ${pct(v.recall)} | ${v.gMinus} | ${v.viol} | ${pct(v.mustNotViolationRate)} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function sectionMust(title, s) {
  const lines = [
    `### ${title}`,
    '',
    `| metric | value |`,
    `| --- | --- |`,
    `| eligible (label=true) | ${s.eligible} |`,
    `| unknown (excl.) | ${s.unknown ?? 0} |`,
    `| deferred (excl.) | ${s.deferred ?? 0} |`,
    `| hit | ${s.hit} |`,
    `| miss | ${s.miss} |`,
    `| **Recall** | **${pct(s.recall)}** |`,
    '',
  ];
  if (s.misses?.length) {
    lines.push('Misses (sample):', '');
    for (const m of s.misses) lines.push(`- ${m}`);
    lines.push('');
  }
  return lines.join('\n');
}

function sectionMustNot(title, s) {
  const lines = [
    `### ${title}`,
    '',
    `| metric | value |`,
    `| --- | --- |`,
    `| eligible (label=false) | ${s.eligible} |`,
    `| unknown (excl.) | ${s.unknown ?? 0} |`,
    `| deferred (excl.) | ${s.deferred ?? 0} |`,
    `| clean (absent) | ${s.hit} |`,
    `| violations | ${s.miss} |`,
    `| **Must-not violation rate** | **${pct(s.mustNotViolationRate)}** |`,
    `| must-not hold rate | ${pct(s.mustNotHoldRate)} |`,
    '',
  ];
  if (s.violations?.length) {
    lines.push('Violations:', '');
    for (const m of s.violations) lines.push(`- ${m}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderMarkdown(doc) {
  const lines = [];
  lines.push(`# HomeGraph L2/L3 soak report — applications_photos`);
  lines.push('');
  lines.push(`Generated: ${doc.generatedAt}`);
  lines.push('');
  lines.push('## Meta');
  lines.push('');
  lines.push(`- project: \`${doc.meta.root}\``);
  lines.push(`- lock commit: \`${doc.meta.lockCommit}\``);
  lines.push(`- HEAD: \`${doc.meta.head || 'n/a'}\``);
  lines.push(`- homegraph: \`${doc.meta.homegraphVersion || 'n/a'}\``);
  lines.push(`- arkanalyzer: \`${doc.meta.arkanalyzer || 'n/a'}\``);
  lines.push(`- indexMs: ${doc.meta.indexMs}`);
  lines.push(`- must gold: ${doc.meta.mustCount} (eligible scored separately)`);
  lines.push(`- must-not gold: ${doc.meta.mustNotCount}`);
  lines.push('');

  // Coverage first — user asked for proportions in report
  lines.push('## Gold coverage (diversity)');
  lines.push('');
  lines.push(
    'Gold is stratified so edge kinds / scopes / suites each hold a share (not only simple same-file calls).'
  );
  lines.push('');
  if (doc.coverage?.goldMust) {
    lines.push(pctMapTable('Must gold — by edge kind', doc.coverage.goldMust.kind));
    lines.push(pctMapTable('Must gold — by scope', doc.coverage.goldMust.scope));
    lines.push(pctMapTable('Must gold — by suite', doc.coverage.goldMust.suite));
    lines.push(pctMapTable('Must gold — by bucket', doc.coverage.goldMust.bucket));
    lines.push(pctMapTable('Must gold — caller node kind', doc.coverage.goldMust.callerNodeKind));
    lines.push(pctMapTable('Must gold — callee node kind', doc.coverage.goldMust.calleeNodeKind));
  }
  if (doc.coverage?.goldMustNot) {
    lines.push(pctMapTable('Must-not gold — by edge kind', doc.coverage.goldMustNot.kind));
    lines.push(pctMapTable('Must-not gold — by scope', doc.coverage.goldMustNot.scope));
  }
  if (doc.coverage?.alerts?.length) {
    lines.push('### Coverage floor alerts');
    lines.push('');
    for (const a of doc.coverage.alerts) lines.push(`- ${a}`);
    lines.push('');
  }

  lines.push('## Indexed graph coverage (whole repo)');
  lines.push('');
  if (doc.coverage?.graph) {
    lines.push(pctMapTable('Nodes by kind', doc.coverage.graph.nodesByKind));
    lines.push(pctMapTable('Edges by kind', doc.coverage.graph.edgesByKind));
  }

  lines.push('## L2 — sampled gold quality (dual arms)');
  lines.push('');
  const ark = doc.l2.overallArk || doc.l2.overall || {};
  const all = doc.l2.overallAll || {};
  const lift = doc.l2.heuristicLift || {};

  function armBlock(title, o) {
    const lines = [];
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(sectionMust('MUST (Recall)', o.must || {}));
    lines.push(sectionMustNot('MUST-NOT', o.mustNot || {}));
    const prec = o.precision || {};
    lines.push('### Precision@gold');
    lines.push('');
    lines.push(`| metric | value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| \\|E ∩ G+\\| | ${prec.inEPlus ?? 'n/a'} |`);
    lines.push(`| \\|E ∩ (G+ ∪ G-)\\| | ${prec.inEUnion ?? 'n/a'} |`);
    lines.push(`| **Precision@gold** | **${pct(prec.precisionAtGold)}** |`);
    lines.push('');
    const reach = o.reachabilityAtK || {};
    lines.push('### Reachability@k');
    lines.push('');
    lines.push(`| metric | value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| k | ${reach.k ?? 'n/a'} |`);
    lines.push(`| seeds | ${reach.seeds ?? 'n/a'} |`);
    lines.push(`| G+ call callees | ${reach.goldCalls ?? 'n/a'} |`);
    lines.push(`| reachable | ${reach.reachable ?? 'n/a'} |`);
    lines.push(`| **rate** | **${pct(reach.rate)}** |`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(armBlock('Arm A — ArkAnalyzer only (calls = AA)', ark));
  lines.push(armBlock('Arm B — All calls (AA ∪ HG heuristic)', all));

  lines.push('## Heuristic lift (B − A)');
  lines.push('');
  lines.push(`| metric | Δ |`);
  lines.push(`| --- | ---: |`);
  lines.push(
    `| Recall | ${lift.recall == null ? 'n/a' : (lift.recall * 100).toFixed(1) + ' pp'} |`
  );
  lines.push(
    `| Precision@gold | ${lift.precisionAtGold == null ? 'n/a' : (lift.precisionAtGold * 100).toFixed(1) + ' pp'} |`
  );
  lines.push(
    `| Must-not violation | ${lift.mustNotViolationRate == null ? 'n/a' : (lift.mustNotViolationRate * 100).toFixed(1) + ' pp'} |`
  );
  lines.push(
    `| Reachability@k | ${lift.reachabilityAtK == null ? 'n/a' : (lift.reachabilityAtK * 100).toFixed(1) + ' pp'} |`
  );
  lines.push('');
  lines.push(lift.note || 'all − ark');
  lines.push('');

  const prov = doc.l2.provenance;
  if (prov?.metrics) {
    lines.push('## L2 provenance — AA vs HG-heuristic (additive)');
    lines.push('');
    lines.push(prov.note || '');
    lines.push('');
    lines.push(
      '**direct** = uniquely bound callee; **indirect** = unbound/virtual/callback (AA dispatch only).'
    );
    lines.push('');
    const inv = prov.inventory || {};
    lines.push('### Call inventory');
    lines.push('');
    lines.push(`| class | count |`);
    lines.push(`| --- | ---: |`);
    lines.push(`| arkanalyzer | ${inv.byProvenanceClass?.arkanalyzer ?? 0} |`);
    lines.push(`| hg-heuristic | ${inv.byProvenanceClass?.['hg-heuristic'] ?? 0} |`);
    lines.push(`| callsTotal | ${inv.callsTotal ?? 0} |`);
    lines.push('');
    if (inv.bySynthesizedBy) {
      lines.push('| synthesizedBy | count |');
      lines.push('| --- | ---: |');
      for (const [k, v] of Object.entries(inv.bySynthesizedBy).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${k} | ${v} |`);
      }
      lines.push('');
    }
    lines.push('### Call-gold metrics by edge pool');
    lines.push('');
    lines.push(
      `| pool | recall | hit/eligible | must-not viol | Precision@gold |`
    );
    lines.push(`| --- | ---: | ---: | ---: | ---: |`);
    for (const key of ['arkanalyzer', 'hg-heuristic', 'aa+hg-all']) {
      const arm = prov.metrics[key];
      if (!arm) continue;
      lines.push(
        `| ${key} | ${pct(arm.recall)} | ${arm.hit}/${arm.eligibleMust} | ${pct(arm.mustNotViolationRate)} | ${pct(arm.precisionAtGold)} |`
      );
    }
    lines.push('');
    const attr = prov.mustCallAttribution || {};
    lines.push('### Must-call attribution');
    lines.push('');
    lines.push(`| metric | value |`);
    lines.push(`| --- | ---: |`);
    lines.push(`| eligible G+ calls | ${attr.eligible ?? 0} |`);
    lines.push(`| arkOnlyHit | ${attr.arkOnlyHit ?? 0} |`);
    lines.push(`| heuristicOnlyHit | ${attr.heuristicOnlyHit ?? 0} |`);
    lines.push(`| bothHit | ${attr.bothHit ?? 0} |`);
    lines.push(`| neither | ${attr.neither ?? 0} |`);
    lines.push(
      `| **heuristicRecallLift** | **${attr.heuristicRecallLift == null ? 'n/a' : (attr.heuristicRecallLift * 100).toFixed(1) + ' pp'}** |`
    );
    lines.push('');
  }

  if (doc.l2.splits) {
    lines.push('## L2 splits (direct/indirect · scope · suite · kind)');
    lines.push('');
    lines.push(splitTable('By dispatch (calls)', doc.l2.splits.byDispatch));
    lines.push(splitTable('By scope', doc.l2.splits.byScope));
    lines.push(splitTable('By suite (prod/test)', doc.l2.splits.bySuite));
    lines.push(splitTable('By edge kind', doc.l2.splits.byKind));
    lines.push(splitTable('By bucket', doc.l2.splits.byBucket));
    lines.push(splitTable('Top module pairs', doc.l2.splits.byModulePairTop));
  }

  for (const b of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    const pack = doc.l2.byBucket?.[b];
    if (!pack) continue;
    lines.push(`## Bucket ${b}`);
    lines.push('');
    lines.push(sectionMust('MUST', pack.must));
    lines.push(sectionMustNot('MUST-NOT', pack.mustNot));
  }

  lines.push('## L3 — scale / distribution guards');
  lines.push('');
  const l3 = doc.l3 || {};
  const cur = l3.current || {};
  lines.push('### Snapshot');
  lines.push('');
  lines.push(`| metric | value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| arkCallsDirect | ${cur.arkCallsDirect ?? 'n/a'} |`);
  lines.push(`| arkCallsIndirect | ${cur.arkCallsIndirect ?? 'n/a'} |`);
  lines.push(`| arkCallsTotal | ${cur.arkCallsTotal ?? 'n/a'} |`);
  lines.push(`| hg-heuristic calls | ${cur.callHeuristic ?? 'n/a'} |`);
  lines.push(`| indirect/direct ratio (AA) | ${cur.indirectDirectRatio ?? 'n/a'} |`);
  lines.push(`| fanoutTop10Share | ${cur.fanoutTop10Share ?? 'n/a'} |`);
  lines.push(`| zeroCallFileCount | ${cur.zeroCallFileCount ?? 'n/a'} |`);
  lines.push(`| nodes / edges | ${cur.nodes ?? 'n/a'} / ${cur.edges ?? 'n/a'} |`);
  lines.push('');
  lines.push(
    'direct = uniquely bound callee; indirect = virtual/callback/unbound (AA only). Ratio = indirect density vs direct.'
  );
  lines.push('');

  if (l3.absoluteGuards?.length) {
    lines.push('### Absolute densify guards');
    lines.push('');
    for (const a of l3.absoluteGuards) {
      lines.push(
        `- **${a.band}** ${a.name}: current=${a.current} limit=${a.limit}${a.note ? ` (${a.note})` : ''}`
      );
    }
    lines.push('');
  }

  if (doc.notes?.length) {
    lines.push('## Notes');
    lines.push('');
    for (const n of doc.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  // Appendix — formulas
  lines.push('## Appendix A — metric definitions');
  lines.push('');
  lines.push('Let:');
  lines.push('');
  lines.push('- \\(G^+\\) = must gold with `label=true`, `status=active` (noise filtered)');
  lines.push('- \\(G^-\\) = must-not gold with `label=false`, `status=active`');
  lines.push('- `unknown` / `deferred` **never** enter P/R denominators');
  lines.push(
    '- \\(E\\) = indexed edges; for `kind=calls` only `synthesizedBy=arkanalyzer` (or missing synth)'
  );
  lines.push('- Match key: `kind` + files + names (`%AM*$name` wrappers allowed; import callee may be file basename)');
  lines.push('');
  lines.push('| Metric | Formula |');
  lines.push('| --- | --- |');
  lines.push('| **Recall** | \\(\\lvert E \\cap G^+ \\rvert / \\lvert G^+ \\rvert\\) |');
  lines.push(
    '| **Precision@gold** | \\(\\lvert E \\cap G^+ \\rvert / \\lvert E \\cap (G^+ \\cup G^-) \\rvert\\) |'
  );
  lines.push('| **Must-not violation rate** | \\(\\lvert E \\cap G^- \\rvert / \\lvert G^- \\rvert\\) (target ≈ 0) |');
  lines.push(
    '| **Reachability@k** | fraction of \\(G^+\\) call *callees* reachable in ≤ k hops from DummyMain / lifecycle seeds along ark calls |'
  );
  lines.push(
    '| **arkCallsDirect** | AA calls with uniquely bound callee (`dispatch=direct`) |'
  );
  lines.push(
    '| **arkCallsIndirect** | AA calls with unbound/virtual/callback target (`dispatch=indirect`) |'
  );
  lines.push(
    '| **indirectDirectRatio** | arkCallsIndirect / arkCallsDirect — density of indirect vs direct AA edges |'
  );
  lines.push(
    '| **callHeuristic** | calls with `synthesizedBy ≠ arkanalyzer` (HomeGraph synthesis) |'
  );
  lines.push('| **fanoutTop10Share** | sum(inDegree of top-10 callees) / callEdges |');
  lines.push('| **zeroCallFileCount** | `.ets` file nodes with no outbound calls |');
  lines.push(
    '| **heuristicLift.*** | metric(all) − metric(ark) for Recall / Precision@gold / must-not / Reachability |'
  );
  lines.push('');
  lines.push('### Evidence');
  lines.push('');
  lines.push(
    'Each gold edge carries `evidence: file:line` (caller site) and `label: true|false|unknown`. Re-annotate by editing JSON; set `status: deferred` + `bug` when HG is wrong but gold is kept.'
  );
  lines.push('');
  lines.push('### Splits & provenance');
  lines.push('');
  lines.push(
    'Report breaks Recall / must-not by **dispatch** (direct/indirect), **scope**, **suite**, **edge kind**, and **bucket**. Separately, provenance arms score call golds against **arkanalyzer**, **hg-heuristic**, and **aa+hg-all** pools without changing the default AA-scoped KPIs.'
  );
  lines.push('');

  return lines.join('\n');
}

export function writeReport(outDir, doc) {
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, 'report.md');
  const jsonPath = path.join(outDir, 'report.json');
  const htmlPath = path.join(outDir, 'report.html');
  const qualityPath = path.join(outDir, 'call-graph-quality.json');
  fs.writeFileSync(mdPath, renderMarkdown(doc));
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n');
  fs.writeFileSync(htmlPath, renderHtml(doc));
  // Compact machine-readable quality artifact (validation-style)
  const quality = {
    generatedAt: doc.generatedAt,
    meta: doc.meta,
    l2: {
      ark: {
        recall: doc.l2?.overallArk?.must?.recall ?? doc.l2?.overall?.must?.recall ?? null,
        precisionAtGold:
          doc.l2?.overallArk?.precision?.precisionAtGold ??
          doc.l2?.overall?.precision?.precisionAtGold ??
          null,
        mustNotViolationRate:
          doc.l2?.overallArk?.mustNot?.mustNotViolationRate ??
          doc.l2?.overall?.mustNot?.mustNotViolationRate ??
          null,
        reachabilityAtK:
          doc.l2?.overallArk?.reachabilityAtK ?? doc.l2?.overall?.reachabilityAtK ?? null,
      },
      all: {
        recall: doc.l2?.overallAll?.must?.recall ?? null,
        precisionAtGold: doc.l2?.overallAll?.precision?.precisionAtGold ?? null,
        mustNotViolationRate: doc.l2?.overallAll?.mustNot?.mustNotViolationRate ?? null,
        reachabilityAtK: doc.l2?.overallAll?.reachabilityAtK ?? null,
      },
      heuristicLift: doc.l2?.heuristicLift ?? null,
      splits: doc.l2?.splits ?? null,
      provenance: doc.l2?.provenance ?? null,
    },
    l3: {
      current: doc.l3?.current ?? null,
      absoluteGuards: doc.l3?.absoluteGuards ?? [],
    },
    coverage: doc.coverage ?? null,
  };
  fs.writeFileSync(qualityPath, JSON.stringify(quality, null, 2) + '\n');
  return { mdPath, jsonPath, htmlPath, qualityPath };
}
