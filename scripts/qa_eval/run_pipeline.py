#!/usr/bin/env python3
"""
QA Eval A/B 一条龙：Agent 跑题 → Judge 打分 → 完整对比报告。

Usage:
  export DASHSCOPE_API_KEY=sk-...
  # 或智谱: export ZHIPU_API_KEY='id.secret'
  python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo
  python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo --provider zhipu

  # 只重打报告、不重跑 Agent/Judge（无需 --repo）：
  python scripts/qa_eval/run_pipeline.py ab --no-agent --no-judge
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
from collections import defaultdict
from contextlib import redirect_stdout
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = _SCRIPT_DIR / "data"
LOG_DIR = _SCRIPT_DIR / "log"
DEFAULT_REPORT = DATA_DIR / "report-builtin.txt"
DEFAULT_DATASET = DATA_DIR / "test-set.jsonl"
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen3-235b-a22b-instruct-2507"

if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from agent_runner import run_agent_dataset  # noqa: E402
from external_agent import HOST_CLAUDE, HOST_DEVECO, SUPPORTED_HOSTS, run_external_dataset, verify_claude_login  # noqa: E402
from llm_config import PROVIDER_DASHSCOPE, PROVIDER_ZHIPU, provider_help, resolve_llm_config  # noqa: E402
from my_answer_accuracy import extract_json_blocks_answerbyCOT, remove_tool_calls  # noqa: E402
from stats_efficiency import parse_agent_log, summarize_jsonl_usage, summarize_tasks  # noqa: E402
from stats_scores import compute_stats_from_rows, print_statistics  # noqa: E402

AGENT_HOST_BUILTIN = "builtin"
ALL_AGENT_HOSTS = (AGENT_HOST_BUILTIN, HOST_CLAUDE, HOST_DEVECO)

# 各宿主产出文件后缀 → report-builtin.txt / report-claude.txt / report-deveco.txt
HOST_FILE_SUFFIX: dict[str, str] = {
    AGENT_HOST_BUILTIN: "builtin",
    HOST_CLAUDE: "claude",
    HOST_DEVECO: "deveco",
}


def require_repo_arg(repo: str | None, *, no_agent: bool) -> Path | None:
    """Return resolved repo path; required unless --no-agent (report-only)."""
    if no_agent:
        return Path(repo).expanduser().resolve() if repo else None
    if not repo:
        print("错误: 请指定被测仓库路径 --repo / -r（跑 Agent 时必填）")
        return None
    path = Path(repo).expanduser().resolve()
    if not path.is_dir():
        print(f"错误: 仓库不存在: {path}")
        return None
    return path


def host_tag(agent_host: str) -> str:
    suffix = HOST_FILE_SUFFIX.get(agent_host, agent_host.replace("-code", ""))
    return f"-{suffix}"


def clear_log_dir(log_dir: Path) -> tuple[int, list[str]]:
    """Remove files/subdirs under qa_eval log/ before a fresh run.

    Skips paths locked by another process (common on Windows when a file is open
    in the editor) instead of aborting the pipeline.
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    removed = 0
    skipped: list[str] = []
    for child in sorted(log_dir.iterdir(), key=lambda p: (p.is_dir(), p.name.lower())):
        try:
            if child.is_file():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
            else:
                continue
            removed += 1
        except OSError as e:
            skipped.append(f"{child.name} ({e})")
    return removed, skipped


def paths_for_host(agent_host: str, *, log_dir: Path = LOG_DIR, data_dir: Path = DATA_DIR) -> dict[str, Path]:
    tag = host_tag(agent_host)
    log_dir.mkdir(parents=True, exist_ok=True)
    return {
        "with_jsonl": log_dir / f"result-with{tag}.jsonl",
        "without_jsonl": log_dir / f"result-without{tag}.jsonl",
        "with_scored": log_dir / f"result-with{tag}-scored.jsonl",
        "without_scored": log_dir / f"result-without{tag}-scored.jsonl",
        "with_log": log_dir / f"agent-with{tag}.log",
        "without_log": log_dir / f"agent-without{tag}.log",
        "report": data_dir / f"report{tag}.txt",
    }


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def index_by_id(rows: list[dict]) -> dict[str, dict]:
    return {str(r.get("id", i)): r for i, r in enumerate(rows)}


