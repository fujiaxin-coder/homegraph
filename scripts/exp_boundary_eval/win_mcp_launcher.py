#!/usr/bin/env python3
"""Windows MCP entry: pythonw (no window) → hidden node child; stdio inherited from DevEco."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

# Applied here so MCP works even if DevEco ignores deveco.jsonc "environment".
_MCP_ENV_DEFAULTS = {
    "HOMEGRAPH_NO_DAEMON": "1",
    "HOMEGRAPH_NO_WATCHDOG": "1",
    "HOMEGRAPH_WASM_RELAUNCHED": "1",
}


def _resolve_node() -> str:
    env_node = os.environ.get("HOMEGRAPH_NODE", "").strip()
    if env_node:
        return env_node
    found = shutil.which("node")
    if not found:
        print("node not found on PATH", file=sys.stderr)
        sys.exit(127)
    return found


def _node_argv(raw: list[str]) -> list[str]:
    """Ensure --liftoff-only is on the node command line (before homegraph.js)."""
    node = _resolve_node()
    args = list(raw)
    if "--liftoff-only" not in args:
        args.insert(0, "--liftoff-only")
    return [node, *args]


def _hidden_call(argv: list[str], env: dict) -> int:
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0
    return subprocess.call(
        argv,
        env=env,
        stdin=sys.stdin,
        stdout=sys.stdout,
        stderr=sys.stderr,
        creationflags=_CREATE_NO_WINDOW,
        startupinfo=si,
    )


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: win_mcp_launcher.py [--liftoff-only] [--stack-size=N] homegraph.js …",
            file=sys.stderr,
        )
        return 2
    env = os.environ.copy()
    for key, val in _MCP_ENV_DEFAULTS.items():
        env.setdefault(key, val)
    argv = _node_argv(sys.argv[1:])
    if os.name == "nt":
        return _hidden_call(argv, env)
    return subprocess.call(argv, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
