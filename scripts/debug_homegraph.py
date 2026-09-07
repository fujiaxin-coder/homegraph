#!/usr/bin/env python3
"""Read-only HomeGraph MCP/Planner debugger. Python 3.10+, standard library only."""
import argparse
import contextlib
import datetime as dt
import hashlib
import http.server
import json
import os
from pathlib import Path, PurePosixPath
import queue
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

READ_TOOLS = {"homegraph_" + x for x in (
    "project", "explore", "search", "node", "usages", "native", "modules", "callers", "callees")}
MAX_FRAME = 16 * 1024 * 1024


def now():
    return dt.datetime.now().astimezone().isoformat()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write("\n")


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def stop(process):
    if process is None or process.poll() is not None:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            if os.name == "posix":
                os.killpg(process.pid, sig)  # Only our new-session subprocess.
            elif sig == signal.SIGTERM:
                process.terminate()
            else:
                process.kill()
            process.wait(timeout=3)
            return
        except ProcessLookupError:
            return
        except subprocess.TimeoutExpired:
            continue


def clean_env():
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL", "LC_CTYPE",
               "TMPDIR", "TMP", "TEMP", "HOME", "USERPROFILE"}
    env = {k: v for k, v in os.environ.items() if k in allowed}
    env.update(HOMEGRAPH_NO_DAEMON="1", HOMEGRAPH_NO_WATCH="1",
               HOMEGRAPH_WASM_RELAUNCHED="1", HOMEGRAPH_AUTO_INIT="0",
               HOMEGRAPH_MCP_TOOLS=",".join(x.removeprefix("homegraph_") for x in sorted(READ_TOOLS)),
               CODEGRAPH_QUERY_BUSY_TIMEOUT_MS="15000", HOMEGRAPH_QUERY_PLANNER_TIMEOUT_MS="10000")
    return env


def prepare_archive(source, base, output):
    """Extract only regular files/directories; never follow archive symlinks."""
    commit = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "--verify", base + "^{commit}"],
        text=True, timeout=15).strip()
    archive = output / "base.tar"
    with archive.open("xb") as stream:
        subprocess.run(["git", "-C", str(source), "archive", "--format=tar", commit],
                       stdout=stream, check=True, timeout=90)
    repo = output / "repo"
    repo.mkdir()
    total = 0
    with tarfile.open(archive) as tar:
        for member in tar:
            relative = PurePosixPath(member.name)
            if (relative.is_absolute() or ".." in relative.parts or "\\" in member.name
                    or any(p.lower() in {".git", ".homegraph"} for p in relative.parts)
                    or not (member.isdir() or member.isfile())):
                raise ValueError("Unsupported archive member: " + member.name)
            total += member.size
            if total > 2 * 1024 ** 3:
                raise ValueError("Archive exceeds 2 GiB source budget")
            target = repo.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            else:
                with tar.extractfile(member) as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(member.mode & 0o777)
    archive.unlink()  # Only the temporary tar; extracted source stays in output.
    return repo, commit


def run_index(homegraph, repo, output, timeout):
    code = """
const lib = require(process.argv[1]);
const HG = lib.HomeGraph ?? lib.default?.HomeGraph ?? lib.default;
(async () => { let graph;
 try { graph = await HG.init(process.argv[2], {index:false});
  const result = await graph.indexAll(); console.log(JSON.stringify(result));
  if (!result?.success) process.exitCode=1;
 } finally { graph?.destroy(); }
})().catch(e => { console.error(e.stack); process.exitCode=1; });
"""
    with (output / "index.stdout.log").open("x") as out, (output / "index.stderr.log").open("x") as err:
        proc = subprocess.Popen(["node", "--liftoff-only", "-e", code,
                                 str(homegraph / "dist/index.js"), str(repo)],
                                cwd=repo, env=clean_env(), stdout=out, stderr=err, start_new_session=True)
        started = time.monotonic()
        try:
            code = proc.wait(timeout=timeout)
            save(output / "index.json", {"exit_code": code, "seconds": time.monotonic() - started})
            if code:
                raise RuntimeError("Index failed; inspect index.stderr.log")
        finally:
            stop(proc)


