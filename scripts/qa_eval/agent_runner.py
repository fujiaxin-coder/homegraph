"""Multi-turn QA agent: with homegraph tools vs without (grep/read only). DashScope Qwen."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None  # type: ignore[misc, assignment]

from memory_monitor import sample_memory

logger = logging.getLogger(__name__)

TIME_FMT = "%Y-%m-%d %H:%M:%S.%f"


def _arm_short(arm: str) -> str:
    return "WITH" if arm == "with" else "WITHOUT"


def print_agent_progress(
    arm: str,
    index: int,
    total: int,
    item_id: str,
    message: str,
    *,
    indent: int = 0,
) -> None:
    prefix = "  " * indent
    print(f"{prefix}[{_arm_short(arm)} {index}/{total}] {item_id} — {message}", flush=True)


def print_agent_turn(task_id: int, turn: int, max_turns: int, message: str = "请求 LLM…") -> None:
    print(f"      · 第 {turn}/{max_turns} 轮 {message}", flush=True)


def _log_line(log_file: Path | None, msg: str) -> None:
    if log_file is None:
        return
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now().strftime(TIME_FMT)} {msg}\n")


def _log_memory(log_file: Path | None, mem: dict[str, float | None]) -> None:
    if mem.get("peak_rss_mb") is not None:
        _log_line(log_file, f"peakRssMb = {mem['peak_rss_mb']}")
    if mem.get("avg_rss_mb") is not None:
        _log_line(log_file, f"avgRssMb = {mem['avg_rss_mb']}")


def find_homegraph_bin(explicit: str | None = None) -> str:
    if explicit:
        p = Path(explicit)
        if p.is_file() and os.access(p, os.X_OK):
            return str(p.resolve())
        raise FileNotFoundError(f"homegraph binary not found: {explicit}")

    # Prefer local dev build when testing unreleased changes
    repo_root = Path(__file__).resolve().parents[2]
    for local in (
        repo_root / "dist" / "bin" / "homegraph.js",
        repo_root / "dist" / "bin" / "homegraph.js",
    ):
        if local.is_file():
            return f"node {local.resolve()}"

    for name in ("homegraph", "homegraph"):
        found = shutil.which(name)
        if found:
            return found
    raise FileNotFoundError(
        "homegraph/homegraph not on PATH.\n"
        "  在 homegraph 仓库里: npm run build\n"
        "  或: python scripts/qa_eval/run_pipeline.py ab --homegraph-bin 'node /path/to/dist/bin/homegraph.js'"
    )


def _hg_cmd(hg_bin: str, args: list[str]) -> list[str]:
    if hg_bin.startswith("node "):
        return hg_bin.split(" ", 1) + args
    return [hg_bin, *args]


def require_index(repo: Path) -> None:
    for name in (".homegraph", ".homegraph"):
        d = repo / name
        if (d / "homegraph.db").exists() or (d / "homegraph.db").exists():
            return
    raise RuntimeError(f"仓库未索引: {repo}\n请先运行: homegraph sync {repo}")


def tool_block(name: str, body: str) -> str:
    return f"---\n{name}\n{body.strip()}\n---"


def homegraph_query(repo: Path, query: str, *, hg_bin: str, limit: int = 8) -> str:
    proc = subprocess.run(
        _hg_cmd(hg_bin, ["query", query, "-p", str(repo.resolve()), "-l", str(limit), "-j"]),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        return f"(homegraph query failed: {(proc.stderr or proc.stdout)[-400:]})"
    try:
        hits = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return proc.stdout[:4000]
    lines: list[str] = []
    for i, hit in enumerate(hits[:limit], 1):
        node = hit.get("node") or {}
        lines.append(
            f"{i}. [{node.get('kind')}] {node.get('qualifiedName', node.get('name'))}\n"
            f"   file: {node.get('filePath')}:{node.get('startLine')}-{node.get('endLine')}\n"
            f"   sig: {node.get('signature', '')}"
        )
    return "\n".join(lines) if lines else "(no hits)"


def read_file(repo: Path, rel_path: str, start: int = 1, end: int | None = None, context: int = 0) -> str:
    path = (repo / rel_path).resolve()
    if not path.is_file() or not str(path).startswith(str(repo.resolve())):
        return f"(file not found: {rel_path})"
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if end is None:
        end = min(len(lines), start + 80)
    lo = max(1, start - context) - 1
    hi = min(len(lines), end + context)
    body = "\n".join(f"{i + 1:4}| {lines[i]}" for i in range(lo, hi))
    return f"// {rel_path}:{start}-{end}\n{body}"


def find_rg_binary() -> str | None:
    found = shutil.which("rg")
    if found:
        return found
    candidates = [
        Path.home() / ".cursor-server/bin/*/node_modules/@vscode/ripgrep/bin/rg",
    ]
    import glob

    for pattern in candidates:
        for path in glob.glob(str(pattern)):
            if os.path.isfile(path) and os.access(path, os.X_OK):
                return path
    return None


def search_text(repo: Path, pattern: str, max_hits: int = 20) -> str:
    rg = find_rg_binary()
    if not rg:
        return "(rg not found on PATH; install: sudo apt install ripgrep)"
    proc = subprocess.run(
        [rg, "-n", "--no-heading", "-m", str(max_hits), pattern, str(repo)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    out = (proc.stdout or proc.stderr or "").strip()
    return out[:6000] if out else "(no matches)"


def find_files(repo: Path, pattern: str, max_hits: int = 30) -> str:
    """Find files by glob. Invalid patterns return a hint instead of crashing the agent."""
    pattern = pattern.strip().lstrip("/")
    if not pattern:
        return "(empty pattern)"

    hits: list[str] = []
    try:
        # pathlib rglob: ** must be a whole path segment (e.g. **/*.ets, not */**/x)
        if "**" in pattern and not pattern.startswith("**"):
            # Fallback: treat as substring search via rg --files | rg
            rg = shutil.which("rg")
            if rg:
                proc = subprocess.run(
                    [rg, "--files", str(repo)],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                needle = pattern.replace("**", "").replace("*", "")
                for line in (proc.stdout or "").splitlines():
                    if needle and needle.lower() in line.lower():
                        hits.append(line)
                        if len(hits) >= max_hits:
                            break
                return "\n".join(hits) if hits else "(no files; try SearchText instead)"
            return "(invalid glob: use pattern like **/*.ets or use SearchText)"

        for p in sorted(repo.rglob(pattern)):
            if p.is_file() and ".git" not in p.parts:
                hits.append(str(p.relative_to(repo)))
                if len(hits) >= max_hits:
                    break
    except ValueError as e:
        return f"(invalid glob pattern '{pattern}': {e}. Try **/*.ets or SearchText)"
    except OSError as e:
        return f"(find failed: {e})"

    return "\n".join(hits) if hits else "(no files)"


WITH_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "HomegraphQuery",
            "description": "Search symbols in the repo via homegraph index (preferred for finding functions/classes/files).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Symbol name or search terms"},
                    "limit": {"type": "integer", "description": "Max hits", "default": 8},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ReadFile",
            "description": "Read source file lines from the repo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "start_line": {"type": "integer", "default": 1},
                    "end_line": {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
]

WITHOUT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "SearchText",
            "description": "Ripgrep search in the repo (like grep).",
            "parameters": {
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ReadFile",
            "description": "Read source file lines from the repo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "start_line": {"type": "integer", "default": 1},
                    "end_line": {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "FindFiles",
            "description": "Glob find files under repo. Use patterns like *.ets or **/BenchmarkHub*.ets (not */**/x).",
            "parameters": {
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            },
        },
    },
]


def execute_tool(
    repo: Path,
    name: str,
    args: dict[str, Any],
    *,
    arm: str,
    hg_bin: str,
) -> str:
    if name == "HomegraphQuery":
        if arm != "with":
            return "(homegraph disabled in without arm)"
        return homegraph_query(repo, args["query"], hg_bin=hg_bin, limit=int(args.get("limit") or 8))
    if name == "ReadFile":
        return read_file(
            repo,
            args["path"],
            start=int(args.get("start_line") or 1),
            end=int(args["end_line"]) if args.get("end_line") else None,
        )
    if name == "SearchText":
        return search_text(repo, args["pattern"])
    if name == "FindFiles":
        return find_files(repo, args["pattern"])
    return f"(unknown tool: {name})"


def run_agent_on_query(
    repo: Path,
    query: str,
    *,
    arm: str,
    api_key: str,
    base_url: str,
    model: str,
    hg_bin: str,
    log_file: Path | None = None,
    task_id: int = 1,
    max_turns: int = 8,
    timeout_sec: int = 600,
    extra_body: dict | None = None,
) -> dict[str, Any]:
    if OpenAI is None:
        raise RuntimeError("pip install openai")

    client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout_sec)
    tools = WITH_TOOLS if arm == "with" else WITHOUT_TOOLS
    backend = "agent-with-homegraph" if arm == "with" else "agent-grep-read"

    if arm == "with":
        system = (
            "你是鸿蒙 ArkTS 代码分析 Agent。可用 HomegraphQuery 检索符号、ReadFile 读源码。"
            "先检索再读文件，基于仓库事实作答。回答简洁准确，中文。"
        )
    else:
        system = (
            "你是鸿蒙 ArkTS 代码分析 Agent。可用 SearchText(rg)、FindFiles、ReadFile 探索仓库。"
            "没有 homegraph，请主动搜索和读文件后再答。回答简洁准确，中文。"
        )

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        {"role": "user", "content": query},
    ]
    tool_trace: list[str] = []
    total_tokens = 0
    t0 = time.time()
    _log_line(log_file, f"Evaluate {task_id}:")

    with sample_memory() as mem_sampler:
        for turn in range(1, max_turns + 1):
            _log_line(log_file, f"the {turn} turn")
            print_agent_turn(task_id, turn, max_turns)
            create_kwargs: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "tools": tools,
                "temperature": 0.2,
            }
            if extra_body:
                create_kwargs["extra_body"] = extra_body
            resp = client.chat.completions.create(**create_kwargs)
            if turn == 1:
                _log_line(log_file, "first token")
            if resp.usage:
                total_tokens += int(resp.usage.total_tokens or 0)
                _log_line(log_file, f"totalTokenCount = {resp.usage.total_tokens}")

            msg = resp.choices[0].message
            if msg.tool_calls:
                names = ", ".join(tc.function.name for tc in msg.tool_calls)
                print_agent_turn(task_id, turn, max_turns, f"工具: {names}")
                messages.append(msg.model_dump())
                for tc in msg.tool_calls:
                    fn = tc.function
                    try:
                        fn_args = json.loads(fn.arguments or "{}")
                    except json.JSONDecodeError:
                        fn_args = {}
                    result = execute_tool(repo, fn.name, fn_args, arm=arm, hg_bin=hg_bin)
                    arg_str = json.dumps(fn_args, ensure_ascii=False)
                    tool_trace.append(tool_block(fn.name, f"args: {arg_str}\nresult:\n{result[:3000]}"))
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": result[:8000],
                        }
                    )
                continue

            answer = (msg.content or "").strip()
            duration_ms = int((time.time() - t0) * 1000)
            trace_text = "\n\n".join(tool_trace)
            output = f"{trace_text}\n\n{answer}" if trace_text else answer
            usage = resp.usage
            mem = mem_sampler.last_stats
            _log_memory(log_file, mem)
            meta: dict[str, Any] = {
                "output_answer": output,
                "agent_status": "success" if answer else "error",
                "agent_backend": backend,
                "agent_host": "builtin",
                "agent_model": model,
                "agent_turns": turn,
                "agent_duration_ms": duration_ms,
                "ab_arm": "with-homegraph" if arm == "with" else "without-homegraph",
                "agent_memory_mb": mem,
            }
            if usage:
                meta["agent_usage"] = {
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                    "total_tokens": usage.total_tokens,
                }
            if not answer:
                meta["agent_error"] = "empty final answer"
            return meta

    mem = mem_sampler.last_stats
    _log_memory(log_file, mem)
    return {
        "output_answer": "\n\n".join(tool_trace),
        "agent_status": "error",
        "agent_error": f"max turns ({max_turns}) exceeded",
        "agent_backend": backend,
        "agent_host": "builtin",
        "agent_model": model,
        "ab_arm": "with-homegraph" if arm == "with" else "without-homegraph",
        "agent_memory_mb": mem,
    }


def run_agent_dataset(
    repo: Path,
    dataset: list[dict[str, Any]],
    *,
    arm: str,
    output: Path,
    log_file: Path | None,
    api_key: str,
    base_url: str,
    model: str,
    hg_bin: str,
    max_turns: int = 8,
    extra_body: dict | None = None,
) -> list[dict[str, Any]]:
    if arm == "with":
        require_index(repo)
    hg = find_homegraph_bin(hg_bin) if arm == "with" else ""
    output.parent.mkdir(parents=True, exist_ok=True)
    if log_file:
        log_file.write_text("", encoding="utf-8")

    results: list[dict[str, Any]] = []
    auth_failed = False
    total = len(dataset)
    print(f"  → {_arm_short(arm)} 臂：共 {total} 题", flush=True)
    with output.open("w", encoding="utf-8") as f:
        for i, item in enumerate(dataset, 1):
            q = str(item["query"])
            item_id = str(item.get("id") or i)
            print_agent_progress(arm, i, total, item_id, "开始…")
            logger.info("[%s] %s/%s %s", arm, i, total, item_id)
            try:
                agent_meta = run_agent_on_query(
                    repo,
                    q,
                    arm=arm,
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    hg_bin=hg,
                    log_file=log_file,
                    task_id=i,
                    max_turns=max_turns,
                    extra_body=extra_body,
                )
            except Exception as e:
                err = str(e)
                logger.error("Agent failed %s: %s", item.get("id"), e)
                if "401" in err or "invalid_api_key" in err or "Incorrect API key" in err:
                    auth_failed = True
                agent_meta = {
                    "output_answer": "",
                    "agent_status": "error",
                    "agent_error": err,
                    "agent_backend": "agent-with-homegraph" if arm == "with" else "agent-grep-read",
                }
            row = {**item, **agent_meta}
            results.append(row)
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            if agent_meta.get("agent_status") == "success":
                turns = agent_meta.get("agent_turns", "?")
                dur_ms = agent_meta.get("agent_duration_ms")
                dur_s = f"{dur_ms / 1000:.1f}s" if isinstance(dur_ms, (int, float)) else "?"
                print_agent_progress(arm, i, total, item_id, f"完成 ({turns} 轮, {dur_s})")
            else:
                err = str(agent_meta.get("agent_error") or agent_meta.get("agent_status") or "error")
                print_agent_progress(arm, i, total, item_id, f"失败: {err[:100]}")
            if auth_failed:
                raise RuntimeError(
                    "LLM API 鉴权失败 (401)。智谱 Key 请用:\n"
                    "  export ZHIPU_API_KEY='your-id.your-secret'\n"
                    "  python scripts/qa_eval/run_pipeline.py ab --provider zhipu\n"
                    "DashScope Key 请用:\n"
                    "  export DASHSCOPE_API_KEY='sk-...'\n"
                    "  python scripts/qa_eval/run_pipeline.py ab --provider dashscope"
                ) from None
    ok = sum(1 for r in results if r.get("agent_status") == "success")
    print(f"  → {_arm_short(arm)} 臂结束：{ok}/{total} 成功", flush=True)
    return results
