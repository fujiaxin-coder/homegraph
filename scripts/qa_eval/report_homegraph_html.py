#!/usr/bin/env python3
"""
Generate an HTML leadership report focused on whether the WITH arm actually used HomeGraph.

Reads scored JSONL + agent logs (same inputs as run_pipeline.py), splits the WITH arm by
``agent_used_homegraph``, and writes a styled HTML file under scripts/qa_eval/data/.

Usage:
  python scripts/qa_eval/report_homegraph_html.py
  python scripts/qa_eval/report_homegraph_html.py --agent-host deveco-code
  python scripts/qa_eval/report_homegraph_html.py -o scripts/qa_eval/data/report-deveco-homegraph.html
"""

from __future__ import annotations

import argparse
import html
import statistics
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from external_agent import HOST_DEVECO  # noqa: E402
from run_pipeline import (  # noqa: E402
    DATA_DIR,
    clean_answer,
    fmt_delta,
    fmt_metric_cell,
    fmt_num,
    index_by_id,
    load_jsonl,
    paths_for_host,
)
from stats_efficiency import per_item_efficiency_by_id  # noqa: E402
from stats_scores import compute_stats_from_rows  # noqa: E402

DEFAULT_HOST = HOST_DEVECO
DEFAULT_OUTPUT = DATA_DIR / "report-deveco-homegraph.html"

METRIC_KEYS = ("turns", "duration_s", "first_token_s", "tokens", "peak_rss_mb")
METRIC_LABELS = {
    "turns": "轮次",
    "duration_s": "耗时 (s)",
    "first_token_s": "首响应 (s)",
    "tokens": "Token",
    "peak_rss_mb": "峰值内存 (MB)",
}
LOWER_BETTER = {"duration_s", "first_token_s", "tokens", "peak_rss_mb"}


def score_or_none(row: dict) -> float | None:
    if row.get("evaluation_status") != "success":
        return None
    score = row.get("answer_accuracy_score")
    if isinstance(score, (int, float)):
        return float(score)
    return None


def split_by_homegraph_usage(rows_with: list[dict]) -> tuple[list[dict], list[dict]]:
    used: list[dict] = []
    unused: list[dict] = []
    for row in rows_with:
        if row.get("agent_used_homegraph"):
            used.append(row)
        else:
            unused.append(row)
    return used, unused


def aggregate_metrics(
    eff_map: dict[str, dict[str, float | int | None]],
    ids: list[str],
    key: str,
) -> float | None:
    vals = [
        float(eff_map[i][key])  # type: ignore[arg-type]
        for i in ids
        if eff_map.get(i, {}).get(key) is not None
    ]
    return statistics.mean(vals) if vals else None


def compare_outcomes(rows_with: list[dict], rows_without: list[dict]) -> tuple[int, int, int]:
    wo = index_by_id(rows_without)
    wins = ties = losses = 0
    for r in rows_with:
        rid = str(r.get("id", ""))
        sw = score_or_none(r)
        swo = score_or_none(wo.get(rid, {}))
        if sw is None or swo is None:
            continue
        if sw > swo:
            wins += 1
        elif sw < swo:
            losses += 1
        else:
            ties += 1
    return wins, ties, losses


def build_subset_summary(
    rows_with: list[dict],
    rows_without: list[dict],
    *,
    with_log: Path | None,
    without_log: Path | None,
    eff_with_full: dict[str, dict[str, float | int | None]],
    eff_wo_full: dict[str, dict[str, float | int | None]],
) -> dict[str, Any]:
    ids = [str(r.get("id", "")) for r in rows_with]
    stats_w = compute_stats_from_rows(rows_with) or {}
    wo_rows = [index_by_id(rows_without)[i] for i in ids if i in index_by_id(rows_without)]
    stats_wo = compute_stats_from_rows(wo_rows) or {}
    wins, ties, losses = compare_outcomes(rows_with, rows_without)

    summary: dict[str, Any] = {
        "count": len(rows_with),
        "accuracy_with": stats_w.get("mean"),
        "accuracy_without": stats_wo.get("mean"),
        "accuracy_median_with": stats_w.get("median"),
        "accuracy_median_without": stats_wo.get("median"),
        "wins": wins,
        "ties": ties,
        "losses": losses,
        "metrics": {},
    }

    for key in METRIC_KEYS:
        summary["metrics"][key] = {
            "with": aggregate_metrics(eff_with_full, ids, key),
            "without": aggregate_metrics(eff_wo_full, ids, key),
        }
    return summary


