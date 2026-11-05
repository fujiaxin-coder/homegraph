/** HTML soak report — plain-language Chinese for external readers. */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(x) {
  if (x == null || Number.isNaN(x)) return null;
  return x * 100;
}

function fmtPct(x, digits = 1) {
  const p = pct(x);
  if (p == null) return '—';
  return `${p.toFixed(digits)}%`;
}

function toneRecall(r) {
  if (r == null) return 'muted';
  if (r >= 0.7) return 'good';
  if (r >= 0.5) return 'warn';
  return 'bad';
}

function toneViol(v) {
  if (v == null) return 'muted';
  if (v <= 0.05) return 'good';
  if (v <= 0.15) return 'warn';
  return 'bad';
}

function tonePrec(p) {
  if (p == null) return 'muted';
  if (p >= 0.85) return 'good';
  if (p >= 0.7) return 'warn';
  return 'bad';
}

const KIND_ZH = {
  calls: '函数/方法调用',
  imports: '模块导入',
  extends: '类继承',
  implements: '接口实现',
  contains: '包含关系（如类包含方法）',
  references: '引用关系',
  instantiates: '实例化',
  file: '文件',
  class: '类',
  struct: '结构体/组件结构',
  interface: '接口',
  method: '方法',
  function: '函数',
  import: '导入符号',
  component: 'UI 组件',
  property: '属性',
  constant: '常量',
  variable: '变量',
  enum: '枚举',
  enum_member: '枚举成员',
  namespace: '命名空间',
  type_alias: '类型别名',
  route: '路由',
  anonymous_method: '匿名方法',
};

const SCOPE_ZH = {
  'cross-module': '跨模块（不同业务模块之间）',
  'cross-file': '同模块跨文件',
  'same-file': '同一文件内',
};

const BUCKET_ZH = {
  A: 'A · 跨模块调用',
  B: 'B · 同文件未导出辅助函数',
  C: 'C · 高扇出 API（易被误连）',
  D: 'D · 同模块清晰调用',
  E: 'E · 页面生命周期 / UI 入口',
  F: 'F · 导入 / 继承 / 包含等结构边',
  G: 'G · HomeGraph 启发式调用边',
};

const SUITE_ZH = {
  prod: '正式业务代码',
  test: '测试代码',
};

const DISPATCH_ZH = {
  direct: '直接调用',
  indirect: '间接调用',
  unknown: '未区分',
  'n/a': '非调用边',
};

const DISPATCH_TITLE = {
  direct: '调用目标可唯一静态绑定',
  indirect: '虚调 / 回调 / 多态等，目标未唯一绑定',
  unknown: '分析器未标注 dispatch',
  'n/a': '非 kind=calls',
};

const PROV_ZH = {
  arkanalyzer: 'ArkAnalyzer（AA）',
  'hg-heuristic': 'HomeGraph 启发式合成',
  'aa+hg-all': 'AA + HG 全量 calls',
};

function labelKey(k, dict) {
  if (dict[k]) return dict[k];
  if (/^[A-G]$/.test(k) && BUCKET_ZH[k]) return BUCKET_ZH[k];
  return k;
}

function remapPack(pack, dict) {
  if (!pack?.by) return pack;
  const by = {};
  for (const [k, v] of Object.entries(pack.by)) {
    by[labelKey(k, dict)] = v;
  }
  return { total: pack.total, by };
}

function barRows(pack, maxBars = 12) {
  if (!pack?.by) return '<p class="dim">暂无数据</p>';
  const entries = Object.entries(pack.by)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxBars);
  const max = Math.max(...entries.map(([, v]) => v.count), 1);
  return entries
    .map(([k, v]) => {
      const w = Math.max(2, Math.round((v.count / max) * 100));
      return `<div class="bar-row">
        <div class="bar-label" title="${esc(k)}">${esc(k)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
        <div class="bar-meta">${v.count} <span class="dim">(${v.pct}%)</span></div>
      </div>`;
    })
    .join('\n');
}