def fmt_num(value: float | None, *, digits: int = 2) -> str:
    if value is None:
        return "N/A"
    return f"{value:.{digits}f}"


def fmt_delta(a: float | None, b: float | None, *, digits: int = 2) -> str:
    if a is None or b is None:
        return "N/A"
    sign = "+" if a - b >= 0 else ""
    return f"{sign}{a - b:.{digits}f}"


def clip(text: str, n: int = 56) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def clean_answer(raw: str) -> str:
    return remove_tool_calls(extract_json_blocks_answerbyCOT(str(raw or "")))


def tool_chain_summary(raw: str, *, used_homegraph: bool | None = None) -> str:
    tools = re.findall(r"---\n([^\n]+)\n", str(raw or ""))
    chain = " → ".join(tools) if tools else "-"
    if used_homegraph is True:
        return f"{chain} [homegraph]"
    if used_homegraph is False:
        return f"{chain} [无homegraph]"
    return chain


def print_trajectory_section(rows_with: list[dict], rows_without: list[dict]) -> None:
    rows = [( "with", r) for r in rows_with] + [("without", r) for r in rows_without]
    if not any(r.get("deveco_session_id") or r.get("agent_trace_file") for _, r in rows):
        return
    print("\n" + "=" * 120)
    print("【Agent 轨迹 / DevEco Session】")
    print("跑完后查看完整轨迹：")
    print("  1) JSON 文件：scripts/qa_eval/log/traces/<with|without>-deveco/<ID>-ses_*.json")
    print("  2) CLI：deveco export <session_id>   或  deveco session list  找标题 qa-eval-*")
    print("-" * 120)
    print(f"{'ID':<6}{'臂':<8}{'HG':<4}{'状态':<8}{'工具链':<28}{'session_id':<28}{'轨迹文件'}")
    print("-" * 120)
    for arm, r in rows:
        rid = str(r.get("id", ""))
        status = str(r.get("agent_status", ""))[:7]
        hg = "Y" if r.get("agent_used_homegraph") else ("N" if arm == "with" else "-")
        chain = clip(
            tool_chain_summary(
                str(r.get("output_answer", "")),
                used_homegraph=r.get("agent_used_homegraph") if arm == "with" else None,
            ),
            26,
        )
        sid = str(r.get("deveco_session_id") or "-")
        trace = str(r.get("agent_trace_file") or "-")
        print(f"{rid:<6}{arm:<8}{hg:<4}{status:<8}{chain:<28}{sid:<28}{trace}")
    print("=" * 120)


def row_tokens(row: dict) -> int | None:
    usage = row.get("agent_usage") or {}
    total = usage.get("total_tokens")
    return int(total) if isinstance(total, (int, float)) else None


def resolve_api_key() -> str | None:
    try:
        return resolve_llm_config(provider=os.environ.get("QA_EVAL_PROVIDER")).api_key
    except RuntimeError:
        return None


def run_judge(agent_jsonl: Path, scored_jsonl: Path, *, workers: int, llm) -> int:
    if not agent_jsonl.is_file():
        print(f"错误: Agent 产出不存在，无法 Judge: {agent_jsonl}")
        return 1
    n = sum(1 for line in agent_jsonl.open(encoding="utf-8") if line.strip())
    print(f"\n>>> Judge ({llm.provider})：{agent_jsonl.name}，共 {n} 条", flush=True)
    cmd = [
        sys.executable,
        str(_SCRIPT_DIR / "eval_metrics.py"),
        "-i",
        str(agent_jsonl),
        "-o",
        str(scored_jsonl),
        "-w",
        str(workers),
        "-m",
        llm.model,
        "--base-url",
        llm.base_url,
        "--provider",
        llm.provider,
    ]
    print(f"\n>>> {' '.join(cmd)}\n")
    return subprocess.call(cmd)