def planner_endpoint(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("Planner URL must be an explicit HTTP(S) endpoint without credentials/query/fragment")
    path = parsed.path.rstrip("/")
    if not path.endswith("/chat/completions"):
        path += "/chat/completions"
    return urllib.parse.urlunsplit(parsed._replace(path=path))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def bounded_body(response, timeout=12):
    deadline, parts, size = time.monotonic() + timeout, [], 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Planner response deadline")
        # HTTPError wraps an HTTPResponse; both expose read1 and the socket below.
        stream = response.fp if isinstance(response, urllib.error.HTTPError) else response
        sock = getattr(getattr(getattr(stream, "fp", None), "raw", None), "_sock", None)
        if sock is not None:
            sock.settimeout(remaining)
        part = response.read1(min(65536, MAX_FRAME + 1 - size))
        if not part:
            return b"".join(parts)
        parts.append(part)
        size += len(part)
        if size > MAX_FRAME:
            raise ValueError("Planner response exceeds capture budget")


class PlannerRecorder:
    """Capture only Planner body/response; keys and HTTP headers never go to disk."""
    def __init__(self, endpoint, key, output):
        self.endpoint, self.key, self.output = planner_endpoint(endpoint), key, output
        self.sequence, self.label = 0, "unassigned"
        self.lock = threading.Lock()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                if self.path != "/v1/chat/completions":
                    self.send_error(404)
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_FRAME:
                    self.send_error(413)
                    return
                body = self.rfile.read(length)
                with owner.lock:
                    owner.sequence += 1
                    label = owner.label
                    destination = owner.output / f"{owner.sequence:03d}-{label}"
                destination.mkdir(parents=True)
                started = time.monotonic()
                status, error, response = 502, None, b""
                try:
                    save(destination / "request.json", json.loads(body))
                    request = urllib.request.Request(owner.endpoint, data=body, method="POST",
                        headers={"Content-Type": "application/json", "Authorization": "Bearer " + owner.key})
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                    try:
                        with opener.open(request, timeout=12) as upstream:
                            status, response = upstream.status, bounded_body(upstream)
                    except urllib.error.HTTPError as exc:
                        with exc:
                            status, response = exc.code, bounded_body(exc)
                    if len(response) > MAX_FRAME:
                        raise ValueError("Planner response exceeds capture budget")
                    (destination / "response.body").write_bytes(response)
                    try:
                        envelope = json.loads(response)
                        save(destination / "response.json", envelope)
                        content = envelope.get("choices", [{}])[0].get("message", {}).get("content", "")
                        raw = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", content)
                        save(destination / "raw-plan.json", json.loads(raw))
                    except (ValueError, TypeError, AttributeError, IndexError):
                        pass  # Preserve malformed bodies and provider failures as observations.
                except Exception as exc:
                    error = type(exc).__name__
                    status, response = 502, json.dumps({"error": error}).encode()
                finally:
                    save(destination / "meta.json", {"status": status, "error": error,
                         "seconds": time.monotonic() - started, "step": label})
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class MCPClient:
    def __init__(self, command, repo, env, output):
        output.mkdir(parents=True)
        self.output, self.seq = output, 0
        self.inbox = queue.Queue()
        self.lock = threading.Lock()
        self.wire = (output / "mcp.jsonl").open("x", encoding="utf-8")
        self.stderr = (output / "server.stderr.log").open("x")
        self.proc = subprocess.Popen(command, cwd=repo, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=self.stderr, start_new_session=True)
        save(output / "process.json", {"pid": self.proc.pid, "started_at": now(), "command": command})
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def record(self, direction, value):
        with self.lock:
            self.wire.write(json.dumps({"at": now(), "direction": direction, "message": value}, ensure_ascii=False) + "\n")
            self.wire.flush()

    def _read(self):
        try:
            while True:
                raw = self.proc.stdout.readline(MAX_FRAME + 1)
                if not raw:
                    break
                if len(raw) > MAX_FRAME:
                    raise ValueError("Oversized MCP frame")
                try:
                    value = json.loads(raw)
                except ValueError:
                    self.record("non-json-stdout", raw.decode("utf-8", "replace"))
                    continue
                self.record("response", value)
                self.inbox.put(value)
        except Exception as exc:
            self.inbox.put({"reader_error": type(exc).__name__})
        finally:
            self.inbox.put(None)

    def send(self, value):
        self.record("request", value)
        self.proc.stdin.write((json.dumps(value, ensure_ascii=False) + "\n").encode())
        self.proc.stdin.flush()

    def request(self, method, params, timeout=30):
        self.seq += 1
        request_id = self.seq
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        end = time.monotonic() + timeout
        while True:
            try:
                item = self.inbox.get(timeout=max(.001, end - time.monotonic()))
            except queue.Empty:
                raise TimeoutError("MCP deadline: " + method) from None
            if item is None or "reader_error" in item:
                raise RuntimeError("MCP stdout closed or invalid; inspect server.stderr.log")
            if "method" in item and "id" in item:
                payload = {"result": {"roots": []}} if item["method"] == "roots/list" else {
                    "error": {"code": -32601, "message": "Unsupported client method"}}
                self.send({"jsonrpc": "2.0", "id": item["id"], **payload})
            elif item.get("id") == request_id and "method" not in item:
                if "error" in item:
                    raise RuntimeError("MCP protocol error: " + json.dumps(item["error"]))
                return item["result"]
            if time.monotonic() >= end:
                raise TimeoutError("MCP deadline: " + method)

    def initialize(self):
        result = self.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
             "clientInfo": {"name": "python-retrieval-debugger", "version": "1"}}, timeout=60)
        save(self.output / "initialize.json", result)
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        inventory = self.request("tools/list", {})
        save(self.output / "tools.json", inventory)
        return {tool["name"]: tool for tool in inventory["tools"]}

    def close(self):
        with contextlib.suppress(BrokenPipeError, OSError):
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            stop(self.proc)
        self.reader.join(timeout=3)
        self.proc.stdout.close()
        self.stderr.close()
        self.wire.close()
        save(self.output / "exit.json", {"returncode": self.proc.poll(), "ended_at": now()})


