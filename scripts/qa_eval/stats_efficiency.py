#!/usr/bin/env python3
"""
Stage 4 — 从 Agent 日志统计效率指标（首响应、轮次、总耗时、总 Token）。

「首响应」= 从 Evaluate 开始到第一次 LLM API 返回的耗时（日志行 `first token`）。

兼容 CodeGenie / Trae 等 Agent 日志格式：
  - Evaluate N:
  - first token
  - the N turn
  - totalTokenCount = N

Usage:
  python scripts/qa_eval/stats_efficiency.py -l scripts/qa_eval/log/agent-with-builtin.log
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path
from statistics import mean

_SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_LOG = _SCRIPT_DIR / "log" / "agent-with-builtin.log"

TIME_FMT = "%Y-%m-%d %H:%M:%S.%f"

TIME_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)")
EVALUATE_PATTERN = re.compile(r"Evaluate\s+(\d+):")
FIRST_TOKEN_PATTERN = re.compile(r"first token")
TURN_PATTERN = re.compile(r"the\s+(\d+)\s+turn")
TOKEN_PATTERN = re.compile(r"totalTokenCount\s*=\s*(\d+)")
PEAK_RSS_PATTERN = re.compile(r"peakRssMb\s*=\s*([\d.]+)")
AVG_RSS_PATTERN = re.compile(r"avgRssMb\s*=\s*([\d.]+)")


def parse_agent_log(log_file: Path) -> list[dict]:
    tasks: list[dict] = []
    current_task: dict | None = None
    last_log_time: datetime | None = None

    with log_file.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            time_match = TIME_PATTERN.search(line)
            if not time_match:
                continue

            try:
                log_time = datetime.strptime(time_match.group(1), TIME_FMT)
            except ValueError:
                continue

            last_log_time = log_time

            eval_match = EVALUATE_PATTERN.search(line)
            if eval_match:
                if current_task:
                    current_task["end_time"] = log_time
                    tasks.append(current_task)

                current_task = {
                    "id": int(eval_match.group(1)),
                    "start_time": log_time,
                    "first_token_time": None,
                    "first_api_response_time": None,
                    "max_turn": 0,
                    "end_time": None,
                    "total_tokens": 0,
                    "peak_rss_mb": None,
                    "avg_rss_mb": None,
                }
                continue

            if current_task is None:
                continue

            if FIRST_TOKEN_PATTERN.search(line):
                current_task["first_token_time"] = log_time
                continue

            turn_match = TURN_PATTERN.search(line)
            if turn_match:
                turn = int(turn_match.group(1))
                current_task["max_turn"] = max(current_task["max_turn"], turn)

            token_match = TOKEN_PATTERN.search(line)
            if token_match:
                if current_task["first_api_response_time"] is None:
                    current_task["first_api_response_time"] = log_time
                current_task["total_tokens"] += int(token_match.group(1))

            peak_match = PEAK_RSS_PATTERN.search(line)
            if peak_match:
                current_task["peak_rss_mb"] = float(peak_match.group(1))

            avg_match = AVG_RSS_PATTERN.search(line)
            if avg_match:
                current_task["avg_rss_mb"] = float(avg_match.group(1))

    if current_task:
        current_task["end_time"] = last_log_time
        tasks.append(current_task)

    return tasks


def _memory_from_rows(rows: list[dict]) -> tuple[list[float], list[float]]:
    peaks: list[float] = []
    avgs: list[float] = []
    for row in rows:
        mem = row.get("agent_memory_mb") or {}
        if mem.get("peak_rss_mb") is not None:
            peaks.append(float(mem["peak_rss_mb"]))
        if mem.get("avg_rss_mb") is not None:
            avgs.append(float(mem["avg_rss_mb"]))
    return peaks, avgs


def summarize_jsonl_usage(rows: list[dict]) -> dict:
    """Fallback when agent .log is missing: aggregate agent_usage from JSONL rows."""
    tokens: list[int] = []
    for row in rows:
        usage = row.get("agent_usage") or {}
        total = usage.get("total_tokens")
        if isinstance(total, (int, float)):
            tokens.append(int(total))
    peaks, avgs = _memory_from_rows(rows)
    return {
        "task_count": len(rows),
        "avg_first_token_s": None,
        "avg_turns": None,
        "avg_duration_s": None,
        "avg_tokens": mean(tokens) if tokens else None,
        "total_tokens": sum(tokens),
        "avg_peak_rss_mb": mean(peaks) if peaks else None,
        "max_peak_rss_mb": max(peaks) if peaks else None,
        "avg_avg_rss_mb": mean(avgs) if avgs else None,
        "source": "jsonl",
    }


FIRST_TOKEN_MIN_S = 0.05


def effective_first_response_time(task: dict) -> datetime | None:
    """首响应时间：优先用 first token 行；若与 Evaluate 几乎同时（旧日志 bug）则回退到首次 API 返回。"""
    start = task.get("start_time")
    ft = task.get("first_token_time")
    if start and ft:
        if (ft - start).total_seconds() >= FIRST_TOKEN_MIN_S:
            return ft
    return task.get("first_api_response_time") or ft


def item_efficiency_metrics(row: dict, log_task: dict | None = None) -> dict[str, float | int | None]:
    """Per-question efficiency: merge agent log task with JSONL row fallbacks."""
    metrics: dict[str, float | int | None] = {
        "turns": None,
        "duration_s": None,
        "first_token_s": None,
        "tokens": None,
        "peak_rss_mb": None,
    }

    if log_task:
        if log_task.get("max_turn"):
            metrics["turns"] = int(log_task["max_turn"])
        if log_task.get("start_time") and log_task.get("end_time"):
            metrics["duration_s"] = (log_task["end_time"] - log_task["start_time"]).total_seconds()
        response_time = effective_first_response_time(log_task)
        if response_time and log_task.get("start_time"):
            metrics["first_token_s"] = (response_time - log_task["start_time"]).total_seconds()
        if log_task.get("total_tokens"):
            metrics["tokens"] = int(log_task["total_tokens"])
        if log_task.get("peak_rss_mb") is not None:
            metrics["peak_rss_mb"] = float(log_task["peak_rss_mb"])

    if metrics["turns"] is None and row.get("agent_turns") is not None:
        metrics["turns"] = int(row["agent_turns"])
    if metrics["duration_s"] is None and row.get("agent_duration_ms") is not None:
        metrics["duration_s"] = float(row["agent_duration_ms"]) / 1000.0
    if metrics["tokens"] is None:
        usage = row.get("agent_usage") or {}
        if usage.get("total_tokens") is not None:
            metrics["tokens"] = int(usage["total_tokens"])
    if metrics["peak_rss_mb"] is None:
        mem = row.get("agent_memory_mb") or {}
        if mem.get("peak_rss_mb") is not None:
            metrics["peak_rss_mb"] = float(mem["peak_rss_mb"])

    return metrics


def per_item_efficiency_by_id(rows: list[dict], log_path: Path | None) -> dict[str, dict[str, float | int | None]]:
    """Map dataset id (e.g. D01) → efficiency metrics; log task N aligns with rows[N-1]."""
    tasks_by_seq: dict[int, dict] = {}
    if log_path and log_path.is_file():
        for task in parse_agent_log(log_path):
            tasks_by_seq[int(task["id"])] = task

    out: dict[str, dict[str, float | int | None]] = {}
    for i, row in enumerate(rows):
        rid = str(row.get("id", i))
        out[rid] = item_efficiency_metrics(row, tasks_by_seq.get(i + 1))
    return out


def summarize_tasks(tasks: list[dict], *, print_report: bool = True) -> dict:
    first_token_costs: list[float] = []
    turns: list[int] = []
    durations: list[float] = []
    tokens_list: list[int] = []
    peak_rss: list[float] = []
    avg_rss: list[float] = []

    if print_report:
        print("=" * 100)
        print("任务明细")
        print("=" * 100)

    for task in tasks:
        first_token_seconds = None
        response_time = effective_first_response_time(task)
        if response_time and task["start_time"]:
            first_token_seconds = (response_time - task["start_time"]).total_seconds()
            first_token_costs.append(first_token_seconds)

        turns.append(task["max_turn"])

        duration_seconds = 0.0
        if task["end_time"] and task["start_time"]:
            duration_seconds = (task["end_time"] - task["start_time"]).total_seconds()
            durations.append(duration_seconds)

        tokens_list.append(task["total_tokens"])
        if task.get("peak_rss_mb") is not None:
            peak_rss.append(float(task["peak_rss_mb"]))
        if task.get("avg_rss_mb") is not None:
            avg_rss.append(float(task["avg_rss_mb"]))

        if print_report:
            first_display = f"{first_token_seconds:.2f}s" if first_token_seconds is not None else "N/A"
            mem_display = (
                f"{task['peak_rss_mb']:.0f}MB"
                if task.get("peak_rss_mb") is not None
                else "N/A"
            )
            print(
                f"任务 {task['id']:>3} | "
                f"首响应: {first_display:<8} | "
                f"轮次: {task['max_turn']:>3} | "
                f"总时间: {duration_seconds:.2f}s | "
                f"总Token: {task['total_tokens']:<6} | "
                f"峰值内存: {mem_display}"
            )

    summary = {
        "task_count": len(tasks),
        "avg_first_token_s": mean(first_token_costs) if first_token_costs else None,
        "avg_turns": mean(turns) if turns else None,
        "avg_duration_s": mean(durations) if durations else None,
        "avg_tokens": mean(tokens_list) if tokens_list else None,
        "total_tokens": sum(tokens_list),
        "avg_peak_rss_mb": mean(peak_rss) if peak_rss else None,
        "max_peak_rss_mb": max(peak_rss) if peak_rss else None,
        "avg_avg_rss_mb": mean(avg_rss) if avg_rss else None,
        "source": "log",
    }

    if print_report:
        print("\n" + "=" * 100)
        print("统计结果")
        print("=" * 100)
        print(f"任务总数: {summary['task_count']}")

        if summary["avg_first_token_s"] is not None:
            print(f"平均首响应时间: {summary['avg_first_token_s']:.2f} 秒")
        if summary["avg_turns"] is not None:
            print(f"平均轮次: {summary['avg_turns']:.2f}")
        if summary["avg_duration_s"] is not None:
            print(f"平均总时间: {summary['avg_duration_s'] / 60:.2f} min ({summary['avg_duration_s']:.2f} s)")
        if summary["avg_tokens"] is not None:
            print(f"平均总 Token: {summary['avg_tokens'] / 1000:.2f} k")
            print(f"合计总 Token: {summary['total_tokens']}")
        if summary["avg_peak_rss_mb"] is not None:
            print(f"平均峰值内存: {summary['avg_peak_rss_mb']:.1f} MB")
        if summary["max_peak_rss_mb"] is not None:
            print(f"最大峰值内存: {summary['max_peak_rss_mb']:.1f} MB")
        if summary["avg_avg_rss_mb"] is not None:
            print(f"平均内存占用: {summary['avg_avg_rss_mb']:.1f} MB")

        print("=" * 100)
    return summary


def summarize_log(log_file: Path, *, print_report: bool = True) -> dict | None:
    if not log_file.is_file():
        return None
    tasks = parse_agent_log(log_file)
    if not tasks:
        return None
    return summarize_tasks(tasks, print_report=print_report)


def main() -> int:
    parser = argparse.ArgumentParser(description="Agent 日志效率统计")
    parser.add_argument("--log", "-l", type=str, default=str(DEFAULT_LOG), help="Agent 日志路径")
    args = parser.parse_args()

    log_file = Path(args.log)
    if not log_file.is_file():
        print(f"错误: 日志文件 {log_file} 不存在")
        return 1

    tasks = parse_agent_log(log_file)
    if not tasks:
        print("警告: 日志中未解析到任何 Evaluate 任务段")
        return 1

    summarize_tasks(tasks)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
