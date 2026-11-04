import fs from 'fs';
import path from 'path';

function pct(x) {
  if (x == null || Number.isNaN(x)) return 'n/a';
  return `${(x * 100).toFixed(1)}%`;
}

function sectionMust(title, s) {
  const lines = [
    `### ${title}`,
    '',
    `| metric | value |`,
    `| --- | --- |`,
    `| active gold | ${s.active} |`,
    `| deferred | ${s.deferred} |`,
    `| skipped noise | ${s.skippedNoise ?? 0} |`,
    `| hit | ${s.hit} |`,
    `| miss | ${s.miss} |`,
    `| recall | ${pct(s.recall)} |`,
    '',
  ];
  if (s.misses?.length) {
    lines.push('Misses (sample):', '');
    for (const m of s.misses) lines.push(`- ${m}`);
    lines.push('');
  }
  if (s.deferredStillBroken?.length) {
    lines.push('Deferred still broken:', '');
    for (const m of s.deferredStillBroken) lines.push(`- ${m}`);
    lines.push('');
  }
  if (s.deferredFixed?.length) {
    lines.push('Deferred now fixed (consider activating):', '');
    for (const m of s.deferredFixed) lines.push(`- ${m}`);
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
    `| active gold | ${s.active} |`,
    `| deferred | ${s.deferred} |`,
    `| clean (absent) | ${s.hit} |`,
    `| violations | ${s.miss} |`,
    `| must-not hold rate | ${pct(s.mustNotHoldRate ?? s.precision)} |`,
    '',
  ];
  if (s.violations?.length) {
    lines.push('Violations (dirty edges present):', '');
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
  lines.push(`- must gold: ${doc.meta.mustCount} (active ${doc.meta.mustActive})`);
  lines.push(`- must-not gold: ${doc.meta.mustNotCount} (active ${doc.meta.mustNotActive})`);
  lines.push('');

  lines.push('## L2 — sampled gold quality');
  lines.push('');
  lines.push(sectionMust('Overall MUST (recall)', doc.l2.overall.must));
  lines.push(sectionMustNot('Overall MUST-NOT', doc.l2.overall.mustNot));

  for (const b of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const pack = doc.l2.byBucket[b];
    if (!pack) continue;
    lines.push(`## Bucket ${b}`);
    lines.push('');
    lines.push(sectionMust(`MUST`, pack.must));
    lines.push(sectionMustNot(`MUST-NOT`, pack.mustNot));
  }

  lines.push('## L3 — scale / distribution guards');
  lines.push('');
  if (!doc.l3.hasBaseline) {
    lines.push(doc.l3.message || 'No baseline.');
    lines.push('');
    lines.push('Current snapshot:');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(doc.l3.current, null, 2));
    lines.push('```');
  } else {
    lines.push(`Baseline commit: \`${doc.l3.baselineCommit || 'n/a'}\``);
    lines.push('');
    lines.push('| metric | previous | current | Δ% | band |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const d of doc.l3.deltas) {
      lines.push(
        `| ${d.name} | ${d.previous} | ${d.current} | ${d.deltaPct ?? 'n/a'} | ${d.band} |`
      );
    }
    lines.push('');
    if (doc.l3.alerts?.length) {
      lines.push(`### Alerts (${doc.l3.alerts.length})`);
      lines.push('');
      for (const a of doc.l3.alerts) {
        lines.push(`- **${a.band}** ${a.name}: ${a.previous} → ${a.current} (${a.deltaPct}%)`);
      }
      lines.push('');
    } else {
      lines.push('No L3 alerts.');
      lines.push('');
    }
  }

  if (doc.notes?.length) {
    lines.push('## Notes');
    lines.push('');
    for (const n of doc.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function writeReport(outDir, doc) {
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, 'report.md');
  const jsonPath = path.join(outDir, 'report.json');
  fs.writeFileSync(mdPath, renderMarkdown(doc));
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n');
  return { mdPath, jsonPath };
}
