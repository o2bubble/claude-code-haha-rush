"""Tag normalization — apply externally-computed mappings.

No local embedding/clustering. The caller (typically an LLM via MCP)
processes all tag names, decides which are semantically similar, and
calls memory_normalize_tags with a {old: canonical} mapping. The server
only applies the mapping to the database.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from store import MemoryStore


def apply_tag_mapping(
    store: "MemoryStore",
    mapping: dict[str, str],
    dry_run: bool = False,
) -> dict:
    """Apply a tag normalization mapping to the store.

    Args:
        store: MemoryStore instance.
        mapping: {old_tag: canonical_tag}. Tags not in the mapping are unchanged.
        dry_run: If True, only return the mapping without applying changes.

    Returns:
        {"mappings": mapping, "merged_count": int, "dry_run": bool}
    """
    if not mapping:
        return {"mappings": {}, "merged_count": 0, "dry_run": dry_run}

    if dry_run:
        return {"mappings": mapping, "merged_count": len(mapping), "dry_run": True}

    # Apply: for each old tag, find memories that use it and replace with canonical
    for old_tag, canonical in mapping.items():
        if old_tag == canonical:
            continue
        cur = store._conn.execute(
            """SELECT DISTINCT mt.memory_id FROM memory_tags mt
               JOIN tags t ON t.id = mt.tag_id
               WHERE t.name = ?""",
            (old_tag,),
        )
        memory_ids = [r[0] for r in cur.fetchall()]

        for mid in memory_ids:
            current_tags = store.get_tags_for_memory(mid)
            new_tags = [canonical if t == old_tag else t for t in current_tags]
            new_tags = list(dict.fromkeys(new_tags))  # deduplicate, preserve order
            store.replace_tags(mid, new_tags)

    # Clean up orphaned tags (tags no longer used by any memory)
    store._delete_orphan_tags()

    return {"mappings": mapping, "merged_count": len(mapping), "dry_run": False}