def run_judge_if_needed(agent_jsonl: Path, scored_jsonl: Path, *, workers: int, llm) -> int:
    return run_judge(agent_jsonl, scored_jsonl, workers=workers, llm=llm)


def print_category_table(rows_with: list[dict], rows_without: list[dict]) -> None:
    by_cat: dict[str, list[tuple[float, float]]] = defaultdict(list)
    wo = index_by_id(rows_without)
    for r in rows_with:
        rid = str(r.get("id"))
        if rid not in wo:
            continue
        if r.get("evaluation_status") != "success" or wo[rid].get("evaluation_status") != "success":
            continue
        cat = str(r.get("category_l1") or "未分类")
        by_cat[cat].append((float(r["answer_accuracy_score"]), float(wo[rid]["answer_accuracy_score"])))

    print("\n" + "=" * 88)
    print("按类别准确率")
    print("=" * 88)
    print(f"{'类别':<12}{'题数':>6}{'with均分':>12}{'without均分':>14}{'Δ':>10}")
    print("-" * 88)
    for cat in sorted(by_cat):
        pairs = by_cat[cat]
        w_mean = statistics.mean(p[0] for p in pairs)
        wo_mean = statistics.mean(p[1] for p in pairs)
        print(f"{cat:<12}{len(pairs):>6}{w_mean:>12.4f}{wo_mean:>14.4f}{w_mean - wo_mean:>+10.4f}")
    print("=" * 88)


def print_per_item_table(rows_with: list[dict], rows_without: list[dict]) -> None:
    wo = index_by_id(rows_without)
    wins = ties = losses = 0

    print("\n" + "=" * 120)
    print("逐题对比（query → with / without 得分与答案摘要）")
    print("=" * 120)
    print(
        f"{'ID':<5}{'类':<6}{'with':>6}{'wo':>6}{'Δ':>7} {'问题':<28} {'with答案':<32} {'without答案'}"
    )
    print("-" * 120)

    for r in rows_with:
        rid = str(r.get("id", ""))
        w = wo.get(rid, {})
        sw = float(r["answer_accuracy_score"]) if r.get("evaluation_status") == "success" else None
        swo = float(w["answer_accuracy_score"]) if w.get("evaluation_status") == "success" else None
        if sw is not None and swo is not None:
            if sw > swo:
                wins += 1
            elif sw < swo:
                losses += 1
            else:
                ties += 1
        cat = str(r.get("category_l1") or "")[:4]
        q = clip(str(r.get("query", "")), 26)
        aw = clip(clean_answer(str(r.get("output_answer", ""))), 30)
        awo = clip(clean_answer(str(w.get("output_answer", ""))), 30)
        print(
            f"{rid:<5}{cat:<6}"
            f"{fmt_num(sw, digits=2):>6}"
            f"{fmt_num(swo, digits=2):>6}"
            f"{fmt_delta(sw, swo, digits=2):>7} "
            f"{q:<28} {aw:<32} {awo}"
        )

    print("-" * 120)
    print(f"with 更高: {wins}  |  持平: {ties}  |  without 更高: {losses}")
    print("=" * 120)


