#!/usr/bin/env python3
"""Memory MCP Server — dual transport (stdio + Streamable HTTP), 9 tools.

Usage:
  python server.py                           # stdio transport
  python server.py --transport sse --port 8080  # Streamable HTTP transport
  python server.py --db-path /data/claude-memory.db
"""

from __future__ import annotations

import argparse
import json
import sys
from contextlib import asynccontextmanager
from typing import Optional

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from embeddings import EmbeddingModel
from normalize import apply_tag_mapping
from search_engine import hybrid_search
from store import MemoryStore, _unpack_embedding

# ---------------------------------------------------------------------------
# Globals (initialized in main)
# ---------------------------------------------------------------------------
store: Optional[MemoryStore] = None
embedder: Optional[EmbeddingModel] = None

# ---------------------------------------------------------------------------
# Tool descriptions
# ---------------------------------------------------------------------------

TOOL_DEFS = [
    {
        "name": "memory_store",
        "description": "Store a new memory or experience. Content is automatically embedded for semantic search."
        " Tags help with organization; associations link to related memories."
        " Use type='fact' for knowledge, 'experience' for successful approaches, 'lesson' for pitfalls.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["fact", "experience", "lesson"],
                    "description": "Memory type: fact=knowledge, experience=success pattern, lesson=pitfall",
                },
                "title": {"type": "string", "description": "Short descriptive title"},
                "content": {"type": "string", "description": "Full content in Markdown"},
                "scope": {
                    "type": "string",
                    "default": "global",
                    "description": "Scope: 'global', 'domain:<name>' (e.g. 'domain:rust'), or 'project:<name>'",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Tags for categorization",
                },
                "importance": {
                    "type": "number",
                    "default": 0.5,
                    "minimum": 0.0,
                    "maximum": 1.0,
                },
                "associations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "target_id": {"type": "string"},
                            "weight": {"type": "number", "default": 0.5},
                            "type": {
                                "type": "string",
                                "enum": ["related_to", "derived_from", "contradicts", "supports"],
                                "default": "related_to",
                            },
                        },
                        "required": ["target_id"],
                    },
                    "description": "Initial associations to other memories",
                },
            },
            "required": ["type", "title", "content"],
        },
    },
    {
        "name": "memory_update",
        "description": "Update an existing memory. Only provided fields are changed; others stay unchanged."
        " If title or content changes, the embedding and content_hash are recomputed automatically."
        " Use this to merge new knowledge into existing memories instead of creating duplicates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Memory ID (UUID) to update"},
                "title": {"type": "string", "description": "New title (omit to keep current)"},
                "content": {"type": "string", "description": "New content in Markdown (omit to keep current)"},
                "type": {
                    "type": "string",
                    "enum": ["fact", "experience", "lesson"],
                    "description": "New memory type (omit to keep current)",
                },
                "scope": {
                    "type": "string",
                    "description": "New scope (omit to keep current)",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Replace all tags (omit to keep current)",
                },
                "importance": {
                    "type": "number",
                    "minimum": 0.0,
                    "maximum": 1.0,
                    "description": "New importance score (omit to keep current)",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "memory_search",
        "description": "Search memories by semantic similarity, tags, or both (hybrid)."
        " Returns matching memories with relevance scores, content snippets, and content_hash"
        " (title+content SHA256, use to skip re-reading unchanged memories)."
        " Filter by scope, type, or tags for targeted results.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language search query"},
                "mode": {
                    "type": "string",
                    "enum": ["semantic", "tag", "hybrid"],
                    "default": "hybrid",
                },
                "scope": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Filter by scopes. Supports prefix: 'domain:*'",
                },
                "type": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["fact", "experience", "lesson"]},
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Filter memories that have ALL these tags (tag mode only)",
                },
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50},
                "min_similarity": {"type": "number", "default": 0.3, "minimum": 0.0, "maximum": 1.0},
            },
            "required": ["query"],
        },
    },
    {
        "name": "memory_get",
        "description": "Get a single memory by ID with full content, tags, content_hash,"
        " and all associations (both directions)."
        " Automatically records access for importance tracking.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Memory ID (UUID)"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "memory_associate",
        "description": "Create or update a weighted relationship edge between two memories."
        " Supports 4 edge types: related_to, derived_from, contradicts, supports."
        " Optionally create the reverse edge too (bidirectional).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_id": {"type": "string"},
                "target_id": {"type": "string"},
                "weight": {"type": "number", "default": 0.5, "minimum": 0.0, "maximum": 1.0},
                "type": {
                    "type": "string",
                    "enum": ["related_to", "derived_from", "contradicts", "supports"],
                    "default": "related_to",
                },
                "bidirectional": {"type": "boolean", "default": False},
            },
            "required": ["source_id", "target_id"],
        },
    },
    {
        "name": "memory_traverse",
        "description": "Traverse the knowledge graph from a starting memory, following association edges"
        " up to max_depth hops. Returns the connected subgraph (nodes + edges)."
        " Use to explore related memories by association.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "start_id": {"type": "string"},
                "max_depth": {"type": "integer", "default": 2, "minimum": 1, "maximum": 5},
                "min_weight": {"type": "number", "default": 0.3, "minimum": 0.0, "maximum": 1.0},
                "direction": {
                    "type": "string",
                    "enum": ["outgoing", "incoming", "both"],
                    "default": "both",
                },
            },
            "required": ["start_id"],
        },
    },
    {
        "name": "memory_tags",
        "description": "List all tags with usage counts. Optionally filter by scope."
        " Use to discover available tags before searching.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {"type": "string", "description": "Optional scope filter"},
            },
        },
    },
    {
        "name": "memory_forget",
        "description": "Delete a memory and all its associations. Requires explicit confirmation."
        " Cascade deletes tags that become orphaned.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "confirm": {"type": "boolean", "description": "Must be true to actually delete"},
            },
            "required": ["id", "confirm"],
        },
    },
    {
        "name": "memory_stats",
        "description": "Get statistics about the memory system: counts by type and scope,"
        " total tags and associations, database file size, and embedding model info.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "memory_normalize_tags",
        "description": "Apply tag normalization mappings. The caller (typically an LLM)"
        " first reads all tags via memory_tags, determines which are semantically"
        " similar, and passes a {old_tag: canonical_tag} mapping here."
        " Use dry_run=true to preview without applying changes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "mapping": {
                    "type": "object",
                    "description": "Dict mapping old tag names to canonical replacements.",
                },
                "dry_run": {"type": "boolean", "default": False},
            },
            "required": ["mapping"],
        },
    },
]


