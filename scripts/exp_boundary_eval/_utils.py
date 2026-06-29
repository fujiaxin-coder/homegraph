#!/usr/bin/env python3
"""Shared utilities for experiment scripts — multi-agent support."""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
EVAL_ROOT = SCRIPT_DIR
DATA_DIR = EVAL_ROOT / "data"
LOG_DIR = EVAL_ROOT / "log"
OUTPUT_DIR = EVAL_ROOT / "output"
CONFIG_FILE = DATA_DIR / "experiments.json"
AGENTS_FILE = DATA_DIR / "agents.json"
# Legacy aliases used by analyze.py
RESULTS_DIR = OUTPUT_DIR
STATE_DIR = LOG_DIR

_HOMEGRAPH_TOOL_RE = re.compile(
    r"homegraph(?:_homegraph)?_(?:explore|node|search|callers|callees)", re.I,
)

# Windows: stop PowerShell/node subprocesses from flashing console windows.
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def subprocess_no_window_kwargs() -> dict:
    """Extra kwargs for subprocess.run/Popen on Windows (no-op elsewhere)."""
    if sys.platform == "win32":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0
        return {"creationflags": _CREATE_NO_WINDOW, "startupinfo": si}
    return {}


def merge_subprocess_kwargs(kwargs: dict) -> dict:
    """Merge caller kwargs with subprocess_no_window_kwargs (OR creationflags)."""
    merged = dict(kwargs)
    extra = subprocess_no_window_kwargs()
    if "creationflags" in extra:
        merged["creationflags"] = merged.get("creationflags", 0) | extra["creationflags"]
    if sys.platform == "win32" and "startupinfo" not in merged:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0
        merged["startupinfo"] = si
    return merged


def is_homegraph_tool(name: str) -> bool:
    n = str(name or "").strip()
    if not n:
        return False
    if _HOMEGRAPH_TOOL_RE.search(n):
        return True
    return n.lower() in ("homegraph_explore", "homegraph_node")


def count_homegraph_tools(tool_names: list) -> int:
    return sum(1 for t in tool_names if is_homegraph_tool(t))


def create_output_dirs(agent_name: str = "", arm: str = "baseline") -> Tuple[Path, Path]:
    """Create timestamped run directories.

    Input/output (prompt, stream, results) → output/{arm}/{agent}/{ts}/
    Logs/state/clone/session backups       → log/{arm}/{agent}/{ts}/
    """
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    agent = agent_name or "default"
    run_key = Path(arm) / agent / ts
    results_dir = OUTPUT_DIR / run_key
    state_dir = LOG_DIR / run_key
    results_dir.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)
    return results_dir, state_dir


def append_run_log(state_dir: Path, message: str):
    """Append a line to the per-run log (everything except raw agent I/O)."""
    log_path = state_dir / "run.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"[{ts}] {message}\n")

RED = "\033[0;31m"
GREEN = "\033[0;32m"
CYAN = "\033[0;36m"
YELLOW = "\033[1;33m"
NC = "\033[0m"


def log(msg: str):   print(f"{GREEN}[SETUP]{NC} {msg}")
def info(msg: str):  print(f"{GREEN}[RUN]{NC} {msg}")
def warn(msg: str):  print(f"{YELLOW}[WARN]{NC} {msg}")
def error(msg: str): print(f"{RED}[ERROR]{NC} {msg}", file=sys.stderr)
def header(msg: str): print(f"\n{CYAN}==== {msg} ===={NC}")


def load_config() -> dict:
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def find_experiment(exp_id: str) -> Optional[dict]:
    for exp in load_config()["experiments"]:
        if exp["id"] == exp_id:
            return exp
    return None


def generate_session_id() -> str:
    return str(uuid.uuid4())


def current_time_ms() -> int:
    return int(time.time() * 1000)


def run_cmd_ok(cmd: list, cwd: Optional[Path] = None) -> bool:
    r = subprocess.run(
        cmd, capture_output=True, text=True, cwd=str(cwd) if cwd else None,
        **subprocess_no_window_kwargs(),
    )
    return r.returncode == 0


def git_output(cmd: list, cwd: Path) -> str:
    r = subprocess.run(
        ["git"] + cmd, capture_output=True, text=True, cwd=cwd,
        **subprocess_no_window_kwargs(),
    )
    return r.stdout.strip()


def git_ok(cmd: list, cwd: Path) -> bool:
    return run_cmd_ok(["git"] + cmd, cwd=cwd)


def shell_ok(cmd: str, cwd: Optional[Path] = None) -> bool:
    r = subprocess.run(
        cmd, shell=True, capture_output=True, text=True,
        cwd=str(cwd) if cwd else None,
        **subprocess_no_window_kwargs(),
    )
    return r.returncode == 0


