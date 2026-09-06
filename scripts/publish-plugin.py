#!/usr/bin/env python3
"""Publish a GUI plugin package to the registry server.

Usage:
  python scripts/publish-plugin.py \
      --manifest meta.yaml --zip my-plugin.zip --api-key sk-xxxx \
      [--host http://192.168.186.96:8765]

The server endpoint: POST /api/packages (form: manifest YAML, type=plugin, skills=zip file).
Manifest metadata (name/author/version...) is the MARKET display info; the plugin's
real behaviour lives in plugin.json inside the zip (must exist at zip root).

stdlib only (urllib) — no pip install needed.
"""
import argparse
import sys
import uuid
import urllib.request
import urllib.error


def main() -> int:
    ap = argparse.ArgumentParser(description="Publish a GUI plugin package")
    ap.add_argument("--manifest", required=True, help="Path to manifest YAML (name/author/version/...)")
    ap.add_argument("--zip", required=True, help="Path to plugin zip (must contain plugin.json at root)")
    ap.add_argument("--api-key", required=True, help="Registry API key (sk-...)")
    ap.add_argument("--host", default="http://192.168.186.96:8765", help="Registry base URL")
    args = ap.parse_args()

    with open(args.manifest, encoding="utf-8") as f:
        manifest_text = f.read()
    with open(args.zip, "rb") as f:
        zip_bytes = f.read()

    # multipart/form-data (stdlib)
    boundary = uuid.uuid4().hex

    def field(name: str, val: str) -> bytes:
        return (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{val}\r\n').encode()

    body = b""
    body += field("manifest", manifest_text)
    body += field("type", "plugin")
    filename = args.zip.replace("\\", "/").split("/")[-1]
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="skills"; filename="{filename}"\r\n'
             f'Content-Type: application/zip\r\n\r\n').encode()
    body += zip_bytes + b"\r\n"
    body += f'--{boundary}--\r\n'.encode()

    req = urllib.request.Request(f"{args.host.rstrip('/')}/api/packages", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("X-API-Key", args.api_key)

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            print(f"HTTP {resp.status}")
            print(resp.read().decode(errors="replace")[:1000])
            return 0 if resp.status < 400 else 1
    except urllib.error.HTTPError as e:
        print(f"HTTP ERROR {e.code}")
        print(e.read().decode(errors="replace")[:1000])
        return 1
    except Exception as e:
        print(f"FAIL: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