def print_efficiency_section(
    label: str, log_path: Path | None, rows: list[dict], *, print_report: bool = True
) -> dict:
    if print_report:
        print(f"\n{'=' * 88}")
        print(f"{label} — 效率明细")
        print("=" * 88)

    if log_path and log_path.is_file():
        tasks = parse_agent_log(log_path)
        if tasks:
            summary = summarize_tasks(tasks, print_report=print_report)
            summary["source"] = f"日志 {log_path}"
            return summary

    if print_report:
        print(f"日志: {log_path} （不存在或未解析到 Evaluate 段）")
        print("\n从 JSONL agent_usage 逐题 Token:")
        print(f"{'ID':<6}{'Token':>10}{'agent_backend':>20}")
        print("-" * 40)
    tokens: list[int] = []
    for r in rows:
        tok = row_tokens(r)
        if tok is not None:
            tokens.append(tok)
        if print_report:
            print(
                f"{str(r.get('id', '')):<6}"
                f"{tok if tok is not None else 'N/A':>10}"
                f"{str(r.get('agent_backend', '')):>20}"
            )
    summary = summarize_jsonl_usage(rows)
    summary["source"] = "JSONL agent_usage"
    if print_report:
        print("-" * 40)
        print(f"平均 Token: {summary['avg_tokens']:.0f}" if summary.get("avg_tokens") else "平均 Token: N/A")
        print(f"合计 Token: {summary.get('total_tokens', 0)}")
        print("=" * 88)
    return summary


def print_full_ab_report(
    *,
    with_scored: Path,
    without_scored: Path,
    with_log: Path | None,
    without_log: Path | None,
    rows_with: list[dict],
    rows_without: list[dict],
) -> None:
    stats_with = compute_stats_from_rows(rows_with)
    stats_without = compute_stats_from_rows(rows_without)

    print("\n")
    print("#" * 88)
    print("#" + " " * 30 + "A/B 完整评测报告" + " " * 30 + "#")
    print("#" * 88)

    print("\n【输入文件】")
    print(f"  with  scored : {with_scored}")
    print(f"  without scored: {without_scored}")
    print(f"  with  log    : {with_log} {'(存在)' if with_log and with_log.is_file() else '(无)'}")
    print(f"  without log  : {without_log} {'(存在)' if without_log and without_log.is_file() else '(无)'}")

    eff_with = print_efficiency_section("WITH homegraph", with_log, rows_with)
    eff_without = print_efficiency_section("WITHOUT homegraph", without_log, rows_without)

    print_statistics(stats_with, with_scored, title="【WITH homegraph】准确率统计")
    print_statistics(stats_without, without_scored, title="【WITHOUT homegraph】准确率统计")

    print_category_table(rows_with, rows_without)
    print_per_item_table(rows_with, rows_without)
    print_trajectory_section(rows_with, rows_without)

    w = 22
    print("\n" + "=" * 88)
    print("【A/B 汇总表】")
    print("=" * 88)
    print(f"{'指标':<24}{'with':>{w}}{'without':>{w}}{'Δ (with−without)':>{w}}")
    print("-" * 88)

    def sm(s: dict | None) -> float | None:
        return float(s["mean"]) if s and s.get("valid_scores") else None

    def sd(s: dict | None) -> float | None:
        return float(s["median"]) if s and s.get("valid_scores") else None

    print(
        f"{'准确率 均值':<24}"
        f"{fmt_num(sm(stats_with), digits=4):>{w}}"
        f"{fmt_num(sm(stats_without), digits=4):>{w}}"
        f"{fmt_delta(sm(stats_with), sm(stats_without), digits=4):>{w}}"
    )
    print(
        f"{'准确率 中位数':<24}"
        f"{fmt_num(sd(stats_with), digits=4):>{w}}"
        f"{fmt_num(sd(stats_without), digits=4):>{w}}"
        f"{fmt_delta(sd(stats_with), sd(stats_without), digits=4):>{w}}"
    )
    jw = f"{stats_with['success_samples']}/{stats_with['total_samples']}"
    jo = f"{stats_without['success_samples']}/{stats_without['total_samples']}"
    print(
        f"{'Judge 成功/总数':<24}"
        f"{jw:>{w}}"
        f"{jo:>{w}}"
        f"{'—':>{w}}"
    )
    print("-" * 88)
    print(
        f"{'平均轮次':<24}"
        f"{fmt_num(eff_with.get('avg_turns')):>{w}}"
        f"{fmt_num(eff_without.get('avg_turns')):>{w}}"
        f"{fmt_delta(eff_with.get('avg_turns'), eff_without.get('avg_turns')):>{w}}"
    )
    print(
        f"{'平均耗时 (秒)':<24}"
        f"{fmt_num(eff_with.get('avg_duration_s')):>{w}}"
        f"{fmt_num(eff_without.get('avg_duration_s')):>{w}}"
        f"{fmt_delta(eff_with.get('avg_duration_s'), eff_without.get('avg_duration_s')):>{w}}"
    )
    tw = eff_with.get("avg_tokens")
    two = eff_without.get("avg_tokens")
    print(
        f"{'平均 Token (k)':<24}"
        f"{fmt_num(tw / 1000 if tw else None, digits=2):>{w}}"
        f"{fmt_num(two / 1000 if two else None, digits=2):>{w}}"
        f"{fmt_delta(tw / 1000 if tw else None, two / 1000 if two else None, digits=2):>{w}}"
    )
    print(
        f"{'平均首响应 (秒)':<24}"
        f"{fmt_num(eff_with.get('avg_first_token_s')):>{w}}"
        f"{fmt_num(eff_without.get('avg_first_token_s')):>{w}}"
        f"{fmt_delta(eff_with.get('avg_first_token_s'), eff_without.get('avg_first_token_s')):>{w}}"
    )
    print(
        f"{'平均峰值内存 (MB)':<24}"
        f"{fmt_num(eff_with.get('avg_peak_rss_mb')):>{w}}"
        f"{fmt_num(eff_without.get('avg_peak_rss_mb')):>{w}}"
        f"{fmt_delta(eff_with.get('avg_peak_rss_mb'), eff_without.get('avg_peak_rss_mb')):>{w}}"
    )
    print(
        f"{'最大峰值内存 (MB)':<24}"
        f"{fmt_num(eff_with.get('max_peak_rss_mb')):>{w}}"
        f"{fmt_num(eff_without.get('max_peak_rss_mb')):>{w}}"
        f"{fmt_delta(eff_with.get('max_peak_rss_mb'), eff_without.get('max_peak_rss_mb')):>{w}}"
    )
    print("-" * 88)
    print("效率数据来源:")
    print(f"  with    : {eff_with.get('source', '?')}")
    print(f"  without : {eff_without.get('source', '?')}")
    print("=" * 88)