def count_mentions(text: str, pattern: str) -> int:
    return len(re.findall(pattern, text, re.IGNORECASE))


def file_mentions(filepath: Path, pattern: str) -> bool:
    if not filepath.exists():
        return False
    return count_mentions(filepath.read_text(errors="ignore"), pattern) > 0


def is_portrait(width: int, height: int) -> bool:
    """判断图片是否为竖屏（高度大于宽度）。"""
    return height > width


def write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ═══════════════════════════════════════════════════════════
# Process memory monitoring (agent + HomeGraph sidecar)
# ═══════════════════════════════════════════════════════════

try:
    import psutil  # type: ignore
    _HAS_PSUTIL = True
except ImportError:
    psutil = None  # type: ignore
    _HAS_PSUTIL = False


@dataclass
class MemoryStats:
    peak_rss_mb: float = 0.0
    peak_homegraph_rss_mb: float = 0.0
    peak_combined_rss_mb: float = 0.0
    samples: int = 0

    def to_dict(self) -> dict:
        return {
            "peak_rss_mb": round(self.peak_rss_mb, 1),
            "peak_homegraph_rss_mb": round(self.peak_homegraph_rss_mb, 1),
            "peak_combined_rss_mb": round(self.peak_combined_rss_mb, 1),
            "samples": self.samples,
        }


def _bytes_to_mb(n: float) -> float:
    return n / (1024 * 1024)


def _tree_rss_psutil(root_pid: int) -> float:
    try:
        proc = psutil.Process(root_pid)
        total = proc.memory_info().rss
        for child in proc.children(recursive=True):
            try:
                total += child.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return float(total)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return 0.0


def _homegraph_rss_psutil() -> float:
    total = 0.0
    for proc in psutil.process_iter(["cmdline"]):
        try:
            cmdline = " ".join(proc.info.get("cmdline") or [])
            if "homegraph" in cmdline.lower():
                total += proc.memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return total


def _tree_rss_powershell(root_pid: int) -> float:
    """Windows fallback: filtered CIM queries (no full process scan)."""
    if sys.platform != "win32" or root_pid <= 0:
        return 0.0
    script = (
        f"$root={root_pid};$seen=@{{}};$q=[Collections.Queue]::new();"
        "$q.Enqueue($root);$t=0L;"
        "while($q.Count -gt 0){"
        "$p=$q.Dequeue();if($seen[$p]){continue};$seen[$p]=$true;"
        "$proc=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -ErrorAction SilentlyContinue;"
        "if($proc){$t+=[int64]$proc.WorkingSetSize;"
        "Get-CimInstance Win32_Process -Filter \"ParentProcessId=$p\" -ErrorAction SilentlyContinue | "
        "ForEach-Object {$q.Enqueue($_.ProcessId)}}};$t"
    )
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True, text=True, timeout=5,
        **subprocess_no_window_kwargs(),
    )
    if r.returncode != 0:
        return 0.0
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def _homegraph_rss_powershell() -> float:
    if sys.platform != "win32":
        return 0.0
    # node.exe 数量远少于全进程，比扫 Win32_Process 快
    script = (
        "$t=0L;Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | "
        "Where-Object { $_.CommandLine -like '*homegraph*' } | "
        "ForEach-Object { $t += [int64]$_.WorkingSetSize }; $t"
    )
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True, text=True, timeout=5,
        **subprocess_no_window_kwargs(),
    )
    if r.returncode != 0:
        return 0.0
    out = r.stdout.strip()
    if not out or out.lower() == "nan":
        return 0.0
    try:
        return float(out)
    except ValueError:
        return 0.0


def _sample_rss(root_pid: int, track_homegraph: bool) -> Tuple[float, float]:
    if not _HAS_PSUTIL:
        # Without psutil, do not spawn PowerShell every 0.5s (console flash on Windows).
        return 0.0, 0.0
    agent = _tree_rss_psutil(root_pid)
    hg = _homegraph_rss_psutil() if track_homegraph else 0.0
    return agent, hg


