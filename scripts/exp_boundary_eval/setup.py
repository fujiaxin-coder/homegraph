#!/usr/bin/env python3
"""Prepare a clean repo for an experiment run. Agent-aware."""

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

from _utils import (append_run_log, error, generate_session_id,
                    get_agent, get_agent_version, git_output, git_ok, log,
                    shell_ok, verify_agent_binary, write_json)


def prepare_environment(exp_id: str, clean_mode: str = "full",
                        agent_name: str = "",
                        state_dir: Optional[Path] = None) -> Tuple[str, str]:
    """Prepare repo. Returns (session_id, agent_name)."""
    clone_path = os.environ.get("REPO_CLONE", "")
    is_clone = bool(clone_path and Path(clone_path).is_dir())
    local_repo = os.environ.get("REPO_PATH", "")
    if is_clone:
        repo_root = Path(clone_path)
    elif local_repo and Path(local_repo).is_dir():
        repo_root = Path(local_repo)
    else:
        error("No repo available. Clone via run_all.py or set REPO_PATH / REPO_CLONE.")
        sys.exit(1)

    if state_dir is not None:
        _state_dir = state_dir
    else:
        from _utils import LOG_DIR
        _state_dir = LOG_DIR

    if is_clone:
        log(f"Using cloned repo: {repo_root}")
    else:
        log(f"Using local repo: {repo_root}")

    os.chdir(repo_root)

    # Agent config
    agent = get_agent(agent_name)
    binary = agent["binary"]

    # Step 1: Clean repo
    if clean_mode == "full":
        log("Restoring repo to clean state...")
        branch = os.environ.get("BRANCH", "weekly_20260601")
        shell_ok(f"git checkout {branch}")
        git_ok(["checkout", "."], cwd=repo_root)
        if is_clone:
            git_ok(["clean", "-fd"], cwd=repo_root)
        else:
            git_ok(["clean", "-fd"], cwd=repo_root)

        current_branch = git_output(["branch", "--show-current"], cwd=repo_root)
        commit = git_output(["rev-parse", "--short", "HEAD"], cwd=repo_root)
        log(f"Branch: {current_branch} | Commit: {commit}")

    # Step 2: Clear CLAUDE.md
    claude_md = repo_root / "CLAUDE.md"
    if claude_md.exists() and claude_md.stat().st_size > 0:
        backup_dir = _state_dir / "claude_md_backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"CLAUDE.md.{ts}"
        backup_path.write_text(claude_md.read_text())
        log(f"Backed up CLAUDE.md → {backup_path}")
    with open(claude_md, "w") as f:
        f.write("")
    log("Cleared CLAUDE.md")

    for f in [".cursorrules", ".cursor/rules"]:
        p = repo_root / f
        if p.exists():
            p.unlink()

    # Step 3: Session ID
    session_id = generate_session_id()
    (_state_dir / f"session_{exp_id}.txt").write_text(session_id)
    log(f"Session ID: {session_id}")

    # Step 4: Verify agent binary
    ok, resolved, err_msg = verify_agent_binary(agent)
    if not ok:
        error(err_msg)
        sys.exit(1)
    binary = resolved
    agent_ver = get_agent_version(agent)
    log(f"Agent: {agent['name']} ({binary}) v{agent_ver}")

    # Step 5: Record state
    write_json(_state_dir / exp_id / "state.json", {
        "experiment_id": exp_id, "session_id": session_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "clean_mode": clean_mode, "agent": agent["name"],
        "agent_version": agent_ver, "repo_root": str(repo_root),
        "git_branch": git_output(["branch", "--show-current"], cwd=repo_root),
        "git_commit": git_output(["rev-parse", "HEAD"], cwd=repo_root),
    })

    append_run_log(_state_dir, f"Setup complete for {exp_id}: session={session_id}, agent={agent['name']}")
    log("Setup complete.")
    return session_id, agent["name"]


if __name__ == "__main__":
    exp_id = sys.argv[1] if len(sys.argv) > 1 else "all"
    clean_mode = sys.argv[2] if len(sys.argv) > 2 else "full"
    agent_name = sys.argv[3] if len(sys.argv) > 3 else ""
    sid, _ = prepare_environment(exp_id, clean_mode, agent_name)
    print(sid)
