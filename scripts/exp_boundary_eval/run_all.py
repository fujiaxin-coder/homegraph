#!/usr/bin/env python3
"""
Run boundary-eval experiments sequentially. Multi-agent + HomeGraph A/B arm support.

Usage:
    python run_all.py --both-arms --agent deveco     # 一条命令跑 baseline + homegraph
    python run_all.py --agent deveco --arm homegraph
    python run_all.py --agent deveco --arm baseline
    python run_all.py 1-1 1-2 1-3
    python run_all.py --repo-path /path/to/photos
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple

import run_one
import run_session
import analyze
from _utils import (DATA_DIR, EVAL_ROOT, LOG_DIR, OUTPUT_DIR, GREEN, NC, append_run_log,
                    current_time_ms, create_output_dirs, error, get_agent, header,
                    info, load_config, log, verify_agent_binary, warn)

DEFAULT_EXPERIMENTS = ["1-1", "1-2", "1-3"]
SHARED_CLONE_DIR = DATA_DIR / "clone"


def clone_repo(url: str, branch: str, clone_dir: Path) -> bool:
    clone_dir = Path(clone_dir)
    if (clone_dir / ".git").is_dir():
        log(f"Clone exists, updating: {clone_dir}")
        subprocess.run(["git", "fetch", "origin", branch], cwd=clone_dir, capture_output=True, text=True)
        subprocess.run(["git", "checkout", branch], cwd=clone_dir, capture_output=True, text=True)
        subprocess.run(["git", "reset", "--hard", f"origin/{branch}"], cwd=clone_dir, capture_output=True, text=True)
        return True
    log(f"Cloning {url} (branch: {branch})...")
    if clone_dir.exists():
        shutil.rmtree(clone_dir)
    clone_dir.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", branch, url, str(clone_dir)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        error(f"Clone failed: {r.stderr}")
        return False
    r2 = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=clone_dir)
    log(f"Clone complete: {r2.stdout.strip()}")
    return True


def reset_clone(clone_dir: Path, branch: str):
    subprocess.run(["git", "checkout", branch], cwd=clone_dir, capture_output=True, text=True)
    subprocess.run(["git", "checkout", "."], cwd=clone_dir, capture_output=True, text=True)
    subprocess.run(["git", "clean", "-fd"], cwd=clone_dir, capture_output=True, text=True)


def reset_local(work_dir: Path):
    subprocess.run(["git", "checkout", "."], cwd=work_dir, capture_output=True, text=True)
    subprocess.run(["git", "clean", "-fd"], cwd=work_dir, capture_output=True, text=True)


def ensure_homegraph_index(repo_root: Path, arm: str) -> dict:
    """Index repo when running the homegraph arm. Returns timing metadata."""
    if arm != "homegraph":
        return {"homegraph_index_ms": 0, "homegraph_index_success": None}
    hg_root = EVAL_ROOT.parents[1]
    hg_bin = hg_root / "dist" / "bin" / "homegraph.js"
    if not hg_bin.exists():
        warn(f"homegraph binary not found at {hg_bin}; run npm run build first")
        return {"homegraph_index_ms": 0, "homegraph_index_success": False}
    log(f"Indexing {repo_root} for homegraph arm...")
    start_ms = current_time_ms()
    r = subprocess.run(
        ["node", str(hg_bin), "init", "-i", "--path", str(repo_root)],
        capture_output=True, text=True,
    )
    index_ms = current_time_ms() - start_ms
    success = r.returncode == 0
    if not success:
        warn(f"homegraph init failed: {r.stderr or r.stdout}")
    else:
        log(f"homegraph index ready ({index_ms / 1000:.1f}s)")
    return {"homegraph_index_ms": index_ms, "homegraph_index_success": success}


def write_run_manifest(state_dir: Path, results_dir: Path, meta: dict):
    manifest = {
        **meta,
        "results_dir": str(results_dir),
        "state_dir": str(state_dir),
    }
    for d in (state_dir, results_dir):
        d.mkdir(parents=True, exist_ok=True)
        (d / "run_manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
        )


def resolve_work_dir(args, state_dir: Path) -> Tuple[Path, Optional[Path], bool]:
    """Return (work_dir, ephemeral_clone_dir_or_none, owns_ephemeral_clone)."""
    if args.repo_path:
        work_dir = Path(args.repo_path).resolve()
        if not (work_dir / ".git").is_dir():
            error(f"--repo-path 不是 git 仓库: {work_dir}")
            sys.exit(1)
        os.environ["REPO_PATH"] = str(work_dir)
        os.environ.pop("REPO_CLONE", None)
        log(f"使用本地仓库: {work_dir}")
        return work_dir, None, False

    if args.both_arms:
        clone_dir = SHARED_CLONE_DIR
        if not clone_repo(args.repo_url, args.branch, clone_dir):
            error("Clone 失败。请检查网络，或改用 --repo-path。")
            sys.exit(1)
        os.environ["REPO_PATH"] = str(clone_dir)
        os.environ.pop("REPO_CLONE", None)
        log(f"A/B 共用仓库: {clone_dir}")
        return clone_dir, None, False

    clone_dir = state_dir / "clone"
    if not clone_repo(args.repo_url, args.branch, clone_dir):
        error("Clone 失败。请改用 --repo-path 指定本地 checkout。")
        sys.exit(1)
    os.environ["REPO_CLONE"] = str(clone_dir)
    os.environ.pop("REPO_PATH", None)
    return clone_dir, clone_dir, True


def run_suite(args, arm: str) -> dict:
    """Run one arm (baseline or homegraph). Returns summary dict."""
    agent = get_agent(args.agent)
    skip_perms = not args.no_skip_permissions
    experiments = args.experiments or DEFAULT_EXPERIMENTS
    total = len(experiments)
    passed = 0
    failed = 0

    results_dir, state_dir = create_output_dirs(args.agent or "default", arm)
    work_dir, ephemeral_clone, owns_clone = resolve_work_dir(args, state_dir)

    index_meta = ensure_homegraph_index(work_dir, arm)

    write_run_manifest(state_dir, results_dir, {
        "arm": arm,
        "agent": agent["name"],
        "agent_key": args.agent,
        "branch": args.branch,
        "repo_url": args.repo_url,
        "repo_root": str(work_dir),
        "experiments": experiments,
        **index_meta,
    })
    append_run_log(state_dir, f"开始: arm={arm}, agent={agent['name']}, exps={experiments}")

    os.environ["EVAL_ARM"] = arm

    header(f"边界评测 — 档位切换 ({arm})")
    print(f"组别    : {arm}")
    print(f"Agent   : {agent['name']} ({agent['binary']})")
    print(f"仓库    : {work_dir}")
    print(f"分支    : {args.branch}")
    print(f"权限    : {'跳过确认' if skip_perms else '需确认'}")
    print(f"实验数  : {total}")
    print(f"输出    : {results_dir}")
    print(f"日志    : {state_dir}\n")

    overall_start = current_time_ms()

    for exp_id in experiments:
        header(f"实验 {exp_id}")
        append_run_log(state_dir, f"开始实验 {exp_id}")

        if ephemeral_clone:
            log("重置 clone 到干净状态...")
            reset_clone(ephemeral_clone, args.branch)
        else:
            log("重置本地仓库...")
            reset_local(work_dir)

        if exp_id == "5":
            ok = run_session.run_session("5", skip_perms, args.agent,
                                         results_dir=results_dir, state_dir=state_dir)
        else:
            ok = run_one.run_experiment(exp_id, skip_perms, args.agent,
                                        results_dir=results_dir, state_dir=state_dir)

        if ok:
            passed += 1
        else:
            failed += 1
            error(f"实验 {exp_id} 失败")
        print()

    overall_end = current_time_ms()
    duration = (overall_end - overall_start) // 1000

    append_run_log(state_dir, f"完成: passed={passed}, failed={failed}, duration_s={duration}")

    header(f"组别完成 — {arm}")
    print(f"  通过   : {passed} / {total}")
    print(f"  失败   : {failed} / {total}")
    print(f"  耗时   : {duration // 60}m {duration % 60}s")
    print(f"  输出   : {results_dir}")
    print(f"  日志   : {state_dir}")

    if owns_clone and ephemeral_clone and not args.keep_clone and ephemeral_clone.exists():
        warn(f"删除临时 clone: {ephemeral_clone}")
        shutil.rmtree(ephemeral_clone)

    return {
        "arm": arm,
        "results_dir": results_dir,
        "state_dir": state_dir,
        "passed": passed,
        "failed": failed,
        "duration_s": duration,
        "homegraph_index_ms": index_meta.get("homegraph_index_ms", 0),
    }


def _generate_reports(summaries: list, agent_key: str):
    """Run analyze.py logic after experiments; print report paths."""
    reports = []
    for s in summaries:
        try:
            path = analyze.analyze_run(s["results_dir"], verbose=False)
            reports.append((s["arm"], path))
        except ValueError as e:
            warn(f"分析 {s['arm']} 失败: {e}")

    compare_path = None
    if len(summaries) == 2 and len(reports) == 2:
        try:
            compare_path = analyze.compare_runs(
                summaries[0]["results_dir"],
                summaries[1]["results_dir"],
                agent=agent_key,
                baseline_wall_s=summaries[0]["duration_s"],
                homegraph_wall_s=summaries[1]["duration_s"],
                verbose=True,
            )
        except ValueError as e:
            warn(f"A/B 对比报告失败: {e}")

    baseline_report = next((p for arm, p in reports if arm == "baseline"), None)
    homegraph_report = next((p for arm, p in reports if arm == "homegraph"), None)
    single_report = reports[0][1] if len(reports) == 1 else None

    analyze.print_report_locations(
        baseline_report=baseline_report,
        homegraph_report=homegraph_report,
        compare_report=compare_path,
        single_report=single_report,
    )
    return reports, compare_path


def main():
    analyze._configure_stdout()
    cfg = load_config()
    meta = cfg.get("meta", {})

    parser = argparse.ArgumentParser(description="HomeGraph 档位切换边界评测")
    parser.add_argument("--agent", default=os.environ.get("EVAL_AGENT", "deveco"),
                        help="Agent：claude / cursor / codex / opencode / deveco")
    parser.add_argument("--arm", default=os.environ.get("EVAL_ARM", "baseline"),
                        choices=["baseline", "homegraph"],
                        help="baseline=不带 HomeGraph；homegraph=带 HomeGraph")
    parser.add_argument("--both-arms", action="store_true",
                        help="一条命令依次跑 baseline 和 homegraph 两组 A/B")
    parser.add_argument("--repo-path", default=os.environ.get("REPO_PATH", ""),
                        help="使用已有本地 clone，跳过 git clone")
    parser.add_argument("--keep-clone", action="store_true")
    parser.add_argument("--no-skip-permissions", action="store_true")
    parser.add_argument("--branch", default=os.environ.get("BRANCH", meta.get("default_branch", "weekly_20260601")))
    parser.add_argument("--repo-url", default=os.environ.get("REPO_URL", meta.get("repo_url", "")))
    parser.add_argument("experiments", nargs="*")
    args = parser.parse_args()

    if not args.experiments:
        args.experiments = DEFAULT_EXPERIMENTS

    agent = get_agent(args.agent)
    ok, resolved, err_msg = verify_agent_binary(agent)
    if not ok:
        error(err_msg)
        sys.exit(1)
    log(f"Agent CLI: {resolved}")

    if args.both_arms and args.arm != "baseline":
        warn("--both-arms 已指定，忽略 --arm")

    if args.both_arms:
        summaries = []
        for arm in ("baseline", "homegraph"):
            print(f"\n{'=' * 60}\n  开始 {arm} 组\n{'=' * 60}\n")
            summaries.append(run_suite(args, arm))

        header("A/B 全部完成")
        for s in summaries:
            print(f"  [{s['arm']}] 通过 {s['passed']}，失败 {s['failed']}，"
                  f"耗时 {s['duration_s'] // 60}m{s['duration_s'] % 60}s")
            print(f"         输出 → {s['results_dir']}")
        _generate_reports(summaries, args.agent or "default")
        sys.exit(0 if all(s["failed"] == 0 for s in summaries) else 1)

    summary = run_suite(args, args.arm)
    _generate_reports([summary], args.agent or "default")
    sys.exit(0 if summary["failed"] == 0 else 1)


if __name__ == "__main__":
    main()