def run_monitored_subprocess(cmd: list, poll_interval: float = 0.5,
                             track_homegraph: bool = False,
                             homegraph_poll_interval: float = 3.0,
                             **popen_kwargs):
    """Run subprocess and poll peak RSS of agent tree (+ optional HomeGraph sidecar)."""
    stats = MemoryStats()
    proc = subprocess.Popen(cmd, **merge_subprocess_kwargs(popen_kwargs))
    last_hg_poll = 0.0
    cached_hg_b = 0.0

    def _record(agent_b: float, hg_b: float):
        stats.samples += 1
        stats.peak_rss_mb = max(stats.peak_rss_mb, _bytes_to_mb(agent_b))
        stats.peak_homegraph_rss_mb = max(stats.peak_homegraph_rss_mb, _bytes_to_mb(hg_b))
        stats.peak_combined_rss_mb = max(
            stats.peak_combined_rss_mb,
            _bytes_to_mb(agent_b + hg_b),
        )

    try:
        while proc.poll() is None:
            now = time.time()
            agent_b, _ = _sample_rss(proc.pid, track_homegraph=False)
            if track_homegraph and (now - last_hg_poll >= homegraph_poll_interval):
                _, cached_hg_b = _sample_rss(proc.pid, track_homegraph=True)
                last_hg_poll = now
            _record(agent_b, cached_hg_b if track_homegraph else 0.0)
            time.sleep(poll_interval)
        agent_b, hg_b = _sample_rss(proc.pid, track_homegraph=False)
        if track_homegraph:
            _, hg_b = _sample_rss(proc.pid, track_homegraph=True)
        else:
            hg_b = 0.0
        _record(agent_b, hg_b)
    finally:
        stdout = proc.stdout
        stderr = proc.stderr
        if stdout and hasattr(stdout, "close"):
            stdout.close()
        if stderr and hasattr(stderr, "close"):
            stderr.close()

    return subprocess.CompletedProcess(
        cmd, proc.returncode, stdout=None, stderr=None,
    ), stats


def read_run_manifest(results_dir: Path) -> dict:
    """Load run_manifest.json from results dir if present."""
    path = results_dir / "run_manifest.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}



def load_agents() -> dict:
    """Load agent definitions from config/agents.json."""
    if AGENTS_FILE.exists():
        return json.loads(AGENTS_FILE.read_text(encoding="utf-8"))
    # Fallback: minimal built-in definition for Claude Code
    return {
        "default": "claude",
        "agents": {
            "claude": {
                "name": "Claude Code", "binary": "claude",
                "flags": {
                    "print": "-p", "verbose": "--verbose",
                    "output_format": ["--output-format", "stream-json"],
                    "session": ["--session-id"], "resume": ["--resume"],
                    "max_turns": ["--max-turns"],
                    "skip_permissions": ["--dangerously-skip-permissions"],
                },
                "parser": "claude_stream_json",
            }
        }
    }


def resolve_agent_binary(agent: dict) -> str:
    """Resolve CLI path: env override → absolute path → PATH lookup → configured name."""
    env_key = agent.get("binary_env", "")
    if env_key:
        override = os.environ.get(env_key, "").strip()
        if override:
            return override
    name = agent.get("binary", "")
    if name and Path(name).is_file():
        return str(Path(name).resolve())
    found = shutil.which(name)
    return found or name


def verify_agent_binary(agent: dict) -> Tuple[bool, str, str]:
    """Return (ok, resolved_path, error_message)."""
    binary = resolve_agent_binary(agent)
    label = agent.get("name", agent.get("binary", "agent"))
    configured = agent.get("binary", "")

    if not binary:
        return False, "", f"未配置 {label} 的 CLI 可执行文件。"

    on_path = shutil.which(binary) is not None or Path(binary).is_file()
    if not on_path:
        env_hint = ""
        if agent.get("binary_env"):
            env_hint = f"\n  或设置环境变量 {agent['binary_env']}=/完整/路径/{configured}"
        return False, binary, (
            f"找不到 {label} 的 CLI：`{configured}` 不在 PATH 中。{env_hint}"
        )

    r = subprocess.run([binary, "--version"], capture_output=True, text=True, **subprocess_no_window_kwargs())
    if r.returncode != 0:
        detail = (r.stdout + r.stderr).strip().replace("\n", " ")[:300]
        extra = ""
        if configured == "deveco":
            extra = (
                "\n  DevEco Code 官方仅支持 Windows x64 和 macOS（无 Linux 包）。\n"
                "  WSL 请改用 Windows 侧跑评测（CMD 用 pushd，PowerShell 可直接 cd UNC）：\n"
                "    pushd \\\\wsl.localhost\\Ubuntu-22.04\\home\\fujiaxin\\code\\homegraph\\scripts\\exp_boundary_eval\n"
                "    python run_all.py --both-arms --agent deveco"
            )
        return False, binary, (
            f"{label} 已找到 `{binary}`，但 `{configured} --version` 失败：\n"
            f"  {detail}{extra}"
        )

    return True, binary, ""


def get_agent(agent_name: str = "") -> dict:
    """Get agent definition by name. Uses default if empty."""
    data = load_agents()
    name = agent_name or data.get("default", "claude")
    agent = data.get("agents", {}).get(name)
    if agent is None:
        error(f"Agent '{name}' not found in agents.json. Available: {list(data.get('agents', {}).keys())}")
        sys.exit(1)
    agent = dict(agent)
    agent["_binary"] = resolve_agent_binary(agent)
    return agent


