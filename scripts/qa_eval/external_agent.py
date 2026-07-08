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

_QA_EVAL_DIR = Path(__file__).resolve().parent

TIME_FMT = "%Y-%m-%d %H:%M:%S.%f"

HOST_CLAUDE = "claude-code"
HOST_DEVECO = "deveco-code"
SUPPORTED_HOSTS = (HOST_CLAUDE, HOST_DEVECO)

# DevEco / opencode MCP tool names (server "homegraph" may prefix once or twice).
_HOMEGRAPH_TOOL_RE = re.compile(r"homegraph(?:_homegraph)?_(?:explore|node|search|callers|callees)", re.I)


def trace_tool_names(output_answer: str) -> list[str]:
    return re.findall(r"---\n([^\n]+)\n", str(output_answer or ""))


def is_homegraph_tool(name: str) -> bool:
    n = str(name or "").strip()
    if not n:
        return False
    if _HOMEGRAPH_TOOL_RE.search(n):
        return True
    return n.lower() in ("homegraph_explore", "homegraph_node")


def output_used_homegraph(output_answer: str) -> bool:
    return any(is_homegraph_tool(n) for n in trace_tool_names(output_answer))


def _tools_from_session_export(raw: str) -> list[str]:
    tools: list[str] = []
    try:
        data = json.loads(raw.strip())
    except json.JSONDecodeError:
        return tools
    if not isinstance(data, dict):
        return tools
    for msg in data.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        for part in msg.get("parts") or []:
            if not isinstance(part, dict) or part.get("type") != "tool":
                continue
            t = part.get("tool")
            if t:
                tools.append(str(t))
    return tools


_DEVECO_HOMEGRAPH_TOOL_GUIDE = """\
本环境已接入 HomeGraph MCP，与 grep、read、glob 并列可选；按题目需要自行选择工具。
若本题使用 HomeGraph，请遵守：
- homegraph_explore：结构/定位/「与 X 相关的实现有哪些」的首选；query 写类名、函数名或文件名（如 PreferenceStore、statfs），避免空泛关键词。
- explore 返回的源码视为已 Read；不要对同一符号反复调用 node/search。
- homegraph_node / homegraph_search：仅 explore 之后仍缺一条调用链、或完全不知符号名时各用一次。
- 不要用 homegraph_files 拉全仓或通配目录树；列举文件用 explore（带具体名称）或 grep/glob。
- 架构、流程、对比类题目：explore 定位关键文件后，用 read 补充仍缺的细节，再归纳作答。"""

_DEVECO_WITH_AGENT_PROMPT = (
    "你是鸿蒙 ArkTS 代码仓库问答 Agent。\n"
    f"{_DEVECO_HOMEGRAPH_TOOL_GUIDE}\n"
    "基于仓库事实作答，中文简洁准确。"
)

_DEVECO_WITHOUT_AGENT_PROMPT = (
    "你是鸿蒙 ArkTS 代码仓库问答 Agent。"
    "用 grep、read、glob 等内置工具探索仓库后作答，中文简洁准确。"
)


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


def _is_wsl() -> bool:
    if os.environ.get("WSL_DISTRO_NAME"):
        return True
    try:
        with open("/proc/version", encoding="utf-8") as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


