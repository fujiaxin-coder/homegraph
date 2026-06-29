#!/usr/bin/env python3
"""Windows: run node without a console window; inherit stdio (MCP / homegraph CLI)."""

from __future__ import annotations

import os
import subprocess
import sys

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: win_node_launcher.py [--stack-size=N] script.js …", file=sys.stderr)
        return 2
    node = os.environ.get("HOMEGRAPH_NODE", "node")
    cmd = [node, *sys.argv[1:]]
    flags = _CREATE_NO_WINDOW if os.name == "nt" else 0
    return subprocess.call(cmd, creationflags=flags)


if __name__ == "__main__":
    raise SystemExit(main())
