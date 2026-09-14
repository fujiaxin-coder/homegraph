import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/debug_homegraph.py"
spec = importlib.util.spec_from_file_location("debug_homegraph", SCRIPT)
debug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(debug)


class DebuggerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hg-python-debug-test-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_archive_is_independent_and_keeps_git_checkout_unchanged(self):
        source = self.root / "source"
        source.mkdir()
        subprocess.run(["git", "init", "-q", str(source)], check=True)
        (source / "example.ts").write_text("original")
        subprocess.run(["git", "-C", str(source), "add", "."], check=True)
        subprocess.run(["git", "-C", str(source), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@localhost", "commit", "-qm", "base"], check=True)
        (source / "example.ts").write_text("user work")
        output = self.root / "output"
        output.mkdir()
        repo, commit = debug.prepare_archive(source, "HEAD", output)
        self.assertEqual(len(commit), 40)
        self.assertEqual((repo / "example.ts").read_text(), "original")
        (repo / "example.ts").write_text("local experiment")
        self.assertEqual((source / "example.ts").read_text(), "user work")
        self.assertFalse((repo / ".git").exists())

    def test_archive_rejects_traversal_and_symlinks(self):
        for name, kind in [("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE)]:
            output = self.root / ("regular" if kind == tarfile.REGTYPE else "symlink")
            output.mkdir()
            def archive(*args, **kwargs):
                with tarfile.open(fileobj=kwargs["stdout"], mode="w") as tar:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = "../escape"
                    tar.addfile(member)
            with patch.object(debug.subprocess, "check_output", return_value="a" * 40), \
                    patch.object(debug.subprocess, "run", side_effect=archive):
                with self.assertRaises(ValueError):
                    debug.prepare_archive(self.root, "HEAD", output)
            self.assertFalse((self.root / "escape").exists())

    def test_mcp_partial_frames_server_request_and_non_json_logs(self):
        peer = r'''
import sys,json
for raw in sys.stdin:
    request=json.loads(raw)
    if "method" not in request or "id" not in request: continue
    print("diagnostic stdout line",flush=True)
    print(json.dumps({"jsonrpc":"2.0","id":999,"method":"roots/list","params":{}}),flush=True)
    answer=json.loads(sys.stdin.readline())
    message=json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"roots_answer":answer["result"],"echo":request["params"]}})+"\n"
    sys.stdout.write(message[:7]);sys.stdout.flush()
    sys.stdout.write(message[7:]);sys.stdout.flush()
'''
        client = debug.MCPClient([sys.executable, "-u", "-c", peer], self.root,
                                 os.environ.copy(), self.root / "mcp")
        try:
            result = client.request("example", {"query": "中文"}, timeout=3)
            self.assertEqual(result["echo"]["query"], "中文")
            self.assertEqual(result["roots_answer"], {"roots": []})
        finally:
            client.close()
        wire = [json.loads(line) for line in (self.root / "mcp/mcp.jsonl").read_text().splitlines()]
        self.assertTrue(any(x["direction"] == "non-json-stdout" for x in wire))

    def test_eof_is_immediate_instead_of_waiting_for_deadline(self):
        client = debug.MCPClient([sys.executable, "-c", "pass"], self.root,
                                 os.environ.copy(), self.root / "mcp")
        started = time.monotonic()
        try:
            with self.assertRaises((RuntimeError, BrokenPipeError)):
                client.request("test", {}, timeout=10)
            self.assertLess(time.monotonic() - started, 3)
        finally:
            client.close()

    def test_timeout_closes_owned_process(self):
        client = debug.MCPClient([sys.executable, "-c", "import time;time.sleep(60)"], self.root,
                                 os.environ.copy(), self.root / "mcp")
        try:
            with self.assertRaises(TimeoutError):
                client.request("test", {}, timeout=.05)
        finally:
            client.close()
        self.assertIsNotNone(client.proc.poll())

    def test_planner_capture_preserves_invalid_plan_and_redacts_auth(self):
        received = []
        class Upstream(debug.http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                received.append(self.headers.get("Authorization"))
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                content = '{"steps": []}' if request.get("query") == "proposal" else "invalid json"
                body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
                self.send_response(200);self.send_header("Content-Length", str(len(body)))
                self.end_headers();self.wfile.write(body)
        upstream = debug.http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True);thread.start()
        capture = debug.PlannerRecorder(f"http://127.0.0.1:{upstream.server_port}/v1",
                                        "super-secret-fixture-key", self.root / "planner")
        try:
            req = urllib.request.Request(capture.url + "/chat/completions", data=b'{"query":"hello"}')
            with urllib.request.urlopen(req, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(b"invalid json", response.read())
            req = urllib.request.Request(capture.url + "/chat/completions", data=b'{"query":"proposal"}')
            with urllib.request.urlopen(req, timeout=3) as response:
                self.assertEqual(response.status, 200)
        finally:
            capture.close();upstream.shutdown();upstream.server_close();thread.join()
        self.assertEqual(received, ["Bearer super-secret-fixture-key"] * 2)
        bodies = "".join(p.read_text() for p in (self.root / "planner").rglob("*") if p.is_file())
        self.assertNotIn("super-secret-fixture-key", bodies)
        self.assertTrue(list((self.root / "planner").glob("*/response.json")))
        proposals = list((self.root / "planner").glob("*/raw-plan.json"))
        self.assertEqual(len(proposals), 1)
        self.assertEqual(json.loads(proposals[0].read_text()), {"steps": []})

    def test_provider_failure_is_preserved(self):
        capture = debug.PlannerRecorder("http://127.0.0.1:1/v1", "EMPTY", self.root / "planner")
        try:
            req = urllib.request.Request(capture.url + "/chat/completions", data=b'{}')
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(req, timeout=3)
            self.assertEqual(raised.exception.code, 502)
            raised.exception.close()
        finally:
            capture.close()
        meta = json.loads(next((self.root / "planner").glob("*/meta.json")).read_text())
        self.assertEqual(meta["status"], 502)
        self.assertEqual(meta["error"], "URLError")

    def test_endpoint_and_report_distinguish_proposal_from_evidence(self):
        with self.assertRaises(ValueError):debug.planner_endpoint("https://name:secret@example.org/v1")
        self.assertEqual(debug.planner_endpoint("http://127.0.0.1:8002/v1"), "http://127.0.0.1:8002/v1/chat/completions")
        result = {"content": [{"type": "text", "text": "No evidence"}], "_meta": {
            "homegraphQueryPlan": {"source": "rules", "fallbackReason": "invalid_plan", "modelRequests": 1},
            "homegraphEvidence": {"status": "empty"}}}
        summary, text = debug.summarize(result)
        self.assertEqual(summary["fallback"], "invalid_plan")
        self.assertEqual(summary["evidence_status"], "empty")
        debug.render_report(self.root, {"title": "Example"}, [dict(summary, mode="llm", session="task", id="plan", tool="homegraph_explore", seconds=.1)])
        report = (self.root / "report.md").read_text()
        self.assertIn("not necessarily the accepted plan", report)
        self.assertIn("invalid_plan", report)


if __name__ == "__main__":
    unittest.main()
