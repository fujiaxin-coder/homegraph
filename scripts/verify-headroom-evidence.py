"""Offline compatibility check against an existing external Headroom adapter.

Does not install Headroom, modify codingeval or make provider requests.
Run evidence-pack-smoke.cjs first to create the synthetic MCP response.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, default=Path("validation/evidence-smoke.json"))
    parser.add_argument("--result-key", default="packs")
    parser.add_argument("--output", type=Path, default=Path("validation/headroom-compatibility.json"))
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("headroom_adapter", args.adapter)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    record = json.loads(args.evidence.read_text())
    source = record["results"][args.result_key]["content"][0]["text"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    worker = module.Worker(args.python, args.tokenizer, args.output.parent / "headroom-worker.stderr.log")
    try:
        compressor = module.Compressor(mode="on", worker=worker, timeout_ms=250)
        calls = [{"id": name, "type": "function", "function": {"name": tool, "arguments": "{}"}}
                 for name, tool in [("evidence", "homegraph_explore"), ("build", "build_project")]]
        payload = {"messages": [
            {"role": "user", "content": "Trace the button callback and its conditional state update."},
            {"role": "assistant", "content": None, "tool_calls": calls},
            {"role": "tool", "tool_call_id": "evidence", "content": source},
            {"role": "tool", "tool_call_id": "build", "content":
             "WARN: synthetic repeated compiler diagnostic\n" * 120 + "BUILD SUCCESS\n"},
        ]}
        transformed, meta, _ = compressor.apply(payload, "synthetic_evidence_packs", "agent")
        assert transformed["messages"][2]["content"] == source, "Evidence body changed"
        assert any(row.get("accepted") and row.get("roundtrip") for row in meta["items"]), meta
        assert meta["applied_saved_tokens"] > 0, meta
        result = {"scope": "Local compatibility smoke, not a codingeval or model latency measurement",
                  "headroom": worker.info, "evidence_byte_preserved": True,
                  "evidence_sha256": hashlib.sha256(source.encode()).hexdigest(), "compression": meta}
        args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(result, ensure_ascii=False))
    finally:
        worker.close()


if __name__ == "__main__":
    main()
