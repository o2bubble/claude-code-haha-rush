"""SQLite storage layer for the memory MCP server.

Schema:
  memories      — id, type, scope, title, content, embedding, importance, ...
  tags          — id, name (unique)
  memory_tags   — many-to-many bridge
  associations  — directed weighted edges between memories
  meta          — key-value metadata (schema_version, model info, etc.)
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import struct
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import re

SCHEMA_VERSION = 2


def _compute_hash(title: str, content: str) -> str:
    """Stable hash of core memory fields for change detection."""
    joined = f"{title}\0{content}"
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uid() -> str:
    return str(uuid.uuid4())


def _pack_embedding(vec: list[float]) -> bytes:
    """Pack a float32 list into a BLOB."""
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack_embedding(blob: bytes) -> list[float]:
    """Unpack a BLOB back into a float32 list."""
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


def _open_db(db_path: str) -> sqlite3.Connection:
    """Open (or create) the SQLite database and apply the schema."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memories (
            id           TEXT PRIMARY KEY,
            type         TEXT NOT NULL CHECK(type IN ('fact','experience','lesson')),
            scope        TEXT NOT NULL DEFAULT 'global',
            title        TEXT NOT NULL,
            content      TEXT NOT NULL,
            embedding    BLOB,
            importance   REAL NOT NULL DEFAULT 0.5,
            access_count INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            content_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memories_type       ON memories(type);
        CREATE INDEX IF NOT EXISTS idx_memories_scope      ON memories(scope);
        CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);

        CREATE TABLE IF NOT EXISTS tags (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_tags (
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (memory_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS associations (
            source_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            target_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            weight     REAL NOT NULL DEFAULT 0.5,
            type       TEXT NOT NULL DEFAULT 'related_to'
                       CHECK(type IN ('related_to','derived_from','contradicts','supports')),
            created_at TEXT NOT NULL,
            PRIMARY KEY (source_id, target_id, type)
        );

        CREATE TABLE IF NOT EXISTS content_refs (
            source_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            target_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            PRIMARY KEY (source_id, target_id)
        );
    """)
    _ensure_meta(conn)
    return conn


def _ensure_meta(conn: sqlite3.Connection) -> None:
    cur = conn.execute("SELECT value FROM meta WHERE key='schema_version'")
    row = cur.fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO meta VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),)
        )
    else:
        stored = int(row[0])
        if stored == 1 and SCHEMA_VERSION == 2:
            conn.execute("ALTER TABLE memories ADD COLUMN content_hash TEXT")
            # Backfill existing rows
            for row in conn.execute("SELECT id, title, content FROM memories WHERE content_hash IS NULL"):
                h = _compute_hash(row["title"], row["content"])
                conn.execute("UPDATE memories SET content_hash=? WHERE id=?", (h, row["id"]))
            conn.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
        elif stored != SCHEMA_VERSION:
            raise RuntimeError(
                f"DB schema version is {stored}, expected {SCHEMA_VERSION}. "
                f"Run migration or delete the DB file."
            )


# ---------------------------------------------------------------------------
# MemoryStore
# ---------------------------------------------------------------------------


class MemoryStore:
    """CRUD + search over memories, tags, and associations."""

    def __init__(self, db_path: str = "claude-memory.db") -> None:
        self.db_path = db_path
        self._conn = _open_db(db_path)

    # -- helpers ------------------------------------------------------------

    def _get_tag_id(self, name: str) -> int:
        cur = self._conn.execute(
            "INSERT OR IGNORE INTO tags(name) VALUES (?)", (name.lower().strip(),)
        )
        cur = self._conn.execute("SELECT id FROM tags WHERE name=?", (name.lower().strip(),))
        return cur.fetchone()[0]

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        d = {k: row[k] for k in row.keys()}
        if d.get("embedding") is not None:
            d["embedding"] = _unpack_embedding(d["embedding"])
        return d

    # -- memories -----------------------------------------------------------

    def add_memory(
        self,
        type: str,
        title: str,
        content: str,
        scope: str = "global",
        tags: Optional[list[str]] = None,
        embedding: Optional[list[float]] = None,
        importance: float = 0.5,
        associations: Optional[list[dict[str, Any]]] = None,
    ) -> dict[str, Any]:
        mid = _uid()
        now = _now()
        emb_blob = _pack_embedding(embedding) if embedding is not None else None
        content_hash = _compute_hash(title, content)

        with self._conn:
            self._conn.execute(
                """INSERT INTO memories (id, type, scope, title, content, embedding,
                   importance, created_at, updated_at, content_hash)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (mid, type, scope, title, content, emb_blob, importance, now, now, content_hash),
            )
            if tags:
                for t in tags:
                    tid = self._get_tag_id(t)
                    self._conn.execute(
                        "INSERT OR IGNORE INTO memory_tags(memory_id, tag_id) VALUES (?, ?)",
                        (mid, tid),
                    )
            if associations:
                for a in associations:
                    self._conn.execute(
                        """INSERT OR REPLACE INTO associations
                           (source_id, target_id, weight, type, created_at)
                           VALUES (?, ?, ?, ?, ?)""",
                        (mid, a["target_id"], a.get("weight", 0.5), a.get("type", "related_to"), now),
                    )

            # Auto-parse memory://<id> references in content
            refs = set(re.findall(r'memory://([a-f0-9-]{36})', content))
            for target_id in refs:
                self._conn.execute(
                    "INSERT OR IGNORE INTO content_refs(source_id, target_id) VALUES (?, ?)",
                    (mid, target_id),
                )

        return {"id": mid, "title": title, "type": type, "scope": scope}

    def get_memory(self, memory_id: str) -> Optional[dict[str, Any]]:
        cur = self._conn.execute(
            "SELECT * FROM memories WHERE id=?", (memory_id,)
        )
        row = cur.fetchone()
        if row is None:
            return None
        return self._row_to_dict(row)

    def update_memory(
        self,
        memory_id: str,
        *,
        title: Optional[str] = None,
        content: Optional[str] = None,
        importance: Optional[float] = None,
        embedding: Optional[list[float]] = None,
    ) -> bool:
        sets: list[str] = []
        params: list[Any] = []
        if title is not None:
            sets.append("title=?")
            params.append(title)
        if content is not None:
            sets.append("content=?")
            params.append(content)
        if importance is not None:
            sets.append("importance=?")
            params.append(importance)
        if embedding is not None:
            sets.append("embedding=?")
            params.append(_pack_embedding(embedding))
        if not sets:
            return False
        sets.append("updated_at=?")
        params.append(_now())
        if "title" in {s.split("=")[0] for s in sets} or "content" in {s.split("=")[0] for s in sets}:
            # Need current values if only one of title/content is changing
            cur = self._conn.execute("SELECT title, content FROM memories WHERE id=?", (memory_id,))
            row = cur.fetchone()
            if row:
                new_title = title if title is not None else row["title"]
                new_content = content if content is not None else row["content"]
                sets.append("content_hash=?")
                params.append(_compute_hash(new_title, new_content))
        params.append(memory_id)
        sql = f"UPDATE memories SET {', '.join(sets)} WHERE id=?"
        with self._conn:
            self._conn.execute(sql, params)
        return True

    def delete_memory(self, memory_id: str) -> bool:
        with self._conn:
            cur = self._conn.execute("DELETE FROM memories WHERE id=?", (memory_id,))
        return cur.rowcount > 0

    # -- tags ---------------------------------------------------------------

    def add_tags(self, memory_id: str, tag_names: list[str]) -> None:
        with self._conn:
            for t in tag_names:
                tid = self._get_tag_id(t)
                self._conn.execute(
                    "INSERT OR IGNORE INTO memory_tags(memory_id, tag_id) VALUES (?, ?)",
                    (memory_id, tid),
                )

    def remove_tags(self, memory_id: str, tag_names: list[str]) -> None:
        with self._conn:
            for t in tag_names:
                self._conn.execute(
                    """DELETE FROM memory_tags
                       WHERE memory_id=? AND tag_id=(SELECT id FROM tags WHERE name=?)""",
                    (memory_id, t.lower().strip()),
                )

    def replace_tags(self, memory_id: str, tag_names: list[str]) -> None:
        """Atomically replace all tags for a memory (used by tag normalization)."""
        with self._conn:
            self._conn.execute("DELETE FROM memory_tags WHERE memory_id=?", (memory_id,))
            for t in tag_names:
                tid = self._get_tag_id(t)
                self._conn.execute(
                    "INSERT INTO memory_tags(memory_id, tag_id) VALUES (?, ?)",
                    (memory_id, tid),
                )

    def get_tags_for_memory(self, memory_id: str) -> list[str]:
        cur = self._conn.execute(
            """SELECT t.name FROM tags t
               JOIN memory_tags mt ON t.id = mt.tag_id
               WHERE mt.memory_id=?
               ORDER BY t.name""",
            (memory_id,),
        )
        return [r[0] for r in cur.fetchall()]

    def list_all_tags(self, scope: Optional[str] = None) -> list[dict[str, Any]]:
        if scope:
            cur = self._conn.execute(
                """SELECT t.name, COUNT(mt.memory_id) as cnt
                   FROM tags t
                   JOIN memory_tags mt ON t.id = mt.tag_id
                   JOIN memories m ON m.id = mt.memory_id
                   WHERE m.scope = ?
                   GROUP BY t.name ORDER BY cnt DESC""",
                (scope,),
            )
        else:
            cur = self._conn.execute(
                """SELECT t.name, COUNT(mt.memory_id) as cnt
                   FROM tags t
                   JOIN memory_tags mt ON t.id = mt.tag_id
                   GROUP BY t.name ORDER BY cnt DESC"""
            )
        return [{"tag": r[0], "count": r[1]} for r in cur.fetchall()]

    def _delete_orphan_tags(self) -> None:
        self._conn.execute(
            """DELETE FROM tags WHERE id NOT IN
               (SELECT DISTINCT tag_id FROM memory_tags)"""
        )

    # -- content refs -------------------------------------------------------

    def get_content_refs(self, memory_id: str) -> list[dict[str, Any]]:
        """Return memories this memory references via memory:// links."""
        cur = self._conn.execute(
            """SELECT cr.target_id, m.title
               FROM content_refs cr
               JOIN memories m ON m.id = cr.target_id
               WHERE cr.source_id = ?""",
            (memory_id,),
        )
        return [{"id": r[0], "title": r[1]} for r in cur.fetchall()]

    def get_referencing(self, memory_id: str) -> list[dict[str, Any]]:
        """Return memories that reference this one via memory:// links."""
        cur = self._conn.execute(
            """SELECT cr.source_id, m.title
               FROM content_refs cr
               JOIN memories m ON m.id = cr.source_id
               WHERE cr.target_id = ?""",
            (memory_id,),
        )
        return [{"id": r[0], "title": r[1]} for r in cur.fetchall()]

    def get_all_content_refs(self) -> list[dict[str, Any]]:
        """Return all content reference edges (for graph rendering)."""
        cur = self._conn.execute(
            """SELECT cr.source_id, cr.target_id, ms.title as source_title, mt.title as target_title
               FROM content_refs cr
               JOIN memories ms ON ms.id = cr.source_id
               JOIN memories mt ON mt.id = cr.target_id
               ORDER BY cr.source_id"""
        )
        return [
            {"source_id": r[0], "target_id": r[1], "source_title": r[2], "target_title": r[3]}
            for r in cur.fetchall()
        ]

    # -- associations -------------------------------------------------------

    def add_association(
        self,
        source_id: str,
        target_id: str,
        weight: float = 0.5,
        type: str = "related_to",
        bidirectional: bool = False,
    ) -> dict[str, Any]:
        now = _now()
        with self._conn:
            self._conn.execute(
                """INSERT OR REPLACE INTO associations
                   (source_id, target_id, weight, type, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (source_id, target_id, weight, type, now),
            )
            if bidirectional:
                self._conn.execute(
                    """INSERT OR REPLACE INTO associations
                       (source_id, target_id, weight, type, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (target_id, source_id, weight, type, now),
                )
        return {"source_id": source_id, "target_id": target_id, "weight": weight, "type": type}

    def get_associations(
        self, memory_id: str, direction: str = "both"
    ) -> list[dict[str, Any]]:
        """Return edges where memory_id is source, target, or both."""
        results: list[dict[str, Any]] = []
        cur: sqlite3.Cursor

        if direction in ("outgoing", "both"):
            cur = self._conn.execute(
                """SELECT a.source_id, a.target_id, a.weight, a.type, m.title as target_title
                   FROM associations a
                   JOIN memories m ON m.id = a.target_id
                   WHERE a.source_id=?""",
                (memory_id,),
            )
            for r in cur.fetchall():
                results.append({
                    "source_id": r[0], "target_id": r[1], "weight": r[2],
                    "type": r[3], "target_title": r[4], "direction": "outgoing",
                })

        if direction in ("incoming", "both"):
            cur = self._conn.execute(
                """SELECT a.source_id, a.target_id, a.weight, a.type, m.title as source_title
                   FROM associations a
                   JOIN memories m ON m.id = a.source_id
                   WHERE a.target_id=?""",
                (memory_id,),
            )
            for r in cur.fetchall():
                results.append({
                    "source_id": r[0], "target_id": r[1], "weight": r[2],
                    "type": r[3], "source_title": r[4], "direction": "incoming",
                })

        return results

    def delete_association(
        self, source_id: str, target_id: str, type: str = "related_to"
    ) -> bool:
        with self._conn:
            cur = self._conn.execute(
                "DELETE FROM associations WHERE source_id=? AND target_id=? AND type=?",
                (source_id, target_id, type),
            )
        return cur.rowcount > 0

    def get_connected_edges(
        self, memory_id: str, min_weight: float = 0.0, max_depth: int = 2
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """BFS traversal from memory_id, returning (nodes, edges)."""
        visited: set[str] = set()
        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        frontier = {memory_id}

        for _ in range(max_depth + 1):
            next_frontier: set[str] = set()
            for nid in frontier:
                if nid in visited:
                    continue
                visited.add(nid)
                mem = self.get_memory(nid)
                if mem:
                    mem.pop("embedding", None)
                    mem.pop("content", None)
                    nodes.append(mem)

                assocs = self.get_associations(nid, direction="outgoing")
                for a in assocs:
                    if a["weight"] >= min_weight:
                        edges.append(a)
                        if a["target_id"] not in visited:
                            next_frontier.add(a["target_id"])

            frontier = next_frontier
            if not frontier:
                break

        return nodes, edges

    # -- search -------------------------------------------------------------

    def search_by_tags(
        self,
        tags: list[str],
        scope: Optional[list[str]] = None,
        type: Optional[list[str]] = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Find memories that match ALL given tags, with optional filters."""
        tag_names = [t.lower().strip() for t in tags]
        placeholders = ",".join("?" * len(tag_names))
        conditions = ["1=1"]
        params: list[Any] = []

        if scope:
            scope_ph = ",".join("?" * len(scope))
            conditions.append(f"m.scope IN ({scope_ph})")
            params.extend(scope)
        if type:
            type_ph = ",".join("?" * len(type))
            conditions.append(f"m.type IN ({type_ph})")
            params.extend(type)

        params.extend(tag_names)
        params.append(len(tag_names))
        params.append(limit)

        sql = f"""
            SELECT m.*, GROUP_CONCAT(t.name) as tag_list
            FROM memories m
            JOIN memory_tags mt ON m.id = mt.memory_id
            JOIN tags t ON t.id = mt.tag_id
            WHERE {' AND '.join(conditions)}
              AND t.name IN ({placeholders})
            GROUP BY m.id
            HAVING COUNT(DISTINCT t.name) = ?
            ORDER BY m.importance DESC, m.updated_at DESC
            LIMIT ?
        """
        cur = self._conn.execute(sql, params)
        rows = cur.fetchall()
        results = []
        for r in rows:
            d = {k: r[k] for k in r.keys()}
            d["tags"] = d.pop("tag_list", "").split(",") if d.get("tag_list") else []
            if d.get("embedding") is not None:
                del d["embedding"]  # don't send raw vectors to agent
            results.append(d)
        return results

    def search_by_text(
        self,
        query: str,
        scope: Optional[list[str]] = None,
        type: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Find memories whose title or content contains ANY keyword from the query.

        The query is split into tokens. Documents matching more keywords
        rank higher. Single-character tokens and very common words are skipped.
        """
        import re

        # Tokenize: split on whitespace + punctuation, keep CJK chars
        raw_tokens = re.split(r"[\s,.;:!?()\[\]{}\"']+", query.strip().lower())
        # Filter: keep tokens >= 2 chars (or single CJK char)
        tokens = []
        for t in raw_tokens:
            if not t:
                continue
            if len(t) >= 2:
                tokens.append(t)
            elif len(t) == 1 and "\u4e00" <= t <= "\u9fff":
                tokens.append(t)  # single CJK character is meaningful

        # Deduplicate
        tokens = list(dict.fromkeys(tokens))

        if not tokens:
            tokens = [query.strip().lower()]

        # Build OR conditions: each token matches title or content
        or_clauses = []
        params: list[Any] = []
        score_parts = []
        for t in tokens:
            like = f"%{t}%"
            or_clauses.append("(m.title LIKE ? OR m.content LIKE ?)")
            params.extend([like, like])
            # Score: +10 if title matches this token, +5 if content matches
            score_parts.append(
                f"(CASE WHEN m.title LIKE ? THEN 10 WHEN m.content LIKE ? THEN 5 ELSE 0 END)"
            )
            params.extend([like, like])

        token_conditions = f"({' OR '.join(or_clauses)})"
        score_expr = " + ".join(score_parts)

        conditions = [token_conditions]

        if scope:
            scope_ph = ",".join("?" * len(scope))
            conditions.append(f"m.scope IN ({scope_ph})")
            params.extend(scope)
        if type:
            type_ph = ",".join("?" * len(type))
            conditions.append(f"m.type IN ({type_ph})")
            params.extend(type)

        params.append(limit)
        sql = f"""
            SELECT m.*, GROUP_CONCAT(t.name) as tag_list,
                   ({score_expr}) as keyword_score
            FROM memories m
            LEFT JOIN memory_tags mt ON m.id = mt.memory_id
            LEFT JOIN tags t ON t.id = mt.tag_id
            WHERE {' AND '.join(conditions)}
            GROUP BY m.id
            ORDER BY
                keyword_score DESC,
                m.importance DESC,
                m.updated_at DESC
            LIMIT ?
        """
        cur = self._conn.execute(sql, params)
        rows = cur.fetchall()
        results = []
        for r in rows:
            d = {k: r[k] for k in r.keys()}
            d["tags"] = d.pop("tag_list", "").split(",") if d.get("tag_list") else []
            if d.get("embedding") is not None:
                del d["embedding"]
            results.append(d)
        return results

    def get_all_with_embeddings(self) -> list[dict[str, Any]]:
        """Return (id, embedding, importance, updated_at) for all memories that have embeddings."""
        cur = self._conn.execute(
            """SELECT id, embedding, importance, updated_at
               FROM memories WHERE embedding IS NOT NULL"""
        )
        results = []
        for r in cur.fetchall():
            results.append({
                "id": r[0],
                "embedding": _unpack_embedding(r[1]),
                "importance": r[2],
                "updated_at": r[3],
            })
        return results

    def record_access(self, memory_id: str) -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?",
                (_now(), memory_id),
            )

    # -- stats & meta -------------------------------------------------------

    def get_stats(self) -> dict[str, Any]:
        stats: dict[str, Any] = {}

        for t in ("fact", "experience", "lesson"):
            cur = self._conn.execute("SELECT COUNT(*) FROM memories WHERE type=?", (t,))
            stats.setdefault("by_type", {})[t] = cur.fetchone()[0]

        cur = self._conn.execute(
            "SELECT scope, COUNT(*) FROM memories GROUP BY scope ORDER BY COUNT(*) DESC"
        )
        stats["by_scope"] = {r[0]: r[1] for r in cur.fetchall()}

        cur = self._conn.execute("SELECT COUNT(*) FROM tags")
        stats["total_tags"] = cur.fetchone()[0]

        cur = self._conn.execute("SELECT COUNT(*) FROM associations")
        stats["total_associations"] = cur.fetchone()[0]

        cur = self._conn.execute("SELECT COUNT(*) FROM content_refs")
        stats["total_content_refs"] = cur.fetchone()[0]

        cur = self._conn.execute("SELECT COUNT(*) FROM memories")
        stats["total_memories"] = cur.fetchone()[0]

        if os.path.exists(self.db_path):
            stats["db_size_kb"] = round(os.path.getsize(self.db_path) / 1024, 1)
        else:
            stats["db_size_kb"] = 0

        cur = self._conn.execute("SELECT value FROM meta WHERE key='embedding_model'")
        row = cur.fetchone()
        stats["model"] = row[0] if row else None

        return stats

    def set_meta(self, key: str, value: str) -> None:
        with self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value)
            )

    def get_meta(self, key: str) -> Optional[str]:
        cur = self._conn.execute("SELECT value FROM meta WHERE key=?", (key,))
        row = cur.fetchone()
        return row[0] if row else None

    def close(self) -> None:
        self._conn.close()
