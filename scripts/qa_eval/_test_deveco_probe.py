#!/usr/bin/env python3
"""One-off probe: parser + single run_deveco_query. Run from repo root."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from external_agent import DEFAULT_DEVECO_MODEL, parse_opencode_json_events, run_deveco_query

SAMPLE = (
    '{"type":"step_start","part":{"type":"step-start"}}\n'
    '{"type":"text","part":{"type":"text","text":"\\nOK"}}\n'
)

def main() -> int:
    parsed = parse_opencode_json_events(SAMPLE)
    assert parsed["agent_status"] == "success" and "OK" in parsed["output_answer"], parsed
    print("parser OK:", parsed["output_answer"])

    repo = Path(r"D:\code\benchmark")
    if not repo.is_dir():
        print("skip run: benchmark repo missing")
        return 0

    print(f"probing run_deveco_query (model={DEFAULT_DEVECO_MODEL}, timeout=90s)...")
    r = run_deveco_query(
        repo,
        "reply OK only",
        arm="with",
        hg_bin=None,
        log_file=None,
        task_id=0,
        timeout_sec=90,
    )
    print("status:", r.get("agent_status"))
    print("error:", r.get("agent_error"))
    print("answer:", (r.get("output_answer") or "")[:200])
    return 0 if r.get("agent_status") == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
