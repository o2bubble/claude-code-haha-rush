#!/usr/bin/env python3
"""Seed a throwaway DB with a long scope tree + one memory, then serve the UI.

Usage: python tests/seed_for_ui.py [port]
Prints the port; Ctrl+C to stop.
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import api  # noqa: E402
from store import MemoryStore  # noqa: E402


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 48330
    db = os.path.join(tempfile.mkdtemp(prefix="memui-"), "mem.db")
    store = MemoryStore(db)
    api.store = store

    target = store.add_memory(
        type="fact",
        title="UI 编辑验证目标",
        content="原始内容 original body",
        scope="global",
        tags=["alpha", "beta"],
        importance=0.4,
    )

    # A long, deep scope tree → exactly the sidebar-overflow scenario.
    for i in range(24):
        for j in range(3):
            store.add_memory(
                type="fact",
                title=f"seed {i}-{j}",
                content=f"seed content {i}-{j}",
                scope=f"project:demo-suite-{i}:module-{j}:leaf",
                tags=["seed"],
                importance=0.1,
            )

    print(f"TARGET_ID={target['id']}", flush=True)
    print(f"PORT={port}", flush=True)

    import uvicorn

    uvicorn.run(api.create_app(auth_token=None), host="127.0.0.1", port=port,
                log_level="warning")


if __name__ == "__main__":
    main()