def _tool_defs_as_mcp() -> list[Tool]:
    return [Tool(**td) for td in TOOL_DEFS]


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


async def _handle_memory_store(arguments: dict) -> list[TextContent]:
    content = arguments["content"]
    title = arguments.get("title", "")
    # Embed only if a local model is loaded
    embedding = None
    if embedder is not None and embedder.loaded:
        try:
            emb_text = f"{title}\n{content}"
            embedding = embedder.encode(emb_text)
        except NotImplementedError:
            pass

    result = store.add_memory(
        type=arguments["type"],
        title=title,
        content=content,
        scope=arguments.get("scope", "global"),
        tags=arguments.get("tags"),
        embedding=embedding,
        importance=arguments.get("importance", 0.5),
        associations=arguments.get("associations"),
    )
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]


async def _handle_memory_update(arguments: dict) -> list[TextContent]:
    mid = arguments["id"]
    mem = store.get_memory(mid)
    if mem is None:
        return [TextContent(type="text", text=json.dumps({"error": f"Memory {mid} not found"}))]

    title = arguments.get("title")
    content = arguments.get("content")
    importance = arguments.get("importance")
    new_type = arguments.get("type")
    new_scope = arguments.get("scope")
    new_tags = arguments.get("tags")

    # Recompute embedding if title or content changed and a model is loaded
    new_title = title if title is not None else mem.get("title", "")
    new_content = content if content is not None else mem.get("content", "")
    if title is not None or content is not None:
        embedding = None
        if embedder is not None and embedder.loaded:
            try:
                emb_text = f"{new_title}\n{new_content}"
                embedding = embedder.encode(emb_text)
            except NotImplementedError:
                pass
        store.update_memory(mid, title=title, content=content, embedding=embedding, importance=importance)
    elif importance is not None:
        store.update_memory(mid, importance=importance)

    # Scope / type — direct update (not in store.update_memory yet)
    if new_scope is not None or new_type is not None:
        sets = []
        params = []
        if new_scope is not None:
            sets.append("scope=?")
            params.append(new_scope)
        if new_type is not None:
            sets.append("type=?")
            params.append(new_type)
        if sets:
            params.append(mid)
            store._conn.execute(f"UPDATE memories SET {', '.join(sets)} WHERE id=?", params)
            store._conn.commit()

    # Tags — full replacement
    if new_tags is not None:
        store.replace_tags(mid, new_tags)

    # Return updated memory
    updated = store.get_memory(mid)
    if updated:
        updated.pop("embedding", None)
    updated["tags"] = store.get_tags_for_memory(mid)
    return [TextContent(type="text", text=json.dumps(updated, ensure_ascii=False, default=str))]


