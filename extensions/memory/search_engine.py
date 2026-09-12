"""Hybrid search engine — RRF fusion over FTS and tag channels.

Pure functions with no MCP or HTTP dependencies. Only depends on MemoryStore.

Design (borrowed from tencentdb-agent-memory):
  - Each channel retrieves its own candidates (over-fetch, then threshold).
  - Reciprocal Rank Fusion (k=60) merges lists by rank only, so no score
    calibration is needed between channels with different score scales.
  - Results carry a `strategy` field that reports which path the query
    actually took — degradation is explicit, never silent.
  - Channels fail to empty rather than raising; one dead channel never
    blocks the other.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from store import MemoryStore

RRF_K = 60

SEMANTIC_UNAVAILABLE_MSG = (
    "Semantic search requires an embedding provider, which is not configured. "
    "Use mode='hybrid' (BM25 keyword + tags) instead. / "
    "语义检索未启用（无 embedding 提供者），请改用 hybrid 模式（BM25 关键词 + 标签）。"
)


def rrf_merge(
    lists: list[list[dict]],
    key: Callable[[dict], str],
    k: int = RRF_K,
) -> list[dict]:
    """Reciprocal Rank Fusion: score = Σ 1/(k + rank + 1) across hit lists.

    Only ranks are consumed (original scores are discarded), which avoids
    calibrating BM25 scores against other channels. An item appearing in
    multiple lists accumulates score from each.
    """
    merged: dict[str, dict] = {}
    for lst in lists:
        for rank, item in enumerate(lst):
            _id = key(item)
            score = 1.0 / (k + rank + 1)
            if _id in merged:
                merged[_id]["rrf_score"] += score
            else:
                merged[_id] = {"item": item, "rrf_score": score}
    return [
        {**e["item"], "rrf_score": e["rrf_score"]}
        for e in sorted(merged.values(), key=lambda e: -e["rrf_score"])
    ]


def _apply_threshold(hits: list[dict], limit: int, min_similarity: float) -> list[dict]:
    """Drop weak FTS hits — unless the candidate count is already <= limit.

    Small corpora have unreliable absolute BM25 scores (IDF collapses toward
    zero), so a strict threshold would wipe out valid hits; the exemption
    keeps tiny result sets intact.
    """
    if len(hits) <= limit:
        return hits
    return [h for h in hits if (h.get("score") or 0.0) >= min_similarity]


def _like_fallback(
    store: MemoryStore,
    query: str,
    scope_list: Optional[list[str]],
    type_list: Optional[list[str]],
    limit: int,
) -> list[dict]:
    """Legacy keyword path used when SQLite lacks FTS5 (strategy='like')."""
    rows = store.search_by_text(
        query=query, scope=scope_list, type=type_list, limit=max(limit * 3, limit)
    )
    for r in rows:
        ks = r.pop("keyword_score", 0) or 0
        r["score"] = min(ks / 30.0, 1.0)  # legacy heuristic → 0-1 range
    return rows


def hybrid_search(
    store: MemoryStore,
    query: str,
    *,
    mode: str = "hybrid",
    tags: list[str] | None = None,
    scope: list[str] | None = None,
    type_: list[str] | None = None,
    limit: int = 10,
    min_similarity: float = 0.3,
) -> dict[str, Any]:
    """Search memories across channels; returns a result envelope.

    Returns:
        {
          "results": [memory dicts + match_type + score, ...],
          "total": int,
          "strategy": "hybrid" | "fts" | "tag" | "like" | "none",
          "message": str | None,   # human-readable note when degraded
        }

    `score` semantics differ by strategy: normalized BM25 (0-1) for "fts",
    RRF fusion score (~0.01-0.03) for "hybrid"; treat it as a ranking hint,
    not a calibrated similarity.
    """
    query = (query or "").strip()
    tags = tags or []
    scope_list = list(scope) if scope else None
    type_list = list(type_) if type_ else None

    if mode == "semantic":
        # Never silently return an empty list — say the channel is unavailable.
        return {
            "results": [],
            "total": 0,
            "strategy": "none",
            "message": SEMANTIC_UNAVAILABLE_MSG,
        }

    caps = store.get_capabilities()
    fts_hits: list[dict] = []
    tag_hits: list[dict] = []

    # A dead channel must not take the query down with it: each path fails
    # to empty so the other can still answer.
    if mode in ("hybrid", "keyword") and query:
        over = max(limit * 3, limit)
        try:
            if caps.get("fts"):
                fts_hits = store.fts_search(
                    query, scope=scope_list, type=type_list, limit=over
                )
            else:
                fts_hits = _like_fallback(store, query, scope_list, type_list, limit)
            fts_hits = _apply_threshold(fts_hits, limit, min_similarity)
        except Exception:
            fts_hits = []

    if mode in ("hybrid", "tag") and tags:
        try:
            tag_hits = store.search_by_tags(
                tags=tags, scope=scope_list, type=type_list, limit=max(limit * 2, 50)
            )
        except Exception:
            tag_hits = []

    for h in fts_hits:
        h["match_type"] = "fts" if caps.get("fts") else "like"
    for h in tag_hits:
        h["match_type"] = "tag"

    # -- single-channel modes ------------------------------------------------
    if mode == "keyword":
        results = fts_hits[:limit]
        strategy = ("fts" if caps.get("fts") else "like") if query else "none"
        return {
            "results": results,
            "total": len(results),
            "strategy": strategy,
            "message": None,
        }

    if mode == "tag":
        results = tag_hits[:limit]
        return {
            "results": results,
            "total": len(results),
            "strategy": "tag" if results else "none",
            "message": None,
        }

    # -- hybrid --------------------------------------------------------------
    lists = [lst for lst in (fts_hits, tag_hits) if lst]

    if len(lists) >= 2:
        merged = rrf_merge(lists, key=lambda m: m["id"])
        fts_ids = {h["id"] for h in fts_hits}
        tag_ids = {h["id"] for h in tag_hits}
        for r in merged:
            in_f, in_t = r["id"] in fts_ids, r["id"] in tag_ids
            r["match_type"] = "both" if (in_f and in_t) else ("fts" if in_f else "tag")
            r["score"] = round(r.pop("rrf_score"), 6)
        merged.sort(key=lambda r: (-r["score"], -(r.get("importance") or 0)))
        results = merged[:limit]
        strategy = "hybrid"
    elif len(lists) == 1:
        results = lists[0][:limit]
        strategy = "fts" if fts_hits else "tag"
        if strategy == "fts" and not caps.get("fts"):
            strategy = "like"
    else:
        # No hits: report the path that was actually attempted, for diagnosis.
        results = []
        if query:
            strategy = "fts" if caps.get("fts") else "like"
        else:
            strategy = "none"

    return {
        "results": results,
        "total": len(results),
        "strategy": strategy,
        "message": None,
    }