def run_agent_stage(
    *,
    agent_host: str,
    repo: Path,
    dataset: list[dict],
    with_jsonl: Path,
    without_jsonl: Path,
    with_log: Path | None,
    without_log: Path | None,
    llm,
    hg_bin: str | None,
    max_turns: int,
    deveco_model: str | None = None,
    deveco_attach: str | None = None,
) -> None:
    if agent_host == HOST_CLAUDE:
        verify_claude_login()
    for arm, out, log in (
        ("with", with_jsonl, with_log),
        ("without", without_jsonl, without_log),
    ):
        label = "WITH homegraph" if arm == "with" else "WITHOUT (grep/read only)"
        print(f"\n>>> Agent [{agent_host}] [{label}] → {out}")
        if agent_host == AGENT_HOST_BUILTIN:
            run_agent_dataset(
                repo,
                dataset,
                arm=arm,
                output=out,
                log_file=log,
                api_key=llm.api_key,
                base_url=llm.base_url,
                model=llm.model,
                hg_bin=hg_bin,
                max_turns=max_turns,
                extra_body=llm.extra_body,
            )
        else:
            run_external_dataset(
                agent_host,
                repo,
                dataset,
                arm=arm,
                output=out,
                log_file=log,
                hg_bin=hg_bin or "",
                model=deveco_model if agent_host == HOST_DEVECO else None,
                deveco_attach=deveco_attach if agent_host == HOST_DEVECO else None,
            )