def _deveco_cli_works(exe: str) -> bool:
    try:
        r = subprocess.run(
            [exe, "--version"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    combined = f"{r.stdout or ''}{r.stderr or ''}".lower()
    if r.returncode != 0 or "package manager failed" in combined:
        return False
    return True


def find_deveco_cli() -> str:
    explicit = os.environ.get("DEVECO_BIN") or os.environ.get("QA_EVAL_DEVECO_BIN")
    if explicit:
        if _deveco_cli_works(explicit):
            return explicit
        raise FileNotFoundError(f"DEVECO_BIN 不可用（deveco --version 失败）: {explicit}")

    candidates: list[str] = []
    npm_global = Path.home() / ".npm-global" / "bin" / "deveco"
    if npm_global.is_file():
        candidates.append(str(npm_global))
    for name in ("deveco", "opencode"):
        found = shutil.which(name)
        if not found:
            continue
        # WSL PATH 常把 Windows npm 的 deveco 排在前面，在 Linux 下必失败
        if name == "deveco" and _is_wsl() and found.startswith("/mnt/"):
            continue
        candidates.append(found)

    for exe in candidates:
        if _deveco_cli_works(exe):
            return exe

    if _is_wsl():
        raise FileNotFoundError(
            "DevEco Code 没有 Linux 原生版。WSL 里 which deveco 指向 /mnt/c/.../npm/deveco，"
            "在 Linux 下会报 package manager failed。\n"
            "请在 Windows PowerShell 里跑 qa_eval pipeline，例如：\n"
            "  cd D:\\code\\homegraph\\scripts\\qa_eval\n"
            "  python run_pipeline.py ab -r D:\\code\\scene_board_ext -d D:\\code\\dataSet10.xlsx "
            "--agent-host deveco-code --provider zhipu --skip-index\n"
            "或在 WSL 里安装可用的 opencode 并设置 DEVECO_BIN=opencode 的路径。"
        )
    raise FileNotFoundError(
        "未找到可用的 DevEco Code / opencode CLI。请安装并加入 PATH，或设置 DEVECO_BIN。"
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
        node, script = hg_bin.split(" ", 1)
        return node, [script.strip(), "serve", "--mcp"]
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
    session_id = ""
    stream_errors: list[str] = []

    def note_session(ev: dict[str, Any], part: dict[str, Any]) -> None:
        nonlocal session_id
        sid = ev.get("sessionID") or ev.get("sessionId") or part.get("sessionID") or part.get("sessionId")
        if sid:
            session_id = str(sid)

    def append_tool(name: str, inp: Any, outp: Any = "") -> None:
        payload = json.dumps(inp, ensure_ascii=False)[:500] if inp else ""
        block = f"---\n{name}\nargs: {payload}\n---"
        if outp:
            out_s = str(outp)
            block = f"---\n{name}\nargs: {payload}\noutput: {out_s[:800]}\n---"
        tool_trace.append(block)

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        ev_type = ev.get("type") or ev.get("event")
        part = ev.get("part") if isinstance(ev.get("part"), dict) else {}
        part_type = part.get("type") or ""
        note_session(ev, part)

        if ev_type == "error":
            err = ev.get("error") or {}
            data = err.get("data") or {}
            msg = data.get("message") or err.get("message") or err.get("name")
            if msg:
                stream_errors.append(str(msg))

        if ev_type == "text" and part.get("text"):
            text = str(part["text"]).strip()
            if text:
                answer_parts.append(text)
                max_turn += 1
        elif ev_type == "text" and ev.get("text"):
            text = str(ev["text"]).strip()
            if text:
                answer_parts.append(text)
                max_turn += 1

        if ev_type == "tool_use":
            max_turn += 1
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            name = part.get("tool") or part.get("name") or "?"
            append_tool(str(name), state.get("input") or part.get("input"), state.get("output"))
        elif ev_type in ("tool", "tool_call") or part_type in (
            "tool",
            "tool-invocation",
            "tool_use",
            "tool-call",
        ):
            max_turn += 1
            name = part.get("tool") or part.get("name") or ev.get("tool") or "?"
            inp = part.get("input") or part.get("args") or part.get("state") or ev.get("input") or {}
            if isinstance(inp, dict) and "input" in inp:
                outp = inp.get("output")
                inp = inp.get("input") or inp
            else:
                outp = ""
            append_tool(str(name), inp, outp)

        if ev_type in ("message", "assistant"):
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
                            append_tool(
                                str(block.get("name", "?")),
                                block.get("input") or {},
                            )

        usage = ev.get("usage") or ev.get("tokens")
        if isinstance(usage, dict):
            total = usage.get("total") or usage.get("total_tokens")
            if total:
                total_tokens = max(total_tokens, int(total))

        if ev_type == "step_finish":
            tokens = part.get("tokens") if isinstance(part.get("tokens"), dict) else {}
            step_total = tokens.get("total") or tokens.get("total_tokens")
            if step_total:
                total_tokens = max(total_tokens, int(step_total))

        if ev.get("duration_ms"):
            duration_ms = max(duration_ms, int(ev["duration_ms"]))

        part_time = part.get("time") if isinstance(part.get("time"), dict) else {}
        if part_time.get("start") and part_time.get("end"):
            duration_ms = max(duration_ms, int(part_time["end"]) - int(part_time["start"]))

    answer = "\n".join(answer_parts).strip()
    output = "\n\n".join(tool_trace + ([answer] if answer else []))
    base = {
        "output_answer": output,
        "agent_turns": max_turn,
        "agent_duration_ms": duration_ms,
        "agent_usage": {"total_tokens": total_tokens} if total_tokens else {},
        "deveco_session_id": session_id or None,
    }
    auth_err = auth_failure_reason(answer) or auth_failure_reason(raw)
    if auth_err:
        return {
            **base,
            "agent_status": "error",
            "agent_error": auth_err,
        }
    if stream_errors and not answer:
        return {
            **base,
            "agent_status": "error",
            "agent_error": "; ".join(stream_errors),
        }
    return {
        **base,
        "agent_status": "success" if answer else "error",
        "agent_error": None if answer else "deveco 未返回可解析的文本回答",
    }


def _meaningful_text(text: str) -> bool:
    return bool(str(text or "").strip())


def _extract_text_from_export(raw: str) -> list[str]:
    """Pull assistant answer text from `deveco export` (session JSON, JSONL, or array)."""
    texts: list[str] = []

    def collect_stream_event(ev: dict[str, Any]) -> None:
        if ev.get("type") == "text":
            t = ev.get("text")
            if not t and isinstance(ev.get("part"), dict):
                t = ev["part"].get("text")
            if _meaningful_text(str(t or "")):
                texts.append(str(t).strip())
            return
        part = ev.get("part") if isinstance(ev.get("part"), dict) else {}
        if part.get("type") == "text" and _meaningful_text(str(part.get("text") or "")):
            texts.append(str(part["text"]).strip())

    def collect_session_export(data: dict[str, Any]) -> None:
        for msg in data.get("messages") or []:
            if not isinstance(msg, dict):
                continue
            info = msg.get("info") if isinstance(msg.get("info"), dict) else {}
            if info.get("role") != "assistant":
                continue
            for part in msg.get("parts") or []:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text" and _meaningful_text(str(part.get("text") or "")):
                    texts.append(str(part["text"]).strip())

    stripped = raw.strip()
    if not stripped:
        return texts

    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        for line in stripped.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                collect_stream_event(json.loads(line))
            except json.JSONDecodeError:
                continue
        return texts

    if isinstance(data, dict) and isinstance(data.get("messages"), list):
        collect_session_export(data)
        return texts
    if isinstance(data, list):
        for ev in data:
            if isinstance(ev, dict):
                collect_stream_event(ev)
    return texts


def _final_answer_from_export(raw: str) -> str:
    """Best-effort final assistant text from exported session."""
    texts = _extract_text_from_export(raw)
    return texts[-1] if texts else ""


def export_deveco_session(
    session_id: str,
    dest: Path,
    *,
    cwd: str,
    cli: str | None = None,
    timeout_sec: int = 60,
) -> bool:
    """Save `deveco export <session_id>` to dest. Returns True if file written."""
    if not session_id:
        return False
    exe = cli or find_deveco_cli()
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [exe, "export", session_id],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_sec,
    )
    body = (proc.stdout or "").strip()
    if proc.returncode != 0 or not body:
        logger.warning(
            "deveco export %s failed (rc=%s): %s",
            session_id,
            proc.returncode,
            (proc.stderr or "")[:200],
        )
        return False
    dest.write_text(body + "\n", encoding="utf-8")
    return True


def supplement_from_session_export(parsed: dict[str, Any], export_path: Path) -> dict[str, Any]:
    """If stdout missed final text, recover from exported session file."""
    if not export_path.is_file():
        return parsed
    raw = export_path.read_text(encoding="utf-8")
    answer = _final_answer_from_export(raw)
    if not answer:
        return parsed
    existing = str(parsed.get("output_answer") or "")
    if answer not in existing:
        parsed = {**parsed, "output_answer": (existing + "\n\n" + answer).strip() if existing else answer}
    if parsed.get("agent_status") != "success":
        parsed = {
            **parsed,
            "agent_status": "success",
            "agent_error": None,
            "agent_answer_source": "session_export",
        }
    return parsed


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

        wall_ms = int((time.time() - t0) * 1000)
        _log_line(log_file, f"completed ({wall_ms}ms)")
        return {
            **parsed,
            "agent_duration_ms": wall_ms,
            "agent_backend": backend,
            "agent_host": HOST_CLAUDE,
            "ab_arm": "with-homegraph" if arm == "with" else "without-homegraph",
            "agent_memory_mb": mem,
        }


def _deveco_project_config_dir(repo: Path) -> Path:
    """Project-level deveco config (read before ~/.config/deveco/deveco.jsonc)."""
    return repo / ".deveco"


def _write_deveco_project_mcp(repo: Path, *, arm: str, hg_bin: str) -> Path:
    """Write repo/.deveco/deveco.jsonc — MCP, permissions, and agent prompt for qa_eval A/B."""
    config_dir = _deveco_project_config_dir(repo)
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "deveco.jsonc"
    body: dict[str, Any] = {"$schema": "https://opencode.ai/config.json"}
    if arm == "with":
        if not hg_bin:
            from agent_runner import find_homegraph_bin

            hg_bin = find_homegraph_bin(None)
        cmd, base_args = _split_hg_bin(hg_bin)
        body["mcp"] = {
            "homegraph": {
                "type": "local",
                "command": [cmd, *base_args, "--path", str(repo.resolve())],
                "enabled": True,
                "environment": {
                    "HOMEGRAPH_NO_WATCHDOG": "1",
                    "HOMEGRAPH_WASM_RELAUNCHED": "1",
                },
            }
        }
        body["permission"] = {
            # files 在大仓上易返回整棵目录树，Token 高且对答题帮助小（qa_eval 实测主要劣化源）
            "homegraph_homegraph_files": "deny",
        }
        body["agent"] = {
            "build": {
                "prompt": _DEVECO_WITH_AGENT_PROMPT,
                "permission": {
                    "homegraph_homegraph_files": "deny",
                },
            }
        }
    else:
        body["mcp"] = {}
        body["permission"] = {
            "homegraph_*": "deny",
            "homegraph_homegraph_*": "deny",
        }
        body["agent"] = {
            "build": {
                "prompt": _DEVECO_WITHOUT_AGENT_PROMPT,
                "permission": {
                    "homegraph_*": "deny",
                    "homegraph_homegraph_*": "deny",
                },
            }
        }
    config_path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return config_path


DEFAULT_DEVECO_MODEL = "zhipuai/glm-4.5-flash"


def run_deveco_query(
    repo: Path,
    query: str,
    *,
    arm: str,
    hg_bin: str,
    log_file: Path | None,
    task_id: int,
    item_id: str | None = None,
    trace_dir: Path | None = None,
    model: str | None = None,
    timeout_sec: int = 600,
    deveco_attach: str | None = None,
) -> dict[str, Any]:
    cli = find_deveco_cli()
    backend = f"deveco-code-{'with' if arm == 'with' else 'without'}-homegraph"
    qid = item_id or str(task_id)
    title = f"qa-eval-{arm}-{qid}"
    prompt = query

    run_cmd = [
        cli,
        "run",
        prompt,
        "--format",
        "json",
        "--dir",
        str(repo),
        "--title",
        title,
        "--skip-agreement",
        "--dangerously-skip-permissions",
    ]
    if deveco_attach:
        run_cmd.extend(["--attach", deveco_attach])
    if model:
        run_cmd.extend(["--model", model])
    else:
        run_cmd.extend(["--model", DEFAULT_DEVECO_MODEL])

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
            wall_ms = int((time.time() - t0) * 1000)
            return {
                "output_answer": "",
                "agent_status": "error",
                "agent_error": f"timeout after {timeout_sec}s",
                "agent_backend": backend,
                "agent_duration_ms": wall_ms,
                "agent_memory_mb": mem,
            }
    mem = sampler.last_stats
    combined = f"{stdout or ''}\n{stderr or ''}"
    wall_ms = int((time.time() - t0) * 1000)

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
            "agent_duration_ms": wall_ms,
            "agent_memory_mb": mem,
        }

    out = (stdout or "").strip()
    err = (stderr or "").strip()
    parsed = parse_opencode_json_events(out if out else err)
    session_id = parsed.get("deveco_session_id")
    trace_file: Path | None = None
    tools_used: list[str] = trace_tool_names(str(parsed.get("output_answer") or ""))
    if session_id and trace_dir is not None:
        safe_sid = re.sub(r"[^\w.-]", "_", str(session_id))
        trace_file = trace_dir / f"{qid}-{safe_sid}.json"
        if export_deveco_session(str(session_id), trace_file, cwd=str(repo), cli=cli):
            try:
                rel = trace_file.relative_to(_QA_EVAL_DIR)
            except ValueError:
                rel = trace_file
            parsed["agent_trace_file"] = str(rel).replace("\\", "/")
            parsed = supplement_from_session_export(parsed, trace_file)
            export_tools = _tools_from_session_export(trace_file.read_text(encoding="utf-8"))
            for t in export_tools:
                if t not in tools_used:
                    tools_used.append(t)
            _log_line(log_file, f"session export → {parsed.get('agent_trace_file')}")
        else:
            parsed["agent_trace_file"] = None
    if session_id:
        _log_line(log_file, f"sessionID = {session_id}")
    if tools_used:
        _log_line(log_file, f"tools = {', '.join(tools_used)}")
    used_hg = any(is_homegraph_tool(t) for t in tools_used)
    parsed["agent_tools_used"] = tools_used
    parsed["agent_used_homegraph"] = used_hg

    tokens = (parsed.get("agent_usage") or {}).get("total_tokens") or 0
    if tokens:
        _log_line(log_file, f"totalTokenCount = {tokens}")
    _log_memory(log_file, mem)
    _log_line(log_file, f"completed ({wall_ms}ms)")

    result = {
        **parsed,
        "agent_duration_ms": wall_ms,
        "agent_backend": backend,
        "agent_host": HOST_DEVECO,
        "ab_arm": "with-homegraph" if arm == "with" else "without-homegraph",
        "agent_memory_mb": mem,
    }
    if result.get("agent_status") != "success" and not result.get("agent_error"):
        result["agent_error"] = _extract_deveco_json_errors(combined) or "deveco 未返回可解析的文本回答"
    return result


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
    deveco_attach: str | None = None,
) -> list[dict[str, Any]]:
    if host not in SUPPORTED_HOSTS:
        raise ValueError(f"unknown agent host: {host}")

    from agent_runner import find_homegraph_bin, print_agent_progress, _arm_short

    hg = find_homegraph_bin(hg_bin) if arm == "with" else ""

    output.parent.mkdir(parents=True, exist_ok=True)
    if log_file:
        log_file.write_text("", encoding="utf-8")

    results: list[dict[str, Any]] = []
    total = len(dataset)
    print(f"  → [{host}] {_arm_short(arm)} 臂：共 {total} 题", flush=True)
    if host == HOST_DEVECO:
        _write_deveco_project_mcp(repo, arm=arm, hg_bin=hg)
        trace_root = output.parent / "traces" / f"{arm}-deveco"
        if deveco_attach:
            print(f"  → deveco attach: {deveco_attach}", flush=True)
            print(
                "  → 提示: 若 serve 启动报 ServeError，多为端口占用；"
                "可 netstat -ano | findstr :4096 后 taskkill，或不加 --deveco-attach 直接跑",
                flush=True,
            )
        print(f"  → 轨迹目录: {trace_root}", flush=True)
        if arm == "with":
            print("  → WITH 臂: 优先 homegraph_explore，不足时可 grep/read", flush=True)
    else:
        trace_root = None

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
                    meta = run_deveco_query(
                        repo,
                        q,
                        model=model,
                        deveco_attach=deveco_attach,
                        item_id=item_id,
                        trace_dir=trace_root,
                        **common,
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
            if meta.get("agent_status") == "success":
                dur_ms = meta.get("agent_duration_ms")
                dur_s = f"{dur_ms / 1000:.1f}s" if isinstance(dur_ms, (int, float)) else "?"
                extra = ""
                if host == HOST_DEVECO and arm == "with":
                    extra = " ✓homegraph" if meta.get("agent_used_homegraph") else " ⚠未用homegraph"
                print_agent_progress(arm, i, total, item_id, f"[{host}] 完成 ({dur_s}){extra}")
            else:
                err = str(meta.get("agent_error") or meta.get("agent_status") or "error")
                extra = ""
                if host == HOST_DEVECO and arm == "with" and meta.get("agent_tools_used"):
                    extra = f" tools={','.join(meta['agent_tools_used'][:4])}"
                print_agent_progress(arm, i, total, item_id, f"[{host}] 失败: {err[:100]}{extra}")
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
