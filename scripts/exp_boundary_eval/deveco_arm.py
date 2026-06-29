#!/usr/bin/env python3
"""DevEco A/B arm wiring — MCP config, git clean."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

from _utils import EVAL_ROOT, count_homegraph_tools, is_homegraph_tool, log, subprocess_no_window_kwargs, warn

__all__ = [
    "count_homegraph_tools",
    "is_homegraph_tool",
    "find_homegraph_bin",
    "find_homegraph_bin_path",
    "homegraph_node_argv",
    "write_deveco_project_config",
    "git_clean_repo",
    "try_remove_homegraph_index",
    "is_homegraph_indexed",
    "ensure_homegraph_index",
    "analyze_homegraph_stream",
]

# Photos-scale repos can take 15+ minutes on first index.
HOMEGRAPH_INDEX_TIMEOUT_S = 1800

# Node.js rejects --stack-size in NODE_OPTIONS; pass it as a direct node argv instead.
# Override with HOMEGRAPH_NODE_STACK_SIZE_KB=0 to use the V8 default (~984 KB).
def _homegraph_stack_size_kb() -> int:
    raw = os.environ.get("HOMEGRAPH_NODE_STACK_SIZE_KB", "32768").strip()
    if not raw:
        return 32768
    try:
        return max(0, int(raw))
    except ValueError:
        return 32768

# Windows STATUS_STACK_OVERFLOW (native stack, not catchable in JS).
_STACK_OVERFLOW_EXIT_CODES = frozenset({3221225725, -1073741571})


def _homegraph_stack_sizes_to_try() -> List[int]:
    base = _homegraph_stack_size_kb()
    sizes: List[int] = []
    for kb in (base, 65536, 131072, 262144):
        if kb > 0 and kb not in sizes:
            sizes.append(kb)
    return sizes


def _is_stack_overflow_exit(code: Optional[int]) -> bool:
    return code in _STACK_OVERFLOW_EXIT_CODES if code is not None else False


_HG_FAILURE_MARKERS = (
    "No HomeGraph project is loaded",
    "isn't indexed with homegraph",
    "not indexed with homegraph",
    "Pass projectPath to the tool call",
)

_DEVECO_WITH_AGENT_PROMPT = (
    "你是鸿蒙 ArkTS 代码仓库问答 Agent（homegraph 评测臂）。"
    "定位/理解代码时，优先调用 MCP 工具 homegraph_explore（不要用 homegraph_node）；"
    "query 写符号名（类名、方法名、组件名、常量名），"
    "如 ThirdSelectAlbumGridBase、GRID_GUTTER、ImageGridItemComponent。"
    "仅当 explore 结果不足时再用 grep/read/glob。"
    "基于仓库事实作答，中文简洁准确。"
)

_DEVECO_WITHOUT_AGENT_PROMPT = (
    "你是鸿蒙 ArkTS 代码仓库问答 Agent（baseline 臂，无 homegraph）。"
    "用 grep、read 等内置工具探索仓库后作答，中文简洁准确。"
)


def find_homegraph_bin_path() -> Optional[Path]:
    hg_bin = EVAL_ROOT.parents[1] / "dist" / "bin" / "homegraph.js"
    return hg_bin if hg_bin.exists() else None


def _homegraph_node_inner(*args: str, stack_kb: Optional[int] = None) -> List[str]:
    """Args after ``node``: ``[--liftoff-only, --stack-size=N, homegraph.js, …]``."""
    hg_bin = find_homegraph_bin_path()
    if hg_bin is None:
        raise FileNotFoundError("homegraph binary not found")
    kb = _homegraph_stack_size_kb() if stack_kb is None else stack_kb
    inner: List[str] = []
    # Skip homegraph.js re-exec spawn (extra node.exe flash on Windows).
    if os.name == "nt":
        inner.append("--liftoff-only")
    if kb > 0:
        inner.append(f"--stack-size={kb}")
    inner.append(str(hg_bin))
    inner.extend(args)
    return inner


def _homegraph_mcp_env() -> dict:
    """Fewer node spawns during eval MCP (no daemon / watchdog subprocesses)."""
    return {
        "HOMEGRAPH_NO_DAEMON": "1",
        "HOMEGRAPH_NO_WATCHDOG": "1",
        "HOMEGRAPH_WASM_RELAUNCHED": "1",
    }


def _resolve_node_binary() -> str:
    return os.environ.get("HOMEGRAPH_NODE", "node").strip() or "node"


def homegraph_node_argv(*args: str, stack_kb: Optional[int] = None) -> List[str]:
    """``node [--stack-size=N] homegraph.js …`` for Python subprocess (capture_output-safe)."""
    return [_resolve_node_binary(), *_homegraph_node_inner(*args, stack_kb=stack_kb)]


def _mcp_launcher_python() -> str:
    """pythonw.exe — no console when DevEco spawns MCP."""
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    return str(pythonw) if pythonw.is_file() else sys.executable


def homegraph_mcp_command(repo: Path) -> List[str]:
    """MCP argv: pythonw (no flash) → hidden node, stdio preserved."""
    inner = _homegraph_node_inner("serve", "--mcp", "--path", str(repo.resolve()))
    if os.name == "nt":
        launcher = EVAL_ROOT / "win_mcp_launcher.py"
        return [_mcp_launcher_python(), str(launcher), *inner]
    return [_resolve_node_binary(), *inner]


def find_homegraph_bin() -> str:
    """Human-readable homegraph CLI prefix (logging only)."""
    hg_bin = find_homegraph_bin_path()
    if hg_bin is None:
        return ""
    stack_kb = _homegraph_stack_size_kb()
    stack = f" --stack-size={stack_kb}" if stack_kb > 0 else ""
    return f"{_resolve_node_binary()}{stack} {hg_bin}"


def deveco_project_config_dir(repo: Path) -> Path:
    return repo / ".deveco"


def write_deveco_project_config(repo: Path, arm: str) -> Optional[Path]:
    """Write repo/.deveco/deveco.jsonc for baseline or homegraph arm."""
    config_dir = deveco_project_config_dir(repo)
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "deveco.jsonc"
    body = {"$schema": "https://opencode.ai/config.json"}

    if arm == "homegraph":
        if find_homegraph_bin_path() is None:
            warn("homegraph binary not found; MCP will not be configured")
            return None
        body["mcp"] = {
            "homegraph": {
                "type": "local",
                "command": homegraph_mcp_command(repo),
                "enabled": True,
                "environment": _homegraph_mcp_env(),
            }
        }
        body["agent"] = {"build": {"prompt": _DEVECO_WITH_AGENT_PROMPT}}
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
    log(f"DevEco config ({arm}): {config_path}")
    return config_path


def git_clean_repo(repo_root: Path, arm: str) -> None:
    """Reset untracked files.

    Always preserve ``.homegraph/`` — deleting it on every experiment reset hits
    Windows file locks when homegraph.db is open. Baseline arm blocks HG via
    ``deveco.jsonc`` permissions instead.
    """
    cmd = ["git", "clean", "-fd", "-e", ".homegraph"]
    if arm == "homegraph":
        cmd.append("-e")
        cmd.append(".deveco")
    subprocess.run(
        cmd, cwd=repo_root, capture_output=True, text=True,
        **subprocess_no_window_kwargs(),
    )


def try_remove_homegraph_index(repo_root: Path) -> bool:
    """Best-effort remove ``.homegraph/`` once at baseline suite start."""
    import os
    import stat
    import time

    hg_dir = repo_root.resolve() / ".homegraph"
    if not hg_dir.exists():
        return True

    def _onerror(func, path, _exc_info):
        try:
            os.chmod(path, stat.S_IWRITE)
            func(path)
        except OSError:
            pass

    for attempt in range(3):
        try:
            shutil.rmtree(str(hg_dir), onerror=_onerror)
        except OSError:
            pass
        if not hg_dir.exists():
            log(f"Removed .homegraph for baseline arm")
            return True
        time.sleep(0.5 * (attempt + 1))

    warn(f"无法删除 {hg_dir}（homegraph.db 可能被占用）")
    warn("baseline 组将继续：.deveco/deveco.jsonc 已 deny homegraph_* 工具")
    return False


def homegraph_db_path(repo: Path) -> Path:
    return repo.resolve() / ".homegraph" / "homegraph.db"


def is_homegraph_indexed(repo: Path) -> bool:
    """True when ``.homegraph/homegraph.db`` exists (not necessarily complete)."""
    db = homegraph_db_path(repo)
    return db.is_file() and db.stat().st_size > 0


def _run_homegraph_cli(
    repo: Path, subcommand: str, *extra_args: str, capture: bool = False,
    stack_kb: Optional[int] = None,
) -> subprocess.CompletedProcess:
    if find_homegraph_bin_path() is None:
        raise FileNotFoundError("homegraph binary not found")
    kwargs: dict = {
        "timeout": HOMEGRAPH_INDEX_TIMEOUT_S,
        "text": True,
        **subprocess_no_window_kwargs(),
    }
    if capture:
        kwargs["capture_output"] = True
    return subprocess.run(
        homegraph_node_argv(subcommand, *extra_args, str(repo.resolve()), stack_kb=stack_kb),
        **kwargs,
    )


def _run_homegraph_index_with_stack_retry(repo: Path, command: str) -> subprocess.CompletedProcess:
    """Run index/init; on Windows stack overflow, retry with larger --stack-size."""
    last: Optional[subprocess.CompletedProcess] = None
    for stack_kb in _homegraph_stack_sizes_to_try():
        if stack_kb != _homegraph_stack_size_kb():
            log(f"Retrying homegraph {command} with --stack-size={stack_kb} …")
        last = _run_homegraph_cli(repo, command, stack_kb=stack_kb)
        if last.returncode == 0 or not _is_stack_overflow_exit(last.returncode):
            return last
    assert last is not None
    return last


def get_homegraph_status(repo: Path) -> dict:
    """Parse ``homegraph status --json``."""
    try:
        r = _run_homegraph_cli(repo, "status", "-j", capture=True)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {}
    if r.returncode != 0:
        return {}
    raw = (r.stdout or "").strip()
    start = raw.find("{")
    if start < 0:
        return {}
    try:
        return json.loads(raw[start:])
    except json.JSONDecodeError:
        return {}


def _count_ets_files(repo: Path) -> int:
    cache = getattr(_count_ets_files, "_cache", {})
    key = str(repo.resolve())
    if key not in cache:
        cache[key] = sum(1 for _ in repo.rglob("*.ets"))
        _count_ets_files._cache = cache
    return cache[key]


def assess_index_health(repo: Path, status: Optional[dict] = None) -> Tuple[bool, str]:
    """Return (healthy, reason). Detects partial indexes (e.g. aborted init)."""
    status = status if status is not None else get_homegraph_status(repo)
    if not status.get("initialized"):
        return False, "not initialized"

    index_meta = status.get("index") or {}
    if index_meta.get("reindexRecommended"):
        return False, "homegraph status reports reindexRecommended"

    kinds = status.get("nodesByKind") or {}
    arkts_nodes = kinds.get("struct", 0) + kinds.get("component", 0)
    langs = status.get("languages") or []
    file_count = int(status.get("fileCount") or 0)
    ets_count = _count_ets_files(repo)

    if ets_count >= 50 and arkts_nodes == 0 and "arkts" not in langs:
        return False, (
            f"repo has {ets_count} .ets files but index has no arkts/struct/component "
            f"(fileCount={file_count})"
        )
    if ets_count >= 50 and file_count < max(ets_count // 2, 200):
        return False, (
            f"indexed only {file_count} files but repo has {ets_count} .ets files "
            "(likely partial/aborted index)"
        )
    return True, ""


def ensure_homegraph_index(repo: Path, *, force: bool = False, skip: bool = False) -> dict:
    """Ensure index exists via full rebuild (never sync-only).

    - No ``.homegraph/`` → ``homegraph init <repo>`` (then ``index`` if still unhealthy)
    - Otherwise → ``homegraph index`` every time (clears DB + rebuilds ArkTS Scene)
    - ``skip=True`` → use existing ``.homegraph/`` only (no init/index); fails if missing/unhealthy

    Use ``sync`` only for manual incremental updates outside this eval harness.
    """
    import time

    repo = repo.resolve()
    hg_bin = find_homegraph_bin_path()
    if hg_bin is None:
        msg = "homegraph binary not found; run npm run build in homegraph repo first"
        warn(msg)
        return _index_result(False, "none", 0, msg)

    if skip:
        return _use_existing_homegraph_index(repo)

    status = get_homegraph_status(repo)
    healthy, health_reason = assess_index_health(repo, status)

    if not status.get("initialized"):
        command = "init"
        log("HomeGraph not initialized — running homegraph init (Photos may take 15–30 min)...")
    else:
        command = "index"
        if not healthy:
            warn(f"HomeGraph index unhealthy: {health_reason}")
        elif force:
            log("HomeGraph index — forced full rebuild (homegraph index)...")
        else:
            log("HomeGraph index — full rebuild (homegraph index, progress below)...")

    start_ms = int(time.time() * 1000)
    try:
        if command == "index":
            r = _run_homegraph_index_with_stack_retry(repo, command)
        else:
            r = _run_homegraph_cli(repo, command)
    except subprocess.TimeoutExpired:
        msg = f"homegraph {command} timed out after {HOMEGRAPH_INDEX_TIMEOUT_S}s"
        warn(msg)
        return _index_result(False, command, HOMEGRAPH_INDEX_TIMEOUT_S * 1000, msg)

    elapsed_ms = int(time.time() * 1000) - start_ms
    err_tail = (r.stderr or r.stdout or "").strip()
    if len(err_tail) > 500:
        err_tail = err_tail[:500] + "…"

    # init on an already-initialized repo exits 0 but does not re-index — follow with index.
    if command == "init" and r.returncode == 0 and is_homegraph_indexed(repo):
        post_status = get_homegraph_status(repo)
        post_healthy, post_reason = assess_index_health(repo, post_status)
        if not post_healthy:
            log(f"init finished but index still unhealthy ({post_reason}) — running homegraph index...")
            try:
                r = _run_homegraph_index_with_stack_retry(repo, "index")
                elapsed_ms = int(time.time() * 1000) - start_ms
                if r.returncode != 0:
                    err_tail = (r.stderr or r.stdout or "").strip()[:500]
                    return _index_result(False, "index", elapsed_ms, err_tail or "index failed after init")
                command = "index"
            except subprocess.TimeoutExpired:
                return _index_result(False, "index", elapsed_ms, "index timed out after init")

    if r.returncode != 0:
        return _index_result(False, command, elapsed_ms, err_tail or f"exit code {r.returncode}")

    final_status = get_homegraph_status(repo)
    final_healthy, final_reason = assess_index_health(repo, final_status)
    if not final_healthy:
        return _index_result(False, command, elapsed_ms, final_reason)

    log(
        f"homegraph {command} OK ({elapsed_ms / 1000:.1f}s) — "
        f"{final_status.get('fileCount', '?')} files, "
        f"{final_status.get('nodeCount', '?')} nodes"
    )
    return _index_result(True, command, elapsed_ms, "", final_status)


def _use_existing_homegraph_index(repo: Path) -> dict:
    """Validate a pre-copied ``.homegraph/`` without running init/index."""
    repo = repo.resolve()
    if not is_homegraph_indexed(repo):
        msg = (
            "no .homegraph/homegraph.db — copy a .homegraph/ directory into the repo "
            "or omit --skip-index"
        )
        warn(msg)
        return _index_result(False, "skip", 0, msg)

    status = get_homegraph_status(repo)
    if not status.get("initialized"):
        msg = "homegraph status: not initialized (invalid or empty .homegraph/)"
        warn(msg)
        return _index_result(False, "skip", 0, msg)

    healthy, health_reason = assess_index_health(repo, status)
    if not healthy:
        warn(f"已有 .homegraph/ 不健康: {health_reason}")
        return _index_result(False, "skip", 0, health_reason or "index unhealthy")

    changes = status.get("pendingChanges") or {}
    pending = int(changes.get("added", 0)) + int(changes.get("modified", 0)) + int(
        changes.get("removed", 0)
    )
    if pending > 0:
        warn(
            f"仓库相对索引有 {pending} 处文件变更（added/modified/removed）；"
            "复制索引要求相同 commit。可 `homegraph sync` 或去掉 --skip-index 全量 index。"
        )

    log(
        f"跳过 index — 使用已有 .homegraph/ "
        f"({status.get('fileCount', '?')} files, {status.get('nodeCount', '?')} nodes)"
    )
    out = _index_result(True, "skip", 0, "", status)
    out["homegraph_index_skipped"] = True
    return out


def _index_result(success: bool, command: str, ms: int, error: str,
                  status: Optional[dict] = None) -> dict:
    out = {
        "homegraph_index_ms": ms,
        "homegraph_index_success": success,
        "homegraph_index_command": command,
        "homegraph_index_skipped": False,
        "homegraph_index_error": error,
    }
    if status:
        out["homegraph_file_count"] = status.get("fileCount", 0)
        out["homegraph_node_count"] = status.get("nodeCount", 0)
        kinds = status.get("nodesByKind") or {}
        out["homegraph_arkts_nodes"] = kinds.get("struct", 0) + kinds.get("component", 0)
    return out


def analyze_homegraph_stream(stream_path: Path) -> dict:
    """Count HomeGraph MCP calls and how many returned usable graph data."""
    result = {
        "homegraph_calls": 0,
        "homegraph_effective_calls": 0,
        "homegraph_failed_calls": 0,
        "homegraph_failure_snippets": [],
    }
    if not stream_path.exists():
        return result

    import json
    for line in stream_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "tool_use":
            continue
        part = event.get("part") or {}
        tool = part.get("tool", "")
        if not is_homegraph_tool(tool):
            continue
        result["homegraph_calls"] += 1
        state = part.get("state") or {}
        output = str(state.get("output") or "")
        failed = any(m in output for m in _HG_FAILURE_MARKERS)
        if failed:
            result["homegraph_failed_calls"] += 1
            snippet = output.split("\n", 1)[0][:120]
            if snippet and snippet not in result["homegraph_failure_snippets"]:
                result["homegraph_failure_snippets"].append(snippet)
        else:
            result["homegraph_effective_calls"] += 1
    return result
