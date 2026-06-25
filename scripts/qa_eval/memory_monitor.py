"""Sample RSS for a process tree (Linux /proc). Used by qa_eval Agent runs."""

from __future__ import annotations

import os
import threading
import time
from statistics import mean


def _read_rss_kb(pid: int) -> int:
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
    for name in os.listdir("/proc"):
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


def process_tree_pids(root_pid: int) -> set[int]:
    if root_pid <= 0:
        return set()
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


def tree_rss_kb(root_pid: int) -> int:
    return sum(_read_rss_kb(pid) for pid in process_tree_pids(root_pid))


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
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._samples_kb.append(tree_rss_kb(self._root_pid))
            self._stop.wait(self.interval_sec)

    def stop(self) -> dict[str, float | None]:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        if not self._samples_kb:
            return {"peak_rss_mb": None, "avg_rss_mb": None}
        peak_kb = max(self._samples_kb)
        avg_kb = mean(self._samples_kb)
        return {
            "peak_rss_mb": round(peak_kb / 1024, 2),
            "avg_rss_mb": round(avg_kb / 1024, 2),
        }


from contextlib import contextmanager


@contextmanager
def sample_memory(root_pid: int | None = None):
    """Sample process-tree RSS while the wrapped block runs."""
    sampler = MemorySampler()
    pid = root_pid if root_pid is not None else os.getpid()
    sampler.start(pid)
    try:
        yield sampler
    finally:
        sampler.last_stats = sampler.stop()  # type: ignore[attr-defined]