def cmd_ab(args: argparse.Namespace) -> int:
    if args.agent_host == "all":
        return cmd_hosts(args)

    agent_host = args.agent_host
    paths = paths_for_host(agent_host)
    if args.with_scored:
        with_scored = Path(args.with_scored)
    else:
        with_scored = paths["with_scored"]
    if args.without_scored:
        without_scored = Path(args.without_scored)
    else:
        without_scored = paths["without_scored"]
    if args.with_jsonl:
        with_jsonl = Path(args.with_jsonl)
    else:
        with_jsonl = paths["with_jsonl"]
    if args.without_jsonl:
        without_jsonl = Path(args.without_jsonl)
    else:
        without_jsonl = paths["without_jsonl"]
    with_log = Path(args.with_log) if args.with_log else paths["with_log"]
    without_log = Path(args.without_log) if args.without_log else paths["without_log"]
    repo = require_repo_arg(getattr(args, "repo", None), no_agent=args.no_agent)
    if repo is None and not args.no_agent:
        return 1
    dataset_path = Path(args.dataset).expanduser().resolve()

    try:
        llm = resolve_llm_config(
            provider=getattr(args, "provider", None),
            model=getattr(args, "model", None),
            base_url=getattr(args, "base_url", None),
        )
    except RuntimeError as e:
        print(f"错误: {e}")
        return 1

    if not args.no_agent:
        if not dataset_path.is_file():
            print(f"错误: 测试集不存在: {dataset_path}")
            return 1

        dataset = load_jsonl(dataset_path)
        if not getattr(args, "keep_log", False):
            removed, skipped = clear_log_dir(LOG_DIR)
            print(f"已清空 log 目录: {LOG_DIR} ({removed} 项)", flush=True)
            if skipped:
                print("⚠ 以下项被占用，未删除（关闭占用进程后可手动删）:", flush=True)
                for item in skipped:
                    print(f"  - {item}", flush=True)
        print("=" * 60)
        print(f"Stage 1 — Agent 跑题 ({len(dataset)} 条)  host={agent_host}")
        print(f"  LLM    : {llm.provider}")
        print(f"  仓库   : {repo}")
        print(f"  测试集 : {dataset_path}")
        print(f"  报告   : {paths['report']}")
        print("=" * 60)

        assert repo is not None
        run_agent_stage(
            agent_host=agent_host,
            repo=repo,
            dataset=dataset,
            with_jsonl=with_jsonl,
            without_jsonl=without_jsonl,
            with_log=with_log,
            without_log=without_log,
            llm=llm,
            hg_bin=args.homegraph_bin,
            max_turns=args.max_turns,
            deveco_model=getattr(args, "deveco_model", None),
            deveco_attach=getattr(args, "deveco_attach", None),
        )

    if not args.no_judge:
        print("\n" + "=" * 60)
        print(f"Stage 2 — Judge 打分 ({llm.provider})")
        print("=" * 60)
        if run_judge(with_jsonl, with_scored, workers=args.workers, llm=llm) != 0:
            return 1
        if run_judge(without_jsonl, without_scored, workers=args.workers, llm=llm) != 0:
            return 1

    if not with_scored.is_file() or not without_scored.is_file():
        print("错误: 缺少 scored 结果。请去掉 --no-agent --no-judge 完整跑一遍，或提供 scored 文件。")
        return 1

    rows_with = load_jsonl(with_scored)
    rows_without = load_jsonl(without_scored)

    print("\n" + "=" * 60)
    print("Stage 3–4 — 效率统计 + A/B 对比报告")
    print("=" * 60)

    eff_with = print_efficiency_section("WITH homegraph", with_log, rows_with)
    eff_without = print_efficiency_section("WITHOUT homegraph", without_log, rows_without)

    report_path = Path(args.report).expanduser().resolve() if args.report else paths["report"]
    report_path.parent.mkdir(parents=True, exist_ok=True)

    buf = io.StringIO()
    with redirect_stdout(buf):
        print_full_ab_report(
            with_scored=with_scored,
            without_scored=without_scored,
            with_log=with_log,
            without_log=without_log,
            rows_with=rows_with,
            rows_without=rows_without,
        )

    report_path.write_text(buf.getvalue(), encoding="utf-8")
    print(f"\nA/B 完整报告已写入: {report_path}")
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    input_jsonl = Path(args.input)
    scored = Path(args.scored) if args.scored else input_jsonl.with_name(input_jsonl.stem + "-scored.jsonl")
    cmd = [
        sys.executable,
        str(_SCRIPT_DIR / "eval_metrics.py"),
        "-i",
        str(input_jsonl),
        "-o",
        str(scored),
        "-w",
        str(args.workers),
    ]
    if getattr(args, "provider", None):
        cmd.extend(["--provider", args.provider])
    if args.model:
        cmd.extend(["-m", args.model])
    rc = subprocess.call(cmd)
    if rc != 0:
        return rc
    rows = load_jsonl(scored)
    print_statistics(compute_stats_from_rows(rows), scored)
    if args.log:
        print_efficiency_section("单路", Path(args.log), rows)
    return 0


