#!/usr/bin/env python3
"""
Stage 2 — RAG Answer Accuracy Evaluation (LLM-as-Judge).

Reads agent-produced JSONL (query + output_answer + reference_answer),
strips tool-call blocks, scores 0–1 via MyAnswerAccuracy.

Usage:
  export DASHSCOPE_API_KEY="sk-..."
  python scripts/qa_eval/eval_metrics.py \\
    -i scripts/qa_eval/log/result-with-builtin.jsonl \\
    -o scripts/qa_eval/log/result-with-builtin-scored.jsonl \\
    -w 2
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import statistics
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from tqdm import tqdm

_SCRIPT_DIR = Path(__file__).resolve().parent
LOG_DIR = _SCRIPT_DIR / "log"
LOG_DIR.mkdir(parents=True, exist_ok=True)

if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from my_answer_accuracy import MyAnswerAccuracy  # noqa: E402
from llm_config import PROVIDER_DASHSCOPE, PROVIDER_ZHIPU, provider_help, resolve_llm_config  # noqa: E402

os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "eval_metrics.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

file_write_lock = threading.Lock()

DEFAULT_INPUT = LOG_DIR / "result-with-builtin.jsonl"
DEFAULT_OUTPUT = LOG_DIR / "result-with-builtin-scored.jsonl"
DEFAULT_MODEL = "qwen3-235b-a22b-instruct-2507"
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_API_KEY_ENV = "DASHSCOPE_API_KEY"


class RAGEvaluator:
    """Answer accuracy judge with concurrent processing."""

    def __init__(
        self,
        llm_model: str,
        *,
        api_key: str,
        base_url: str,
        extra_body: dict | None = None,
    ) -> None:
        self.scorer = MyAnswerAccuracy.create(
            api_key=api_key,
            base_url=base_url,
            model=llm_model,
            extra_body=extra_body,
        )

    async def evaluate_answer_accuracy_single(self, sample_data: dict) -> dict:
        return await self.scorer.evaluate_answer_accuracy_single(sample_data)


def process_single_item_sync(evaluator: RAGEvaluator, item: dict) -> dict:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(evaluator.evaluate_answer_accuracy_single(item))
    finally:
        loop.close()


def load_jsonl(path: Path) -> list[dict]:
    items: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError as e:
                logger.error("第 %s 行 JSON 解析失败: %s", line_no, e)
    return items


def resolve_api_key(env_name: str) -> str | None:
    key = os.environ.get(env_name, "").strip()
    if key:
        return key
    fallback = os.environ.get("OPENAI_API_KEY", "").strip()
    return fallback or None


def main() -> int:
    parser = argparse.ArgumentParser(description="RAG Answer Accuracy Evaluation (LLM-as-Judge)")
    parser.add_argument("--input", "-i", type=str, default=str(DEFAULT_INPUT), help="Agent 产出的 JSONL")
    parser.add_argument("--output", "-o", type=str, default=str(DEFAULT_OUTPUT), help="打分后的 JSONL")
    parser.add_argument("--workers", "-w", type=int, default=1, help="并发线程数")
    parser.add_argument(
        "--provider",
        choices=[PROVIDER_DASHSCOPE, PROVIDER_ZHIPU],
        default=None,
        help=provider_help(),
    )
    parser.add_argument("--model", "-m", type=str, default=None, help="Judge 模型（默认随 provider）")
    parser.add_argument("--base-url", type=str, default=None, help="OpenAI 兼容 API 端点（默认随 provider）")
    args = parser.parse_args()

    input_file = Path(args.input)
    output_file = Path(args.output)

    try:
        llm = resolve_llm_config(provider=args.provider, model=args.model, base_url=args.base_url)
    except RuntimeError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1

    print(f"输入文件: {input_file}")
    print(f"输出文件: {output_file}")
    print(f"并发线程数: {args.workers}")
    print(f"LLM provider: {llm.provider}")
    print(f"评估模型: {llm.model}")

    if not input_file.is_file():
        print(f"错误: 输入文件 {input_file} 不存在")
        return 1

    api_key = llm.api_key

    all_items = load_jsonl(input_file)
    total_items = len(all_items)
    print(f"读取到 {total_items} 个样本")

    if total_items == 0:
        print("没有找到有效的样本数据")
        return 1

    for i, item in enumerate(all_items, 1):
        if not str(item.get("query", "")).strip():
            print(f"错误: 第 {i} 条缺少 query")
            return 1
        if not str(item.get("reference_answer", "")).strip():
            print(f"错误: 第 {i} 条缺少 reference_answer")
            return 1
        if not str(item.get("output_answer", "")).strip():
            logger.warning("第 %s 条 (%s) output_answer 为空，Judge 可能得 0 分", i, item.get("id", "?"))

    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text("", encoding="utf-8")

    evaluator = RAGEvaluator(
        llm.model,
        api_key=api_key,
        base_url=llm.base_url,
        extra_body=llm.extra_body,
    )
    print("初始化 Judge 完成")

    processed_items: list[dict] = []
    results_lock = threading.Lock()

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {
            executor.submit(process_single_item_sync, evaluator, item): item
            for item in all_items
        }
        for future in tqdm(as_completed(futures), total=len(all_items), desc="评估答案准确性"):
            try:
                processed_item = future.result()
                with results_lock:
                    processed_items.append(processed_item)
                    if len(processed_items) % 5 == 0:
                        with file_write_lock:
                            with output_file.open("a", encoding="utf-8") as writer:
                                for row in processed_items[-5:]:
                                    writer.write(json.dumps(row, ensure_ascii=False) + "\n")
            except Exception as e:
                logger.error("样本处理任务异常: %s", e)

    remaining = len(processed_items) % 5
    if remaining:
        with file_write_lock:
            with output_file.open("a", encoding="utf-8") as writer:
                for row in processed_items[-remaining:]:
                    writer.write(json.dumps(row, ensure_ascii=False) + "\n")

    if processed_items:
        successful = [x for x in processed_items if x.get("evaluation_status") == "success"]
        scores = [float(x.get("answer_accuracy_score", 0.0)) for x in processed_items]
        print("\n评估完成!")
        print(f"总样本数: {total_items}")
        print(f"成功评估: {len(successful)}")
        print(f"失败评估: {total_items - len(successful)}")
        if successful:
            ok_scores = [float(x["answer_accuracy_score"]) for x in successful]
            print(f"平均答案准确性得分: {statistics.mean(ok_scores):.4f}")
            print(f"最高得分: {max(ok_scores):.4f}")
            print(f"最低得分: {min(ok_scores):.4f}")
        print(f"\n结果已写入: {output_file}")
    else:
        print("没有成功处理任何样本")
        return 1

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n用户中断了程序执行")
        raise SystemExit(130)
