#!/usr/bin/env python3
"""Run a single one-shot experiment. Supports multiple agents via --agent."""

import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import setup as setup_mod
from _utils import (OUTPUT_DIR, append_run_log, build_agent_cmd, current_time_ms,
                    error, find_experiment, get_agent, info, header,
                    parse_output, resolve_agent_model, run_monitored_subprocess,
                    warn, write_json)


def run_experiment(exp_id: str, skip_permissions: bool = True,
                   agent_name: str = "",
                   results_dir: Optional[Path] = None,
                   state_dir: Optional[Path] = None) -> bool:
    exp = find_experiment(exp_id)
    if exp is None:
        error(f"Experiment {exp_id} not found in config")
        return False
    if exp.get("type") == "session":
        error(f"Experiment {exp_id} is session type. Use run_session.py.")
        return False

    agent = get_agent(agent_name)
    clone_path = os.environ.get("REPO_CLONE", "")
    local_repo = os.environ.get("REPO_PATH", "")
    if clone_path:
        repo_root = Path(clone_path)
    elif local_repo:
        repo_root = Path(local_repo)
    else:
        error("No repo. Use run_all.py to clone, or set REPO_PATH / REPO_CLONE.")
        return False

    title = exp["title"]
    prompt = exp["prompt"]
    max_turns = exp.get("max_turns", 15)

    header(f"Experiment {exp_id}: {title}")
    info(f"Agent: {agent['name']} ({agent['binary']}) | Repo: {repo_root}")
    info(f"Max turns: {max_turns} | Permissions: {'skip' if skip_permissions else 'ask'}")

    session_id, _ = setup_mod.prepare_environment(exp_id, "full", agent_name,
                                                    state_dir=state_dir)

    result_dir = results_dir / exp_id if results_dir else OUTPUT_DIR / exp_id
    result_dir.mkdir(parents=True, exist_ok=True)
    (result_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
    write_json(result_dir / "experiment_config.json", {**exp, "agent": agent_name or "default"})

    info("Starting agent...")
    start_ms = current_time_ms()
    os.chdir(repo_root)

    cmd = build_agent_cmd(agent, session_id, max_turns, prompt,
                          resume=False, skip_permissions=skip_permissions)

    stream_path = result_dir / "stream_output.jsonl"
    text_path = result_dir / "raw_output.txt"
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
    info(f"Completed in {dur_s}s (exit={exit_code})")

    # Parse agent output
    parser_name = agent.get("parser", "claude_stream_json")
    stats = parse_output(stream_path, parser_name)

    if exit_code != 0:
        error(f"Agent 退出码 {exit_code}")
        for err in stats.errors[:3]:
            error(f"  {err}")
        if "Unexpected server error" in " ".join(stats.errors):
            warn("DevEco 服务端报错 — 通常为 API/网络/配额问题，与评测脚本无关。"
                 "请检查 DevEco 登录状态、模型配置，稍后重试 `deveco run`。")
        elif stats.tool_calls == 0 and not stats.errors:
            warn("无工具调用且无错误事件 — 检查 stream_output.jsonl 是否为空。")

    # Human-readable text
    text_content = "\n".join(stats.text_lines)
    text_path.write_text(text_content or "(no text output)", encoding="utf-8")

    # Modified files
    r2 = subprocess.run(["git", "diff", "--name-only"], capture_output=True, text=True, cwd=repo_root)
    mod_files = len([l for l in r2.stdout.strip().split("\n") if l])

    results = {
        "experiment_id": exp_id, "title": title, "agent": agent["name"],
        "agent_binary": agent["binary"], "session_id": session_id,
        "start_time_ms": start_ms, "end_time_ms": end_ms,
        "duration_ms": dur_ms, "duration_s": dur_s,
        "exit_code": exit_code, "max_turns": max_turns,
        "skip_permissions": skip_permissions,
        "tool_calls": stats.tool_calls, "tool_names": stats.tool_names,
        "files_read": list(set(stats.files_read)),
        "files_edited": list(set(stats.files_edited)),
        "model": resolve_agent_model(agent, stats),
        "deveco_session_id": stats.deveco_session_id,
        "input_tokens": stats.total_input_tokens,
        "output_tokens": stats.total_output_tokens,
        "assistant_messages": stats.assistant_messages,
        "max_turns_hit": stats.max_turns_hit,
        "errors": stats.errors[:5],
        "modified_files": mod_files,
        "memory": mem.to_dict(),
    }
    write_json(result_dir / "results.json", results)

    if state_dir:
        append_run_log(state_dir, f"Exp {exp_id} finished in {dur_s}s, tools={stats.tool_calls}, exit={exit_code}")
    info(f"Results saved: {result_dir}/")
    print(f"  Duration: {dur_s}s | Tool calls: {stats.tool_calls} | "
          f"Files read: {len(set(stats.files_read))} | Edited: {mod_files} | "
          f"Peak mem: {mem.peak_combined_rss_mb:.0f} MB")
    if stats.max_turns_hit:
        print(f"  ⚠️  Max turns ({max_turns}) hit")
    return exit_code == 0


if __name__ == "__main__":
    # Parse: python run_one.py <id> [--agent <name>] [--no-skip-permissions]
    args = sys.argv[1:]
    exp_id = args[0] if args else ""
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

    if not exp_id:
        error("Usage: python run_one.py <experiment_id> [--agent <name>]")
        sys.exit(1)
    sys.exit(0 if run_experiment(exp_id, skip, agent_name) else 1)
