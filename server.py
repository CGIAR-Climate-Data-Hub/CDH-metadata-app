#!/usr/bin/env python3
"""
Single-server for CDH Metadata App.
Serves index.html on GET /  and proxies POST /api/chat → OpenCode Zen.
No CORS issues because everything is on the same origin.

Usage:
    python server.py          # runs on http://localhost:8000
    python server.py 9000     # custom port
"""
import sys, os, json, urllib.request, urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler

ZEN_BASE  = "https://opencode.ai/zen/v1"
PORT      = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_POST(self):
        if self.path == "/api/chat":
            self._proxy("/chat/completions")
        else:
            self.send_error(404)

    def _proxy(self, zen_path):
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length)
        target = ZEN_BASE + zen_path

        req = urllib.request.Request(
            target, data=body,
            headers={
                "Content-Type":  "application/json",
                "Authorization": self.headers.get("Authorization", ""),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = r.read()
                self.send_response(r.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(resp)
        except urllib.error.HTTPError as e:
            resp = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(resp)
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()}  {fmt % args}")


if __name__ == "__main__":
    print(f"\n  CDH Metadata App")
    print(f"  ─────────────────────────────────────")
    print(f"  Open →  http://localhost:{PORT}")
    print(f"  API  →  {ZEN_BASE}")
    print(f"  Ctrl+C to stop\n")
    HTTPServer(("", PORT), Handler).serve_forever()