def delta_class(metric: str, with_val: float | None, wo_val: float | None) -> str:
    if with_val is None or wo_val is None:
        return "neutral"
    diff = with_val - wo_val
    if abs(diff) < 1e-9:
        return "neutral"
    if metric == "accuracy":
        return "good" if diff > 0 else "bad"
    if metric in LOWER_BETTER:
        return "good" if diff < 0 else "bad"
    return "neutral"


def esc(text: Any) -> str:
    return html.escape(str(text or ""), quote=True)


def format_tools(tools: list[str] | None) -> str:
    if not tools:
        return "-"
    short = []
    for t in tools:
        name = t.replace("homegraph_homegraph_", "hg:")
        short.append(name)
    return " → ".join(short)


def render_delta_cell(metric: str, with_val: float | None, wo_val: float | None, *, digits: int = 2) -> str:
    if with_val is None or wo_val is None:
        text = "N/A"
    else:
        text = fmt_delta(with_val, wo_val, digits=digits)
    cls = delta_class(metric, with_val, wo_val)
    return f'<span class="delta {cls}">{esc(text)}</span>'


def render_summary_table(summary: dict[str, Any]) -> str:
    aw = summary.get("accuracy_with")
    awo = summary.get("accuracy_without")
    rows_html = [
        "<tr>",
        "<td>准确率 均值</td>",
        f"<td>{esc(fmt_num(aw, digits=4))}</td>",
        f"<td>{esc(fmt_num(awo, digits=4))}</td>",
        f"<td>{render_delta_cell('accuracy', aw, awo, digits=4)}</td>",
        "</tr>",
        "<tr>",
        "<td>准确率 中位数</td>",
        f"<td>{esc(fmt_num(summary.get('accuracy_median_with'), digits=4))}</td>",
        f"<td>{esc(fmt_num(summary.get('accuracy_median_without'), digits=4))}</td>",
        f"<td>{render_delta_cell('accuracy', summary.get('accuracy_median_with'), summary.get('accuracy_median_without'), digits=4)}</td>",
        "</tr>",
        "<tr>",
        "<td>with 更高 / 持平 / without 更高</td>",
        f'<td colspan="3" class="winloss">{summary["wins"]} / {summary["ties"]} / {summary["losses"]}</td>',
        "</tr>",
    ]

    for key in METRIC_KEYS:
        m = summary["metrics"][key]
        wv, wov = m["with"], m["without"]
        if key == "peak_rss_mb":
            wtxt = fmt_metric_cell(wv, suffix=" MB", digits=0)
            wotxt = fmt_metric_cell(wov, suffix=" MB", digits=0)
            digits = 0
        elif key in ("duration_s", "first_token_s"):
            wtxt = fmt_metric_cell(wv, digits=1)
            wotxt = fmt_metric_cell(wov, digits=1)
            digits = 1
        else:
            wtxt = fmt_metric_cell(wv, digits=0)
            wotxt = fmt_metric_cell(wov, digits=0)
            digits = 0
        rows_html.append(
            "<tr>"
            f"<td>{esc(METRIC_LABELS[key])}</td>"
            f"<td>{esc(wtxt)}</td>"
            f"<td>{esc(wotxt)}</td>"
            f"<td>{render_delta_cell(key, wv, wov, digits=digits)}</td>"
            "</tr>"
        )

    return (
        '<table class="summary-table">'
        "<thead><tr><th>指标</th><th>with</th><th>without</th><th>Δ (with−without)</th></tr></thead>"
        f"<tbody>{''.join(rows_html)}</tbody></table>"
    )