function splitTable(map, keyDict = {}, titleDict = {}) {
  if (!map) return '<p class="dim">暂无数据</p>';
  const rows = Object.entries(map)
    .sort((a, b) => (b[1].gPlus || 0) - (a[1].gPlus || 0))
    .map(([k, v]) => {
      const name = labelKey(k, keyDict);
      const tip = titleDict[k] || name;
      return `<tr>
        <td class="cat" title="${esc(tip)}">${esc(name)}</td>
        <td class="num">${v.gPlus ?? 0}</td>
        <td class="num">${v.hitPlus ?? 0}</td>
        <td class="num ${toneRecall(v.recall)}">${fmtPct(v.recall)}</td>
        <td class="num">${v.gMinus ?? 0}</td>
        <td class="num">${v.viol ?? 0}</td>
        <td class="num ${toneViol(v.mustNotViolationRate)}">${fmtPct(v.mustNotViolationRate)}</td>
      </tr>`;
    })
    .join('\n');
  return `<div class="table-wrap"><table class="metrics">
    <colgroup>
      <col class="col-cat"/><col/><col/><col/><col/><col/><col/>
    </colgroup>
    <thead><tr>
      <th class="cat">分类</th>
      <th class="num" title="正例金标 G+">G+</th>
      <th class="num" title="索引中命中的正例">命中</th>
      <th class="num" title="命中 / G+">Recall</th>
      <th class="num" title="负例金标 G−">G−</th>
      <th class="num" title="索引中误出现的负例">违反</th>
      <th class="num" title="违反 / G−">违反率</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function missList(items, limit = 20) {
  if (!items?.length) return '<p class="dim">无</p>';
  return `<ol class="miss">${items
    .slice(0, limit)
    .map((m) => `<li><code>${esc(m)}</code></li>`)
    .join('')}</ol>`;
}

function l3Cards(cur, l3) {
  const items = [
    {
      title: 'arkCallsDirect',
      value: cur.arkCallsDirect ?? '—',
      purpose: 'AA 直接调用规模：调用点可唯一绑定到具体函数/方法。',
      formula:
        'count(AA calls ∧ dispatch=direct)。例：foo() 解析到唯一定义。',
    },
    {
      title: 'arkCallsIndirect',
      value: cur.arkCallsIndirect ?? '—',
      purpose: 'AA 间接调用规模：虚调/回调/多态等，目标未（或不保证）唯一绑定。',
      formula:
        'count(AA calls ∧ dispatch=indirect)。例：iface.m()、回调注册后的触发边。',
    },
    {
      title: 'indirect / direct',
      value: cur.indirectDirectRatio ?? '—',
      purpose:
        '间接边相对直接边的密度比（仅 AA）。偏高常提示虚调/回调边膨胀或 densify 过激。',
      formula: 'arkCallsIndirect / arkCallsDirect',
    },
    {
      title: 'HG heuristic calls',
      value: cur.callHeuristic ?? '—',
      purpose: 'HomeGraph 非 AA 合成调用边规模（callback / react-render 等）。',
      formula: 'count(calls ∧ synthesizedBy ≠ arkanalyzer)',
    },
    {
      title: 'Fanout Top10 占比',
      value:
        cur.fanoutTop10Share != null
          ? `${(cur.fanoutTop10Share * 100).toFixed(1)}%`
          : '—',
      purpose: '检测调用是否过度集中于少数热点 callee。',
      formula: 'sum(inDegree of top-10 callees) / callEdges',
    },
    {
      title: '零 calls 文件数',
      value: cur.zeroCallFileCount ?? '—',
      purpose: '检测可能的调用漏抽（有文件节点但无出边 calls）。',
      formula: 'count(file nodes of .ets with no outbound calls)',
    },
  ];
  return items
    .map(
      (it) => `<div class="l3-item">
      <div class="l3-title">${esc(it.title)}</div>
      <div class="l3-value">${esc(it.value)}</div>
      <div class="l3-purpose">${esc(it.purpose)}</div>
      <div class="l3-explain"><code>${esc(it.formula)}</code></div>
    </div>`
    )
    .join('');
}

function fmtPp(x) {
  if (x == null || Number.isNaN(x)) return '—';
  const pp = x * 100;
  const sign = pp > 0 ? '+' : '';
  return `${sign}${pp.toFixed(1)} pp`;
}

function kpiGrid(arm) {
  const must = arm?.must || {};
  const mustNot = arm?.mustNot || {};
  const prec = arm?.precision || {};
  const reach = arm?.reachabilityAtK || {};
  const recall = must.recall;
  const precision = prec.precisionAtGold;
  const viol = mustNot.mustNotViolationRate;
  const reachRate = reach.rate;
  return `<div class="kpis">
      <div class="kpi ${toneRecall(recall)}">
        <div class="label">Recall</div>
        <div class="value">${fmtPct(recall)}</div>
        <div class="purpose">正例金标被索引覆盖的程度（漏边风险）。</div>
        <div class="formula">|E ∩ G+| / |G+| = ${must.hit ?? 0} / ${must.eligible ?? 0}</div>
      </div>
      <div class="kpi ${tonePrec(precision)}">
        <div class="label">Precision@gold</div>
        <div class="value">${fmtPct(precision)}</div>
        <div class="purpose">金标子集上，命中边中正例占比（脏边风险）。</div>
        <div class="formula">|E ∩ G+| / |E ∩ (G+ ∪ G−)| = ${prec.inEPlus ?? '—'} / ${prec.inEUnion ?? '—'}</div>
      </div>
      <div class="kpi ${toneViol(viol)}">
        <div class="label">Must-not 违反率</div>
        <div class="value">${fmtPct(viol)}</div>
        <div class="purpose">负例金标被误生成的比例（目标趋近 0）。</div>
        <div class="formula">|E ∩ G−| / |G−| = ${mustNot.miss ?? 0} / ${mustNot.eligible ?? 0}</div>
      </div>
      <div class="kpi ${toneRecall(reachRate)}">
        <div class="label">Reachability@${reach.k ?? 6}</div>
        <div class="value">${fmtPct(reachRate)}</div>
        <div class="purpose">从入口种子沿调用边到达正例 callee 的可达性。</div>
        <div class="formula">reachable ≤${reach.k ?? 6} hops = ${reach.reachable ?? 0} / ${reach.goldCalls ?? 0}</div>
      </div>
    </div>`;
}

function liftGrid(lift) {
  if (!lift) return '';
  return `<div class="kpis">
      <div class="kpi ${toneRecall(lift.recall)}">
        <div class="label">Δ Recall（启发式）</div>
        <div class="value">${fmtPp(lift.recall)}</div>
        <div class="purpose">加入 HG 启发式边后召回变化。</div>
        <div class="formula">recall(all) − recall(AA)</div>
      </div>
      <div class="kpi ${tonePrec(lift.precisionAtGold)}">
        <div class="label">Δ Precision@gold</div>
        <div class="value">${fmtPp(lift.precisionAtGold)}</div>
        <div class="purpose">加入启发式边后精度变化（可正可负）。</div>
        <div class="formula">precision(all) − precision(AA)</div>
      </div>
      <div class="kpi ${toneViol(lift.mustNotViolationRate)}">
        <div class="label">Δ Must-not 违反率</div>
        <div class="value">${fmtPp(lift.mustNotViolationRate)}</div>
        <div class="purpose">加入启发式边后违反率变化（越小越好，负值=改善）。</div>
        <div class="formula">viol(all) − viol(AA)</div>
      </div>
      <div class="kpi ${toneRecall(lift.reachabilityAtK)}">
        <div class="label">Δ Reachability</div>
        <div class="value">${fmtPp(lift.reachabilityAtK)}</div>
        <div class="purpose">沿全量 calls 相对仅 AA 的可达增益。</div>
        <div class="formula">reach(all) − reach(AA)</div>
      </div>
    </div>`;
}

function provenanceSection(prov, graphCov) {
  if (!prov?.metrics) {
    return '';
  }
  const m = prov.metrics;
  const attr = prov.mustCallAttribution || {};
  const inv = prov.inventory || {};
  const arms = [
    ['arkanalyzer', m.arkanalyzer],
    ['hg-heuristic', m['hg-heuristic']],
    ['aa+hg-all', m['aa+hg-all']],
  ];
  const rows = arms
    .map(([key, arm]) => {
      if (!arm) return '';
      return `<tr>
        <td class="cat">${esc(PROV_ZH[key] || key)}</td>
        <td class="num">${arm.eligibleMust ?? 0}</td>
        <td class="num">${arm.hit ?? 0}</td>
        <td class="num ${toneRecall(arm.recall)}">${fmtPct(arm.recall)}</td>
        <td class="num ${toneViol(arm.mustNotViolationRate)}">${fmtPct(arm.mustNotViolationRate)}</td>
        <td class="num ${tonePrec(arm.precisionAtGold)}">${fmtPct(arm.precisionAtGold)}</td>
      </tr>`;
    })
    .join('\n');

  const lift =
    attr.heuristicRecallLift != null
      ? `${attr.heuristicRecallLift >= 0 ? '+' : ''}${(attr.heuristicRecallLift * 100).toFixed(1)} pp`
      : '—';

  const synthBars = graphCov?.callsBySynthesizedBy
    ? barRows(graphCov.callsBySynthesizedBy, 12)
    : '<p class="dim">暂无</p>';
  const classBars = graphCov?.callsByProvenanceClass
    ? barRows(
        {
          total: graphCov.callsByProvenanceClass.total,
          by: Object.fromEntries(
            Object.entries(graphCov.callsByProvenanceClass.by || {}).map(([k, v]) => [
              PROV_ZH[k] || k,
              v,
            ])
          ),
        },
        6
      )
    : '<p class="dim">暂无</p>';

  return `<section>
    <h2>1d. 边来源明细（库存 + call 金标三臂）</h2>
    <p class="sec-lead">
      库存与 call 金标细分：
      <b>arkanalyzer</b> / <b>hg-heuristic</b> / <b>aa+hg-all</b>。
      核心四指标见上方 1a–1c；此处看 synthesizedBy 构成与仅启发式池命中。
    </p>
    <div class="kpis">
      <div class="kpi">
        <div class="label">AA calls（库存）</div>
        <div class="value">${inv.byProvenanceClass?.arkanalyzer ?? '—'}</div>
        <div class="purpose">索引中 AA 调用边条数。</div>
      </div>
      <div class="kpi">
        <div class="label">HG heuristic calls</div>
        <div class="value">${inv.byProvenanceClass?.['hg-heuristic'] ?? '—'}</div>
        <div class="purpose">索引中非 AA 合成调用边条数。</div>
      </div>
      <div class="kpi ${toneRecall(attr.heuristicRecallLift)}">
        <div class="label">Recall lift (HG)</div>
        <div class="value">${lift}</div>
        <div class="purpose">全量 calls 相对仅 AA 在 G+ call 金标上的召回增益。</div>
        <div class="formula">recall(aa+hg-all) − recall(arkanalyzer)</div>
      </div>
      <div class="kpi">
        <div class="label">仅 HG 命中</div>
        <div class="value">${attr.heuristicOnlyHit ?? 0}</div>
        <div class="purpose">G+ call 中 AA 未命中、仅启发式边命中的条数。</div>
        <div class="formula">arkOnly=${attr.arkOnlyHit ?? 0} · both=${attr.bothHit ?? 0} · neither=${attr.neither ?? 0}</div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>Call 金标上的三臂指标</h3>
      <div class="table-wrap"><table class="metrics">
        <colgroup>
          <col class="col-cat"/><col/><col/><col/><col/><col/>
        </colgroup>
        <thead><tr>
          <th class="cat">边来源池</th>
          <th class="num">G+ calls</th>
          <th class="num">命中</th>
          <th class="num">Recall</th>
          <th class="num">违反率</th>
          <th class="num">Precision</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <h3>全图 calls · 来源类</h3>
        ${classBars}
      </div>
      <div class="card">
        <h3>全图 calls · synthesizedBy</h3>
        ${synthBars}
      </div>
    </div>
  </section>`;
}

export function renderHtml(doc) {
  const meta = doc.meta || {};
  const l2 = doc.l2 || {};
  const ark = l2.overallArk || l2.overall || {};
  const all = l2.overallAll || {};
  const lift = l2.heuristicLift || null;
  const must = ark.must || {};
  const mustNot = ark.mustNot || {};
  const l3 = doc.l3 || {};
  const cur = l3.current || {};
  const cov = doc.coverage || {};
  const splits = l2.splits || {};
  const provenance = l2.provenance || null;

  const alerts = [
    ...(cov.alerts || []).map((a) => ({ band: 'warn', text: a })),
    // Scale guards only — skip baseline Δ% noise
    ...((l3.absoluteGuards || []).filter((a) => a.band === 'warn' || a.band === 'alert')).map(
      (a) => ({
        band: a.band,
        text: `${a.name}: current=${a.current} limit=${a.limit}${a.note ? ` (${a.note})` : ''}`,
      })
    ),
  ];

  const goldMustKind = remapPack(cov.goldMust?.kind, KIND_ZH);
  const goldMustScope = remapPack(cov.goldMust?.scope, SCOPE_ZH);
  const goldMustBucket = remapPack(cov.goldMust?.bucket, BUCKET_ZH);
  const goldMustCaller = remapPack(cov.goldMust?.callerNodeKind, KIND_ZH);
  const goldMustCallee = remapPack(cov.goldMust?.calleeNodeKind, KIND_ZH);
  const goldMustNotKind = remapPack(cov.goldMustNot?.kind, KIND_ZH);
  const graphNodes = remapPack(cov.graph?.nodesByKind, KIND_ZH);
  const graphEdges = remapPack(cov.graph?.edgesByKind, KIND_ZH);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Call Graph Quality Report — applications_photos</title>
<style>
  :root {
    --bg: #f6f4ef; --panel: #fffdf8; --ink: #1c1a16; --muted: #6b6560;
    --line: #e4ddd2; --accent: #0f6e56; --good: #0f6e56; --warn: #9a6700;
    --bad: #b42318; --shadow: 0 1px 0 rgba(28,26,22,.04), 0 8px 24px rgba(28,26,22,.06);
    --mono: "Cascadia Code", "Sarasa Mono SC", ui-monospace, Consolas, monospace;
    --sans: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 0 64px; font: 15px/1.55 var(--sans); color: var(--ink);
    background:
      radial-gradient(1200px 600px at 10% -10%, #e8f2ec 0%, transparent 55%),
      radial-gradient(900px 500px at 100% 0%, #eef3f8 0%, transparent 50%), var(--bg);
  }
  header.hero {
    padding: 36px 28px 28px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #fffefb, #f6f4ef);
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 20px; }
  .eyebrow { letter-spacing: .06em; font-size: 12px; color: var(--accent); font-weight: 650; }
  h1 { margin: 6px 0 8px; font-size: 28px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); max-width: 78ch; }
  .meta-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px; margin-top: 18px;
  }
  .meta-chip {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; box-shadow: var(--shadow);
  }
  .meta-chip .k { font-size: 11px; color: var(--muted); }
  .meta-chip .v { font-family: var(--mono); font-size: 13px; word-break: break-all; margin-top: 2px; }
  section { margin-top: 28px; }
  h2 { font-size: 18px; margin: 0 0 8px; }
  .sec-lead { color: var(--muted); font-size: 13px; margin: 0 0 12px; max-width: 80ch; }
  h3 { font-size: 14px; margin: 0 0 10px; color: var(--muted); font-weight: 650; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  @media (max-width: 900px) { .kpis { grid-template-columns: 1fr 1fr; } }
  .kpi {
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    padding: 16px; box-shadow: var(--shadow); position: relative; overflow: hidden;
  }
  .kpi::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background: var(--muted); }
  .kpi.good::before { background: var(--good); }
  .kpi.warn::before { background: var(--warn); }
  .kpi.bad::before { background: var(--bad); }
  .kpi .label { font-size: 12px; color: var(--muted); font-weight: 650; }
  .kpi .value { font-size: 34px; font-weight: 700; letter-spacing: -0.03em; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .kpi .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .kpi.good .value { color: var(--good); }
  .kpi.warn .value { color: var(--warn); }
  .kpi.bad .value { color: var(--bad); }
  .glossary {
    background: #f3faf6; border: 1px solid #cfe6db; border-radius: 12px; padding: 14px 16px; margin-top: 14px;
  }
  .glossary h3 { color: var(--accent); margin-bottom: 8px; }
  .glossary dl { margin: 0; display: grid; gap: 8px; }
  .glossary dt { font-weight: 700; }
  .glossary dd { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 860px) { .grid-2 { grid-template-columns: 1fr; } }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    padding: 16px; box-shadow: var(--shadow);
  }
  .bar-row { display: grid; grid-template-columns: minmax(120px, 200px) 1fr 88px; gap: 8px; align-items: center; margin: 6px 0; }
  .bar-label { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { height: 10px; background: #efeae2; border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, #2a6f97, #3d8fb5); border-radius: 999px; }
  .bar-meta { font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .dim { color: var(--muted); }
  .tiny { font-size: 12px; margin-top: 8px; }
  .table-wrap { width: 100%; overflow-x: auto; }
  table.metrics {
    width: 100%; border-collapse: collapse; font-size: 13px;
    table-layout: fixed;
  }
  table.metrics col.col-cat { width: 28%; }
  table.metrics th, table.metrics td {
    padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: middle;
  }
  table.metrics th {
    color: var(--muted); font-weight: 650; font-size: 12px;
    text-align: left; white-space: nowrap;
  }
  table.metrics th.num, table.metrics td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: var(--mono);
    font-size: 12px;
    white-space: nowrap;
  }
  table.metrics th.cat, table.metrics td.cat {
    text-align: left;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 650; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 12px; }
  td.good, .good { color: var(--good); }
  td.warn, .warn { color: var(--warn); }
  td.bad, .bad { color: var(--bad); }
  .miss { padding-left: 18px; margin: 0; }
  .miss code { font-family: var(--mono); font-size: 11.5px; word-break: break-all; }
  .alert {
    border: 1px solid var(--line); border-left: 4px solid var(--warn);
    background: #fff8e8; padding: 10px 12px; border-radius: 8px; margin: 6px 0; font-size: 13px;
  }
  .alert.bad { border-left-color: var(--bad); background: #fff1f0; }
  .l3-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 900px) { .l3-grid { grid-template-columns: 1fr; } }
  .l3-item {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 14px; box-shadow: var(--shadow);
  }
  .l3-title { font-size: 13px; font-weight: 650; }
  .l3-value { font-size: 26px; font-weight: 700; margin: 6px 0; font-variant-numeric: tabular-nums; }
  .l3-purpose { font-size: 12px; color: var(--ink); margin-bottom: 4px; }
  .l3-explain { font-size: 11.5px; color: var(--muted); }
  .l3-explain code { font-family: var(--mono); font-size: 11px; word-break: break-word; }
  .kpi .formula { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 8px; }
  .kpi .purpose { font-size: 12px; margin-top: 8px; color: var(--ink); }
  footer { margin-top: 36px; color: var(--muted); font-size: 12px; }
  .bucket-legend { font-size: 13px; color: var(--muted); margin: 0; padding-left: 18px; }
</style>
</head>
<body>
<header class="hero">
  <div class="wrap">
    <div class="eyebrow">HomeGraph · Call Graph Quality</div>
    <h1>applications_photos 图质量报告</h1>
    <p class="sub">
      基于源码审定金标，评估索引图在调用 / 导入 / 继承等关系上的召回、精度与规模稳定性。
      Generated: ${esc(doc.generatedAt)}
    </p>
    <div class="meta-grid">
      <div class="meta-chip"><div class="k">Project</div><div class="v">${esc(meta.root)}</div></div>
      <div class="meta-chip"><div class="k">Commit</div><div class="v">${esc(meta.head || meta.lockCommit)}</div></div>
      <div class="meta-chip"><div class="k">HomeGraph / AA</div><div class="v">${esc(meta.homegraphVersion)} · ${esc(meta.arkanalyzer)}</div></div>
      <div class="meta-chip"><div class="k">Gold</div><div class="v">must ${meta.mustCount} · must-not ${meta.mustNotCount}</div></div>
      <div class="meta-chip"><div class="k">Index</div><div class="v">${esc(meta.indexMs)} ms</div></div>
      <div class="meta-chip"><div class="k">Graph</div><div class="v">nodes ${cur.nodes ?? '—'} · edges ${cur.edges ?? '—'}</div></div>
    </div>
  </div>
</header>

<main class="wrap">
  <section>
    <h2>1. 核心指标</h2>
    <p class="sec-lead">
      符号：G+ 正例 · G− 负例 · E 索引边。四项各算两遍：
      <b>仅 AA</b>（calls 限 <code>synthesizedBy=arkanalyzer</code>）与
      <b>全量</b>（AA ∪ HG 启发式）。差值即启发式边贡献。unknown / deferred 不进分母。
    </p>
    <h3 style="margin-top:4px">1a · 仅 ArkAnalyzer</h3>
    ${kpiGrid(ark)}
    <h3 style="margin-top:18px">1b · 全量（AA + HG 启发式）</h3>
    ${kpiGrid(all)}
    <h3 style="margin-top:18px">1c · 启发式边作用（全量 − 仅 AA）</h3>
    <p class="sec-lead">正 Δ Recall / Reachability = HG 补边增益；Δ 违反率负值 = 更干净。</p>
    ${liftGrid(lift)}
  </section>

  ${provenanceSection(provenance, cov.graph)}

  <section>
    <h2>2. L3 规模卫兵</h2>
    <p class="sec-lead">
      规模快照。其中 <b>direct</b> = 调用目标可唯一静态绑定；
      <b>indirect</b> = 虚调 / 回调 / 多态等未唯一绑定（二者均仅针对 AA 边）。
      <b>indirect/direct</b> = 间接边相对直接边的密度。HG 启发式边条数单独列出。
    </p>
    <div class="l3-grid">${l3Cards(cur, l3)}</div>
  </section>

  ${
    alerts.length
      ? `<section><h2>告警</h2>${alerts
          .map(
            (a) =>
              `<div class="alert ${a.band === 'alert' || a.band === 'bad' ? 'bad' : ''}">${esc(a.text)}</div>`
          )
          .join('')}</section>`
      : ''
  }

  <section>
    <h2>3. 金标覆盖分布</h2>
    <p class="sec-lead">按边类型、作用域、端点节点类型与场景桶分层抽样。</p>
    <div class="grid-2">
      <div class="card">
        <h3>Must · 边类型</h3>
        ${barRows(goldMustKind)}
      </div>
      <div class="card">
        <h3>Must · 作用域</h3>
        ${barRows(goldMustScope)}
      </div>
      <div class="card">
        <h3>Must · caller 节点类型</h3>
        ${barRows(goldMustCaller)}
      </div>
      <div class="card">
        <h3>Must · callee 节点类型</h3>
        ${barRows(goldMustCallee)}
      </div>
      <div class="card">
        <h3>Must · 场景桶</h3>
        ${barRows(goldMustBucket)}
        <ul class="bucket-legend">
          <li><b>A</b> 跨模块调用</li>
          <li><b>B</b> 同文件未导出 helper</li>
          <li><b>C</b> 高扇出 API</li>
          <li><b>D</b> 同模块清晰调用</li>
          <li><b>E</b> lifecycle / UI 入口</li>
          <li><b>F</b> imports / extends / implements / contains</li>
          <li><b>G</b> HG heuristic calls（interface-impl / arkui-* / lifecycle…）</li>
        </ul>
      </div>
      <div class="card">
        <h3>Must-not · 边类型</h3>
        ${barRows(goldMustNotKind)}
      </div>
    </div>
  </section>

  <section>
    <h2>4. 全图节点 / 边构成</h2>
    <p class="sec-lead">当前索引产物的 kind 分布。</p>
    <div class="grid-2">
      <div class="card">
        <h3>Nodes by kind</h3>
        ${barRows(graphNodes, 16)}
      </div>
      <div class="card">
        <h3>Edges by kind</h3>
        ${barRows(graphEdges, 12)}
      </div>
    </div>
  </section>

  <section>
    <h2>5. Recall 拆分</h2>
    <p class="sec-lead">按作用域、边类型、dispatch、场景桶、suite、模块对切片。</p>
    <div class="grid-2">
      <div class="card"><h3>Scope</h3>${splitTable(splits.byScope, SCOPE_ZH)}</div>
      <div class="card"><h3>Edge kind</h3>${splitTable(splits.byKind, KIND_ZH)}</div>
      <div class="card"><h3>Dispatch</h3>${splitTable(splits.byDispatch, DISPATCH_ZH, DISPATCH_TITLE)}</div>
      <div class="card"><h3>Bucket</h3>${splitTable(splits.byBucket, BUCKET_ZH)}</div>
      <div class="card"><h3>Suite</h3>${splitTable(splits.bySuite, SUITE_ZH)}</div>
      <div class="card"><h3>Module pair (Top)</h3>${splitTable(splits.byModulePairTop, {})}</div>
    </div>
  </section>

  <section>
    <h2>6. Must misses（样例）</h2>
    <p class="sec-lead">G+ 未命中；含 evidence 路径时便于定位。</p>
    <div class="card">${missList(must.misses, 25)}</div>
  </section>

  ${
    mustNot.violations?.length
      ? `<section>
    <h2>7. Must-not 违反（样例）</h2>
    <p class="sec-lead">G− 在索引中误出现。</p>
    <div class="card">${missList(mustNot.violations, 20)}</div>
  </section>`
      : ''
  }

  <footer>HomeGraph harmony-callgraph-soak</footer>
</main>
</body>
</html>`;
}
