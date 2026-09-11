"""Proxy capture + forward for reverse-engineering official claude.exe.

Usage:
    python temp/proxy_stream.py [--port 8899] [--target https://api.deepseek.com/anthropic]
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CAPTURE_DIR = os.path.join(SCRIPT_DIR)
os.makedirs(CAPTURE_DIR, exist_ok=True)

seq = 0
target_base = "https://api.deepseek.com/anthropic"
auth_token = ""


class ProxyHandler(BaseHTTPRequestHandler):

    def _handle(self, method):
        global seq
        start = time.time()

        # Log every request to stderr
        print(f"\n>>> {method} {self.path}", file=sys.stderr)
        for k, v in self.headers.items():
            print(f"    {k}: {v}", file=sys.stderr)

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b""

        if body and method == "POST":
            seq += 1
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            filename = f"capture_{timestamp}_{seq:04d}.json"
            filepath = os.path.join(CAPTURE_DIR, filename)

            try:
                data = json.loads(body)
            except Exception:
                data = {"_raw": body.decode("utf-8", errors="replace")}

            system_len = 0
            if isinstance(data.get("system"), list):
                system_len = len(json.dumps(data["system"]))
            elif isinstance(data.get("system"), str):
                system_len = len(data["system"])
            tools_count = len(data.get("tools", []))
            model = data.get("model", "?")

            print(f"[{seq}] CAPTURE {filename}", file=sys.stderr)
            print(f"    model={model} tools={tools_count} system_len={system_len} body={len(body)}B", file=sys.stderr)

            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

        # Forward
        target_url = target_base + self.path
        req = urllib.request.Request(target_url, data=body, method=method)

        for key, val in self.headers.items():
            kl = key.lower()
            if kl in ("host", "content-length", "transfer-encoding", "connection", "accept-encoding"):
                continue
            req.add_header(key, val)

        from urllib.parse import urlparse
        target_host = urlparse(target_base).netloc
        req.add_header("Host", target_host)

        if auth_token:
            has_auth = any(k.lower() == "authorization" for k in self.headers.keys())
            if not has_auth:
                req.add_header("Authorization", f"Bearer {auth_token}")

        try:
            resp = urllib.request.urlopen(req, timeout=120)
            self.send_response(resp.status)
            for key, val in resp.headers.items():
                if key.lower() in ("transfer-encoding", "connection", "content-encoding"):
                    continue
                self.send_header(key, val)
            self.end_headers()

            total = 0
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                total += len(chunk)
            elapsed = time.time() - start
            print(f"    <- {resp.status} {total}B {elapsed:.1f}s", file=sys.stderr)

        except urllib.error.HTTPError as e:
            body_err = e.read()
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(body_err)
            print(f"    <- ERROR {e.code} {e.reason}", file=sys.stderr)

    def do_POST(self): self._handle("POST")
    def do_GET(self): self._handle("GET")
    def do_OPTIONS(self): self._handle("OPTIONS")
    def do_HEAD(self): self._handle("HEAD")
    def do_DELETE(self): self._handle("DELETE")

    def log_message(self, format, *args):
        pass


def main():
    global target_base, auth_token
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument("--target", default="https://api.deepseek.com/anthropic")
    parser.add_argument("--auth-token", default="")
    args = parser.parse_args()

    target_base = args.target.rstrip("/")
    auth_token = args.auth_token

    print(f"Proxy: 127.0.0.1:{args.port} -> {args.target}", file=sys.stderr)
    print(f"Captures: {CAPTURE_DIR}/", file=sys.stderr)

    server = HTTPServer(("127.0.0.1", args.port), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping...", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()