def get_agent_version(agent: dict) -> str:
    """Try to get agent version string."""
    binary = agent.get("_binary") or resolve_agent_binary(agent)
    r = subprocess.run([binary, "--version"], capture_output=True, text=True, **subprocess_no_window_kwargs())
    return (r.stdout + r.stderr).strip().split("\n")[0] or "unknown"


def build_agent_cmd(agent: dict, session_id: str, max_turns: int, prompt: str,
                    resume: bool = False, skip_permissions: bool = True,
                    repo_root: Optional[Path] = None) -> list:
    """Build CLI command for any registered agent.

    Handles agents with missing flags gracefully:
      - If 'session' flag is in 'missing', uses 'resume' or 'continue' instead
      - If 'max_turns' is missing, skips it (no turn limit enforcement)
      - If 'skip_permissions' is missing, warns and skips
    """
    # Dedup warnings per agent per run
    if not hasattr(build_agent_cmd, '_warned'):
        build_agent_cmd._warned = set()
    warned = build_agent_cmd._warned
    agent_key = agent.get('binary', '')

    flags = agent["flags"]
    missing = set(agent.get("missing", []))
    binary = agent.get("_binary") or resolve_agent_binary(agent)

    cmd = [binary]

    # Print mode (non-interactive) — can be flag (-p) or subcommand (run/exec)
    print_flag = flags.get("print", "")
    if print_flag:
        cmd.append(print_flag)

    # Verbose
    if flags.get("verbose") and "verbose" not in missing:
        cmd.append(flags["verbose"])

    # Output format
    for f in flags.get("output_format", []):
        cmd.append(f)

    # Session / resume
    # "session" in missing only affects NEW sessions (some agents can resume
    # existing sessions but can't create them via a flag, e.g. DevEco).
    if resume and flags.get("resume"):
        cmd.extend(flags["resume"])
        cmd.append(session_id)
    elif resume and flags.get("continue"):
        # Agent uses --continue instead of --resume
        cmd.extend(flags["continue"])
    elif not resume and flags.get("session") and "session" not in missing:
        cmd.extend(flags["session"])
        cmd.append(session_id)

    # Max turns — skip if agent doesn't support it
    if flags.get("max_turns") and "max_turns" not in missing:
        cmd.extend(flags["max_turns"])
        cmd.append(str(max_turns))
    elif "max_turns" in missing:
        key = f'{agent_key}:max_turns'
        if key not in warned:
            info(f"Agent '{agent['name']}' has no max-turns flag; turn limits not enforced")
            warned.add(key)

    # Skip permissions — skip if agent doesn't support it
    if skip_permissions and flags.get("skip_permissions") and "skip_permissions" not in missing:
        cmd.extend(flags["skip_permissions"])
    elif skip_permissions and "skip_permissions" in missing:
        key = f'{agent_key}:skip_perms'
        if key not in warned:
            info(f"Agent '{agent['name']}' does not support skip-permissions; prompts may appear")
            warned.add(key)

    # DevEco reads project MCP from --dir (repo/.deveco/deveco.jsonc)
    if repo_root and agent.get("binary") == "deveco":
        cmd.extend(["--dir", str(repo_root)])

    cmd.append(prompt)
    return cmd


# ═══════════════════════════════════════════════════════════
# Output parsers (one per agent format)
# ═══════════════════════════════════════════════════════════

@dataclass
class StreamStats:
    tool_calls: int = 0
    homegraph_tool_calls: int = 0
    used_homegraph: bool = False
    tool_names: list = field(default_factory=list)
    files_read: list = field(default_factory=list)
    files_edited: list = field(default_factory=list)
    files_grepped: list = field(default_factory=list)
    assistant_messages: int = 0
    text_lines: list = field(default_factory=list)
    thinking_lines: list = field(default_factory=list)
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    max_turns_hit: bool = False
    errors: list = field(default_factory=list)
    model: str = ""
    deveco_session_id: str = ""


def _is_deveco_session_id(value: str) -> bool:
    return bool(value) and value.startswith("ses_")


def _format_deveco_model(model_obj) -> str:
    if isinstance(model_obj, str) and model_obj:
        return model_obj
    if isinstance(model_obj, dict):
        model_id = model_obj.get("id") or model_obj.get("modelID", "")
        provider_id = model_obj.get("providerID", "")
        if model_id and provider_id:
            return f"{provider_id}/{model_id}"
        return model_id or provider_id or ""
    return ""


