#!/usr/bin/env python3
"""Publish a GUI plugin package to the registry server.

Usage:
  python scripts/publish-plugin.py \
      --manifest meta.yaml --zip my-plugin.zip --api-key sk-xxxx \
      [--host http://192.168.186.96:8765]

The server endpoint: POST /api/packages (form: manifest YAML, type=plugin, skills=zip file).
Manifest metadata (name/author/version...) is the MARKET display info; the plugin's
real behaviour lives in plugin.json inside the zip (must exist at zip root).
"""
import argparse
import sys
import requests


def main() -> int:
    ap = argparse.ArgumentParser(description="Publish a GUI plugin package")
    ap.add_argument("--manifest", required=True, help="Path to manifest YAML (name/author/version/...)")
    ap.add_argument("--zip", required=True, help="Path to plugin zip (must contain plugin.json at root)")
    ap.add_argument("--api-key", required=True, help="Registry API key (sk-...)")
    ap.add_argument("--host", default="http://192.168.186.96:8765", help="Registry base URL")
    args = ap.parse_args()

    try:
        manifest_text = open(args.manifest, encoding="utf-8").read()
    except OSError as e:
        print(f"Cannot read manifest: {e}")
        return 1

    try:
        with open(args.zip, "rb") as f:
            files = {"skills": (args.zip.split("/")[-1].split("\\")[-1], f, "application/zip")}
            data = {"manifest": manifest_text, "type": "plugin"}
            resp = requests.post(
                f"{args.host.rstrip('/')}/api/packages",
                data=data,
                files=files,
                headers={"X-API-Key": args.api_key},
                timeout=60,
            )
    except OSError as e:
        print(f"Cannot read zip: {e}")
        return 1
    except requests.RequestException as e:
        print(f"HTTP request failed: {e}")
        return 1

    print(f"HTTP {resp.status_code}")
    try:
        print(resp.text[:1000])
    except UnicodeDecodeError:
        pass

    return 0 if resp.status_code < 400 else 1


if __name__ == "__main__":
    sys.exit(main())
