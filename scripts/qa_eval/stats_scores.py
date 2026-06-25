#!/usr/bin/env python3
"""
Stage 3 — Answer Accuracy Score 统计。

Usage:
  python scripts/qa_eval/stats_scores.py -i scripts/qa_eval/log/result-with-builtin-scored.jsonl
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = _SCRIPT_DIR / "log" / "result-with-builtin-scored.jsonl"


def calculate_answer_accuracy_statistics(file_path: Path) -> dict | None:
    scores: list[float] = []
    total_samples = 0
    success_samples = 0
    failed_samples = 0

    print(f"正在读取文件: {file_path}")

    try:
        with file_path.open("r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    total_samples += 1

                    if "answer_accuracy_score" not in data:
                        failed_samples += 1
                        print(f"  第{line_num}行: 缺少 answer_accuracy_score 字段")
                        continue

                    score = data["answer_accuracy_score"]
                    eval_status = data.get("evaluation_status", "unknown")

                    if (
                        eval_status == "success"
                        and isinstance(score, (int, float))
                        and not (isinstance(score, float) and str(score).lower() == "nan")
                    ):
                        scores.append(float(score))
                        success_samples += 1
                    else:
                        failed_samples += 1
                        print(f"  第{line_num}行: 评估失败或无效分数 - 状态: {eval_status}, 分数: {score}")

                except json.JSONDecodeError as e:
                    print(f"  第{line_num}行: JSON 解析错误 - {e}")
                    failed_samples += 1

    except FileNotFoundError:
        print(f"错误: 文件 {file_path} 不存在")
        return None
    except OSError as e:
        print(f"读取文件时出错: {e}")
        return None

    if not scores:
        print("警告: 没有找到有效的 answer_accuracy_score 数据")
        return {
            "total_samples": total_samples,
            "success_samples": success_samples,
            "failed_samples": failed_samples,
            "valid_scores": 0,
        }

    stats = {
        "total_samples": total_samples,
        "success_samples": success_samples,
        "failed_samples": failed_samples,
        "valid_scores": len(scores),
        "mean": statistics.mean(scores),
        "median": statistics.median(scores),
        "min": min(scores),
        "max": max(scores),
        "std_dev": statistics.stdev(scores) if len(scores) > 1 else 0.0,
        "variance": statistics.variance(scores) if len(scores) > 1 else 0.0,
        "_scores": scores,
    }
    return stats


def compute_stats_from_rows(rows: list[dict]) -> dict | None:
    """Same stats as calculate_answer_accuracy_statistics, from in-memory rows."""
    scores: list[float] = []
    total_samples = len(rows)
    success_samples = 0
    failed_samples = 0

    for data in rows:
        if "answer_accuracy_score" not in data:
            failed_samples += 1
            continue
        score = data["answer_accuracy_score"]
        eval_status = data.get("evaluation_status", "unknown")
        if (
            eval_status == "success"
            and isinstance(score, (int, float))
            and not (isinstance(score, float) and str(score).lower() == "nan")
        ):
            scores.append(float(score))
            success_samples += 1
        else:
            failed_samples += 1

    if not scores:
        return {
            "total_samples": total_samples,
            "success_samples": success_samples,
            "failed_samples": failed_samples,
            "valid_scores": 0,
        }

    return {
        "total_samples": total_samples,
        "success_samples": success_samples,
        "failed_samples": failed_samples,
        "valid_scores": len(scores),
        "mean": statistics.mean(scores),
        "median": statistics.median(scores),
        "min": min(scores),
        "max": max(scores),
        "std_dev": statistics.stdev(scores) if len(scores) > 1 else 0.0,
        "variance": statistics.variance(scores) if len(scores) > 1 else 0.0,
        "_scores": scores,
    }


def print_statistics(stats: dict | None, file_path: Path | None = None, *, title: str | None = None) -> None:
    if not stats:
        return

    print("\n" + "=" * 60)
    print(title or "Answer Accuracy Score 统计结果")
    print("=" * 60)
    if file_path:
        print(f"文件: {file_path}")

    print(f"总样本数: {stats['total_samples']}")
    print(f"成功评估样本数: {stats['success_samples']}")
    print(f"失败评估样本数: {stats['failed_samples']}")
    print(f"有效分数数量: {stats['valid_scores']}")

    if stats["valid_scores"] > 0:
        print("\n分数统计:")
        print(f"  平均值 (Mean): {stats['mean']:.4f}")
        print(f"  中位数 (Median): {stats['median']:.4f}")
        print(f"  最小值 (Min): {stats['min']:.4f}")
        print(f"  最大值 (Max): {stats['max']:.4f}")
        if stats["valid_scores"] > 1:
            print(f"  标准差 (Std Dev): {stats['std_dev']:.4f}")
            print(f"  方差 (Variance): {stats['variance']:.4f}")

        scores = stats.get("_scores") or []
        print("\n分数分布:")
        ranges = [
            (0.0, 0.2, "很低 (0.0-0.2)"),
            (0.2, 0.4, "低 (0.2-0.4)"),
            (0.4, 0.6, "中等 (0.4-0.6)"),
            (0.6, 0.8, "高 (0.6-0.8)"),
            (0.8, 1.0, "很高 (0.8-1.0)"),
        ]
        for min_val, max_val, label in ranges:
            count = sum(
                1
                for score in scores
                if min_val <= score < max_val or (max_val == 1.0 and score == 1.0)
            )
            pct = (count / len(scores)) * 100 if scores else 0
            print(f"  {label}: {count} ({pct:.1f}%)")

    print("=" * 60)

    if stats["valid_scores"] > 0:
        success_rate = (stats["success_samples"] / stats["total_samples"]) * 100 if stats["total_samples"] else 0
        print(f"\n简要报告: {stats['total_samples']} 个样本，{stats['success_samples']} 个成功评估")
        print(f"Answer Accuracy Score 平均值: {stats['mean']:.4f}")
        print(f"评估成功率: {success_rate:.1f}%")


def main() -> int:
    parser = argparse.ArgumentParser(description="Answer Accuracy Score 统计")
    parser.add_argument("--input", "-i", type=str, default=str(DEFAULT_INPUT), help="打分后的 JSONL")
    args = parser.parse_args()

    file_path = Path(args.input)
    if not file_path.is_file():
        print(f"错误: 文件 {file_path} 不存在")
        return 1

    stats = calculate_answer_accuracy_statistics(file_path)
    print_statistics(stats, file_path)
    return 0 if stats else 1


if __name__ == "__main__":
    raise SystemExit(main())
