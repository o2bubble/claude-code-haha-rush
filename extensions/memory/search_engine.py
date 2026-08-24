"""Hybrid search engine — lightweight, no numpy/PyTorch.

Pure functions with no MCP or HTTP dependencies. Only depends on MemoryStore.
When no embedding model is available, semantic search is skipped and scoring
uses text match + tag match + importance instead.
"""

from __future__ import annotations

from typing import Optional

from store import MemoryStore


def _text_match_relevance(memory: dict, query: str) -> float:
    """Score how well a memory matches the query text.

    Returns 1.0 for title match, 0.5 for content-only match, 0.0 for no match.
    """
    q = query.lower()
    title = (memory.get("title") or "").lower()
    content = (memory.get("content") or "").lower()
    if q in title:
        return 1.0
    if q in content:
        return 0.5
    return 0.0


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
    embedder=None,  # Optional[EmbeddingModel] — kept for API compat, not required
) -> list[dict]:
    """Search memories by text match, tags, and (optionally) semantic similarity.

    When `embedder` is None or has no local model, semantic search is skipped
    and ranking uses text match + importance + tag matching only.

    Returns a list of memory dicts with keys: id, title, type, scope, content,
    snippet, similarity, relevance, tags, importance, access_count, created_at, updated_at.
    """
    tag_results: dict[str, dict] = {}
    text_results: dict[str, dict] = {}
    semantic_results: dict[str, float] = {}

    # --- tag search ---
    if mode in ("tag", "hybrid") and tags:
        tag_matches = store.search_by_tags(
            tags=tags, scope=scope, type=type_, limit=max(limit * 2, 50)
        )
        for m in tag_matches:
            tag_results[m["id"]] = m

    # --- text search ---
    if mode in ("hybrid",) and query.strip():
        text_matches = store.search_by_text(
            query=query.strip(), scope=scope, type=type_, limit=max(limit * 2, 50)
        )
        for m in text_matches:
            text_results[m["id"]] = m

    # --- semantic search (only when embeddings are available) ---
    if mode in ("semantic", "hybrid") and embedder is not None and embedder.loaded:
        try:
            query_emb = embedder.encode(query)
            all_vecs = store.get_all_with_embeddings()

            if all_vecs:
                ids = [v["id"] for v in all_vecs]
                matrix = [v["embedding"] for v in all_vecs]

                # filter by scope / type
                if scope or type_:
                    filtered_ids = []
                    filtered_matrix = []
                    for i, vid in enumerate(ids):
                        mem = store.get_memory(vid)
                        if mem is None:
                            continue
                        if scope and mem.get("scope") not in scope:
                            continue
                        if type_ and mem.get("type") not in type_:
                            continue
                        filtered_ids.append(vid)
                        filtered_matrix.append(matrix[i])
                    ids = filtered_ids
                    matrix = filtered_matrix

                if ids:
                    from embeddings import EmbeddingModel
                    scores = EmbeddingModel.batch_similarity(query_emb, matrix)
                    for i, score in enumerate(scores):
                        if float(score) >= min_similarity:
                            semantic_results[ids[i]] = float(score)
        except NotImplementedError:
            pass  # no local model — skip semantic search silently

    # --- merge ---
    combined: list[dict] = []

    if mode == "tag":
        combined = list(tag_results.values())
        combined.sort(
            key=lambda m: (m.get("importance", 0), m.get("updated_at", "")),
            reverse=True,
        )

    elif mode == "semantic":
        for mid, similarity in sorted(semantic_results.items(), key=lambda x: -x[1]):
            mem = store.get_memory(mid)
            if mem:
                mem.pop("embedding", None)
                mem["similarity"] = similarity
                mem["relevance"] = similarity
                mem["snippet"] = (
                    mem["content"][:200] + ("..." if len(mem["content"]) > 200 else "")
                )
                mem["tags"] = store.get_tags_for_memory(mid)
                combined.append(mem)
                if len(combined) >= limit:
                    break

    else:  # hybrid
        merged_ids: set[str] = set()
        has_semantic = len(semantic_results) > 0

        def add_result(mid: str, similarity: float, *, source: str = "semantic") -> None:
            if mid in merged_ids:
                return
            mem = store.get_memory(mid)
            if mem is None:
                return
            mem.pop("embedding", None)
            mem["similarity"] = similarity
            tag_boost = 0.5 if mid in tag_results else 0.0
            text_boost = _text_match_relevance(mem, query)

            if has_semantic:
                # Original scoring: semantic 50%, text 30%, importance 15%, tag 5%
                mem["relevance"] = (
                    0.50 * similarity
                    + 0.30 * text_boost
                    + 0.15 * mem.get("importance", 0.5)
                    + 0.05 * tag_boost
                )
            else:
                # No embeddings: text 60%, importance 30%, tag 10%
                mem["relevance"] = (
                    0.60 * text_boost
                    + 0.30 * mem.get("importance", 0.5)
                    + 0.10 * tag_boost
                )

            mem["snippet"] = (
                mem["content"][:200] + ("..." if len(mem["content"]) > 200 else "")
            )
            mem["tags"] = store.get_tags_for_memory(mid)
            combined.append(mem)
            merged_ids.add(mid)

        # Process semantic results first
        for mid, similarity in sorted(semantic_results.items(), key=lambda x: -x[1]):
            add_result(mid, similarity, source="semantic")

        # Process text matches
        for mid in text_results:
            if mid not in merged_ids:
                add_result(mid, 0.0, source="text")

        # Process tag matches
        for mid in tag_results:
            if mid not in merged_ids:
                m = tag_results[mid]
                m["similarity"] = 0.0
                m["relevance"] = 0.2 * m.get("importance", 0.5) + 0.5
                m["snippet"] = (
                    m["content"][:200] + ("..." if len(m["content"]) > 200 else "")
                )
                m["tags"] = store.get_tags_for_memory(mid)
                combined.append(m)
                merged_ids.add(mid)

        combined.sort(key=lambda m: m.get("relevance", 0), reverse=True)

    # Trim
    combined = combined[:limit]

    return combined
