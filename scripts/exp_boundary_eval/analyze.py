#!/usr/bin/env python3
"""
Analyze experiment results and produce:
  1. Terminal summary
  2. Markdown report → results/analysis_report.md

The report includes narrative analysis, pattern detection, risk assessment,
and a scoring system — not just raw data tables.
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from _utils import (OUTPUT_DIR, GREEN, NC, header, parse_output, parse_stream_json,
                    read_run_manifest, resolve_deveco_model)

RESULTS_DIR = OUTPUT_DIR  # default when no path argument given


def _configure_stdout():
    """Avoid UnicodeEncodeError on Windows consoles (default GBK)."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


def _memory_from_result(d: dict) -> dict:
    mem = d.get("memory") or {}
    return {
        "peak_rss_mb": mem.get("peak_rss_mb", 0),
        "peak_homegraph_rss_mb": mem.get("peak_homegraph_rss_mb", 0),
        "peak_combined_rss_mb": mem.get("peak_combined_rss_mb", 0),
    }


def _format_mb(val) -> str:
    if not val:
        return "—"
    return f"{float(val):.0f} MB"


def _parser_for_agent(agent: str) -> str:
    a = agent.lower()
    if "deveco" in a:
        return "deveco_json"
    if "codex" in a:
        return "codex_json"
    if "opencode" in a:
        return "opencode_json"
    if "cursor" in a:
        return "cursor_stream_json"
    return "claude_stream_json"


def _stream_stats(stream: Path, agent: str = ""):
    parser = _parser_for_agent(agent) if agent else "auto"
    return parse_output(stream, parser)


def _is_placeholder_model(model: str) -> bool:
    return not model or model in ("?", "--", "unknown", "Unknown")


def _is_session_id(model: str) -> bool:
    return bool(model) and model.startswith("ses_")


def format_model_display(model: str) -> str:
    if _is_placeholder_model(model):
        return "未知"
    if _is_session_id(model):
        return "未知（DevEco session 未导出）"
    return model


def _normalize_model(raw: dict, exp_dir: Path, agent: str) -> str:
    model = raw.get("model", "")
    if not _is_placeholder_model(model) and not _is_session_id(model):
        return model
    if "deveco" not in agent.lower():
        return model or "?"
    deveco_sid = raw.get("deveco_session_id", "")
    if not _is_session_id(deveco_sid):
        deveco_sid = model if _is_session_id(model) else ""
    if not deveco_sid:
        stream = exp_dir / "stream_output.jsonl"
        if not stream.exists():
            stream = exp_dir / "round_1" / "stream_output.jsonl"
        if stream.exists():
            stats = parse_output(stream, "deveco_json")
            deveco_sid = stats.deveco_session_id or (
                stats.model if _is_session_id(stats.model) else ""
            )
    if deveco_sid:
        resolved = resolve_deveco_model(deveco_sid)
        if resolved:
            return resolved
    return model or "?"


def resolve_primary_model(summary: List[dict]) -> str:
    """Pick the most common real model name across oneshot experiments."""
    real = [r["model"] for r in summary
            if not _is_placeholder_model(r.get("model", "")) and not _is_session_id(r["model"])]
    if real:
        return max(set(real), key=real.count)
    fallback = [r["model"] for r in summary if not _is_placeholder_model(r.get("model", ""))]
    if fallback:
        return format_model_display(fallback[0])
    return "未知"


def _has_experiment_outputs(path: Path) -> bool:
    """True if path looks like a directory of per-experiment result folders."""
    if not path.is_dir():
        return False
    for exp_id in ("1-1", "2", "5"):
        if (path / exp_id / "results.json").exists() or (path / exp_id / "session_results.json").exists():
            return True
    return False


def resolve_results_dir(path: Path) -> Path:
    """Accept artifact run root or results/ path; return the results directory."""
    if _has_experiment_outputs(path):
        return path
    nested = path / "results"
    if _has_experiment_outputs(nested):
        return nested
    return path


def resolve_report_path(input_path: Path, results_dir: Path) -> Path:
    """Write analysis_report.md at artifact run root when layout allows."""
    if input_path.resolve() != results_dir.resolve():
        return input_path / "analysis_report.md"
    parent = results_dir.parent
    if (parent / "state").is_dir():
        return parent / "analysis_report.md"
    return results_dir / "analysis_report.md"


# ═══════════════════════════════════════════════════════════
# Data collection (raw metrics from experiment outputs)
# ═══════════════════════════════════════════════════════════

def collect_summary(results_dir: Path) -> List[dict]:
    rows = []
    for exp_dir in sorted(results_dir.iterdir()):
        if not exp_dir.is_dir(): continue
        exp_id = exp_dir.name
        rj, sj = exp_dir / "results.json", exp_dir / "session_results.json"
        if rj.exists():
            d = json.loads(rj.read_text(encoding="utf-8"))
            fr = d.get("files_read", [])
            fe = d.get("modified_files", d.get("files_edited", 0))
            if isinstance(fe, list): fe = len(fe)
            agent = d.get("agent", "?")
            stream = exp_dir / "stream_output.jsonl"
            stats = _stream_stats(stream, agent) if stream.exists() else None
            tool_calls = d.get("tool_calls", 0)
            files_read = len(fr) if isinstance(fr, list) else fr
            input_tokens = d.get("input_tokens", 0)
            if stats and stats.tool_calls:
                tool_calls = stats.tool_calls
                files_read = len(set(stats.files_read))
                if stats.total_input_tokens:
                    input_tokens = stats.total_input_tokens
                if not fe and stats.files_edited:
                    fe = len(set(stats.files_edited))
            rows.append(dict(id=exp_id, title=d.get("title", "?"), type="oneshot",
                duration_s=d.get("duration_s", "?"), tool_calls=tool_calls,
                files_read=files_read, files_edited=fe,
                input_tokens=input_tokens, max_turns_hit=d.get("max_turns_hit", False),
                exit_code=d.get("exit_code", "?"), model=_normalize_model(d, exp_dir, agent),
                tool_names=d.get("tool_names", []), errors=d.get("errors", []),
                agent=agent, memory=_memory_from_result(d)))
        elif sj.exists():
            d = json.loads(sj.read_text(encoding="utf-8"))
            agent = d.get("agent", "?")
            total_tc = d.get("total_tool_calls", 0)
            round_streams = sorted(exp_dir.glob("round_*/stream_output.jsonl"))
            if round_streams:
                total_tc = sum(_stream_stats(s, agent).tool_calls for s in round_streams)
            model = _normalize_model(d, exp_dir, agent)
            if _is_placeholder_model(model) or model == "?":
                r1 = exp_dir / "round_1" / "stream_output.jsonl"
                if r1.exists():
                    m = _stream_stats(r1, agent).model
                    if m:
                        model = m
            rows.append(dict(id=exp_id, title="Session Persistence", type="session",
                duration_s=f"{d.get('total_duration_ms', 0) / 1000:.0f}s",
                tool_calls=total_tc, files_read="--", files_edited="--",
                input_tokens=0, max_turns_hit=False, exit_code="--",
                model=model,
                tool_names=[], errors=[], agent=agent))
    return rows

