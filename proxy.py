#!/usr/bin/env python3
"""
Zero-dependency CORS proxy for OpenCode Zen API.

Run:  python proxy.py
Then open index.html in your browser (or serve with: python -m http.server 8080)
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.request, json

ZEN_BASE = "https://opencode.ai/zen/v1"
PORT = 3001

class Handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length)
        target = ZEN_BASE + self.path          # e.g. /chat/completions

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
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(resp)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def log_message(self, fmt, *args):
        print(f"[proxy] {fmt % args}")

if __name__ == "__main__":
    print(f"CDH proxy  →  http://localhost:{PORT}")
    print(f"Forwarding →  {ZEN_BASE}")
    print(f"Open index.html or run: python -m http.server 8080")
    HTTPServer(("", PORT), Handler).serve_forever()
