#!/usr/bin/env python3
"""Memory REST API — FastAPI server sharing store.py with the MCP server.

Usage:
  python api.py --port 40021
  python api.py --db-path /data/claude-memory.db --port 40021
"""

from __future__ import annotations

import argparse
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from auth import DEFAULT_EXEMPT, BearerAuthMiddleware, resolve_token
from normalize import apply_tag_mapping
from search_engine import hybrid_search
from store import MemoryStore, _scope_condition

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
store: Optional[MemoryStore] = None


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------
def create_app(auth_token: Optional[str] = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        if store:
            store.close()

    app = FastAPI(
        title="Memory MCP API",
        description="REST API for the Claude Code Memory MCP system",
        version="1.0.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Protect /api/*; leave the SPA bundle public so the browser can render the
    # login page (it cannot present a token before it has loaded). Any non-/api
    # path is static assets or the landing page — none of it is user data.
    if auth_token is not None:
        app.add_middleware(
            BearerAuthMiddleware,
            token=auth_token,
            # /api/public-stats 是唯一的公开 API：landing 页在**未登录**时就要
            # 显示「有多少条记忆」，那时它还没有 token。只暴露三个总数，
            # 不含 by_scope 明细（那会泄露内部项目名）。其余 /api/* 一律要 token。
            exempt=DEFAULT_EXEMPT | {"/api/public-stats"},
            protect_prefixes=("/api/",),
        )

    _register_routes(app)

    web_root = Path(__file__).parent / "web"
    web_dir = web_root / "dist"
    if web_dir.is_dir():
        # Landing page route — before StaticFiles catch-all
        @app.get("/landing")
        @app.get("/landing.html")
        async def landing():
            from fastapi.responses import FileResponse
            lp = web_root / "landing.html"
            return FileResponse(str(lp)) if lp.exists() else JSONResponse({"error": "Landing page not found"}, status_code=404)

        # Serve index.html with no-cache for SPA routing
        from starlette.responses import FileResponse as StarletteFileResponse
        from starlette.types import Scope

        class NoCacheStaticFiles(StaticFiles):
            async def get_response(self, path: str, scope: Scope):
                response = await super().get_response(path, scope)
                if path.endswith(".html") or path == "" or "." not in path:
                    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
                    response.headers["Pragma"] = "no-cache"
                    response.headers["Expires"] = "0"
                return response

        app.mount("/", NoCacheStaticFiles(directory=str(web_dir), html=True), name="web")

    return app


# ---------------------------------------------------------------------------
# Read routes
# ---------------------------------------------------------------------------
def _register_routes(app: FastAPI) -> None:

    @app.get("/api/stats")
    async def get_stats():
        return store.get_stats()

    @app.get("/api/public-stats")
    async def get_public_stats():
        """Public aggregate counts for the landing page (no token required).

        Deliberately narrow: three totals only. `by_scope` is NOT exposed here —
        scope names contain internal project identifiers. This endpoint is
        registered in the auth middleware's exempt set; keep the response shape
        minimal if you ever extend it.
        """
        s = store.get_stats()
        return {
            "total_memories": s.get("total_memories", 0),
            "total_tags": s.get("total_tags", 0),
            "total_associations": s.get("total_associations", 0),
        }

    @app.get("/api/tags")
    async def get_tags(scope: Optional[str] = None):
        tags = store.list_all_tags(scope=scope)
        return {"tags": tags}

    @app.get("/api/memories")
    async def list_memories(
        q: Optional[str] = Query(None),
        mode: str = Query("hybrid"),
        type: Optional[str] = Query(None),
        scope: Optional[str] = Query(None),
        tags: Optional[str] = Query(None),
        limit: int = Query(20, ge=1, le=100),
        offset: int = Query(0, ge=0),
        sort: str = Query("newest"),
    ):
        type_list = [t.strip() for t in type.split(",") if t.strip()] if type else None
        scope_list = [s.strip() for s in scope.split(",") if s.strip()] if scope else None
        tags_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None

        message = None
        if q:
            envelope = hybrid_search(
                store=store,
                query=q,
                mode=mode,
                tags=tags_list,
                scope=scope_list,
                type_=type_list,
                limit=limit + offset,
                min_similarity=0.1,
            )
            results = envelope["results"]
            message = envelope.get("message")  # e.g. semantic mode unavailable
        else:
            results = _list_memories(type_list, scope_list, tags_list, sort, limit + offset)

        total = len(results)
        results = results[offset : offset + limit]
        for r in results:
            if "embedding" in r:
                del r["embedding"]

        return {"total": total, "items": results, "message": message}

    @app.get("/api/memories/{memory_id}")
    async def get_memory(memory_id: str):
        mem = store.get_memory(memory_id)
        if mem is None:
            return JSONResponse({"error": f"Memory {memory_id} not found"}, status_code=404)

        mem.pop("embedding", None)
        mem["tags"] = store.get_tags_for_memory(memory_id)
        mem["associations"] = store.get_associations(memory_id, direction="both")
        mem["content_refs"] = store.get_content_refs(memory_id)
        mem["referenced_by"] = store.get_referencing(memory_id)
        mem["associations"] = [
            {
                "source_id": a.get("source_id"),
                "target_id": a.get("target_id"),
                "weight": a.get("weight"),
                "type": a.get("type"),
                "title": a.get("target_title") or a.get("source_title"),
                "direction": a.get("direction"),
            }
            for a in mem["associations"]
        ]

        store.record_access(memory_id)
        return mem

    @app.get("/api/graph")
    async def get_graph(
        start_id: Optional[str] = Query(None),
        max_depth: int = Query(2, ge=1, le=5),
        min_weight: float = Query(0.1, ge=0.0, le=1.0),
        q: Optional[str] = Query(None),
        type: Optional[str] = Query(None),
        scope: Optional[str] = Query(None),
        tags: Optional[str] = Query(None),
    ):
        if start_id:
            nodes, edges = store.get_connected_edges(start_id, min_weight=min_weight, max_depth=max_depth)
        else:
            conn = store._conn
            rows = conn.execute(
                "SELECT id, title, type, scope, importance FROM memories ORDER BY updated_at DESC"
            ).fetchall()
            nodes = [{k: row[k] for k in row.keys()} for row in rows]
            edge_rows = conn.execute(
                "SELECT source_id, target_id, weight, type FROM associations"
            ).fetchall()
            edges = [{k: row[k] for k in row.keys()} for row in edge_rows]

        # --- highlighted_ids: which nodes match current filters ---
        highlighted_ids: list[str] = []
        type_list = [t.strip() for t in type.split(",") if t.strip()] if type else None
        scope_list = [s.strip() for s in scope.split(",") if s.strip()] if scope else None
        tags_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None
        has_filters = bool(q or type_list or scope_list or tags_list)

        if has_filters:
            candidate_sets: list[set] = []

            if q:
                text_matches = store.search_by_text(query=q.strip(), scope=scope_list, type=type_list, limit=500)
                candidate_sets.append({m["id"] for m in text_matches})

            if tags_list:
                tag_matches = store.search_by_tags(tags=tags_list, scope=scope_list, type=type_list, limit=500)
                candidate_sets.append({m["id"] for m in tag_matches})

            if type_list or scope_list:
                conditions = ["1=1"]
                params: list = []
                if type_list:
                    ph = ",".join("?" * len(type_list))
                    conditions.append(f"m.type IN ({ph})")
                    params.extend(type_list)
                if scope_list:
                    cond, scope_params = _scope_condition(scope_list)
                    conditions.append(cond)
                    params.extend(scope_params)
                rowset = set()
                cur = store._conn.execute(
                    f"SELECT id FROM memories m WHERE {' AND '.join(conditions)}", params
                )
                for r in cur.fetchall():
                    rowset.add(r["id"])
                if rowset:
                    candidate_sets.append(rowset)

            if candidate_sets:
                highlighted = candidate_sets[0]
                for s in candidate_sets[1:]:
                    highlighted = highlighted & s
                highlighted_ids = list(highlighted)

        return {"nodes": nodes, "edges": edges, "highlighted_ids": highlighted_ids}

    # ---- Write endpoints ----

    @app.post("/api/memories", status_code=201)
    async def create_memory(request: Request):
        body = await request.json()
        content = body["content"]
        title = body.get("title", "")
        result = store.add_memory(
            type=body["type"],
            title=title,
            content=content,
            scope=body.get("scope", "global"),
            tags=body.get("tags"),
            importance=body.get("importance", 0.5),
            associations=body.get("associations"),
        )
        return result

    @app.put("/api/memories/{memory_id}")
    async def update_memory(memory_id: str, request: Request):
        if store.get_memory(memory_id) is None:
            return JSONResponse({"error": f"Memory {memory_id} not found"}, status_code=404)
        body = await request.json()
        kwargs = {}
        if "title" in body:
            kwargs["title"] = body["title"]
        if "content" in body:
            kwargs["content"] = body["content"]
        if "importance" in body:
            kwargs["importance"] = body["importance"]
        updated = store.update_memory(memory_id, **kwargs)
        return {"id": memory_id, "updated": updated}

    @app.delete("/api/memories/{memory_id}")
    async def delete_memory(memory_id: str):
        if store.get_memory(memory_id) is None:
            return JSONResponse({"error": f"Memory {memory_id} not found"}, status_code=404)
        deleted = store.delete_memory(memory_id)
        store._delete_orphan_tags()
        return {"deleted": deleted, "id": memory_id}

    @app.post("/api/associations", status_code=201)
    async def create_association(request: Request):
        body = await request.json()
        result = store.add_association(
            source_id=body["source_id"],
            target_id=body["target_id"],
            weight=body.get("weight", 0.5),
            type=body.get("type", "related_to"),
        )
        return result

    @app.delete("/api/associations")
    async def delete_association(request: Request):
        body = await request.json()
        deleted = store.delete_association(
            source_id=body["source_id"],
            target_id=body["target_id"],
            type=body.get("type"),
        )
        return {"deleted": deleted}

    @app.post("/api/tags/normalize")
    async def normalize_tags_endpoint(request: Request):
        body = await request.json()
        return apply_tag_mapping(
            store=store,
            mapping=body.get("mapping", {}),
            dry_run=body.get("dry_run", False),
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _list_memories(
    type_list: list[str] | None,
    scope_list: list[str] | None,
    tags_list: list[str] | None,
    sort: str,
    limit: int,
) -> list[dict]:
    conn = store._conn
    # the browse list shows only active memories, same as search
    conditions: list[str] = ["m.superseded_by IS NULL", "m.deleted_at IS NULL"]
    params: list = []

    if type_list:
        placeholders = ",".join("?" for _ in type_list)
        conditions.append(f"m.type IN ({placeholders})")
        params.extend(type_list)
    if scope_list:
        placeholders = ",".join("?" for _ in scope_list)
        conditions.append(f"m.scope IN ({placeholders})")
        params.extend(scope_list)
    if tags_list:
        for tag in tags_list:
            conditions.append(
                "m.id IN (SELECT mt.memory_id FROM memory_tags mt "
                "JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?)"
            )
            params.append(tag.lower().strip())

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    sort_col = {
        "newest": "m.updated_at DESC",
        "importance": "m.importance DESC",
        "access_count": "m.access_count DESC",
    }.get(sort, "m.updated_at DESC")

    rows = conn.execute(
        f"SELECT m.* FROM memories m {where} ORDER BY {sort_col} LIMIT ?",
        [*params, limit],
    ).fetchall()

    results = []
    for row in rows:
        mem = {k: row[k] for k in row.keys()}
        mem.pop("embedding", None)
        mem["snippet"] = mem["content"][:200] + ("..." if len(mem["content"]) > 200 else "")
        mem["tags"] = store.get_tags_for_memory(mem["id"])
        results.append(mem)
    return results


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Memory REST API Server")
    parser.add_argument("--db-path", default="claude-memory.db")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=40021)
    args = parser.parse_args()

    global store
    import uvicorn

    auth_token = resolve_token()

    print(f"[memory-api] Opening database: {args.db_path}", file=sys.stderr)
    store = MemoryStore(args.db_path)
    caps = store.get_capabilities()
    print(
        f"[memory-api] Database ready ({store.get_stats()['total_memories']} memories, "
        f"fts={'on' if caps['fts'] else 'off'}).",
        file=sys.stderr,
    )

    app = create_app(auth_token)
    if auth_token is not None:
        print("[memory-api] Authentication enabled (/api/* requires a bearer token).", file=sys.stderr)
    print(f"[memory-api] REST API listening on {args.host}:{args.port}", file=sys.stderr)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
