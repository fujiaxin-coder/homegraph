import subprocess
import sys

print("middle start", file=sys.stderr, flush=True)
rc = subprocess.call(
    [sys.executable, "-c", "import sys; print('child got stdin', sys.stdin.read(10)); sys.exit(0)"],
)
print("middle rc", rc, file=sys.stderr, flush=True)
