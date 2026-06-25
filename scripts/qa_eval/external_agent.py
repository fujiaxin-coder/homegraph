"""Run qa_eval dataset through real Agent hosts: Claude Code CLI, DevEco Code (opencode CLI)."""

from __future__ import annotations

import json
import logging
import os
import re
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


def _strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", text or "")


def _extract_deveco_json_errors(text: str) -> str | None:
    """Parse deveco --format json error lines into a short message."""
    messages: list[str] = []
    for line in _strip_ansi(text).splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") != "error":
            continue
        err = ev.get("error") or {}
        data = err.get("data") or {}
        msg = data.get("message") or err.get("message") or err.get("name")
        if msg and msg not in messages:
            messages.append(str(msg))
    if not messages:
        return None
    return "; ".join(messages)


def _cli_error_summary(stderr: str, stdout: str, *, max_len: int = 400) -> str:
    """Pick a short user-facing error from CLI stderr/stdout."""
    for raw in (stderr, stdout):
        deveco_err = _extract_deveco_json_errors(raw)
        if deveco_err:
            return deveco_err[:max_len]
    for raw in (stderr, stdout):
        clean = _strip_ansi(raw).strip()
        if not clean:
            continue
        for line in clean.splitlines():
            line = line.strip()
            if not line or line.lower().startswith("error:"):
                continue
            if len(line) > 20:
                return line[:max_len]
        if clean:
            return clean[:max_len]
    return ""


def auth_failure_reason(text: str) -> str | None:
    """Return a user-facing reason if output looks like an auth/login failure."""
    t = _strip_ansi(text or "").lower()
    if any(h in t for h in ("not logged in", "please run /login")) or (
        "/login" in t and "run" in t
    ):
        return "Claude Code 未登录，请先运行: claude login"
    if "credentials cannot be decrypted" in t or "saved provider credentials are unavailable" in t:
        return (
            "DevEco Code 本地凭证无法解密。请运行: deveco providers reset，"
            "然后在 TUI 中重新配置模型，或执行 deveco providers login"
        )
    if "deveco providers reset" in t or "deveco auth reset" in t:
        return (
            "DevEco Code 未配置或凭证无效。请运行: deveco providers reset，"
            "然后重新登录/配置 provider"
        )
    if "model not found" in t:
        return (
            "DevEco 模型名无效。deveco 需要 provider/model 格式（如 zhipuai/glm-4.5-flash），"
            "可用 `deveco models` 查看；勿把 Judge 的 --model 直接传给 deveco"
        )
        return "API Key 无效"
    if "authentication required" in t or "unauthorized" in t:
        return "未授权，请检查登录或 API Key"
    return None


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