def render_item_card(
    row: dict,
    wo_row: dict,
    eff_w: dict[str, float | int | None],
    eff_wo: dict[str, float | int | None],
) -> str:
    rid = str(row.get("id", ""))
    sw = score_or_none(row)
    swo = score_or_none(wo_row)
    cat = esc(row.get("category_l1") or "")
    q = esc(row.get("query") or "")
    aw = esc(clean_answer(str(row.get("output_answer", ""))))
    awo = esc(clean_answer(str(wo_row.get("output_answer", ""))))
    tools = esc(format_tools(row.get("agent_tools_used")))

    metric_rows = []
    for key in METRIC_KEYS:
        wv = eff_w.get(key)
        wov = eff_wo.get(key)
        if key == "peak_rss_mb":
            wtxt = fmt_metric_cell(wv, suffix=" MB", digits=0)
            wotxt = fmt_metric_cell(wov, suffix=" MB", digits=0)
            digits = 0
        elif key in ("duration_s", "first_token_s"):
            wtxt = fmt_metric_cell(wv, digits=1)
            wotxt = fmt_metric_cell(wov, digits=1)
            digits = 1
        else:
            wtxt = fmt_metric_cell(wv, digits=0)
            wotxt = fmt_metric_cell(wov, digits=0)
            digits = 0
        metric_rows.append(
            "<tr>"
            f"<td>{esc(METRIC_LABELS[key])}</td>"
            f"<td>{esc(wtxt)}</td>"
            f"<td>{esc(wotxt)}</td>"
            f"<td>{render_delta_cell(key, wv, wov, digits=digits)}</td>"
            "</tr>"
        )

    acc_delta = render_delta_cell("accuracy", sw, swo, digits=2)
    return f"""
<article class="item-card" id="{esc(rid)}">
  <header class="item-head">
    <span class="item-id">{esc(rid)}</span>
    <span class="badge">{cat}</span>
    <span class="score with">with {esc(fmt_num(sw, digits=2))}</span>
    <span class="score wo">without {esc(fmt_num(swo, digits=2))}</span>
    <span class="score-delta">{acc_delta}</span>
  </header>
  <p class="question">{q}</p>
  <p class="tools"><strong>with 工具链：</strong>{tools}</p>
  <table class="metric-table">
    <thead><tr><th>指标</th><th>with</th><th>without</th><th>Δ</th></tr></thead>
    <tbody>{''.join(metric_rows)}</tbody>
  </table>
  <div class="answers">
    <div class="answer"><h4>with 答案</h4><pre>{aw}</pre></div>
    <div class="answer"><h4>without 答案</h4><pre>{awo}</pre></div>
  </div>
</article>
"""


def render_section(
    title: str,
    subtitle: str,
    rows_with: list[dict],
    rows_without: list[dict],
    summary: dict[str, Any],
    eff_with_full: dict[str, dict[str, float | int | None]],
    eff_wo_full: dict[str, dict[str, float | int | None]],
    *,
    section_class: str,
) -> str:
    wo = index_by_id(rows_without)
    cards = []
    for row in rows_with:
        rid = str(row.get("id", ""))
        cards.append(
            render_item_card(
                row,
                wo.get(rid, {}),
                eff_with_full.get(rid, {}),
                eff_wo_full.get(rid, {}),
            )
        )
    if not cards:
        cards.append('<p class="empty">（无题目）</p>')

    return f"""
<section class="{section_class}">
  <h2>{esc(title)}</h2>
  <p class="section-desc">{esc(subtitle)}</p>
  {render_summary_table(summary)}
  <div class="items">{''.join(cards)}</div>
</section>
"""