def summarize(result):
    text = "\n".join(x.get("text", "") for x in result.get("content", []) if x.get("type") == "text")
    meta = result.get("_meta") or {}
    plan = meta.get("homegraphQueryPlan") or {}
    evidence = meta.get("homegraphEvidence") or {}
    return {"is_error": bool(result.get("isError")), "characters": len(text),
            "plan_source": plan.get("source"), "planning_reason": plan.get("planningReason"),
            "model_requests": plan.get("modelRequests", 0), "planning_ms": plan.get("planningMs"),
            "fallback": plan.get("fallbackReason"), "plan_steps": plan.get("steps", []),
            "planner_seeds": plan.get("plannerSeeds"), "evidence_status": evidence.get("status"),
            "files": evidence.get("files", []), "uncovered": evidence.get("uncoveredObligations", [])}, text


def render_report(output, case, rows):
    lines = ["# HomeGraph retrieval debug", "", case["title"], "",
        "Task session: original task plus recovery/guard probes. Guided/imports sessions: separately prepared source anchors; not autonomous discovery. Specialized tool emissions also consume retrieval history; imports starts its own diagnostic session.", "",
        "| Mode | Session | Step | Tool | Seconds | Plan | Requests | Evidence | Error/fallback |",
        "|---|---|---|---|---:|---|---:|---|---|"]
    for row in rows:
        values = [row["mode"], row["session"], row["id"], row["tool"], f'{row["seconds"]:.2f}',
                  row.get("plan_source"), row.get("model_requests", 0), row.get("evidence_status"),
                  row.get("error") or row.get("fallback") or ("tool error" if row.get("is_error") else "")]
        lines.append("| " + " | ".join(str("—" if v is None or v == "" else v).replace("|", "\\|") for v in values) + " |")
    lines += ["", "## Interpretation", "",
              "Transport success, nonempty text and a valid plan do not prove useful evidence or task correctness.",
              "Missing call edges can reflect dynamic NAPI dispatch. Inspect native registration evidence separately.",
              "The script does not implement the requested feature or run an SDK/device test.", "",
              "Each steps/*/result.md contains full tool evidence; result.json contains raw metadata.",
              "planner/*/raw-plan.json is the model's proposal BEFORE validation, not necessarily the accepted plan.",
              "summary.json includes compiled per-step diagnostics. sessions/*/mcp.jsonl preserves transport messages.", "",
              *["- " + item for item in case.get("limitations", [])]]
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (output / "summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--homegraph", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--case", type=Path, default=Path(__file__).parent / "demos/spatial-upscale.json")
    parser.add_argument("--source-repo", type=Path, help="Local Git repository; original base is archived without changing it")
    parser.add_argument("--output", type=Path, help="New directory; existing directories are refused")
    parser.add_argument("--mode", choices=["rules", "llm", "both"], default="rules")
    parser.add_argument("--only", help="Comma-separated step IDs")
    parser.add_argument("--list-steps", action="store_true")
    parser.add_argument("--interactive", action="store_true", help="Press Enter before each tool call")
    parser.add_argument("--print-chars", type=int, default=350)
    parser.add_argument("--index-timeout", type=int, default=600)
    parser.add_argument("--planner-url", help="Explicit compatible endpoint, e.g. http://127.0.0.1:8002/v1")
    parser.add_argument("--planner-model", default="qwen3-32b")
    parser.add_argument("--planner-key-env", default="HOMEGRAPH_QUERY_PLANNER_API_KEY")
    args = parser.parse_args(argv)
    case = json.loads(args.case.read_text(encoding="utf-8"))
    steps = case["steps"]
    if args.list_steps:
        for s in steps:
            print(f'{s["id"]:16} {s["session"]:8} {s["tool"]:22} {s["purpose"]}')
        return 0
    if not args.source_repo:
        parser.error("--source-repo is required")
    if args.interactive and not sys.stdin.isatty():
        parser.error("--interactive requires a terminal")
    if args.only:
        wanted = set(args.only.split(","))
        if wanted - {s["id"] for s in steps}:
            parser.error("Unknown step IDs: " + ",".join(sorted(wanted - {s["id"] for s in steps})))
        steps = [s for s in steps if s["id"] in wanted]
    for s in steps:
        if (s["tool"] not in READ_TOOLS or not re.fullmatch(r"[a-z0-9_]+", s["id"])
                or not re.fullmatch(r"[a-z0-9_]+", s["session"])):
            parser.error("Case contains an unsupported tool or unsafe step/session name")
    if args.mode != "rules" and not args.planner_url:
        parser.error("LLM mode requires --planner-url; no implicit external provider is used")
    if args.planner_url:
        planner_endpoint(args.planner_url)
    homegraph = args.homegraph.resolve()
    if not (homegraph / "dist/bin/homegraph.js").is_file():
        parser.error("HomeGraph build is missing; run npm run build")
    output = (args.output or Path.cwd() / ".homegraph-debug" / dt.datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
    output.mkdir(parents=True, exist_ok=False)
    output.chmod(0o700)
    save(output / "case.json", case)
    print("Artifacts:", output, flush=True)
    rows, recorder = [], None
    try:
        repo, commit = prepare_archive(args.source_repo.resolve(), case["base_commit"], output)
        files = {str(p.relative_to(repo)): digest(p) for p in repo.rglob("*") if p.is_file()}
        save(output / "source-sha256.json", files)
        build = {str(p.relative_to(homegraph)): digest(p) for name in ("src", "dist")
                 for p in (homegraph / name).rglob("*") if p.is_file()}
        save(output / "build-sha256.json", build)
        save(output / "manifest.json", {"started_at": now(), "base_commit": commit,
             "homegraph": str(homegraph), "repo": str(repo), "case": case["id"], "mode": args.mode,
             "planner_endpoint": planner_endpoint(args.planner_url) if args.mode != "rules" else None,
             "planner_model": args.planner_model, "guided_anchor_origin": case["guided_anchor_origin"]})
        print("Indexing independent base checkout...", flush=True)
        run_index(homegraph, repo, output, args.index_timeout)
        if args.mode != "rules":
            recorder = PlannerRecorder(args.planner_url, os.environ.get(args.planner_key_env, "EMPTY"), output / "planner")
        modes = ["rules", "llm"] if args.mode == "both" else [args.mode]
        for mode in modes:
            for group in dict.fromkeys(s["session"] for s in steps):
                print(f"\n=== {mode} / {group}: new MCP session ===", flush=True)
                env = clean_env()
                env.update(HOMEGRAPH_QUERY_PLANNER=mode, HOMEGRAPH_QUERY_TASK_CONTEXT=case["task"])
                if mode == "llm":
                    env.update(HOMEGRAPH_QUERY_PLANNER_URL=recorder.url,
                               HOMEGRAPH_QUERY_PLANNER_MODEL=args.planner_model,
                               HOMEGRAPH_QUERY_PLANNER_API_KEY="LOCAL_CAPTURE_ONLY")
                client = MCPClient(["node", "--liftoff-only", str(homegraph / "dist/bin/homegraph.js"),
                                    "serve", "mcp", "--path", str(repo)], repo, env,
                                   output / "sessions" / f"{mode}-{group}")
                try:
                    inventory = client.initialize()
                    for step in (s for s in steps if s["session"] == group):
                        label = f'{mode}-{step["id"]}'
                        if recorder:
                            recorder.label = label
                        print(f'\n[{label}] {step["tool"]}: {step["purpose"]}', flush=True)
                        if args.interactive:
                            input("Enter to execute (Ctrl+C preserves completed artifacts): ")
                        destination = output / "steps" / label
                        destination.mkdir(parents=True)
                        save(destination / "input.json", step)
                        started = time.monotonic()
                        row = {"mode": mode, "session": group, "id": step["id"], "tool": step["tool"]}
                        fatal = False
                        try:
                            if step["tool"] not in inventory:
                                raise ValueError("Tool unavailable in tools/list")
                            result = client.request("tools/call", {"name": step["tool"], "arguments": step["arguments"]})
                            save(destination / "result.json", result)
                            summary, text = summarize(result)
                            row.update(summary)
                            (destination / "result.md").write_text(text, encoding="utf-8")
                            print(json.dumps(summary, ensure_ascii=False), flush=True)
                            if args.print_chars > 0:
                                print(text[:args.print_chars], flush=True)
                        except (TimeoutError, RuntimeError, OSError, ValueError) as exc:
                            row["error"] = str(exc)
                            save(destination / "error.json", {"error": str(exc)})
                            print("ERROR:", exc, flush=True)
                            fatal = isinstance(exc, (TimeoutError, RuntimeError, OSError))
                        row["seconds"] = time.monotonic() - started
                        rows.append(row)
                        render_report(output, case, rows)
                        if fatal:
                            break  # Never reuse a timed-out/broken transport as if synchronized.
                finally:
                    client.close()
        changed = [name for name, sha in files.items() if not (repo / name).is_file() or digest(repo / name) != sha]
        save(output / "source-integrity.json", {"changed_files": changed, "original_files": len(files)})
        if changed:
            raise RuntimeError("Source changed during read-only demo")
        print("\nReport:", output / "report.md", flush=True)
        return int(any(r.get("error") or r.get("is_error") for r in rows))
    finally:
        if recorder:
            recorder.close()
        render_report(output, case, rows)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted; completed artifacts retained.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