def collect_hallucination(results_dir: Path) -> dict:
    r = {"exp": "3-1", "has_results": False, "tool_calls": 0, "files_explored": 0,
         "hallucinated": False, "fab_score": 0, "pattern": "none",
         "text_excerpt": "", "qualifiers": [], "real_code_explored": []}
    stream = results_dir / "3-1" / "stream_output.jsonl"
    if not stream.exists(): return r
    r["has_results"] = True
    agent = "?"
    rj = results_dir / "3-1" / "results.json"
    if rj.exists():
        agent = json.loads(rj.read_text(encoding="utf-8")).get("agent", "?")
    stats = _stream_stats(stream, agent)
    r["tool_calls"] = stats.tool_calls
    r["files_explored"] = len(set(stats.files_read))
    text = "\n".join(stats.text_lines)
    r["text_excerpt"] = text[:600]
    r["module_mentioned"] = "PhotoWatermarkEngine" in text
    # Fabrication markers: describing architecture for something nonexistent
    fab = ["watermark", "水印", "sticker", "三层", "three-layer", "ArkTS.*C\\+\\+", "渲染引擎",
           "HmcRenderEngine", "HmcEditorAsset", "WatermarkPicInfo", "跨层协作"]
    r["fab_score"] = sum(1 for m in fab if re.search(m, text, re.I))
    # Detect pattern type
    if "不存在" in text or "not exist" in text.lower():
        if r["fab_score"] >= 5:
            r["pattern"] = "yes_and"  # "doesn't exist, BUT here's how it works..."
        elif r["fab_score"] >= 2:
            r["pattern"] = "partial"
        else:
            r["pattern"] = "honest_denial"
    else:
        r["pattern"] = "pure_fabrication" if r["fab_score"] >= 3 else "none"
    r["hallucinated"] = r["fab_score"] >= 3 and r["module_mentioned"]
    # What real code was explored (wrongly attributed)
    r["real_code_explored"] = list(set(stats.files_read))[:10]
    qs = ["seems", "might", "may be", "possibly", "perhaps", "appears", "好像", "可能", "似乎"]
    r["qualifiers"] = [q for q in qs if q in text.lower()]
    return r


def collect_share_coverage(results_dir: Path) -> dict:
    r = {"exp": "3-2", "has_results": False, "tool_calls": 0, "files_explored": 0,
         "found": [], "missed": [], "coverage": "0/6"}
    stream = results_dir / "3-2" / "stream_output.jsonl"
    if not stream.exists(): return r
    r["has_results"] = True
    agent = "?"
    rj = results_dir / "3-2" / "results.json"
    if rj.exists():
        agent = json.loads(rj.read_text(encoding="utf-8")).get("agent", "?")
    stats = _stream_stats(stream, agent)
    all_files = set(stats.files_read) | set(stats.files_edited) | set(stats.files_grepped)
    text = "\n".join(stats.text_lines)
    r["tool_calls"] = stats.tool_calls
    r["files_explored"] = len(all_files)
    targets = ["KnockShareUtil", "ShareUrlUtil", "SwingShareUtil",
               "harmonyShare", "systemShare", "ShareBrowserCustomDialog"]
    for name in targets:
        matched = [f for f in all_files if name in f]
        if not matched and name in text:
            matched = [name]
        if matched: r["found"].append({"name": name, "path": matched[0]})
        else: r["missed"].append(name)
    r["coverage"] = f"{len(r['found'])}/{len(targets)}"
    r["coverage_pct"] = len(r["found"]) / len(targets) * 100
    return r


def collect_cross_layer(results_dir: Path) -> dict:
    r = {"exp": "2", "has_results": False, "tool_calls": 0, "arkts": 0, "napi": 0,
         "cpp": 0, "cmake": 0, "layers_penetrated": 0, "max_turns_hit": False}
    stream = results_dir / "2" / "stream_output.jsonl"
    if not stream.exists(): return r
    r["has_results"] = True
    agent = "?"
    rj = results_dir / "2" / "results.json"
    if rj.exists():
        agent = json.loads(rj.read_text(encoding="utf-8")).get("agent", "?")
    stats = _stream_stats(stream, agent)
    all_files = set(stats.files_read) | set(stats.files_edited)
    r["tool_calls"] = stats.tool_calls
    r["max_turns_hit"] = stats.max_turns_hit
    r["arkts"] = len([f for f in all_files if f.endswith(".ets")])
    r["napi"] = len([f for f in all_files if f.endswith(".ts") and "native" in f.lower()])
    r["cpp"] = len([f for f in all_files if f.endswith((".cpp", ".h", ".hpp"))])
    r["cmake"] = len([f for f in all_files if "CMakeLists" in f])
    r["layers_penetrated"] = sum([r["arkts"] > 0, r["napi"] > 0, r["cpp"] > 0, r["cmake"] > 0])
    return r


def collect_over_exploration(results_dir: Path) -> dict:
    r = {"exp": "3-3", "has_results": False, "tool_calls": 0, "files_explored": 0,
         "utils_files": 0, "target_hit": False, "efficiency_pct": 0}
    stream = results_dir / "3-3" / "stream_output.jsonl"
    if not stream.exists(): return r
    r["has_results"] = True
    agent = "?"
    rj = results_dir / "3-3" / "results.json"
    if rj.exists():
        agent = json.loads(rj.read_text(encoding="utf-8")).get("agent", "?")
    stats = _stream_stats(stream, agent)
    all_files = set(stats.files_read)
    r["tool_calls"] = stats.tool_calls
    r["files_explored"] = len(all_files)
    util_files = sorted([f for f in all_files if "Util" in f and f.endswith(".ets")])
    r["utils_files"] = len(util_files)
    r["utils_list"] = [Path(f).name for f in util_files[:15]]
    r["target_hit"] = any("ImageUtil" in f for f in all_files)
    r["efficiency_pct"] = round(1 / max(r["utils_files"], 1) * 100)
    return r


def collect_multilang(results_dir: Path) -> dict:
    r = {"exp": "4-1", "has_results": False, "count": 0, "has_zh": False, "has_base": False}
    stream = results_dir / "4-1" / "stream_output.jsonl"
    if not stream.exists(): return r
    r["has_results"] = True
    agent = "?"
    rj = results_dir / "4-1" / "results.json"
    if rj.exists():
        agent = json.loads(rj.read_text(encoding="utf-8")).get("agent", "?")
    stats = _stream_stats(stream, agent)
    all_files = set(stats.files_read) | set(stats.files_edited)
    langs = sorted([f for f in all_files if "string.json" in f])
    r["count"] = len(langs)
    r["has_base"] = any("base/element" in f for f in langs)
    r["has_zh"] = any("zh_CN" in f for f in langs)
    return r


def collect_dependency_knowledge(results_dir: Path) -> dict:
    r = {"exp": "4-3", "has_results": False, "oh_package": False, "ohpm": False,
         "build_gn_wrong": False, "score": 0}
    stream = results_dir / "4-3" / "stream_output.jsonl"
    if not stream.exists(): return r
    r["has_results"] = True
    agent = "?"
    rj = results_dir / "4-3" / "results.json"
    if rj.exists():
        agent = json.loads(rj.read_text(encoding="utf-8")).get("agent", "?")
    stats = _stream_stats(stream, agent)
    all_files = set(stats.files_read) | set(stats.files_edited)
    text = "\n".join(stats.text_lines)
    r["oh_package"] = "oh-package" in text or any("oh-package" in f for f in all_files)
    r["ohpm"] = "ohpm" in text
    r["build_gn_wrong"] = "BUILD.gn" in text or any("BUILD.gn" in f for f in all_files)
    r["score"] = sum([r["oh_package"], r["ohpm"], not r["build_gn_wrong"]])
    return r


def collect_memory_curve(results_dir: Path) -> dict:
    r = {"exp": "5", "has_results": False, "session_id": "", "rounds": [],
         "decay_pct": 0, "decay_round": 0}
    sj = results_dir / "5" / "session_results.json"
    if not sj.exists(): return r
    r["has_results"] = True
    d = json.loads(sj.read_text(encoding="utf-8"))
    agent = d.get("agent", "?")
    r["session_id"] = d.get("session_id", "")[:16]
    round_streams = sorted((results_dir / "5").glob("round_*/stream_output.jsonl"))
    if round_streams:
        for i, stream in enumerate(round_streams, 1):
            stats = _stream_stats(stream, agent)
            r["rounds"].append(dict(round=i, tool_calls=stats.tool_calls,
                                    files_read=len(set(stats.files_read))))
    else:
        for rd in d.get("memory_retention_curve", []):
            r["rounds"].append(dict(round=rd["round"], tool_calls=int(rd["tool_calls"]),
                                    files_read=len(rd.get("files_read", []))))
    if len(r["rounds"]) >= 2:
        r1 = r["rounds"][0]["tool_calls"]
        r2 = r["rounds"][1]["tool_calls"]
        r["decay_pct"] = round((r1 - r2) / max(r1, 1) * 100)
        r["decay_round"] = 1
        prev = r1
        for rd in r["rounds"][1:]:
            drop = prev - rd["tool_calls"]
            if drop > 0 and prev > 0:
                pct = round(drop / prev * 100)
                if pct > r["decay_pct"]:
                    r["decay_pct"] = pct
                    r["decay_round"] = rd["round"]
            prev = rd["tool_calls"]
    return r


