#!/usr/bin/env python3
"""Memory MCP Server — dual transport (stdio + Streamable HTTP), 10 tools.

Usage:
  python server.py                           # stdio transport
  python server.py --transport sse --port 8080  # Streamable HTTP transport
  python server.py --db-path /data/claude-memory.db
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from contextlib import asynccontextmanager
from typing import Optional

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from normalize import apply_tag_mapping
from search_engine import hybrid_search
from store import MemoryStore, _compute_hash

# ---------------------------------------------------------------------------
# Globals (initialized in main)
# ---------------------------------------------------------------------------
store: Optional[MemoryStore] = None

# ---------------------------------------------------------------------------
# Write-path quality gate (MT-T5)
# ---------------------------------------------------------------------------

_CONTENT_MAX = 8000
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_ALNUM_RE = re.compile(r"[a-zA-Z0-9]")

_GATE_MESSAGES = {
    "empty_content": "content is empty",
    "too_short": "content is too short (need 10+ CJK chars or 20+ chars total)",
    "too_long": f"content exceeds {_CONTENT_MAX} characters",
    "noise": "content has no meaningful text (letters or CJK)",
}


def _quality_gate(content: str) -> Optional[str]:
    """Return a rejection reason for junk content, or None when it passes."""
    text = (content or "").strip()
    if not text:
        return "empty_content"
    if len(text) > _CONTENT_MAX:
        return "too_long"
    cjk_count = len(_CJK_RE.findall(text))
    if cjk_count == 0 and not _ALNUM_RE.search(text):
        return "noise"
    if cjk_count < 10 and len(text) < 20:
        return "too_short"
    return None


def _result(payload: dict) -> list[TextContent]:
    return [
        TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, default=str))
    ]

# ---------------------------------------------------------------------------
# Tool descriptions
# ---------------------------------------------------------------------------

TOOL_DEFS = [
    {
        "name": "memory_store",
        "description": "Store a new memory or experience (two-phase contract)."
        " WITHOUT `action`: the server pre-checks for similar memories and either stores directly"
        " ({status:'stored'}) or returns {status:'conflict_detected', candidates:[...]} WITHOUT"
        " persisting — then re-call with action=store|update|merge|skip plus target_ids/merged_content"
        " to resolve. Use type='fact' for knowledge, 'experience' for successful approaches,"
        " 'lesson' for pitfalls."
        " Quality gate: content needs 10+ CJK chars (or 20+ chars total) and at most 8000 chars;"
        " junk is rejected with a closed reason enum.",
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
                "source": {
                    "type": "string",
                    "description": "Optional provenance (session id / where this was learned)",
                },
                "action": {
                    "type": "string",
                    "enum": ["store", "update", "merge", "skip"],
                    "description": "Decision action, used to resolve a conflict_detected response."
                    " store=create anyway; update=overwrite target in place;"
                    " merge=create merged record and mark targets superseded; skip=nothing persisted",
                },
                "target_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Target memory ids to update/merge (required for update/merge)",
                },
                "merged_content": {
                    "type": "string",
                    "description": "Merged/updated content (merge/update; defaults to `content`)",
                },
            },
            "required": ["type", "title", "content"],
        },
    },
    {
        "name": "memory_update",
        "description": "Update an existing memory. Only provided fields are changed; others stay unchanged."
        " If title or content changes, the content_hash and version are recomputed automatically."
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
        "description": "Search memories (BM25 keyword + tag channels, RRF-fused)."
        " Returns {results, total, strategy, message}: strategy reports the path taken"
        " (hybrid/fts/tag/like/none) — mode='semantic' is NOT available (no embedding provider)"
        " and says so explicitly instead of returning silence."
        " Each result carries content_hash (skip re-reading unchanged memories), match_type,"
        " and a score (ranking hint; scale differs by strategy)."
        " Retrieval advice: start with hybrid; if empty, rephrase with synonyms, at most 3 attempts per turn.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language search query"},
                "mode": {
                    "type": "string",
                    "enum": ["hybrid", "keyword", "tag", "semantic"],
                    "default": "hybrid",
                    "description": "hybrid=BM25+tags fused; keyword=BM25 only; tag=tag filter only;"
                    " semantic=not available (reports why)",
                },
                "scope": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Filter by scopes. Exact match by default; a trailing '*'"
                    " matches by prefix (e.g. 'project:*' for every project scope,"
                    " 'domain:rust' for exactly that one).",
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
        " and all associations (both directions). Also returns content_refs and referenced_by"
        " (memory:// links parsed from content)."
        " Increments the memory's access_count (used for 'most accessed' ordering in the web UI).",
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
        "description": "Remove a memory. Requires explicit confirmation."
        " Default is a SOFT delete: hidden from search/traverse but still readable via memory_get"
        " (auditable). Pass hard=true for physical deletion (also cascades associations).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "confirm": {"type": "boolean", "description": "Must be true to actually delete"},
                "hard": {
                    "type": "boolean",
                    "default": False,
                    "description": "true=physical delete; default is soft delete (recoverable)",
                },
            },
            "required": ["id", "confirm"],
        },
    },
    {
        "name": "memory_stats",
        "description": "Get statistics about the memory system: counts by type/scope, tags,"
        " associations, database size, and capabilities ({fts, jieba, tags, like_fallback, embedding})"
        " — capabilities reports which retrieval channels are actually available.",
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


def _find_conflicts(title: str, content: str, top_k: int = 5) -> list[dict]:
    """Pre-check recall: similar memories for the two-phase store contract."""
    query = f"{title} {content}"[:200]
    try:
        hits = store.fts_search(query, limit=top_k)
    except Exception:
        return []  # failure posture: store anyway (prefer duplicates over loss)
    # Small-corpus exemption: with few documents the FTS5 bm25 idf collapses
    # toward zero (N=2, n=1 → log(1.5/1.5)=0), so absolute scores are
    # meaningless — accept any hit. Larger corpora have well-calibrated idf,
    # so weak matches below the threshold are dropped as noise.
    exempt = store.get_stats()["total_memories"] <= 20
    candidates = []
    for h in hits:
        score = h.get("score") or 0.0
        if not exempt and score < 0.3:
            continue
        candidates.append({
            "id": h["id"],
            "title": h["title"],
            "type": h["type"],
            "scope": h["scope"],
            "score": round(score, 4),
            "content_hash": h.get("content_hash"),
            "exact": h.get("content_hash") == _compute_hash(title, content),
            "snippet": (h.get("content") or "")[:120],
        })
    return candidates


def _apply_action(arguments: dict) -> dict:
    """Decision mode: resolve a previous conflict_detected with an explicit action."""
    action = arguments["action"]
    content = arguments["content"]
    title = arguments.get("title", "")
    mtype = arguments.get("type", "fact")
    merged_content = arguments.get("merged_content") or content
    target_ids = arguments.get("target_ids") or []

    if action == "store":
        res = store.add_memory(
            type=mtype, title=title, content=content,
            scope=arguments.get("scope", "global"), tags=arguments.get("tags"),
            importance=arguments.get("importance", 0.5),
            associations=arguments.get("associations"),
            source=arguments.get("source"),
        )
        return {"status": "stored", **res}

    if action == "skip":
        return {"status": "skipped", "message": "nothing was persisted"}

    # Every target must exist — silently dropping a typo'd id would merge
    # fewer memories than the caller asked for.
    missing = [t for t in target_ids if store.get_memory(t) is None]
    if not target_ids or missing:
        return {
            "status": "rejected",
            "reason": "target_not_found",
            "message": f"missing or nonexistent target_ids: {missing or target_ids}",
        }

    if action == "update":
        tid = target_ids[0]
        store.update_memory(
            tid, title=title or None, content=merged_content,
            importance=arguments.get("importance"),
        )
        if arguments.get("tags") is not None:
            store.replace_tags(tid, arguments["tags"])
        updated = store.get_memory(tid)
        return {"status": "updated", "id": tid, "version": updated["version"]}

    # action == "merge"
    new_id = store.merge_supersede(
        target_ids=target_ids, type=mtype, title=title, content=merged_content,
        scope=arguments.get("scope"), tags=arguments.get("tags"),
        importance=arguments.get("importance"), source=arguments.get("source"),
    )
    return {"status": "merged", "id": new_id, "superseded": target_ids}


async def _handle_memory_store(arguments: dict) -> list[TextContent]:
    action = arguments.get("action")

    if action is not None and action not in ("store", "update", "merge", "skip"):
        return _result({
            "status": "rejected",
            "reason": "invalid_action",
            "message": f"action must be one of store|update|merge|skip, got: {action!r}",
        })
    if action == "skip":
        return _result({"status": "skipped", "message": "nothing was persisted"})

    content = arguments["content"]
    gate_text = (arguments.get("merged_content") or content) if action else content
    reason = _quality_gate(gate_text)
    if reason:
        return _result({
            "status": "rejected",
            "reason": reason,
            "message": _GATE_MESSAGES[reason],
        })

    if action is not None:
        try:
            return _result(_apply_action(arguments))
        except Exception as exc:
            # Failure posture: never lose a memory to a bookkeeping error.
            # merge/update run in a single transaction, so nothing was
            # partially written — falling back to a plain store is safe.
            fallback_content = arguments.get("merged_content") or content
            res = store.add_memory(
                type=arguments.get("type", "fact"), title=arguments.get("title", ""),
                content=fallback_content, scope=arguments.get("scope", "global"),
                tags=arguments.get("tags"), importance=arguments.get("importance", 0.5),
                source=arguments.get("source"),
            )
            return _result({"status": "stored", "fallback_reason": str(exc), **res})

    # -- pre-check mode: recall similar memories before persisting ----------
    candidates = _find_conflicts(arguments.get("title", ""), content)
    if candidates:
        return _result({
            "status": "conflict_detected",
            "candidates": candidates,
            "message": "Similar memories found; nothing was persisted. Re-call memory_store"
            " with action=store (create anyway), update or merge (+target_ids, +merged_content),"
            " or skip. If the input looks fine as-is, ignoring this response also leaves it unstored.",
        })

    res = store.add_memory(
        type=arguments["type"], title=arguments.get("title", ""), content=content,
        scope=arguments.get("scope", "global"), tags=arguments.get("tags"),
        importance=arguments.get("importance", 0.5),
        associations=arguments.get("associations"),
        source=arguments.get("source"),
    )
    return _result({"status": "stored", **res})


async def _handle_memory_update(arguments: dict) -> list[TextContent]:
    mid = arguments["id"]
    mem = store.get_memory(mid)
    if mem is None:
        return _result({"error": f"Memory {mid} not found"})

    title = arguments.get("title")
    content = arguments.get("content")
    importance = arguments.get("importance")
    new_type = arguments.get("type")
    new_scope = arguments.get("scope")
    new_tags = arguments.get("tags")

    if title is not None or content is not None or importance is not None:
        store.update_memory(mid, title=title, content=content, importance=importance)

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

    updated = store.get_memory(mid)
    if updated:
        updated.pop("embedding", None)
    updated["tags"] = store.get_tags_for_memory(mid)
    return _result(updated)


async def _handle_memory_search(arguments: dict) -> list[TextContent]:
    result = hybrid_search(
        store=store,
        query=arguments["query"],
        mode=arguments.get("mode", "hybrid"),
        tags=arguments.get("tags"),
        scope=arguments.get("scope"),
        type_=arguments.get("type"),
        limit=min(arguments.get("limit", 10), 50),
        min_similarity=arguments.get("min_similarity", 0.3),
    )
    return _result(result)


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
            if mem and mem.get("superseded_by") is None and mem.get("deleted_at") is None:
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
        return _result({"error": "confirm must be true to delete"})

    mid = arguments["id"]
    if store.get_memory(mid) is None:
        return _result({"error": f"Memory {mid} not found"})

    if arguments.get("hard"):
        deleted = store.delete_memory(mid)
        store._delete_orphan_tags()
        return _result({"status": "forgotten", "id": mid, "soft": False, "deleted": deleted})

    ok = store.soft_delete_memory(mid)
    return _result({
        "status": "forgotten",
        "id": mid,
        "soft": True,
        "message": "soft-deleted: hidden from search/traverse, still readable via memory_get;"
        " pass hard=true to remove permanently",
    })


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

    global store

    print(f"[memory-mcp] Opening database: {args.db_path}", file=sys.stderr)
    store = MemoryStore(args.db_path)
    caps = store.get_capabilities()
    print(
        f"[memory-mcp] Database ready ({store.get_stats()['total_memories']} memories, "
        f"fts={'on' if caps['fts'] else 'off'}, tokenizer={store.get_meta('tokenizer') or 'n/a'}).",
        file=sys.stderr,
    )

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