def build_html(
    *,
    rows_with: list[dict],
    rows_without: list[dict],
    with_scored: Path,
    without_scored: Path,
    with_log: Path | None,
    without_log: Path | None,
    generated_at: str,
) -> str:
    used_rows, unused_rows = split_by_homegraph_usage(rows_with)
    total = len(rows_with)
    used_n = len(used_rows)
    unused_n = len(unused_rows)

    eff_with_full = per_item_efficiency_by_id(rows_with, with_log)
    eff_wo_full = per_item_efficiency_by_id(rows_without, without_log)

    used_summary = build_subset_summary(
        used_rows,
        rows_without,
        with_log=with_log,
        without_log=without_log,
        eff_with_full=eff_with_full,
        eff_wo_full=eff_wo_full,
    )
    unused_summary = build_subset_summary(
        unused_rows,
        rows_without,
        with_log=with_log,
        without_log=without_log,
        eff_with_full=eff_with_full,
        eff_wo_full=eff_wo_full,
    )

    main_section = render_section(
        f"使用了 HomeGraph（{used_n} 题）",
        "WITH 臂中模型实际调用了 HomeGraph 工具的题目；下表为这批题相对 WITHOUT 臂的对比。",
        used_rows,
        rows_without,
        used_summary,
        eff_with_full,
        eff_wo_full,
        section_class="main-section",
    )
    appendix = render_section(
        f"附录：未使用 HomeGraph（{unused_n} 题）",
        "WITH 臂已挂载 HomeGraph MCP，但模型未调用其工具的题目。"
        "相同条件下模型行为存在差异，结果波动不代表 HomeGraph 无效。",
        unused_rows,
        rows_without,
        unused_summary,
        eff_with_full,
        eff_wo_full,
        section_class="appendix-section",
    )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>HomeGraph 使用分析报告</title>
  <style>
    :root {{
      --bg: #f4f6fb;
      --card: #ffffff;
      --text: #1a2332;
      --muted: #5c6b7a;
      --border: #e2e8f0;
      --accent: #2563eb;
      --accent-soft: #dbeafe;
      --good: #059669;
      --good-bg: #d1fae5;
      --bad: #dc2626;
      --bad-bg: #fee2e2;
      --neutral: #64748b;
      --appendix-bg: #fffbeb;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
    }}
    .wrap {{ max-width: 1180px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }}
    header.page-header {{
      background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 60%, #3b82f6 100%);
      color: #fff;
      border-radius: 16px;
      padding: 2rem 2.25rem;
      margin-bottom: 1.75rem;
      box-shadow: 0 10px 30px rgba(37, 99, 235, 0.25);
    }}
    header.page-header h1 {{ margin: 0 0 0.5rem; font-size: 1.75rem; font-weight: 700; }}
    header.page-header p {{ margin: 0.25rem 0; opacity: 0.92; font-size: 0.95rem; }}
    .overview {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }}
    .stat-card {{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.25rem 1.5rem;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
    }}
    .stat-card .label {{ color: var(--muted); font-size: 0.85rem; margin-bottom: 0.35rem; }}
    .stat-card .value {{ font-size: 2rem; font-weight: 700; color: var(--accent); }}
    .stat-card.highlight .value {{ color: #047857; }}
    .stat-card.muted-card .value {{ color: var(--muted); }}
    section {{ margin-bottom: 2.5rem; }}
    section h2 {{
      font-size: 1.35rem;
      margin: 0 0 0.35rem;
      padding-bottom: 0.5rem;
      border-bottom: 3px solid var(--accent-soft);
    }}
    .section-desc {{ color: var(--muted); margin: 0 0 1.25rem; font-size: 0.92rem; }}
    .appendix-section {{
      background: var(--appendix-bg);
      border: 1px solid #fde68a;
      border-radius: 16px;
      padding: 1.5rem 1.25rem;
    }}
    .summary-table, .metric-table {{
      width: 100%;
      border-collapse: collapse;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 1.5rem;
      font-size: 0.92rem;
    }}
    .summary-table th, .summary-table td,
    .metric-table th, .metric-table td {{
      padding: 0.65rem 0.85rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }}
    .summary-table thead, .metric-table thead {{
      background: #f8fafc;
      font-weight: 600;
    }}
    .summary-table tr:last-child td, .metric-table tr:last-child td {{ border-bottom: none; }}
    .winloss {{ font-weight: 600; }}
    .items {{ display: flex; flex-direction: column; gap: 1rem; }}
    .item-card {{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.1rem 1.25rem;
      box-shadow: 0 2px 6px rgba(15, 23, 42, 0.03);
    }}
    .item-head {{
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
      margin-bottom: 0.65rem;
    }}
    .item-id {{ font-weight: 700; font-size: 1.05rem; }}
    .badge {{
      background: var(--accent-soft);
      color: var(--accent);
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 600;
    }}
    .score {{ font-size: 0.88rem; font-weight: 600; }}
    .score.with {{ color: var(--accent); }}
    .score.wo {{ color: var(--muted); }}
    .question {{ font-weight: 600; margin: 0 0 0.5rem; }}
    .tools {{ font-size: 0.85rem; color: var(--muted); margin: 0 0 0.75rem; word-break: break-all; }}
    .answers {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      margin-top: 0.75rem;
    }}
    @media (max-width: 860px) {{ .answers {{ grid-template-columns: 1fr; }} }}
    .answer h4 {{ margin: 0 0 0.35rem; font-size: 0.82rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }}
    .answer pre {{
      margin: 0;
      padding: 0.65rem 0.75rem;
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.82rem;
      max-height: 220px;
      overflow: auto;
    }}
    .delta {{ font-weight: 700; padding: 0.1rem 0.35rem; border-radius: 4px; }}
    .delta.good {{ color: var(--good); background: var(--good-bg); }}
    .delta.bad {{ color: var(--bad); background: var(--bad-bg); }}
    .delta.neutral {{ color: var(--neutral); }}
    .empty {{ color: var(--muted); font-style: italic; }}
    footer {{ text-align: center; color: var(--muted); font-size: 0.82rem; margin-top: 2rem; }}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="page-header">
      <h1>HomeGraph 使用分析报告</h1>
      <p>生成时间：{esc(generated_at)}</p>
      <p>数据源：{esc(with_scored.name)} / {esc(without_scored.name)}</p>
    </header>

    <div class="overview">
      <div class="stat-card">
        <div class="label">总题目数（WITH 臂）</div>
        <div class="value">{total}</div>
      </div>
      <div class="stat-card highlight">
        <div class="label">使用了 HomeGraph</div>
        <div class="value">{used_n}</div>
      </div>
      <div class="stat-card muted-card">
        <div class="label">未使用 HomeGraph</div>
        <div class="value">{unused_n}</div>
      </div>
    </div>

    {main_section}
    {appendix}

    <footer>qa_eval · report_homegraph_html.py</footer>
  </div>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate HomeGraph usage HTML report from scored JSONL")
    parser.add_argument(
        "--agent-host",
        default=DEFAULT_HOST,
        help=f"Agent host tag (default: {DEFAULT_HOST})",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        default=str(DEFAULT_OUTPUT),
        help=f"Output HTML path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument("--log-dir", type=str, default=str(_SCRIPT_DIR / "log"))
    args = parser.parse_args()

    paths = paths_for_host(args.agent_host, log_dir=Path(args.log_dir))
    with_scored = paths["with_scored"]
    without_scored = paths["without_scored"]
    with_log = paths["with_log"]
    without_log = paths["without_log"]
    output = Path(args.output).expanduser().resolve()

    if not with_scored.is_file():
        print(f"错误: 缺少 {with_scored}")
        return 1
    if not without_scored.is_file():
        print(f"错误: 缺少 {without_scored}")
        return 1

    rows_with = load_jsonl(with_scored)
    rows_without = load_jsonl(without_scored)
    used, unused = split_by_homegraph_usage(rows_with)

    html_text = build_html(
        rows_with=rows_with,
        rows_without=rows_without,
        with_scored=with_scored,
        without_scored=without_scored,
        with_log=with_log if with_log.is_file() else None,
        without_log=without_log if without_log.is_file() else None,
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html_text, encoding="utf-8")

    print(f"HTML 报告已写入: {output}")
    print(f"  总题数: {len(rows_with)}  |  使用 HG: {len(used)}  |  未使用 HG: {len(unused)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