async def _handle_memory_search(arguments: dict) -> list[TextContent]:
    query = arguments["query"]
    mode = arguments.get("mode", "hybrid")
    tags = arguments.get("tags")
    scope = arguments.get("scope")
    type_ = arguments.get("type")
    limit = min(arguments.get("limit", 10), 50)
    min_similarity = arguments.get("min_similarity", 0.3)

    results = hybrid_search(
        store=store,
        embedder=embedder,
        query=query,
        mode=mode,
        tags=tags,
        scope=scope,
        type_=type_,
        limit=limit,
        min_similarity=min_similarity,
    )
    return [TextContent(type="text", text=json.dumps(results, ensure_ascii=False, default=str))]


async def _handle_memory_get(arguments: dict) -> list[TextContent]:
    mid = arguments["id"]
    mem = store.get_memory(mid)
    if mem is None:
        return [TextContent(type="text", text=json.dumps({"error": f"Memory {mid} not found"}))]

    mem.pop("embedding", None)
    mem["tags"] = store.get_tags_for_memory(mid)
    mem["associations"] = store.get_associations(mid, direction="both")
    mem["content_refs"] = store.get_content_refs(mid)
    mem["referenced_by"] = store.get_referencing(mid)

    # Flatten associations for readability
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

    store.record_access(mid)

    return [TextContent(type="text", text=json.dumps(mem, ensure_ascii=False, default=str))]


async def _handle_memory_associate(arguments: dict) -> list[TextContent]:
    result = store.add_association(
        source_id=arguments["source_id"],
        target_id=arguments["target_id"],
        weight=arguments.get("weight", 0.5),
        type=arguments.get("type", "related_to"),
        bidirectional=arguments.get("bidirectional", False),
    )
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]


async def _handle_memory_traverse(arguments: dict) -> list[TextContent]:
    start_id = arguments["start_id"]
    max_depth = min(arguments.get("max_depth", 2), 5)
    min_weight = arguments.get("min_weight", 0.3)

    # Check start exists
    if store.get_memory(start_id) is None:
        return [TextContent(type="text", text=json.dumps({"error": f"Memory {start_id} not found"}))]

    # We need direction-aware BFS
    direction = arguments.get("direction", "both")
    visited: set[str] = set()
    nodes: list[dict] = []
    edges: list[dict] = []
    frontier: set[str] = {start_id}

    for _ in range(max_depth + 1):
        next_frontier: set[str] = set()
        for nid in frontier:
            if nid in visited:
                continue
            visited.add(nid)
            mem = store.get_memory(nid)
            if mem:
                mem.pop("embedding", None)
                mem.pop("content", None)
                nodes.append(mem)

            assocs = store.get_associations(nid, direction=direction)
            for a in assocs:
                if a["weight"] >= min_weight:
                    a["title"] = a.get("target_title") or a.get("source_title")
                    edges.append({
                        "source_id": a["source_id"],
                        "target_id": a["target_id"],
                        "weight": a["weight"],
                        "type": a["type"],
                        "title": a["title"],
                    })
                    # Follow outgoing from target or incoming from source
                    other = a["target_id"] if a["direction"] == "outgoing" else a["source_id"]
                    if other not in visited:
                        next_frontier.add(other)

        frontier = next_frontier
        if not frontier:
            break

    return [TextContent(type="text", text=json.dumps(
        {"start_id": start_id, "max_depth": max_depth, "nodes": nodes, "edges": edges},
        ensure_ascii=False, default=str,
    ))]


async def _handle_memory_tags(arguments: dict) -> list[TextContent]:
    scope = arguments.get("scope")
    result = store.list_all_tags(scope=scope)
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]


async def _handle_memory_forget(arguments: dict) -> list[TextContent]:
    if not arguments.get("confirm"):
        return [TextContent(type="text", text=json.dumps(
            {"error": "confirm must be true to delete"}, ensure_ascii=False
        ))]

    mid = arguments["id"]
    if store.get_memory(mid) is None:
        return [TextContent(type="text", text=json.dumps({"error": f"Memory {mid} not found"}))]

    deleted = store.delete_memory(mid)
    store._delete_orphan_tags()
    return [TextContent(type="text", text=json.dumps({"deleted": deleted}))]