def resolve_deveco_model(deveco_session_id: str) -> str:
    """Resolve model name via `deveco export <sessionID>`."""
    if not _is_deveco_session_id(deveco_session_id):
        return ""
    cache = getattr(resolve_deveco_model, "_cache", None)
    if cache is None:
        cache = {}
        resolve_deveco_model._cache = cache
    if deveco_session_id in cache:
        return cache[deveco_session_id]
    try:
        result = subprocess.run(
            ["deveco", "export", deveco_session_id],
            capture_output=True, text=True, timeout=15,
            **subprocess_no_window_kwargs(),
        )
        if result.returncode != 0:
            cache[deveco_session_id] = ""
            return ""
        raw = result.stdout.strip()
        json_start = raw.find("{")
        if json_start < 0:
            cache[deveco_session_id] = ""
            return ""
        data = json.loads(raw[json_start:])
        model = _format_deveco_model(data.get("info", {}).get("model", ""))
        cache[deveco_session_id] = model
        return model
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        cache[deveco_session_id] = ""
        return ""


def resolve_agent_model(agent: dict, stats: StreamStats) -> str:
    """Return the best available model label for an agent run."""
    if agent.get("binary") == "deveco" or agent.get("parser") == "deveco_json":
        deveco_sid = stats.deveco_session_id or (
            stats.model if _is_deveco_session_id(stats.model) else ""
        )
        if deveco_sid:
            resolved = resolve_deveco_model(deveco_sid)
            if resolved:
                return resolved
        if stats.model and not _is_deveco_session_id(stats.model):
            return stats.model
        return ""
    return stats.model


def _collect_paths_from_obj(obj, paths: list):
    """Recursively collect file paths from nested grep/glob result objects."""
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key in ("file", "path") and isinstance(val, str) and val and not val.startswith("http"):
                if "/" in val or "." in val:
                    paths.append(val)
            elif key == "files" and isinstance(val, list):
                for item in val:
                    if isinstance(item, str):
                        paths.append(item)
            else:
                _collect_paths_from_obj(val, paths)
    elif isinstance(obj, list):
        for item in obj:
            _collect_paths_from_obj(item, paths)