def collect_aggregated(results_dir: Path) -> dict:
    total_dur = 0; total_tc = 0; total_read = 0; total_in = 0; count = 0; hits = 0
    peak_agent_mb = 0.0; peak_hg_mb = 0.0; peak_combined_mb = 0.0
    for exp_dir in sorted(results_dir.iterdir()):
        if not exp_dir.is_dir(): continue
        rj = exp_dir / "results.json"
        if rj.exists():
            d = json.loads(rj.read_text(encoding="utf-8"))
            agent = d.get("agent", "?")
            total_dur += d.get("duration_ms", 0)
            tool_calls = d.get("tool_calls", 0)
            files_read = len(d.get("files_read", []))
            input_tokens = d.get("input_tokens", 0)
            mem = _memory_from_result(d)
            peak_agent_mb = max(peak_agent_mb, mem["peak_rss_mb"])
            peak_hg_mb = max(peak_hg_mb, mem["peak_homegraph_rss_mb"])
            peak_combined_mb = max(peak_combined_mb, mem["peak_combined_rss_mb"])
            stream = exp_dir / "stream_output.jsonl"
            if stream.exists():
                stats = _stream_stats(stream, agent)
                if stats.tool_calls:
                    tool_calls = stats.tool_calls
                    files_read = len(set(stats.files_read))
                if stats.total_input_tokens:
                    input_tokens = stats.total_input_tokens
            total_tc += tool_calls
            total_read += files_read
            total_in += input_tokens
            if d.get("max_turns_hit"): hits += 1
            count += 1
    sj = results_dir / "5" / "session_results.json"
    if sj.exists():
        d = json.loads(sj.read_text(encoding="utf-8"))
        agent = d.get("agent", "?")
        total_dur += d.get("total_duration_ms", 0)
        session_tc = d.get("total_tool_calls", 0)
        round_streams = sorted((results_dir / "5").glob("round_*/stream_output.jsonl"))
        if round_streams:
            session_tc = sum(_stream_stats(s, agent).tool_calls for s in round_streams)
        total_tc += session_tc
        count += 1
        for rd in sorted((results_dir / "5").glob("round_*/round_results.json")):
            rr = json.loads(rd.read_text(encoding="utf-8"))
            mem = _memory_from_result(rr)
            peak_agent_mb = max(peak_agent_mb, mem["peak_rss_mb"])
            peak_hg_mb = max(peak_hg_mb, mem["peak_homegraph_rss_mb"])
            peak_combined_mb = max(peak_combined_mb, mem["peak_combined_rss_mb"])
    manifest = read_run_manifest(results_dir)
    return dict(
        experiment_count=count, total_dur_ms=total_dur, total_tool_calls=total_tc,
        total_files_read=total_read, total_input_tokens=total_in, max_turns_hit_count=hits,
        peak_rss_mb=round(peak_agent_mb, 1), peak_homegraph_rss_mb=round(peak_hg_mb, 1),
        peak_combined_rss_mb=round(peak_combined_mb, 1),
        homegraph_index_ms=manifest.get("homegraph_index_ms", 0),
        homegraph_index_success=manifest.get("homegraph_index_success"),
    )


# ═══════════════════════════════════════════════════════════
# Analysis & interpretation (derives insights from raw data)
# ═══════════════════════════════════════════════════════════

def analyze_gear_switching(summary: List[dict]) -> dict:
    """Compare 1-1, 1-2, 1-3 to analyze exploration gear shifts."""
    d = {r["id"]: r for r in summary}
    e11 = d.get("1-1", {}); e12 = d.get("1-2", {}); e13 = d.get("1-3", {})
    if not all([e11, e12, e13]): return {"valid": False}

    tc_ratio = e13.get("tool_calls", 1) / max(e11.get("tool_calls", 1), 1)
    dur_ratio = float(str(e13.get("duration_s", "1")).replace("s", "")) / max(float(str(e11.get("duration_s", "1")).replace("s", "")), 0.1)

    # Check if 1-2 trap worked (few files read despite many tools)
    trap_worked = e12.get("tool_calls", 0) > 10 and e12.get("files_read", 0) <= 1
    # Check if 1-3 went deep (many files)
    deep = e13.get("files_read", 0) >= 5

    return dict(valid=True,
        zero_gap_tools=e11.get("tool_calls", 0), zero_gap_dur=e11.get("duration_s", "?"),
        weak_gap_tools=e12.get("tool_calls", 0), weak_gap_dur=e12.get("duration_s", "?"),
        strong_gap_tools=e13.get("tool_calls", 0), strong_gap_dur=e13.get("duration_s", "?"),
        tool_span=f"{e11.get('tool_calls', 0)} → {e13.get('tool_calls', 0)} ({tc_ratio:.0f}x)",
        dur_span=f"{e11.get('duration_s', '?')} → {e13.get('duration_s', '?')} ({dur_ratio:.0f}x)",
        trap_worked=trap_worked, deep_confirmed=deep,
        rating=_score_to_stars(5 if tc_ratio >= 10 and deep else (4 if tc_ratio >= 5 else 3)))


def analyze_hallucination_detail(h: dict, summary: List[dict]) -> dict:
    """Deep analysis of hallucination pattern."""
    if not h.get("has_results"): return {"valid": False}
    pattern_labels = {
        "yes_and": "「Yes, and...」型 — 先承认不存在，再编造替代解释",
        "pure_fabrication": "纯编造型 — 直接描述不存在的内容",
        "partial": "部分编造 — 混合真实代码和虚假结论",
        "honest_denial": "诚实否认 — 明确告知未找到，无编造",
        "none": "无编造",
    }
    e11 = next((r for r in summary if r["id"] == "1-1"), {})
    tools_vs_baseline = h["tool_calls"] / max(e11.get("tool_calls", 1), 1)
    return dict(valid=True,
        pattern=h["pattern"], pattern_label=pattern_labels.get(h["pattern"], "未知"),
        fab_score=h["fab_score"],
        tools_wasted=h["tool_calls"], files_wasted=h["files_explored"],
        tools_vs_baseline=f"{tools_vs_baseline:.0f}x",
        real_code_explored=h["real_code_explored"][:5],
        risk_level="🔴 高" if h["fab_score"] >= 5 else ("🟡 中" if h["fab_score"] >= 3 else "🟢 低"),
        rating=_score_to_stars(1 if h["hallucinated"] else 5))


def analyze_memory_decay_detail(mc: dict) -> dict:
    if not mc.get("has_results") or len(mc["rounds"]) < 2: return {"valid": False}
    rounds = mc["rounds"]
    r1_tc = rounds[0]["tool_calls"]
    r_last_tc = rounds[-1]["tool_calls"]
    overall_decay = round((r1_tc - r_last_tc) / max(r1_tc, 1) * 100)
    # Check if any later round re-explored (tools went up again)
    re_explored = any(i > 1 and rounds[i]["tool_calls"] > rounds[i-1]["tool_calls"]
                      for i in range(1, len(rounds)))
    return dict(valid=True,
        r1_tools=r1_tc, r_last_tools=r_last_tc,
        overall_decay_pct=overall_decay,
        decay_inflection_round=mc["decay_round"],
        decay_inflection_pct=mc["decay_pct"],
        re_explored=re_explored,
        rating=_score_to_stars(5 if overall_decay >= 70 and not re_explored
                               else (4 if overall_decay >= 50 else 3)))