def _popen_capture(cmd: list[str], *, cwd: str) -> subprocess.Popen:
    """Run CLI with UTF-8 stdout/stderr (Windows default locale is often GBK)."""
    return subprocess.Popen(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
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
    auth_err = auth_failure_reason(answer) or auth_failure_reason(raw)
    if auth_err:
        return {
            "output_answer": output,
            "agent_status": "error",
            "agent_error": auth_err,
            "agent_turns": max_turn,
            "agent_duration_ms": duration_ms,
            "agent_usage": {"total_tokens": total_tokens} if total_tokens else {},
        }
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
    auth_err = auth_failure_reason(answer) or auth_failure_reason(raw)
    if auth_err:
        return {
            "output_answer": output,
            "agent_status": "error",
            "agent_error": auth_err,
            "agent_turns": max_turn,
            "agent_duration_ms": duration_ms,
            "agent_usage": {"total_tokens": total_tokens} if total_tokens else {},
        }
    return {
        "output_answer": output,
        "agent_status": "success" if answer else "error",
        "agent_turns": max_turn,
        "agent_duration_ms": duration_ms,
        "agent_usage": {"total_tokens": total_tokens} if total_tokens else {},
    }


def verify_claude_login() -> None:
    """Fail fast before burning the whole dataset on 'Not logged in'."""
    claude = find_claude_cli()
    proc = subprocess.run(
        [claude, "-p", "ping", "--output-format", "text", "--max-turns", "1"],
        capture_output=True,
        text=True,
        timeout=45,
        cwd=os.getcwd(),
    )
    combined = f"{proc.stdout}\n{proc.stderr}"
    reason = auth_failure_reason(combined)
    if reason:
        raise RuntimeError(f"{reason}\n（探测输出: {combined.strip()[:200]}）")


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

        proc = _popen_capture(cmd, cwd=str(repo))
        with sample_memory(proc.pid) as sampler:
            try:
                stdout, stderr = proc.communicate(timeout=timeout_sec)
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
                mem = sampler.last_stats
                _log_memory(log_file, mem)
                return {
                    "output_answer": "",
                    "agent_status": "error",
                    "agent_error": f"timeout after {timeout_sec}s",
                    "agent_backend": backend,
                    "agent_memory_mb": mem,
                }
        mem = sampler.last_stats

        if proc.returncode != 0 and not (stdout or "").strip():
            _log_memory(log_file, mem)
            return {
                "output_answer": (stderr or "")[:2000],
                "agent_status": "error",
                "agent_error": f"claude exit {proc.returncode}",
                "agent_backend": backend,
                "agent_memory_mb": mem,
            }

        _log_line(log_file, "first token")
        combined = f"{stdout}\n{stderr}"
        auth_err = auth_failure_reason(combined)
        if auth_err:
            _log_memory(log_file, mem)
            return {
                "output_answer": (stdout or stderr or "")[:2000],
                "agent_status": "error",
                "agent_error": auth_err,
                "agent_backend": backend,
                "agent_host": HOST_CLAUDE,
                "agent_memory_mb": mem,
            }
        parsed = parse_claude_stream_json(stdout or "")
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


def _deveco_project_config_dir(repo: Path) -> Path:
    """Project-level deveco config (read before ~/.config/deveco/deveco.jsonc)."""
    return repo / ".deveco"


def _write_deveco_project_mcp(repo: Path, *, arm: str, hg_bin: str) -> Path:
    """Write repo/.deveco/deveco.jsonc for MCP only; credentials stay in ~/.config/deveco."""
    config_dir = _deveco_project_config_dir(repo)
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "deveco.jsonc"
    if arm == "with":
        cmd, base_args = _split_hg_bin(hg_bin)
        body = {
            "$schema": "https://opencode.ai/config.json",
            "mcp": {
                "homegraph": {
                    "type": "local",
                    "command": [cmd, *base_args, "--path", str(repo.resolve())],
                    "enabled": True,
                }
            },
        }
    else:
        body = {"$schema": "https://opencode.ai/config.json", "mcp": {}}
    config_path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return config_path


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

    _write_deveco_project_mcp(repo, arm=arm, hg_bin=hg_bin)

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

    proc = _popen_capture(run_cmd, cwd=str(repo))
    with sample_memory(proc.pid) as sampler:
        try:
            stdout, stderr = proc.communicate(timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            mem = sampler.last_stats
            _log_memory(log_file, mem)
            return {
                "output_answer": "",
                "agent_status": "error",
                "agent_error": f"timeout after {timeout_sec}s",
                "agent_backend": backend,
                "agent_memory_mb": mem,
            }
    mem = sampler.last_stats
    combined = f"{stdout or ''}\n{stderr or ''}"

    if proc.returncode != 0:
        auth_err = auth_failure_reason(combined)
        detail = auth_err or _cli_error_summary(stderr, stdout)
        err_msg = detail or f"{cli} exit {proc.returncode}"
        _log_memory(log_file, mem)
        return {
            "output_answer": _strip_ansi(stderr or stdout or "")[:2000],
            "agent_status": "error",
            "agent_error": err_msg,
            "agent_backend": backend,
            "agent_host": HOST_DEVECO,
            "agent_memory_mb": mem,
        }

    _log_line(log_file, "first token")
    out = (stdout or "").strip()
    err = (stderr or "").strip()
    parsed = parse_opencode_json_events(out if out else err)
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

    from agent_runner import find_homegraph_bin, print_agent_progress, require_index, _arm_short

    if arm == "with":
        require_index(repo)
    hg = find_homegraph_bin(hg_bin) if arm == "with" else ""

    output.parent.mkdir(parents=True, exist_ok=True)
    if log_file:
        log_file.write_text("", encoding="utf-8")

    results: list[dict[str, Any]] = []
    total = len(dataset)
    print(f"  → [{host}] {_arm_short(arm)} 臂：共 {total} 题", flush=True)

    auth_abort: str | None = None
    with output.open("w", encoding="utf-8") as f:
        for i, item in enumerate(dataset, 1):
            if auth_abort:
                meta = {
                    "output_answer": "",
                    "agent_status": "error",
                    "agent_error": auth_abort,
                    "agent_backend": f"{host}-{arm}",
                    "agent_host": host,
                }
                print_agent_progress(arm, i, total, str(item.get("id") or i), f"跳过: {auth_abort[:80]}")
                row = {**item, **meta}
                results.append(row)
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                f.flush()
                continue
            q = str(item["query"])
            item_id = str(item.get("id") or i)
            print_agent_progress(arm, i, total, item_id, f"[{host}] 开始…")
            logger.info("[%s/%s] %s/%s %s", host, arm, i, total, item_id)
            try:
                common = dict(
                    arm=arm,
                    hg_bin=hg,
                    log_file=log_file,
                    task_id=i,
                )
                if host == HOST_CLAUDE:
                    meta = run_claude_query(repo, q, **common)
                else:
                    meta = run_deveco_query(repo, q, model=model, **common)
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
            if meta.get("agent_status") == "success":
                dur_ms = meta.get("agent_duration_ms")
                dur_s = f"{dur_ms / 1000:.1f}s" if isinstance(dur_ms, (int, float)) else "?"
                print_agent_progress(arm, i, total, item_id, f"[{host}] 完成 ({dur_s})")
            else:
                err = str(meta.get("agent_error") or meta.get("agent_status") or "error")
                print_agent_progress(arm, i, total, item_id, f"[{host}] 失败: {err[:100]}")
                if i == 1 and meta.get("agent_error") and (
                    "未登录" in str(meta["agent_error"])
                    or "DevEco Code" in str(meta["agent_error"])
                    or "DevEco 模型" in str(meta["agent_error"])
                    or "Model not found" in str(meta["agent_error"])
                ):
                    auth_abort = str(meta["agent_error"])
                    print(f"\n  ✗ {auth_abort} — 后续题目跳过", flush=True)
    ok = sum(1 for r in results if r.get("agent_status") == "success")
    print(f"  → [{host}] {_arm_short(arm)} 臂结束：{ok}/{total} 成功", flush=True)
    return results
