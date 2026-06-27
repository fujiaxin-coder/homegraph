#!/usr/bin/env python3
"""Run multi-turn session experiment (5). Supports multiple agents via --agent."""

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import setup as setup_mod
from _utils import (OUTPUT_DIR, append_run_log, build_agent_cmd,
                    current_time_ms, find_experiment, get_agent, info, header,
                    log, parse_output, resolve_agent_model, run_monitored_subprocess,
                    write_json, warn)


def run_session(exp_id: str = "5", skip_permissions: bool = True,
                agent_name: str = "",
                results_dir: Optional[Path] = None,
                state_dir: Optional[Path] = None) -> bool:
    exp = find_experiment(exp_id)
    if exp is None:
        print(f"ERROR: Experiment {exp_id} not found")
        return False

    agent = get_agent(agent_name)
    clone_path = os.environ.get("REPO_CLONE", "")
    local_repo = os.environ.get("REPO_PATH", "")
    if clone_path:
        repo_root = Path(clone_path)
    elif local_repo:
        repo_root = Path(local_repo)
    else:
        print("ERROR: No repo. Use run_all.py to clone, or set REPO_PATH / REPO_CLONE.")
        return False
    max_turns = exp.get("max_turns_per_round", 25)

    header("Experiment 5: Session Persistence & Context Decay")
    info(f"Agent: {agent['name']} ({agent['binary']}) | Repo: {repo_root}")
    info(f"Max turns/round: {max_turns} | Permissions: {'skip' if skip_permissions else 'ask'}")

    session_id, _ = setup_mod.prepare_environment("5", "full", agent_name,
                                                    state_dir=state_dir)
    log(f"Shared Session ID: {session_id}")

    result_dir = results_dir / "5" if results_dir else OUTPUT_DIR / "5"
    result_dir.mkdir(parents=True, exist_ok=True)

    rounds_data = []
    session_model = ""
    deveco_session_id = ""
    for round_num in range(1, 6):
        ri = next((r for r in exp["rounds"] if r["round"] == round_num), None)
        if not ri: continue

        header(f"Round {round_num} of 5")
        info(f"Title: {ri['title']}")

        round_dir = result_dir / f"round_{round_num}"
        round_dir.mkdir(parents=True, exist_ok=True)
        (round_dir / "prompt.txt").write_text(ri["prompt"], encoding="utf-8")

        start_ms = current_time_ms()
        is_resume = round_num > 1

        cmd = build_agent_cmd(agent, session_id, max_turns, ri["prompt"],
                              resume=is_resume, skip_permissions=skip_permissions)

        stream_path = round_dir / "stream_output.jsonl"
        text_path = round_dir / "raw_output.txt"
        track_hg = os.environ.get("EVAL_ARM", "") == "homegraph"

        with open(stream_path, "w", encoding="utf-8") as stream_f:
            result, mem = run_monitored_subprocess(
                cmd, stdout=stream_f, stderr=subprocess.STDOUT, text=True,
                track_homegraph=track_hg,
            )
        exit_code = result.returncode

        end_ms = current_time_ms()
        dur_ms = end_ms - start_ms
        dur_s = f"{dur_ms / 1000:.1f}"

        parser_name = agent.get("parser", "claude_stream_json")
        stats = parse_output(stream_path, parser_name)
        if not session_model:
            session_model = resolve_agent_model(agent, stats)
        if not deveco_session_id and stats.deveco_session_id:
            deveco_session_id = stats.deveco_session_id

        text_content = "\n".join(stats.text_lines)
        text_path.write_text(text_content or "(no text output)", encoding="utf-8")

        r2 = subprocess.run(["git", "diff", "--name-only"], capture_output=True, text=True, cwd=repo_root)
        mod_files = len([l for l in r2.stdout.strip().split("\n") if l])

        rr = {"round": round_num, "title": ri["title"], "duration_ms": dur_ms,
              "duration_s": dur_s, "exit_code": exit_code,
              "tool_calls": stats.tool_calls, "tool_names": stats.tool_names,
              "files_read": list(set(stats.files_read)),
              "files_edited": list(set(stats.files_edited)),
              "assistant_messages": stats.assistant_messages,
              "max_turns_hit": stats.max_turns_hit,
              "modified_files": mod_files, "max_turns": max_turns,
              "memory": mem.to_dict()}
        write_json(round_dir / "round_results.json", rr)
        rounds_data.append(rr)

        info(f"Round {round_num} done: {dur_s}s | Tool calls: {stats.tool_calls} | "
             f"Files read: {len(set(stats.files_read))} | Edited: {mod_files}")
        if stats.max_turns_hit:
            warn(f"  Max turns ({max_turns}) hit in round {round_num}")
        if round_num < 5:
            time.sleep(2)

    summary = {
        "experiment_id": "5", "session_id": session_id, "agent": agent["name"],
        "model": session_model,
        "deveco_session_id": deveco_session_id,
        "total_rounds": len(rounds_data),
        "total_duration_ms": sum(r["duration_ms"] for r in rounds_data),
        "total_tool_calls": sum(int(r["tool_calls"]) for r in rounds_data),
        "memory_retention_curve": [
            {"round": r["round"], "tool_calls": int(r["tool_calls"]),
             "files_read": r.get("files_read", [])} for r in rounds_data
        ],
    }
    write_json(result_dir / "session_results.json", summary)

    print("\nMemory Retention Curve:")
    for r in rounds_data:
        tc = int(r["tool_calls"])
        fr = len(r.get("files_read", []))
        print(f"  Round {r['round']}: {'#' * (tc // 2)} ({tc} tool calls, {fr} files read)")

    log(f"Results: {result_dir}/session_results.json")
    return True


if __name__ == "__main__":
    args = sys.argv[1:]
    exp_id = args[0] if args else "5"
    agent_name = ""
    skip = True
    i = 1
    while i < len(args):
        if args[i] == "--agent" and i + 1 < len(args):
            agent_name = args[i + 1]; i += 2
        elif args[i] == "--no-skip-permissions":
            skip = False; i += 1
        else:
            i += 1
    sys.exit(0 if run_session(exp_id, skip, agent_name) else 1)