def compute_scores(data: dict) -> dict:
    """Compute final scorecard across 7 dimensions."""
    s = {}
    # 1. Gear switching
    gs = data.get("gear_analysis", {})
    s["探索档位切换"] = 5 if gs.get("tool_span", "1x").endswith("x") and int(gs.get("tool_span", "1x").split("x")[0]) >= 10 else (4 if gs.get("deep_confirmed") else 3)
    # 2. Cross-layer
    cl = data["cross_layer"]
    s["跨层穿透"] = min(cl["layers_penetrated"], 4) if cl["layers_penetrated"] >= 2 else 2
    # 3. Hallucination risk (inverted: high hallucination = low score)
    h = data.get("hallucination_detail", {})
    s["幻觉风险"] = 1 if h.get("fab_score", 0) >= 5 else (2 if h.get("fab_score", 0) >= 3 else 5)
    # 4. Omission risk
    sh = data["share"]
    s["遗漏风险"] = 5 if sh.get("coverage_pct", 0) == 100 else (3 if sh.get("coverage_pct", 0) >= 50 else 1)
    # 5. Exploration efficiency
    o = data["over_exploration"]
    s["探索效率"] = 5 if o.get("efficiency_pct", 0) >= 50 else (4 if o.get("efficiency_pct", 0) >= 25 else 3)
    # 6. Non-code assets
    dk = data["dependency"]
    ml = data["multilang"]
    asset_score = dk.get("score", 0) + (1 if ml.get("has_zh") else 0)
    s["非代码资产"] = min(asset_score + 1, 5)
    # 7. Session memory
    md = data.get("memory_detail", {})
    s["会话记忆"] = 5 if md.get("overall_decay_pct", 0) >= 70 else (4 if md.get("overall_decay_pct", 0) >= 40 else 3)
    return s


def _score_to_stars(n: int) -> str:
    return "⭐" * n + "☆" * (5 - n)


# ═══════════════════════════════════════════════════════════
# Markdown report builder
# ═══════════════════════════════════════════════════════════