def cmd_hosts(args: argparse.Namespace) -> int:
    """Run full A/B for each Agent host (builtin, claude-code, deveco-code)."""
    repo = require_repo_arg(getattr(args, "repo", None), no_agent=args.no_agent)
    if repo is None and not args.no_agent:
        return 1

    hosts_raw = getattr(args, "agent_hosts", None) or ",".join(ALL_AGENT_HOSTS)
    hosts = [h.strip() for h in hosts_raw.split(",") if h.strip()]
    unknown = [h for h in hosts if h not in ALL_AGENT_HOSTS]
    if unknown:
        print(f"错误: 未知 agent host: {unknown}，可选: {', '.join(ALL_AGENT_HOSTS)}")
        return 1

    rc = 0
    for host in hosts:
        print("\n" + "#" * 88)
        print(f"# Agent host: {host}")
        print("#" * 88)
        host_args = argparse.Namespace(
            repo=args.repo,
            dataset=args.dataset,
            with_scored=None,
            without_scored=None,
            with_jsonl=None,
            without_jsonl=None,
            with_log=None,
            without_log=None,
            workers=args.workers,
            provider=getattr(args, "provider", None),
            model=args.model,
            base_url=args.base_url,
            homegraph_bin=args.homegraph_bin,
            max_turns=args.max_turns,
            no_agent=args.no_agent,
            no_judge=args.no_judge,
            keep_log=getattr(args, "keep_log", False),
            report=None,
            agent_host=host,
            deveco_model=getattr(args, "deveco_model", None),
            deveco_attach=getattr(args, "deveco_attach", None),
        )
        if cmd_ab(host_args) != 0:
            rc = 1
    if rc == 0:
        print("\n" + "=" * 60)
        print("全部宿主跑完，报告文件：")
        for host in hosts:
            p = paths_for_host(host)["report"]
            print(f"  {host}: {p}")
        print("=" * 60)
    return rc


