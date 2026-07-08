"""Sample RSS for a process tree. Linux uses /proc; other platforms use psutil."""

from __future__ import annotations

import os
import sys
import threading
from contextlib import contextmanager
from statistics import mean

try:
    import psutil

    _PSUTIL_AVAILABLE = True
except ImportError:
    psutil = None  # type: ignore[assignment]
    _PSUTIL_AVAILABLE = False

_PROC_AVAILABLE = sys.platform == "linux" and os.path.isdir("/proc")
_SAMPLING_AVAILABLE = _PROC_AVAILABLE or _PSUTIL_AVAILABLE


def memory_sampling_supported() -> bool:
    """True when process-tree RSS sampling is available."""
    return _SAMPLING_AVAILABLE


def _read_rss_kb_proc(pid: int) -> int:
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except OSError:
        return 0
    return 0


def _build_ppid_map() -> dict[int, list[int]]:
    children: dict[int, list[int]] = {}
    if not _PROC_AVAILABLE:
        return children
    try:
        proc_entries = os.listdir("/proc")
    except OSError:
        return children
    for name in proc_entries:
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
                stat = f.read()
            # comm may contain ')'; ppid follows closing paren + space
            after = stat.rsplit(")", 1)[1].split()
            ppid = int(after[1])
        except (OSError, IndexError, ValueError):
            continue
        children.setdefault(ppid, []).append(pid)
    return children


def _process_tree_pids_proc(root_pid: int) -> set[int]:
    children = _build_ppid_map()
    seen: set[int] = set()
    stack = [root_pid]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        stack.extend(children.get(pid, []))
    return seen


def _process_tree_pids_psutil(root_pid: int) -> set[int]:
    if not _PSUTIL_AVAILABLE or psutil is None:
        return set()
    try:
        root = psutil.Process(root_pid)
    except psutil.NoSuchProcess:
        return set()
    pids = {root_pid}
    for child in root.children(recursive=True):
        pids.add(child.pid)
    return pids


def process_tree_pids(root_pid: int) -> set[int]:
    if root_pid <= 0:
        return set()
    if _PROC_AVAILABLE:
        return _process_tree_pids_proc(root_pid)
    if _PSUTIL_AVAILABLE:
        return _process_tree_pids_psutil(root_pid)
    return set()


def _read_rss_kb_psutil(pid: int) -> int:
    if not _PSUTIL_AVAILABLE or psutil is None:
        return 0
    try:
        return psutil.Process(pid).memory_info().rss // 1024
    except psutil.NoSuchProcess:
        return 0


def tree_rss_kb(root_pid: int) -> int:
    if _PROC_AVAILABLE:
        return sum(_read_rss_kb_proc(pid) for pid in process_tree_pids(root_pid))
    if _PSUTIL_AVAILABLE:
        return sum(_read_rss_kb_psutil(pid) for pid in process_tree_pids(root_pid))
    return 0


class MemorySampler:
    """Background RSS sampler for root_pid and its descendants."""

    def __init__(self, interval_sec: float = 0.25) -> None:
        self.interval_sec = interval_sec
        self._root_pid = os.getpid()
        self._samples_kb: list[int] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, root_pid: int | None = None) -> None:
        self._root_pid = root_pid if root_pid is not None else os.getpid()
        self._samples_kb = []
        self._stop.clear()
        if not _SAMPLING_AVAILABLE:
            self._thread = None
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._samples_kb.append(tree_rss_kb(self._root_pid))
            except OSError:
                break
            self._stop.wait(self.interval_sec)

    @property
    def last_stats(self) -> dict[str, float | None]:
        """Peak/avg RSS so far (safe to read while sampling is active)."""
        if not self._samples_kb:
            return {"peak_rss_mb": None, "avg_rss_mb": None}
        peak_kb = max(self._samples_kb)
        avg_kb = mean(self._samples_kb)
        return {
            "peak_rss_mb": round(peak_kb / 1024, 2),
            "avg_rss_mb": round(avg_kb / 1024, 2),
        }

    def stop(self) -> dict[str, float | None]:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        return self.last_stats


@contextmanager
def sample_memory(root_pid: int | None = None):
    """Sample process-tree RSS while the wrapped block runs."""
    sampler = MemorySampler()
    pid = root_pid if root_pid is not None else os.getpid()
    sampler.start(pid)
    try:
        yield sampler
    finally:
        sampler.stop()
