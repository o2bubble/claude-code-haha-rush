#!/usr/bin/env python3
"""Publish a GUI plugin package to the registry server.

Usage:
  python scripts/publish-plugin.py \
      --manifest meta.yaml --zip my-plugin.zip --api-key sk-xxxx \
      [--host http://192.168.186.96:8765]

The server endpoint: POST /api/packages (form: manifest YAML, type=plugin, skills=zip file).
Manifest metadata (name/author/version...) is the MARKET display info; the plugin's
real behaviour lives in plugin.json inside the zip (must exist at zip root).

Recommended zip contents (all UTF-8, at package root):
  plugin.json    required — manifest
  README.md      optional — human-facing docs, shown on the market detail page
  AI_NOTES.md    optional — AI-facing troubleshooting doc (failure modes, log
                 locations, diagnostics). Surfaced to AI assistants via the
                 plugin_docs MCP tool — ask your AI for the template, or see
                 the demo-widget package for a live example.

stdlib only (urllib) — no pip install needed.
"""
import argparse
import sys
import uuid
import urllib.request
import urllib.error
import os
import hashlib
import base64

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature

KEY_PATH = os.path.expanduser("~/.claude/plugin-signing.key")


def sign_zip(zip_path: str) -> str:
    """Sign the zip bytes with the publisher's Ed25519 private key.
    Returns base64 signature (64 bytes). Raises if no key. """
    if not os.path.exists(KEY_PATH):
        raise FileNotFoundError(
            f"Signing key not found: {KEY_PATH}. Run scripts/gen-plugin-key.py first."
        )
    priv_hex = open(KEY_PATH, encoding="utf-8").read().strip()
    priv_bytes = bytes.fromhex(priv_hex)
    key = Ed25519PrivateKey.from_private_bytes(priv_bytes)
    with open(zip_path, "rb") as f:
        zip_bytes = f.read()
    digest = hashlib.sha256(zip_bytes).digest()
    sig = key.sign(digest)
    return base64.b64encode(sig).decode()


def verify_zip(zip_path: str, sig_b64: str, pub_b64: str) -> bool:
    """Optional self-check: verify (zip, sig) against a public key b64. """
    try:
        pub_bytes = base64.b64decode(pub_b64)
        pub = Ed25519PublicKey.from_public_bytes(pub_bytes)
        sig = base64.b64decode(sig_b64)
        digest = hashlib.sha256(open(zip_path, "rb").read()).digest()
        pub.verify(sig, digest)
        return True
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Publish a GUI plugin package")
    ap.add_argument("--manifest", required=True, help="Path to manifest YAML (name/author/version/...)")
    ap.add_argument("--zip", required=True, help="Path to plugin zip (must contain plugin.json at root)")
    ap.add_argument("--api-key", required=True, help="Registry API key (sk-...)")
    ap.add_argument("--host", default="http://192.168.186.96:8765", help="Registry base URL")
    ap.add_argument("--no-sign", action="store_true", help="Skip signing (unsafe — only for local/untrusted).")
    ap.add_argument("--force", action="store_true", help="Overwrite existing package (re-sign/re-publish).")
    args = ap.parse_args()

    with open(args.manifest, encoding="utf-8") as f:
        manifest_text = f.read()
    with open(args.zip, "rb") as f:
        zip_bytes = f.read()

    # ── Sign (Ed25519 over sha256(zip)) — official publisher only ──
    sig = None
    if not args.no_sign:
        try:
            sig = sign_zip(args.zip)
            print(f"Signed: sha256(zip) → Ed25519 sig ({len(base64.b64decode(sig))} bytes)")
        except FileNotFoundError as e:
            print(f"ERROR: {e}")
            return 1
        except Exception as e:
            print(f"Signing failed: {e}")
            return 1

    # multipart/form-data (stdlib)
    boundary = uuid.uuid4().hex

    def field(name: str, val: str) -> bytes:
        return (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{val}\r\n').encode()

    body = b""
    body += field("manifest", manifest_text)
    body += field("type", "plugin")
    if sig:
        body += field("signature", sig)  # server stores as <slug>.sig
    if args.force:
        body += field("force", "true")  # server overwrites existing package
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
