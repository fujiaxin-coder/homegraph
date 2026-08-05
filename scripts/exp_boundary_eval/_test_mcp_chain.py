#!/usr/bin/env python3
"""Quick stdio test for win_mcp_launcher chain."""
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

LAUNCHER = Path(__file__).with_name("win_mcp_launcher.py")
HG = Path(__file__).resolve().parents[2] / "dist" / "bin" / "homegraph.js"
REPO = Path(r"D:\code\applications_photos")


def run_chain(python: str) -> None:
    cmd = [
        python,
        str(LAUNCHER),
        "--liftoff-only",
        "--stack-size=32768",
        str(HG),
        "serve",
        "mcp",
        "--path",
        str(REPO),
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    req = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        },
    }
    proc.stdin.write((json.dumps(req) + "\n").encode())
    proc.stdin.flush()

    chunks: list[bytes] = []

    def read_stdout() -> None:
        while True:
            block = proc.stdout.read(4096)
            if not block:
                break
            chunks.append(block)

    threading.Thread(target=read_stdout, daemon=True).start()
    time.sleep(20)
    alive = proc.poll() is None
    if alive:
        proc.kill()
        proc.wait(timeout=5)
    out = b"".join(chunks)
    err = proc.stderr.read()
    print(
        f"{Path(python).name}: alive={alive} rc={proc.returncode} "
        f"out={len(out)} err={len(err)} result={'result' in out.decode('utf-8', 'replace')}"
    )
    if err:
        print("  stderr:", err[:400].decode("utf-8", "replace"))
    if out:
        print("  stdout:", out[:200].decode("utf-8", "replace"))


if __name__ == "__main__":
    py_dir = Path(sys.executable).parent
    for name in ("python.exe", "pythonw.exe"):
        candidate = py_dir / name
        if candidate.is_file():
            run_chain(str(candidate))