def _parse_cursor_stream_json(filepath: Path) -> StreamStats:
    """Cursor Agent stream-json format (type=tool_call, camelCase tool names)."""
    stats = StreamStats()
    if not filepath.exists():
        return stats

    READ_TOOLS = {"readToolCall"}
    WRITE_TOOLS = {"editToolCall", "writeToolCall", "searchReplaceToolCall"}
    SEARCH_TOOLS = {"grepToolCall", "globToolCall", "semanticSearchToolCall", "listToolCall"}

    with open(filepath, errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            ev_type = event.get("type", "")
            if ev_type == "system" and event.get("subtype") == "init":
                stats.model = event.get("model", stats.model)

            if ev_type == "assistant":
                stats.assistant_messages += 1
                msg = event.get("message", {})
                usage = msg.get("usage", {})
                stats.total_input_tokens += usage.get("input_tokens", 0)
                stats.total_output_tokens += usage.get("output_tokens", 0)
                blocks = msg.get("content", [])
                if isinstance(blocks, str):
                    blocks = [{"type": "text", "text": blocks}]
                for block in blocks:
                    if block.get("type") == "text":
                        stats.text_lines.append(block.get("text", ""))

            if ev_type == "tool_call" and event.get("subtype") == "completed":
                stats.tool_calls += 1
                tc = event.get("tool_call", {})
                for tool_key, tool_data in tc.items():
                    if not tool_key.endswith("ToolCall"):
                        continue
                    stats.tool_names.append(tool_key.replace("ToolCall", ""))
                    args = tool_data.get("args", {}) if isinstance(tool_data, dict) else {}
                    result = tool_data.get("result", {}) if isinstance(tool_data, dict) else {}
                    path = args.get("path") or args.get("targetFile") or args.get("filePath") or ""
                    if tool_key in READ_TOOLS and path:
                        stats.files_read.append(path)
                    elif tool_key in WRITE_TOOLS and path:
                        stats.files_edited.append(path)
                    if tool_key in SEARCH_TOOLS:
                        found: list = []
                        _collect_paths_from_obj(result, found)
                        if not found and path:
                            found.append(path)
                        stats.files_grepped.extend(found)

            if ev_type == "error":
                stats.errors.append(str(event.get("message", event))[:200])

            if ev_type == "result":
                if event.get("is_error"):
                    stats.errors.append(str(event.get("result", ""))[:200])

    return stats


def detect_stream_parser(filepath: Path) -> str:
    """Auto-detect Claude vs Cursor stream-json format."""
    if not filepath.exists():
        return "claude_stream_json"
    scanned = 0
    with open(filepath, errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            scanned += 1
            if event.get("type") == "tool_call":
                tc = event.get("tool_call", {})
                if any(k.endswith("ToolCall") for k in tc):
                    return "cursor_stream_json"
                if any(k == "tool_use" for k in tc):
                    return "claude_stream_json"
            if event.get("type") == "assistant":
                blocks = event.get("message", {}).get("content", [])
                if isinstance(blocks, list) and any(b.get("type") == "tool_use" for b in blocks):
                    return "claude_stream_json"
            if scanned >= 50:
                break
    return "claude_stream_json"


def parse_output(filepath: Path, parser_name: str) -> StreamStats:
    """Dispatch to the appropriate parser based on agent type."""
    parsers = {
        "claude_stream_json": _parse_claude_stream_json,
        "cursor_stream_json": _parse_cursor_stream_json,
        "codex_json": _parse_codex_json,
        "opencode_json": _parse_opencode_json,
        "deveco_json": _parse_deveco_json,
        "generic_json": _parse_generic_json,
        "text": _parse_text_only,
    }
    if parser_name == "auto":
        parser_name = detect_stream_parser(filepath)
    parser = parsers.get(parser_name, _parse_claude_stream_json)
    return parser(filepath)


def _parse_claude_stream_json(filepath: Path) -> StreamStats:
    """Claude Code / Cursor Agent stream-json format."""
    stats = StreamStats()
    if not filepath.exists():
        return stats

    READ_TOOLS = {"Read", "read_file"}
    WRITE_TOOLS = {"Edit", "Write", "edit_file", "write_file"}
    SEARCH_TOOLS = {"Grep", "Glob", "grep", "glob", "search", "find"}

    with open(filepath, errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: event = json.loads(line)
            except json.JSONDecodeError: continue

            ev_type = event.get("type", "")
            if ev_type == "system" and event.get("subtype") == "init":
                stats.model = event.get("model", "")

            if ev_type == "assistant":
                stats.assistant_messages += 1
                msg = event.get("message", {})
                usage = msg.get("usage", {})
                stats.total_input_tokens += usage.get("input_tokens", 0)
                stats.total_output_tokens += usage.get("output_tokens", 0)
                blocks = msg.get("content", [])
                if isinstance(blocks, str):
                    blocks = [{"type": "text", "text": blocks}]
                for block in blocks:
                    btype = block.get("type", "")
                    if btype == "tool_use":
                        stats.tool_calls += 1
                        stats.tool_names.append(block.get("name", ""))
                        inp = block.get("input", {})
                        if isinstance(inp, dict):
                            fp = inp.get("file_path", inp.get("filePath", ""))
                            if fp:
                                name = block.get("name", "")
                                if name in READ_TOOLS: stats.files_read.append(fp)
                                elif name in WRITE_TOOLS: stats.files_edited.append(fp)
                                elif name in SEARCH_TOOLS: stats.files_grepped.append(fp)
                    elif btype == "text":
                        stats.text_lines.append(block.get("text", ""))
                    elif btype == "thinking":
                        stats.thinking_lines.append(block.get("thinking", ""))

            if ev_type == "user":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "tool_result" and block.get("is_error"):
                        stats.errors.append(str(block.get("content", ""))[:200])

            if ev_type == "error":
                msg = event.get("message", str(event))
                stats.errors.append(msg)
                if "max turns" in msg.lower(): stats.max_turns_hit = True

            if ev_type == "result":
                if "max_turns" in event.get("subtype", "").lower():
                    stats.max_turns_hit = True
                for e in event.get("errors", []):
                    stats.errors.append(str(e)[:200])

    return stats


def _parse_codex_json(filepath: Path) -> StreamStats:
    """OpenAI Codex CLI JSON output format.

    Codex outputs a JSON array of events or line-delimited JSON.
    Each event has: {"type":"tool_call","tool":"read","path":"...","content":"..."}
    """
    stats = StreamStats()
    if not filepath.exists():
        return stats

    READ_TOOLS = {"read", "read_file", "cat"}
    WRITE_TOOLS = {"edit", "write", "create"}
    SEARCH_TOOLS = {"grep", "glob", "search", "find", "ls"}

    raw = filepath.read_text(errors="ignore").strip()

    # Try line-delimited JSON first
    for line in raw.split("\n"):
        line = line.strip()
        if not line: continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # Try parsing whole file as JSON array
            try:
                events = json.loads(raw)
                if isinstance(events, list):
                    for event in events:
                        _parse_codex_event(event, stats, READ_TOOLS, WRITE_TOOLS, SEARCH_TOOLS)
                    return stats
            except json.JSONDecodeError:
                continue
            continue
        _parse_codex_event(event, stats, READ_TOOLS, WRITE_TOOLS, SEARCH_TOOLS)

    return stats


def _parse_codex_event(event: dict, stats: StreamStats,
                       READ_TOOLS: set, WRITE_TOOLS: set, SEARCH_TOOLS: set):
    ev_type = event.get("type", "")
    if ev_type == "init":
        stats.model = event.get("model", "")
    if ev_type == "tool_call":
        stats.tool_calls += 1
        tool = event.get("tool", event.get("name", ""))
        stats.tool_names.append(tool)
        path = event.get("path", event.get("file", event.get("file_path", "")))
        if path:
            if tool in READ_TOOLS: stats.files_read.append(path)
            elif tool in WRITE_TOOLS: stats.files_edited.append(path)
            elif tool in SEARCH_TOOLS: stats.files_grepped.append(path)
    if ev_type == "message" or ev_type == "assistant":
        stats.assistant_messages += 1
        text = event.get("content", event.get("text", ""))
        if isinstance(text, str) and text:
            stats.text_lines.append(text)
        usage = event.get("usage", {})
        stats.total_input_tokens += usage.get("input_tokens", usage.get("prompt_tokens", 0))
        stats.total_output_tokens += usage.get("output_tokens", usage.get("completion_tokens", 0))
    if ev_type == "error":
        stats.errors.append(event.get("message", str(event)))
        if "max turns" in event.get("message", "").lower():
            stats.max_turns_hit = True


def _parse_opencode_json(filepath: Path) -> StreamStats:
    """OpenCode JSON output format.

    Similar to Codex but may have different field names.
    Handles both line-delimited and array formats.
    """
    stats = StreamStats()
    if not filepath.exists():
        return stats

    READ_TOOLS = {"read", "read_file", "open"}
    WRITE_TOOLS = {"edit", "write", "create", "patch"}
    SEARCH_TOOLS = {"grep", "glob", "search", "find", "list"}

    raw = filepath.read_text(errors="ignore").strip()
    for line in raw.split("\n"):
        line = line.strip()
        if not line: continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        ev_type = event.get("type", event.get("event", ""))
        if ev_type in ("init", "start"):
            stats.model = event.get("model", event.get("llm", ""))
        if ev_type in ("tool_call", "tool"):
            stats.tool_calls += 1
            tool = event.get("tool", event.get("name", ""))
            stats.tool_names.append(tool)
            path = event.get("path", event.get("file", event.get("file_path", "")))
            if path:
                if tool in READ_TOOLS: stats.files_read.append(path)
                elif tool in WRITE_TOOLS: stats.files_edited.append(path)
                elif tool in SEARCH_TOOLS: stats.files_grepped.append(path)
        if ev_type in ("message", "assistant", "response"):
            stats.assistant_messages += 1
            text = event.get("content", event.get("text", event.get("message", "")))
            if isinstance(text, str) and text:
                stats.text_lines.append(text)
            usage = event.get("usage", event.get("tokens", {}))
            if isinstance(usage, dict):
                stats.total_input_tokens += usage.get("input", usage.get("input_tokens", 0))
                stats.total_output_tokens += usage.get("output", usage.get("output_tokens", 0))
        if ev_type == "error":
            msg = event.get("message", str(event))
            stats.errors.append(msg)
            if "max turns" in msg.lower(): stats.max_turns_hit = True

    return stats


def _parse_deveco_json(filepath: Path) -> StreamStats:
    """DevEco Studio AI CLI JSON output format.

    Actual deveco output (--format json):
      {"type":"step_start",  "part":{"type":"step-start", "sessionID":"...", ...}}
      {"type":"tool_use",    "part":{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"..."},...}}}
      {"type":"step_finish", "part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":...,"input":...,"output":...},...}}
      {"type":"assistant",   "part":{"type":"text","text":"Hello..."}}

    Tool info is nested under ``part``, not at the event root.
    """
    stats = StreamStats()
    if not filepath.exists():
        return stats

    READ_TOOLS = {"read", "read_file", "Read", "open", "cat"}
    WRITE_TOOLS = {"write", "edit", "Write", "Edit", "create", "replace"}
    SEARCH_TOOLS = {"search", "find", "grep", "glob", "Grep", "Glob", "list", "ls", "bash"}

    raw = filepath.read_text(errors="ignore").strip()

    for line in raw.split("\n"):
        line = line.strip()
        if not line: continue
        try: event = json.loads(line)
        except json.JSONDecodeError: continue

        ev_type = event.get("type", event.get("event", ""))
        part = event.get("part", {}) if isinstance(event.get("part"), dict) else {}

        session_id = event.get("sessionID", part.get("sessionID", ""))
        if _is_deveco_session_id(session_id):
            stats.deveco_session_id = session_id

        if ev_type == "step_start":
            if not stats.model:
                model = event.get("model", part.get("model", ""))
                if model and not _is_deveco_session_id(model):
                    stats.model = model

        elif ev_type == "tool_use":
            tool = part.get("tool", event.get("tool", ""))
            if not tool:
                continue
            stats.tool_calls += 1
            stats.tool_names.append(tool)
            if is_homegraph_tool(tool):
                stats.homegraph_tool_calls += 1
                stats.used_homegraph = True

            state = part.get("state", {})
            inp = state.get("input", {}) if isinstance(state.get("input"), dict) else {}

            if state.get("status") == "error":
                err = state.get("error", "") or str(inp)
                stats.errors.append(str(err)[:200])

            # Extract file path from various input formats
            fp = ""
            if isinstance(inp, dict):
                fp = inp.get("file_path", inp.get("filePath", inp.get("path", "")))
            if not fp:
                fp = event.get("path", event.get("file_path", ""))

            if fp:
                if tool.lower() in READ_TOOLS:
                    stats.files_read.append(fp)
                elif tool.lower() in WRITE_TOOLS:
                    stats.files_edited.append(fp)
                elif tool.lower() in SEARCH_TOOLS:
                    stats.files_grepped.append(fp)

        elif ev_type == "step_finish":
            tokens = part.get("tokens", {}) if isinstance(part.get("tokens"), dict) else {}
            if tokens:
                stats.total_input_tokens += tokens.get("input", 0)
                stats.total_output_tokens += tokens.get("output", 0)
            if part.get("reason") == "stop":
                # Final step — could extract summary here
                pass

        elif ev_type in ("message", "assistant", "response", "text"):
            stats.assistant_messages += 1
            # Try nested part.text first, then flat content
            content = part.get("text", part.get("content", ""))
            if not content:
                content = event.get("content", event.get("text", event.get("message", "")))
            if isinstance(content, str) and content.strip():
                stats.text_lines.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        stats.text_lines.append(block.get("text", ""))

        elif ev_type == "error":
            msg = event.get("message", str(event))
            stats.errors.append(msg)
            if "max" in msg.lower() and ("turn" in msg.lower() or "step" in msg.lower()):
                stats.max_turns_hit = True

    return stats


def _parse_generic_json(filepath: Path) -> StreamStats:
    """Generic JSON parser — tries to auto-detect event structure.

    Handles unknown agent formats by looking for common patterns:
      - Any event with a 'tool' field → tool call
      - Any event with 'content' → assistant message
      - Any event with 'error' → error
    """
    stats = StreamStats()
    if not filepath.exists():
        return stats

    raw = filepath.read_text(errors="ignore").strip()
    for line in raw.split("\n"):
        line = line.strip()
        if not line: continue
        try: event = json.loads(line)
        except json.JSONDecodeError: continue

        # Detect tool calls
        tool = event.get("tool", event.get("name", event.get("function", "")))
        if tool:
            stats.tool_calls += 1
            stats.tool_names.append(tool)
            fp = event.get("file_path", event.get("path", event.get("file", "")))
            if fp:
                if tool.lower() in ("read", "open", "cat"): stats.files_read.append(fp)
                elif tool.lower() in ("write", "edit", "create", "replace"): stats.files_edited.append(fp)
                else: stats.files_grepped.append(fp)

        # Detect messages
        content = event.get("content", event.get("text", event.get("message", "")))
        if isinstance(content, str) and content.strip():
            stats.assistant_messages += 1
            stats.text_lines.append(content)

        # Detect tokens
        stats.total_input_tokens += event.get("input_tokens", event.get("prompt_tokens", 0))
        stats.total_output_tokens += event.get("output_tokens", event.get("completion_tokens", 0))

        # Detect errors
        if event.get("error") or event.get("type") == "error":
            stats.errors.append(event.get("message", str(event)))

        # Detect model
        if event.get("model"):
            stats.model = event["model"]

    return stats


def _parse_text_only(filepath: Path) -> StreamStats:
    """Plain-text output parser — no JSON, just count lines as content.

    Used as fallback when agent only produces human-readable text.
    """
    stats = StreamStats()
    if not filepath.exists():
        return stats

    raw = filepath.read_text(errors="ignore").strip()
    for line in raw.split("\n"):
        line = line.strip()
        if line:
            stats.text_lines.append(line)

    stats.assistant_messages = 1
    # Heuristic: count lines with file paths as "reads"
    for line in stats.text_lines:
        if re.search(r"\.(ets|ts|js|json5?|cpp|h|hpp|py|md)", line):
            stats.files_read.append(line)

    return stats


# ═══════════════════════════════════════════════════════════
# Backward-compatible alias
# ═══════════════════════════════════════════════════════════

def parse_stream_json(filepath: Path) -> StreamStats:
    """Parse stream-json, auto-detecting Claude vs Cursor format."""
    return parse_output(filepath, "auto")

build_claude_cmd = None  # deprecated, use build_agent_cmd instead