async def _handle_memory_stats(arguments: dict) -> list[TextContent]:
    stats = store.get_stats()
    return [TextContent(type="text", text=json.dumps(stats, ensure_ascii=False))]


async def _handle_memory_normalize_tags(arguments: dict) -> list[TextContent]:
    mapping = arguments.get("mapping", {})
    dry_run = arguments.get("dry_run", False)

    result = apply_tag_mapping(
        store=store,
        mapping=mapping,
        dry_run=dry_run,
    )
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]


HANDLERS = {
    "memory_store": _handle_memory_store,
    "memory_update": _handle_memory_update,
    "memory_search": _handle_memory_search,
    "memory_get": _handle_memory_get,
    "memory_associate": _handle_memory_associate,
    "memory_traverse": _handle_memory_traverse,
    "memory_tags": _handle_memory_tags,
    "memory_forget": _handle_memory_forget,
    "memory_stats": _handle_memory_stats,
    "memory_normalize_tags": _handle_memory_normalize_tags,
}


# ---------------------------------------------------------------------------
# Server factory
# ---------------------------------------------------------------------------


def create_server() -> Server:
    """Create and configure the MCP server."""
    server = Server("claude-memory")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return _tool_defs_as_mcp()

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        handler = HANDLERS.get(name)
        if handler is None:
            raise ValueError(f"Unknown tool: {name}")
        try:
            return await handler(arguments)
        except Exception as exc:
            return [TextContent(type="text", text=json.dumps(
                {"error": str(exc)}, ensure_ascii=False
            ))]

    return server


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="Claude Code Memory MCP Server")
    parser.add_argument("--db-path", default="claude-memory.db", help="Path to SQLite database")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio")
    parser.add_argument("--host", default="0.0.0.0", help="Host for SSE transport")
    parser.add_argument("--port", type=int, default=8080, help="Port for SSE transport")
    args = parser.parse_args()

    global store, embedder

    # Try to load local embedding model (optional)
    embedder = EmbeddingModel()
    if embedder.loaded:
        print(f"[memory-mcp] Embedding model loaded: {embedder.MODEL_NAME} ({embedder.DIM}d)", file=sys.stderr)
    else:
        print("[memory-mcp] No local embedding model — semantic search disabled. "
              "Keyword+tag search will be used instead.", file=sys.stderr)

    print(f"[memory-mcp] Opening database: {args.db_path}", file=sys.stderr)
    store = MemoryStore(args.db_path)
    store.set_meta("embedding_model", embedder.MODEL_NAME)
    print(f"[memory-mcp] Database ready ({store.get_stats()['total_memories']} memories).", file=sys.stderr)

    print(f"[memory-mcp] Starting server (transport={args.transport})...", file=sys.stderr)

    mcp_server = create_server()

    if args.transport == "stdio":
        import asyncio

        async def run_stdio() -> None:
            async with stdio_server() as (read_stream, write_stream):
                await mcp_server.run(read_stream, write_stream, mcp_server.create_initialization_options())

        asyncio.run(run_stdio())
    else:
        # Streamable HTTP transport (stateless) — avoids SSE initialization race
        import uvicorn
        from contextlib import asynccontextmanager
        from starlette.responses import JSONResponse
        from starlette.routing import Mount, Route, Router

        from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

        session_manager = StreamableHTTPSessionManager(
            app=mcp_server,
            stateless=True,
        )

        @asynccontextmanager
        async def lifespan(app):
            async with session_manager.run():
                yield

        async def mcp_asgi(scope, receive, send):
            if scope["type"] != "http":
                return
            await session_manager.handle_request(scope, receive, send)

        async def health(request):
            return JSONResponse({"status": "ok"})

        # Wrap mcp_asgi in a class so Route treats it as raw ASGI, not request→response
        class MCPEndpoint:
            async def __call__(self, scope, receive, send):
                await mcp_asgi(scope, receive, send)

        app = Router(
            lifespan=lifespan,
            redirect_slashes=False,
            routes=[
                Route("/mcp", endpoint=MCPEndpoint(), methods=["GET", "POST", "DELETE"]),
                Mount("/mcp", app=mcp_asgi),
                Route("/health", endpoint=health),
            ],
        )

        print(f"[memory-mcp] Streamable HTTP server listening on {args.host}:{args.port}", file=sys.stderr)
        uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