def main() -> int:
    parser = argparse.ArgumentParser(description="QA Eval A/B — 完整打印全部对比结果")
    sub = parser.add_subparsers(dest="command", required=True)

    p_ab = sub.add_parser("ab", help="一条龙：Agent → Judge → 完整报告（默认会更新全部数据）")
    p_ab.add_argument(
        "--repo",
        "-r",
        default=None,
        help="被测仓库绝对路径（跑 Agent 时必填；仅 --no-agent 重打报告时可省略）",
    )
    p_ab.add_argument("--dataset", "-d", default=str(DEFAULT_DATASET))
    p_ab.add_argument(
        "--agent-host",
        default=AGENT_HOST_BUILTIN,
        choices=[*ALL_AGENT_HOSTS, "all"],
        help="Agent 宿主: builtin(Python+Qwen) | claude-code | deveco-code | all",
    )
    p_ab.add_argument("--with-scored", default=None)
    p_ab.add_argument("--without-scored", default=None)
    p_ab.add_argument("--with-jsonl", default=None)
    p_ab.add_argument("--without-jsonl", default=None)
    p_ab.add_argument("--with-log", default=None)
    p_ab.add_argument("--without-log", default=None)
    p_ab.add_argument("--workers", "-w", type=int, default=1)
    p_ab.add_argument(
        "--provider",
        choices=[PROVIDER_DASHSCOPE, PROVIDER_ZHIPU],
        default=None,
        help=provider_help(),
    )
    p_ab.add_argument("--model", "-m", default=None, help="LLM 模型（默认随 provider）")
    p_ab.add_argument("--base-url", default=None, help="OpenAI 兼容 API 端点（默认随 provider）")
    p_ab.add_argument("--homegraph-bin", default=None)
    p_ab.add_argument("--max-turns", type=int, default=8, help="Agent 最多工具轮次")
    p_ab.add_argument(
        "--deveco-model",
        default=None,
        help="DevEco Agent 模型（provider/model，如 zhipuai/glm-4.5-flash）；默认用 DevEco 自身配置，不用 --model",
    )
    p_ab.add_argument(
        "--deveco-attach",
        default=os.environ.get("QA_EVAL_DEVECO_ATTACH"),
        help="已运行的 deveco serve 地址（如 http://127.0.0.1:4096），复用进程避免每题冷启动",
    )
    p_ab.add_argument("--no-agent", action="store_true", help="不跑 Agent，沿用已有 JSONL")
    p_ab.add_argument("--no-judge", action="store_true", help="不跑 Judge，沿用已有 scored")
    p_ab.add_argument(
        "--keep-log",
        action="store_true",
        help="保留 scripts/qa_eval/log 下旧文件（默认每次跑 Agent 前清空）",
    )
    p_ab.add_argument(
        "--report",
        default=None,
        help="A/B 完整报告输出路径（默认 data/report-{host}.txt，如 report-deveco.txt）",
    )
    p_ab.set_defaults(func=cmd_ab)

    p_hosts = sub.add_parser("hosts", help="依次跑 builtin + claude-code + deveco-code 的 A/B")
    p_hosts.add_argument(
        "--repo",
        "-r",
        default=None,
        help="被测仓库绝对路径（跑 Agent 时必填；仅 --no-agent 重打报告时可省略）",
    )
    p_hosts.add_argument("--dataset", "-d", default=str(DEFAULT_DATASET))
    p_hosts.add_argument("--workers", "-w", type=int, default=1)
    p_hosts.add_argument("--provider", choices=[PROVIDER_DASHSCOPE, PROVIDER_ZHIPU], default=None)
    p_hosts.add_argument("--model", "-m", default=None)
    p_hosts.add_argument("--base-url", default=None)
    p_hosts.add_argument("--homegraph-bin", default=None)
    p_hosts.add_argument("--max-turns", type=int, default=8)
    p_hosts.add_argument("--deveco-model", default=None)
    p_hosts.add_argument(
        "--deveco-attach",
        default=os.environ.get("QA_EVAL_DEVECO_ATTACH"),
        help="deveco serve 地址，见 ab --deveco-attach",
    )
    p_hosts.add_argument("--no-agent", action="store_true")
    p_hosts.add_argument("--no-judge", action="store_true")
    p_hosts.add_argument("--keep-log", action="store_true")
    p_hosts.add_argument(
        "--agent-hosts",
        default=",".join(ALL_AGENT_HOSTS),
        help="逗号分隔: builtin,claude-code,deveco-code",
    )
    p_hosts.set_defaults(func=cmd_hosts)

    p_score = sub.add_parser("score", help="单路：Agent JSONL → Judge → 统计")
    p_score.add_argument("--input", "-i", required=True)
    p_score.add_argument("--scored", "-o", default=None)
    p_score.add_argument("--log", "-l", default=None)
    p_score.add_argument("--workers", "-w", type=int, default=1)
    p_score.add_argument("--provider", choices=[PROVIDER_DASHSCOPE, PROVIDER_ZHIPU], default=None)
    p_score.add_argument("--model", "-m", default=None)
    p_score.set_defaults(func=cmd_score)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