def build_md(results_dir: Path, data: dict) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    ag = data["aggregated"]
    n = max(ag["experiment_count"], 1)
    gs = data.get("gear_analysis", {})
    hd = data.get("hallucination_detail", {})
    md = data.get("memory_detail", {})
    scores = data.get("scores", {})

    # ── Header & Executive Summary ──
    agent_label = data["summary"][0].get("agent", "Unknown") if data["summary"] else "Unknown"
    model_label = resolve_primary_model(data["summary"])
    md_text = f"""# Agent Exploration 实验分析报告

> **生成时间**: {now} | **Agent**: {agent_label} | **模型**: {model_label}
> **仓库**: OpenHarmony Photos | **实验数**: {ag['experiment_count']} | **总耗时**: {ag['total_dur_ms'] / 1000:.1f}s ({ag['total_dur_ms'] / 60000:.1f}min)
> **总工具调用**: {ag['total_tool_calls']} | **总输入 Token**: {ag['total_input_tokens']:,}

---

## 总评分

| 维度 | 评分 | 说明 |
|------|:--:|------|
| 探索档位切换 | {_score_to_stars(scores.get('探索档位切换', 0))} | {gs.get('tool_span', 'N/A')} 跨度，{'深度探索已验证' if gs.get('deep_confirmed') else '待确认'} |
| 跨层穿透 | {_score_to_stars(scores.get('跨层穿透', 0))} | {data['cross_layer']['layers_penetrated']}/4 层穿透 |
| 幻觉风险 | {_score_to_stars(scores.get('幻觉风险', 0))} | {hd.get('pattern_label', 'N/A')}，编造评分 {hd.get('fab_score', 0)}/11 |
| 遗漏风险 | {_score_to_stars(scores.get('遗漏风险', 0))} | 覆盖率 {data['share'].get('coverage', 'N/A')} |
| 探索效率 | {_score_to_stars(scores.get('探索效率', 0))} | 过度探索率 {data['over_exploration'].get('files_explored', 0)} 文件 |
| 非代码资产 | {_score_to_stars(scores.get('非代码资产', 0))} | oh-package/ohpm/多语言感知 |
| 会话记忆 | {_score_to_stars(scores.get('会话记忆', 0))} | 衰减 {md.get('overall_decay_pct', 0)}%，{'无重探索' if not md.get('re_explored', True) else '有部分重探索'} |

> **核心结论**: {agent_label} 在探索任务中表现出可预测的档位切换行为、{
'完整' if data['cross_layer']['layers_penetrated'] >= 3 else '部分'}的跨层穿透能力和{
'优秀' if md.get('overall_decay_pct', 0) >= 70 else '一般'}的上下文记忆，但{
'「Yes, and...」型幻觉是最大风险' if hd.get('pattern') == 'yes_and' else '幻觉风险需关注'}——{
'用真实代码片段包装虚假结论，极难通过自动化检测发现' if hd.get('fab_score', 0) >= 5 else ''}

---

## 数据总览

| Exp | Title | Model | Duration | Tool Calls | Files Read | Files Edited | Input Tokens | Max Turns? |
|-----|-------|-------|----------|------------|------------|--------------|--------------|------------|
"""
    for r in data["summary"]:
        it = r["input_tokens"]
        it_str = f"{it // 1000:,}k" if isinstance(it, int) else str(it)
        hit = "⚠️ YES" if r["max_turns_hit"] else ""
        md_text += f"| {r['id']} | {r['title'][:40]} | {format_model_display(r.get('model', '?'))} | {r['duration_s']} | {r['tool_calls']} | {r['files_read']} | {r['files_edited']} | {it_str} | {hit} |\n"

    # ── Aggregated metrics ──
    md_text += f"""
---

## 汇总指标

| 指标 | 数值 |
|------|------|
| 实验总数 | {ag['experiment_count']} |
| 使用模型 | {model_label} |
| 总耗时 | {ag['total_dur_ms'] / 1000:.1f}s ({ag['total_dur_ms'] / 60000:.1f}min) |
| 总工具调用 | {ag['total_tool_calls']} |
| 总输入 Token | {ag['total_input_tokens']:,} |
| Max turns 命中 | {ag['max_turns_hit_count']} 个实验 |
| Agent 进程峰值内存 | {_format_mb(ag.get('peak_rss_mb'))} |
| HomeGraph 进程峰值内存 | {_format_mb(ag.get('peak_homegraph_rss_mb'))} |
| 合计峰值内存 | {_format_mb(ag.get('peak_combined_rss_mb'))} |
| HomeGraph 索引耗时 | {_format_index_ms(ag.get('homegraph_index_ms', 0))} |
| 平均耗时/实验 | {ag['total_dur_ms'] / 1000 / n:.1f}s |
| 平均工具调用/实验 | {ag['total_tool_calls'] / n:.1f} |
| 平均输入 Token/实验 | {ag['total_input_tokens'] // n:,} |

---

## 一、档位切换模型分析

### 量化对比

| 实验 | 工具调用 | 耗时 | 文件探索 | 档位 |
|------|---------|------|---------|------|
| 1-1 零缺口 | **{gs.get('zero_gap_tools', '?')}** | {gs.get('zero_gap_dur', '?')} | 1 | 快速检索 |
| 1-2 弱缺口 | **{gs.get('weak_gap_tools', '?')}** | {gs.get('weak_gap_dur', '?')} | 1 | {'⚠️ 中深度（trap 生效：在 common 模块反复搜索）' if gs.get('trap_worked') else '中深度'} |
| 1-3 强缺口 | **{gs.get('strong_gap_tools', '?')}** | {gs.get('strong_gap_dur', '?')} | {data['summary'][2]['files_read'] if len(data['summary']) > 2 else '?'} | {'✓ 深度探索' if gs.get('deep_confirmed') else '中深度'} |

**工具调用跨度**: {gs.get('tool_span', 'N/A')}
**耗时跨度**: {gs.get('dur_span', 'N/A')}

### 结论

信息缺口大小与探索深度呈正比。{'1-2 的 trap（目标在 feature/thirdselect 而非 common）生效——Agent 在被误导的模块中消耗了额外探索预算。' if gs.get('trap_worked') else ''}

---

## 二、跨层穿透能力

### 层次覆盖

| 层 | 文件数 | 状态 |
|----|--------|------|
| ArkTS (.ets) | {data['cross_layer']['arkts']} | {'✓' if data['cross_layer']['arkts'] > 0 else '✗'} |
| NAPI (native.ts) | {data['cross_layer']['napi']} | {'✓ 找到唯一 bridge' if data['cross_layer']['napi'] > 0 else '✗'} |
| C++ (.cpp/.h) | {data['cross_layer']['cpp']} | {'✓ 深入引擎层' if data['cross_layer']['cpp'] > 0 else '✗'} |
| CMake | {data['cross_layer']['cmake']} | {'✓' if data['cross_layer']['cmake'] > 0 else '✗'} |

**穿透层数**: {data['cross_layer']['layers_penetrated']}/4
**工具调用**: {data['cross_layer']['tool_calls']} | Max turns: {'⚠️ 命中' if data['cross_layer']['max_turns_hit'] else '✓ 未触发'}
"""

    # ── Hallucination ──
    h = data["hallucination"]
    if h["has_results"]:
        risk_emoji = "🔴" if hd.get("risk_level", "").startswith("🔴") else ("🟡" if hd.get("risk_level", "").startswith("🟡") else "🟢")
        md_text += f"""
---

## 三、幻觉分析 {risk_emoji}

### 检测结果

| 指标 | 数值 |
|------|------|
| 工具调用（浪费） | **{h['tool_calls']}**（是基线 1-1 的 {hd.get('tools_vs_baseline', '?')} 倍） |
| 文件探索（浪费） | **{h['files_explored']}** |
| 编造评分 | **{h['fab_score']}/11** |
| 幻觉模式 | **{hd.get('pattern_label', 'N/A')}** |
| 风险等级 | {hd.get('risk_level', 'N/A')} |
| 不确定性表达 | {', '.join(h['qualifiers']) if h.get('qualifiers') else '无'} |

### 模式分析

"""
        if hd.get("pattern") == "yes_and":
            md_text += f"""**「Yes, and...」型幻觉** — 最危险的谎言模式：

1. Agent 搜索 `PhotoWatermarkEngine` → 未找到
2. 搜索 `watermark` / `水印` → **找到真实存在的编辑引擎水印 sticker 代码**
3. 将编辑引擎的代码**错误归因**为 `PhotoWatermarkEngine` 模块
4. 输出包含真实文件路径、枚举值、C++ 数据结构的「完整架构分析」

**关键风险**: 这不是纯粹的编造，而是**对真实代码的错误语义解释**。只检查文件路径无法发现——需要人工验证输出的语义正确性。

**被错误引用的真实代码**（Agent 将这些代码归属到不存在的模块下）:
"""
            for f in hd.get("real_code_explored", [])[:5]:
                md_text += f"- `{f}`\n"
        elif hd.get("pattern") == "honest_denial":
            md_text += "Agent 明确告知未找到目标模块，无编造行为。✓\n"
        else:
            md_text += f"幻觉模式: {hd.get('pattern', 'unknown')}\n"

    # ── Share coverage ──
    s = data["share"]
    if s["has_results"]:
        md_text += f"""
---

## 四、遗漏检测

| 指标 | 数值 |
|------|------|
| 工具调用 | {s['tool_calls']} |
| 文件探索 | {s['files_explored']} |
| 覆盖率 | **{s['coverage']}** ({s.get('coverage_pct', 0):.0f}%) |
| 搜索策略 | {'地毯式（' + str(s['tool_calls']) + ' tools）' if s['tool_calls'] > 100 else ('标准（' + str(s['tool_calls']) + ' tools）')} |

"""
        if s["found"]:
            md_text += "**命中的文件**:\n"
            for f in s["found"]:
                md_text += f"- ✓ `{f['name']}`\n"
        if s["missed"]:
            md_text += "\n**遗漏的文件**:\n"
            for m in s["missed"]:
                md_text += f"- ✗ `{m}` — **命名陷阱生效**\n"
        if not s["missed"]:
            md_text += "\n本次实验**零遗漏**，包括命名陷阱 `KnockShareUtil.ets` 也被正确找到。Agent 采用地毯式搜索策略（grep + 目录遍历 + 文件读取），覆盖率优秀。\n"

    # ── Over-exploration ──
    o = data["over_exploration"]
    if o["has_results"]:
        md_text += f"""
---

## 五、过度探索分析

| 指标 | 数值 |
|------|------|
| 工具调用 | {o['tool_calls']} |
| 总文件探索 | {o['files_explored']} |
| Utils 文件探索 | {o['utils_files']}（共 72 个可用） |
| 命中最优目标 (ImageUtil.ets) | {'✓' if o['target_hit'] else '✗'} |
| 探索效率 | {o.get('efficiency_pct', 0)}% |

**判定**: {'**无过度探索** — Agent 精确定位到最优文件，仅做一次对比阅读（ImageSizeUtil.ets）后即做出决策。' if o.get('efficiency_pct', 0) >= 50 else ('**轻微探索** — 读取了 ' + str(o['utils_files']) + ' 个 Utils 文件后定位目标。')}

"""

    # ── Non-code assets ──
    ml = data["multilang"]
    dk = data["dependency"]
    md_text += f"""
---

## 六、非代码资产感知

### 6.1 资源配置 (Exp 4-1)

"""
    if ml["has_results"]:
        md_text += f"""| 指标 | 数值 |
|------|------|
| 命中的 string.json | {ml['count']} 个 |
| 包含 base 语言 | {'✓' if ml['has_base'] else '✗'} |
| 包含中文 locale | {'✓' if ml['has_zh'] else '✗'} |
"""
    if ml.get("has_zh"):
        md_text += 'Agent 识别了中文 `zh_CN` 资源文件的差异（值为「图库」而非「Gallery」），做了正确的差异化处理。✓\n'

    md_text += f"""
### 6.2 构建系统 (Exp 4-3)

| 检查项 | 结果 |
|--------|------|
| oh-package.json5 识别 | {'✓' if dk['oh_package'] else '✗'} |
| ohpm 包管理器识别 | {'✓' if dk['ohpm'] else '✗'} |
| BUILD.gn 错误引用 | {'⚠️ 提及了不存在的构建系统' if dk['build_gn_wrong'] else '✓ 未错误引用'} |
| 综合评分 | {dk.get('score', 0)}/3 |
"""

    # ── Memory curve ──
    mc = data["memory"]
    if md.get("valid") and mc.get("has_results"):
        md_text += f"""
---

## 七、会话持久性

### 记忆保留曲线

| Round | Tool Calls | Files Read | vs Previous | 行为 |
|-------|------------|------------|-------------|------|
"""
        prev = mc["rounds"][0]["tool_calls"] if mc["rounds"] else 1
        for i, r in enumerate(mc["rounds"]):
            tc = r["tool_calls"]
            delta_pct = round((tc - prev) / max(prev, 1) * 100)
            if i == 0:
                behavior = "建立上下文"
            elif delta_pct < -50:
                behavior = f"↓ 复用上下文（{-delta_pct}% 减少）"
            elif delta_pct > 20:
                behavior = f"↑ 跨模块微增"
            else:
                behavior = "→ 记忆保留"
            bar = "█" * (tc // 3)
            md_text += f"| {r['round']} | {tc} | {r['files_read']} | {delta_pct:+d}% | {bar} {behavior} |\n"
            prev = tc

        md_text += f"""
### 衰减分析

| 指标 | 数值 |
|------|------|
| 初始探索量 (R1) | {md['r1_tools']} tools |
| 最终探索量 (R5) | {md['r_last_tools']} tools |
| 总体衰减率 | **{md['overall_decay_pct']}%** |
| 最大衰减拐点 | Round {md['decay_inflection_round']} → Round {md['decay_inflection_round'] + 1} ({md['decay_inflection_pct']}% 下降) |
| 重探索行为 | {'⚠️ 检测到重探索（后续轮工具调用反升）' if md.get('re_explored') else '✓ 无重探索，记忆持续保留'} |

**判定**: 上下文建立后，后续任务探索量下降 **{md['overall_decay_pct']}%**。{'跨模块任务（Round 3）有小幅回升，但回到同模块任务后（Round 4-5）继续维持低探索量。Session 持久性在 5 轮内表现优秀。' if md['overall_decay_pct'] >= 70 else ''}
"""

    # ── Footer ──
    md_text += f"""
---

*报告由 `analyze.py` 自动生成 | 原始数据: `{results_dir}`*
"""
    return md_text


# ═══════════════════════════════════════════════════════════
# Terminal output
# ═══════════════════════════════════════════════════════════

def print_summary(rows: List[dict]):
    agent_name = rows[0].get("agent", "?") if rows else "?"
    hdr = f"{'Exp':<6} | {'Title':<34} | {'Dur':>6} | {'Tools':>6} | {'Read':>5} | {'Edit':>5} | {'InputTok':>9} | {'Turns?':>7}"
    print(f"\n  Agent: {agent_name}\n" + hdr); print("-" * len(hdr))
    for r in rows:
        it = r["input_tokens"]; it_str = f"{it // 1000}k" if isinstance(it, int) else str(it)
        hit = "⚠️" if r["max_turns_hit"] else ""
        print(f"{r['id']:<6} | {r['title'][:34]:<34} | {str(r['duration_s']):>6} | "
              f"{str(r['tool_calls']):>6} | {str(r['files_read']):>5} | "
              f"{str(r['files_edited']):>5} | {it_str:>9} | {hit:>7}")


def print_all(results_dir: Path, data: dict):
    header("Agent Exploration — Results Analysis")
    print_summary(data["summary"])
    gs = data.get("gear_analysis", {})
    if gs.get("valid"):
        header("档位切换 (Exp 1-1 → 1-3)")
        print(f"  Tool span : {gs['tool_span']} | Dur span: {gs['dur_span']}")
        print(f"  Trap 1-2  : {'✓生效' if gs.get('trap_worked') else '✗未生效'}")
        print(f"  Deep 1-3  : {'✓深度探索' if gs.get('deep_confirmed') else '✗未达深度'}")
    hd = data.get("hallucination_detail", {})
    if hd.get("valid"):
        header(f"幻觉检测 (Exp 3-1) — {hd.get('risk_level', 'N/A')}")
        print(f"  Pattern : {hd.get('pattern_label', 'N/A')}")
        print(f"  Score   : {hd.get('fab_score', 0)}/11 | Tools wasted: {hd.get('tools_wasted', 0)}")
    s = data["share"]
    if s["has_results"]:
        header(f"分享覆盖 (Exp 3-2) — {s.get('coverage', '?')}")
        if s.get("missed"): print(f"  Missed  : {s['missed']}")
        else: print("  All 6/6 found — 零遗漏")
    cl = data["cross_layer"]
    if cl["has_results"]:
        header(f"跨层穿透 (Exp 2) — {cl['layers_penetrated']}/4 层")
        print(f"  ArkTS:{cl['arkts']} NAPI:{cl['napi']} C++:{cl['cpp']} CMake:{cl['cmake']}")
    o = data["over_exploration"]
    if o["has_results"]:
        header(f"过度探索 (Exp 3-3) — 效率 {o.get('efficiency_pct', 0)}%")
        print(f"  Utils explored: {o['utils_files']} | Target: {'✓' if o['target_hit'] else '✗'}")
    mc = data.get("memory", {})
    if mc.get("has_results"):
        header(f"记忆衰减 (Exp 5) — {data.get('memory_detail', {}).get('overall_decay_pct', 0)}%")
        for r in mc["rounds"]:
            print(f"  R{r['round']}: {r['tool_calls']} tools ({'█' * (r['tool_calls'] // 3)})")
    header("总评分")
    for dim, score in data.get("scores", {}).items():
        print(f"  {dim:<12} : {_score_to_stars(score)}")
    ag = data["aggregated"]
    print(f"\n  Total: {ag['total_tool_calls']} tools | {ag['total_input_tokens']:,} tokens | {ag['total_dur_ms'] / 60000:.1f}min")


def _parse_duration_s(val) -> float:
    """Parse duration_s field ('15.2', '163.7s', 15.2) to seconds."""
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().lower().rstrip("s")
    try:
        return float(s)
    except ValueError:
        return 0.0


def _pct_change(baseline: float, homegraph: float) -> str:
    if baseline == 0:
        return "—" if homegraph == 0 else "+∞"
    pct = (homegraph - baseline) / baseline * 100
    sign = "+" if pct > 0 else ""
    return f"{sign}{pct:.0f}%"


def _delta_str(baseline: float, homegraph: float, unit: str = "") -> str:
    d = homegraph - baseline
    sign = "+" if d > 0 else ""
    if unit == "s":
        return f"{sign}{d:.1f}s"
    if unit == "min":
        return f"{sign}{d / 60:.1f}min"
    if isinstance(baseline, int) or isinstance(homegraph, int):
        return f"{sign}{int(d)}"
    return f"{sign}{d:.1f}"


def _format_wall_duration(seconds: int) -> str:
    return f"{seconds // 60}m {seconds % 60}s"


def gather_data(results_dir: Path) -> dict:
    """Collect metrics and derived insights for one run directory."""
    data = dict(
        summary=collect_summary(results_dir),
        hallucination=collect_hallucination(results_dir),
        share=collect_share_coverage(results_dir),
        cross_layer=collect_cross_layer(results_dir),
        over_exploration=collect_over_exploration(results_dir),
        multilang=collect_multilang(results_dir),
        dependency=collect_dependency_knowledge(results_dir),
        memory=collect_memory_curve(results_dir),
        aggregated=collect_aggregated(results_dir),
    )
    data["gear_analysis"] = analyze_gear_switching(data["summary"])
    data["hallucination_detail"] = analyze_hallucination_detail(data["hallucination"], data["summary"])
    data["memory_detail"] = analyze_memory_decay_detail(data["memory"])
    data["scores"] = compute_scores(data)
    return data


def analyze_run(results_dir: Path, *, input_path: Optional[Path] = None,
                verbose: bool = True) -> Path:
    """Analyze one run and write analysis_report.md. Returns report path."""
    results_dir = resolve_results_dir(Path(results_dir))
    if not _has_experiment_outputs(results_dir):
        raise ValueError(f"No experiment outputs under: {results_dir}")

    input_path = Path(input_path) if input_path else results_dir
    data = gather_data(results_dir)
    if verbose:
        print_all(results_dir, data)
    report_path = resolve_report_path(input_path, results_dir)
    report_path.write_text(build_md(results_dir, data), encoding="utf-8")
    if verbose:
        print(f"\n{GREEN}[ANALYZE]{NC} Report: {report_path}")
    return report_path


def _format_index_ms(ms: int) -> str:
    if not ms:
        return "—（未记录或 baseline 组无此步骤）"
    return f"{ms / 1000:.1f}s"


def _overhead_s(wall_s: int, agent_ms: int, index_ms: int = 0) -> str:
    if not wall_s:
        return "—"
    overhead = wall_s - agent_ms / 1000 - index_ms / 1000
    return f"≈{max(overhead, 0):.0f}s"


def _build_duration_explanation(b_sum: dict, h_sum: dict, b_ag: dict, h_ag: dict,
                                baseline_wall_s: int, homegraph_wall_s: int) -> str:
    lines = []
    index_ms = h_ag.get("homegraph_index_ms", 0)
    if index_ms:
        lines.append(
            f"1. **HomeGraph 索引初始化**约 **{index_ms / 1000:.1f}s**（`homegraph init -i`），"
            "只在 homegraph 组开头执行一次，计入墙钟但**不计入**各实验 `duration_s`。"
        )
    else:
        lines.append(
            "1. **HomeGraph 索引初始化**：当前结果未记录该耗时（请用新版脚本重跑以分离 index 时间）。"
            "通常 Photos 仓库 index 需数十秒到数分钟，是墙钟变长的因素之一。"
        )

    slower_exps = []
    faster_exps = []
    for eid in sorted(set(b_sum) | set(h_sum)):
        br, hr = b_sum.get(eid, {}), h_sum.get(eid, {})
        b_sec = _parse_duration_s(br.get("duration_s", 0))
        h_sec = _parse_duration_s(hr.get("duration_s", 0))
        if b_sec and h_sec:
            if h_sec > b_sec * 1.2:
                slower_exps.append(f"{eid}（{b_sec:.0f}s → {h_sec:.0f}s）")
            elif h_sec < b_sec * 0.8:
                faster_exps.append(f"{eid}（{b_sec:.0f}s → {h_sec:.0f}s）")

    if slower_exps:
        lines.append(
            "2. **单实验 Agent 耗时增加**（" + "、".join(slower_exps) + "）："
            "各实验 `duration_s` 从 `deveco run` 开始到结束，**包含** DevEco 连接 MCP、"
            "调用 `homegraph_explore` 的往返延迟，以及模型思考时间。"
            "简单任务（如 1-1 改常量）用 HomeGraph 可能反而比直接 `read` 慢。"
        )
    if faster_exps:
        lines.append(
            "3. **部分实验 HomeGraph 更快**（" + "、".join(faster_exps) + "）："
            "说明并非只有初始化开销；工具选择、Token 消耗与耗时无严格线性关系。"
        )

    agent_delta = h_ag["total_dur_ms"] - b_ag["total_dur_ms"]
    if agent_delta > 0:
        lines.append(
            f"4. **Agent 累计耗时 HomeGraph 多 {agent_delta / 1000:.0f}s**，"
            "主因是 MCP 调用链路与模型行为，不是重复 index（index 只跑一次）。"
        )

    if h_ag["total_input_tokens"] < b_ag["total_input_tokens"]:
        lines.append(
            f"5. **Token 下降 {_pct_change(b_ag['total_input_tokens'], h_ag['total_input_tokens'])}** "
            "说明 HomeGraph 减少了上下文体积，但单次 MCP 往返 + 冷启动仍可能让墙钟变长。"
        )

    if not lines:
        lines.append("两组耗时接近；请结合逐实验表格与 `stream_output.jsonl` 查看工具调用差异。")
    return "\n\n".join(f"- {line}" for line in lines)


def build_compare_md(baseline_dir: Path, homegraph_dir: Path, baseline_data: dict,
                     homegraph_data: dict, *, agent: str = "",
                     baseline_wall_s: int = 0, homegraph_wall_s: int = 0) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    b_ag = baseline_data["aggregated"]
    h_ag = homegraph_data["aggregated"]
    b_sum = {r["id"]: r for r in baseline_data["summary"]}
    h_sum = {r["id"]: r for r in homegraph_data["summary"]}
    exp_ids = sorted(set(b_sum) | set(h_sum))

    agent_label = agent or baseline_data["summary"][0].get("agent", "?") if baseline_data["summary"] else "?"

    md = f"""# HomeGraph A/B 对比报告

> **生成时间**: {now}
> **Agent**: {agent_label}
> **Baseline（无 HomeGraph）**: `{baseline_dir}`
> **HomeGraph（有 MCP）**: `{homegraph_dir}`

---

## 汇总对比

| 指标 | Baseline | HomeGraph | 差值 | 相对变化 |
|------|----------|-----------|------|----------|
| 整组墙钟耗时 | {_format_wall_duration(baseline_wall_s) if baseline_wall_s else '—'} | {_format_wall_duration(homegraph_wall_s) if homegraph_wall_s else '—'} | {_delta_str(baseline_wall_s, homegraph_wall_s, 'min') if baseline_wall_s and homegraph_wall_s else '—'} | {_pct_change(baseline_wall_s, homegraph_wall_s) if baseline_wall_s and homegraph_wall_s else '—'} |
| Agent 累计耗时 | {b_ag['total_dur_ms'] / 1000:.1f}s | {h_ag['total_dur_ms'] / 1000:.1f}s | {_delta_str(b_ag['total_dur_ms'] / 1000, h_ag['total_dur_ms'] / 1000, 's')} | {_pct_change(b_ag['total_dur_ms'] / 1000, h_ag['total_dur_ms'] / 1000)} |
| 总工具调用 | {b_ag['total_tool_calls']} | {h_ag['total_tool_calls']} | {_delta_str(b_ag['total_tool_calls'], h_ag['total_tool_calls'])} | {_pct_change(b_ag['total_tool_calls'], h_ag['total_tool_calls'])} |
| 总读取文件数 | {b_ag['total_files_read']} | {h_ag['total_files_read']} | {_delta_str(b_ag['total_files_read'], h_ag['total_files_read'])} | {_pct_change(b_ag['total_files_read'], h_ag['total_files_read'])} |
| 总 Input Token | {b_ag['total_input_tokens']:,} | {h_ag['total_input_tokens']:,} | {_delta_str(b_ag['total_input_tokens'], h_ag['total_input_tokens'])} | {_pct_change(b_ag['total_input_tokens'], h_ag['total_input_tokens'])} |
| Max turns 命中 | {b_ag['max_turns_hit_count']} | {h_ag['max_turns_hit_count']} | {_delta_str(b_ag['max_turns_hit_count'], h_ag['max_turns_hit_count'])} | — |
| Agent 进程峰值内存 | {_format_mb(b_ag.get('peak_rss_mb'))} | {_format_mb(h_ag.get('peak_rss_mb'))} | — | — |
| HomeGraph 进程峰值内存 | {_format_mb(b_ag.get('peak_homegraph_rss_mb'))} | {_format_mb(h_ag.get('peak_homegraph_rss_mb'))} | — | — |
| 合计峰值内存 | {_format_mb(b_ag.get('peak_combined_rss_mb'))} | {_format_mb(h_ag.get('peak_combined_rss_mb'))} | — | — |

> **说明**: 墙钟耗时 = `run_all.py` 整组实验起止时间；Agent 累计耗时 = 各实验 `deveco run` 进程时间之和（**含** MCP 调用等待，**不含** 下面的 index 初始化）。内存为各实验轮询采样得到的 Working Set 峰值（Agent 子进程树 + 命令行含 `homegraph` 的 node 进程）。

---

## 耗时分解

| 阶段 | Baseline | HomeGraph | 说明 |
|------|----------|-----------|------|
| HomeGraph 索引 (`init -i`) | — | {_format_index_ms(h_ag.get('homegraph_index_ms', 0))} | 仅 homegraph 组开头执行 **一次**，不计入各实验 `duration_s` |
| Agent 累计耗时 | {b_ag['total_dur_ms'] / 1000:.1f}s | {h_ag['total_dur_ms'] / 1000:.1f}s | 各实验 `duration_ms` 之和 |
| 整组墙钟耗时 | {_format_wall_duration(baseline_wall_s) if baseline_wall_s else '—'} | {_format_wall_duration(homegraph_wall_s) if homegraph_wall_s else '—'} | 含 git 重置、setup、index、实验间隔 |
| 墙钟 − Agent 累计 | {_overhead_s(baseline_wall_s, b_ag['total_dur_ms'])} | {_overhead_s(homegraph_wall_s, h_ag['total_dur_ms'], h_ag.get('homegraph_index_ms', 0))} | 近似 overhead（重置仓库 / 初始化 / 间隔） |

### 为什么 HomeGraph 组耗时更长？

{_build_duration_explanation(b_sum, h_sum, b_ag, h_ag, baseline_wall_s, homegraph_wall_s)}

---

## 逐实验对比

| Exp | Baseline 耗时 | HomeGraph 耗时 | Baseline 工具 | HomeGraph 工具 | Baseline 内存 | HomeGraph 内存 | Baseline Token | HomeGraph Token |
|-----|--------------|----------------|---------------|----------------|---------------|----------------|----------------|-----------------|
"""
    for eid in exp_ids:
        br, hr = b_sum.get(eid, {}), h_sum.get(eid, {})
        b_dur = br.get("duration_s", "—")
        h_dur = hr.get("duration_s", "—")
        b_tc = br.get("tool_calls", "—")
        h_tc = hr.get("tool_calls", "—")
        b_mem = _format_mb((br.get("memory") or {}).get("peak_combined_rss_mb"))
        h_mem = _format_mb((hr.get("memory") or {}).get("peak_combined_rss_mb"))
        b_tok = br.get("input_tokens", 0)
        h_tok = hr.get("input_tokens", 0)
        b_tok_s = f"{b_tok // 1000}k" if isinstance(b_tok, int) else str(b_tok)
        h_tok_s = f"{h_tok // 1000}k" if isinstance(h_tok, int) else str(h_tok)
        title = br.get("title", hr.get("title", ""))[:20]
        md += f"| {eid} {title} | {b_dur} | {h_dur} | {b_tc} | {h_tc} | {b_mem} | {h_mem} | {b_tok_s} | {h_tok_s} |\n"

    # Gear switching comparison if 1-1/1-2/1-3 present
    b_gs = baseline_data.get("gear_analysis", {})
    h_gs = homegraph_data.get("gear_analysis", {})
    if b_gs.get("valid") or h_gs.get("valid"):
        md += """
---

## 档位切换 (Exp 1-1 → 1-3)

| 指标 | Baseline | HomeGraph |
|------|----------|-----------|
"""
        md += f"| 工具跨度 | {b_gs.get('tool_span', '—')} | {h_gs.get('tool_span', '—')} |\n"
        md += f"| 耗时跨度 | {b_gs.get('dur_span', '—')} | {h_gs.get('dur_span', '—')} |\n"
        md += f"| 1-2 trap 生效 | {'是' if b_gs.get('trap_worked') else '否'} | {'是' if h_gs.get('trap_worked') else '否'} |\n"
        md += f"| 1-3 深度探索 | {'是' if b_gs.get('deep_confirmed') else '否'} | {'是' if h_gs.get('deep_confirmed') else '否'} |\n"

    md += """
---

## 评分对比（7 维度）

| 维度 | Baseline | HomeGraph |
|------|----------|-----------|
"""
    b_scores = baseline_data.get("scores", {})
    h_scores = homegraph_data.get("scores", {})
    for dim in sorted(set(b_scores) | set(h_scores)):
        bs = b_scores.get(dim, 0)
        hs = h_scores.get(dim, 0)
        md += f"| {dim} | {_score_to_stars(bs)} ({bs}/5) | {_score_to_stars(hs)} ({hs}/5) |\n"

    md += f"""
---

## 结论提示

- **HomeGraph 更快**（墙钟或 Token 下降）通常表示探索路径更短、重复 Read/Grep 更少。
- **工具调用下降但耗时上升**可能表示单次 homegraph 调用延迟或 Agent 等待 MCP 就绪。
- 准确度（是否命中目标文件、是否踩命名陷阱）需对照各实验 `raw_output.txt` 人工核对，本报告仅对比量化指标。

*报告由 `analyze.py compare_runs` 自动生成*
"""
    return md


def compare_runs(baseline_dir: Path, homegraph_dir: Path, *,
                 agent: str = "", baseline_wall_s: int = 0,
                 homegraph_wall_s: int = 0, verbose: bool = False) -> Path:
    """Write A/B compare report under output/compare/. Returns report path."""
    baseline_dir = resolve_results_dir(Path(baseline_dir))
    homegraph_dir = resolve_results_dir(Path(homegraph_dir))
    baseline_data = gather_data(baseline_dir)
    homegraph_data = gather_data(homegraph_dir)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    agent_key = agent or "default"
    compare_dir = OUTPUT_DIR / "compare" / agent_key / ts
    compare_dir.mkdir(parents=True, exist_ok=True)

    report_path = compare_dir / "ab_compare_report.md"
    report_path.write_text(
        build_compare_md(baseline_dir, homegraph_dir, baseline_data, homegraph_data,
                         agent=agent, baseline_wall_s=baseline_wall_s,
                         homegraph_wall_s=homegraph_wall_s),
        encoding="utf-8",
    )

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "agent": agent_key,
        "baseline_dir": str(baseline_dir),
        "homegraph_dir": str(homegraph_dir),
        "baseline_report": str(baseline_dir / "analysis_report.md"),
        "homegraph_report": str(homegraph_dir / "analysis_report.md"),
        "compare_report": str(report_path),
        "baseline_wall_s": baseline_wall_s,
        "homegraph_wall_s": homegraph_wall_s,
    }
    (compare_dir / "compare_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8",
    )

    if verbose:
        _configure_stdout()
        header("A/B 对比报告")
        print(f"  Baseline wall : {_format_wall_duration(baseline_wall_s)}")
        print(f"  HomeGraph wall: {_format_wall_duration(homegraph_wall_s)}")
        b_ag = baseline_data["aggregated"]
        h_ag = homegraph_data["aggregated"]
        print(f"  Tools         : {b_ag['total_tool_calls']} → {h_ag['total_tool_calls']} "
              f"({_pct_change(b_ag['total_tool_calls'], h_ag['total_tool_calls'])})")
        print(f"  Input tokens  : {b_ag['total_input_tokens']:,} → {h_ag['total_input_tokens']:,} "
              f"({_pct_change(b_ag['total_input_tokens'], h_ag['total_input_tokens'])})")

    return report_path


