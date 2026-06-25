"""Run qa_eval dataset through real Agent hosts: Claude Code CLI, DevEco Code (opencode CLI)."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from memory_monitor import sample_memory

logger = logging.getLogger(__name__)

TIME_FMT = "%Y-%m-%d %H:%M:%S.%f"

HOST_CLAUDE = "claude-code"
HOST_DEVECO = "deveco-code"
SUPPORTED_HOSTS = (HOST_CLAUDE, HOST_DEVECO)


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


def find_claude_cli() -> str:
    found = shutil.which("claude")
    if not found:
        raise FileNotFoundError(
            "未找到 claude CLI。请安装 Claude Code 并确保 `claude` 在 PATH 中。"
        )
    return found


def find_deveco_cli() -> str:
    for name in ("deveco", "opencode"):
        found = shutil.which(name)
        if found:
            return found
    raise FileNotFoundError(
        "未找到 DevEco Code / opencode CLI。请安装 DevEco Code 或 opencode 并加入 PATH。"
    )


def write_mcp_config(path: Path, *, hg_command: str, hg_args: list[str]) -> None:
    path.write_text(
        json.dumps({"mcpServers": {"homegraph": {"command": hg_command, "args": hg_args}}}, indent=2)
        + "\n",
        encoding="utf-8",
    )


def _split_hg_bin(hg_bin: str) -> tuple[str, list[str]]:
    if hg_bin.startswith("node "):
        parts = hg_bin.split(" ", 1)
        return parts[0], parts[1].split() + ["serve", "--mcp"]
    return hg_bin, ["serve", "--mcp"]


def parse_claude_stream_json(raw: str) -> dict[str, Any]:
    tool_trace: list[str] = []
    answer_parts: list[str] = []
    total_tokens = 0
    max_turn = 0
    duration_ms = 0

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        if ev.get("type") == "assistant" and ev.get("message", {}).get("content"):
            max_turn += 1
            for block in ev["message"]["content"]:
                if block.get("type") == "text" and block.get("text"):
                    answer_parts.append(str(block["text"]))
                if block.get("type") == "tool_use":
                    name = block.get("name", "?")
                    inp = block.get("input") or {}
                    tool_trace.append(
                        f"---\n{name}\nargs: {json.dumps(inp, ensure_ascii=False)[:500]}\n---"
                    )

        if ev.get("type") == "result":
            usage = ev.get("usage") or {}
            total_tokens = int(
                (usage.get("input_tokens") or 0)
                + (usage.get("cache_read_input_tokens") or 0)
                + (usage.get("cache_creation_input_tokens") or 0)
                + (usage.get("output_tokens") or 0)
            )
            duration_ms = int(ev.get("duration_ms") or 0)
            if ev.get("num_turns"):
                max_turn = max(max_turn, int(ev["num_turns"]))
            if ev.get("result") and not answer_parts:
                answer_parts.append(str(ev["result"]))

    answer = "\n".join(answer_parts).strip()
    output = "\n\n".join(tool_trace + ([answer] if answer else []))
    return {
        "output_answer": output,
        "agent_status": "success" if answer else "error",
        "agent_turns": max_turn,
        "agent_duration_ms": duration_ms,
        "agent_usage": {"total_tokens": total_tokens} if total_tokens else {},
    }


def parse_opencode_json_events(raw: str) -> dict[str, Any]:
    tool_trace: list[str] = []
    answer_parts: list[str] = []
    total_tokens = 0
    max_turn = 0
    duration_ms = 0

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        ev_type = ev.get("type") or ev.get("event")
        if ev_type in ("message", "assistant", "text"):
            content = ev.get("content") or ev.get("text") or ev.get("message")
            if isinstance(content, str) and content.strip():
                answer_parts.append(content.strip())
                max_turn += 1
            elif isinstance(content, list):
                max_turn += 1
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "text" and block.get("text"):
                            answer_parts.append(str(block["text"]))
                        if block.get("type") == "tool_use":
                            tool_trace.append(
                                f"---\n{block.get('name', '?')}\n"
                                f"args: {json.dumps(block.get('input') or {}, ensure_ascii=False)[:500]}\n---"
                            )

        usage = ev.get("usage") or ev.get("tokens")
        if isinstance(usage, dict):
            total = usage.get("total") or usage.get("total_tokens")
            if total:
                total_tokens = max(total_tokens, int(total))

        if ev.get("duration_ms"):
            duration_ms = max(duration_ms, int(ev["duration_ms"]))

    answer = "\n".join(answer_parts).strip()
    output = "\n\n".join(tool_trace + ([answer] if answer else []))
    return {
        "output_answer": output,
        "agent_status": "success" if answer else "error",
        "agent_turns": max_turn,
        "agent_duration_ms": duration_ms,
        "agent_usage": {"total_tokens": total_tokens} if total_tokens else {},
    }


def run_claude_query(
    repo: Path,
    query: str,
    *,
    arm: str,
    hg_bin: str,
    log_file: Path | None,
    task_id: int,
    timeout_sec: int = 600,
) -> dict[str, Any]:
    claude = find_claude_cli()
    backend = f"claude-code-{'with' if arm == 'with' else 'without'}-homegraph"

    with tempfile.TemporaryDirectory(prefix="qa-eval-mcp-") as tmp:
        mcp_path = Path(tmp) / "mcp.json"
        if arm == "with":
            cmd, base_args = _split_hg_bin(hg_bin)
            write_mcp_config(
                mcp_path,
                hg_command=cmd,
                hg_args=[*base_args, "--path", str(repo.resolve())],
            )
            mcp_args = ["--strict-mcp-config", "--mcp-config", str(mcp_path)]
        else:
            mcp_path.write_text('{"mcpServers":{}}\n', encoding="utf-8")
            mcp_args = ["--strict-mcp-config", "--mcp-config", str(mcp_path)]

        cmd = [
            claude,
            "-p",
            query,
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "bypassPermissions",
            *mcp_args,
        ]

        _log_line(log_file, f"Evaluate {task_id}:")
        _log_line(log_file, "the 1 turn")
        t0 = time.time()

        proc = subprocess.Popen(
            cmd,
            cwd=str(repo),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        with sample_memory(proc.pid) as sampler:
            try:
                stdout, stderr = proc.communicate(timeout=timeout_sec)
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
                mem = sampler.last_stats  # type: ignore[attr-defined]
                _log_memory(log_file, mem)
                return {
                    "output_answer": "",
                    "agent_status": "error",
                    "agent_error": f"timeout after {timeout_sec}s",
                    "agent_backend": backend,
                    "agent_memory_mb": mem,
                }
        mem = sampler.last_stats  # type: ignore[attr-defined]

        if proc.returncode != 0 and not stdout.strip():
            _log_memory(log_file, mem)
            return {
                "output_answer": (stderr or "")[:2000],
                "agent_status": "error",
                "agent_error": f"claude exit {proc.returncode}",
                "agent_backend": backend,
                "agent_memory_mb": mem,
            }

        _log_line(log_file, "first token")
        parsed = parse_claude_stream_json(stdout)
        tokens = (parsed.get("agent_usage") or {}).get("total_tokens") or 0
        if tokens:
            _log_line(log_file, f"totalTokenCount = {tokens}")
        _log_memory(log_file, mem)

        duration_ms = parsed.get("agent_duration_ms") or int((time.time() - t0) * 1000)
        return {
            **parsed,
            "agent_duration_ms": duration_ms,
            "agent_backend": backend,
            "agent_host": HOST_CLAUDE,
            "ab_arm": "with-homegraph" if arm == "with" else "without-homegraph",
            "agent_memory_mb": mem,
        }


def run_deveco_query(
    repo: Path,
    query: str,
    *,
    arm: str,
    hg_bin: str,
    log_file: Path | None,
    task_id: int,
    model: str | None = None,
    timeout_sec: int = 600,
) -> dict[str, Any]:
    cli = find_deveco_cli()
    backend = f"deveco-code-{'with' if arm == 'with' else 'without'}-homegraph"

    config_dir = repo / ".qa_eval_deveco"
    config_dir.mkdir(exist_ok=True)
    config_path = config_dir / "opencode.jsonc"
    if arm == "with":
        cmd, base_args = _split_hg_bin(hg_bin)
        config_path.write_text(
            json.dumps(
                {
                    "$schema": "https://opencode.ai/config.json",
                    "mcp": {
                        "homegraph": {
                            "type": "local",
                            "command": [cmd, *base_args, "--path", str(repo.resolve())],
                            "enabled": True,
                        }
                    },
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    else:
        config_path.write_text(
            '{"$schema":"https://opencode.ai/config.json","mcp":{}}\n',
            encoding="utf-8",
        )

    run_cmd = [
        cli,
        "run",
        query,
        "--format",
        "json",
        "--dir",
        str(repo),
        "--dangerously-skip-permissions",
    ]
    if model:
        run_cmd.extend(["--model", model])

    _log_line(log_file, f"Evaluate {task_id}:")
    _log_line(log_file, "the 1 turn")
    t0 = time.time()

    proc = subprocess.Popen(
        run_cmd,
        cwd=str(repo),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "XDG_CONFIG_HOME": str(config_dir)},
    )
    with sample_memory(proc.pid) as sampler:
        try:
            stdout, stderr = proc.communicate(timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            mem = sampler.last_stats  # type: ignore[attr-defined]
            _log_memory(log_file, mem)
            return {
                "output_answer": "",
                "agent_status": "error",
                "agent_error": f"timeout after {timeout_sec}s",
                "agent_backend": backend,
                "agent_memory_mb": mem,
            }
    mem = sampler.last_stats  # type: ignore[attr-defined]

    if proc.returncode != 0 and not stdout.strip():
        _log_memory(log_file, mem)
        return {
            "output_answer": (stderr or stdout or "")[:2000],
            "agent_status": "error",
            "agent_error": f"{cli} exit {proc.returncode}",
            "agent_backend": backend,
            "agent_memory_mb": mem,
        }

    _log_line(log_file, "first token")
    parsed = parse_opencode_json_events(stdout if stdout.strip() else stderr)
    tokens = (parsed.get("agent_usage") or {}).get("total_tokens") or 0
    if tokens:
        _log_line(log_file, f"totalTokenCount = {tokens}")
    _log_memory(log_file, mem)

    duration_ms = parsed.get("agent_duration_ms") or int((time.time() - t0) * 1000)
    return {
        **parsed,
        "agent_duration_ms": duration_ms,
        "agent_backend": backend,
        "agent_host": HOST_DEVECO,
        "ab_arm": "with-homegraph" if arm == "with" else "without-homegraph",
        "agent_memory_mb": mem,
    }


def run_external_dataset(
    host: str,
    repo: Path,
    dataset: list[dict[str, Any]],
    *,
    arm: str,
    output: Path,
    log_file: Path | None,
    hg_bin: str,
    model: str | None = None,
) -> list[dict[str, Any]]:
    if host not in SUPPORTED_HOSTS:
        raise ValueError(f"unknown agent host: {host}")

    from agent_runner import find_homegraph_bin, require_index

    if arm == "with":
        require_index(repo)
    hg = find_homegraph_bin(hg_bin) if arm == "with" else ""

    output.parent.mkdir(parents=True, exist_ok=True)
    if log_file:
        log_file.write_text("", encoding="utf-8")

    runner = run_claude_query if host == HOST_CLAUDE else run_deveco_query
    results: list[dict[str, Any]] = []

    with output.open("w", encoding="utf-8") as f:
        for i, item in enumerate(dataset, 1):
            q = str(item["query"])
            logger.info("[%s/%s] %s/%s %s", host, arm, i, len(dataset), item.get("id"))
            try:
                meta = runner(
                    repo,
                    q,
                    arm=arm,
                    hg_bin=hg,
                    log_file=log_file,
                    task_id=i,
                    model=model,
                )
            except Exception as e:
                logger.error("External agent failed %s: %s", item.get("id"), e)
                meta = {
                    "output_answer": "",
                    "agent_status": "error",
                    "agent_error": str(e),
                    "agent_backend": f"{host}-{arm}",
                    "agent_host": host,
                }
            row = {**item, **meta}
            results.append(row)
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
    return results
