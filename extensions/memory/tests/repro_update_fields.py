#!/usr/bin/env python3
"""Repro: PUT /api/memories/{id} silently ignores type/scope/tags.

Run:  python tests/repro_update_fields.py
Exit 0 = fixed (fields persisted)   Exit 1 = bug present

Uses a throwaway SQLite file and the real FastAPI app, so it exercises the
same path the web UI takes (PUT with a full payload).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import api  # noqa: E402
from store import MemoryStore  # noqa: E402


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="memrepro-")
    db = os.path.join(tmp, "mem.db")

    import uvicorn

    port = 48321
    # Store must be created in the serving thread (sqlite3 check_same_thread).
    def serve():
        api.store = MemoryStore(db)
        uvicorn.run(api.create_app(auth_token=None), host="127.0.0.1", port=port,
                    log_level="critical")

    th = threading.Thread(target=serve, daemon=True)
    th.start()

    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/api/stats", timeout=0.3).read()
            break
        except Exception:
            time.sleep(0.05)

    def call(method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())

    created = call("POST", "/api/memories", {
        "type": "fact",
        "title": "repro original",
        "content": "body",
        "scope": "global",
        "tags": ["alpha"],
        "importance": 0.5,
    })
    mid = created["id"]

    # The web UI sends the FULL form on PUT (MemoryDetail.handleSave).
    resp = call("PUT", f"/api/memories/{mid}", {
        "type": "lesson",
        "title": "repro edited",
        "content": "body edited",
        "scope": "project:repro",
        "importance": 0.9,
        "tags": ["beta", "gamma"],
    })

    got = call("GET", f"/api/memories/{mid}")

    checks = {
        "title": got.get("title") == "repro edited",
        "content": got.get("content") == "body edited",
        "importance": abs(float(got.get("importance", 0)) - 0.9) < 1e-6,
        "type": got.get("type") == "lesson",
        "scope": got.get("scope") == "project:repro",
        "tags": sorted(got.get("tags") or []) == ["beta", "gamma"],
    }

    print("PUT response:", resp)
    for k, ok in checks.items():
        print(f"  {'OK  ' if ok else 'FAIL'} {k}: {got.get(k)!r}")

    time.sleep(0.2)

    failed = [k for k, ok in checks.items() if not ok]
    if failed:
        print(f"\nBUG PRESENT — not persisted: {', '.join(failed)}")
        return 1
    print("\nAll fields persisted — fixed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