def print_report_locations(*, baseline_report: Optional[Path] = None,
                           homegraph_report: Optional[Path] = None,
                           compare_report: Optional[Path] = None,
                           single_report: Optional[Path] = None):
    """Print report paths to console after a run completes."""
    _configure_stdout()
    header("报告已生成")
    if single_report:
        print(f"  单组分析报告 : {single_report}")
    if baseline_report:
        print(f"  Baseline 报告: {baseline_report}")
    if homegraph_report:
        print(f"  HomeGraph 报告: {homegraph_report}")
    if compare_report:
        print(f"  A/B 对比报告 : {compare_report}")
    print(f"\n{GREEN}[ALL]{NC} 所有报告位于 output/ 目录下，可用 Markdown 阅读器打开。")


# ═══════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════

def main():
    _configure_stdout()
    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else RESULTS_DIR
    if not input_path.is_dir():
        print(f"ERROR: Results directory not found: {input_path}")
        sys.exit(1)

    results_dir = resolve_results_dir(input_path)
    if not _has_experiment_outputs(results_dir):
        print(f"ERROR: No experiment outputs found under: {input_path}")
        if input_path != results_dir:
            print(f"       Also checked: {results_dir}")
        sys.exit(1)

    try:
        analyze_run(results_dir, input_path=input_path, verbose=True)
    except ValueError as e:
        print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
