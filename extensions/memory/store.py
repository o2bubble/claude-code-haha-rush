"""SQLite storage layer for the memory MCP server.

Schema:
  memories      — id, type, scope, title, content, embedding, version, ...
  memories_fts  — FTS5 index over tokenized title/content (optional)
  tags          — id, name (unique)
  memory_tags   — many-to-many bridge
  associations  — directed weighted edges between memories
  meta          — key-value metadata (schema_version, tokenizer, etc.)

The FTS5 index stores tokenized text only; display text is always read from
`memories` via JOIN (index and display are separate concerns).
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

import tokenizer

SCHEMA_VERSION = 3


def _compute_hash(title: str, content: str) -> str:
    """Stable hash of core memory fields for change detection."""
    joined = f"{title}\0{content}"
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uid() -> str:
    return str(uuid.uuid4())


def _unpack_embedding(blob: bytes) -> list[float]:
    """Unpack a BLOB into a float32 list.

    Kept for reading legacy rows written before the embedding channel was
    removed; the column stays in the schema for a future vector channel.
    """
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


def _scope_condition(scope: list[str]) -> tuple[str, list[Any]]:
    """Build a WHERE fragment matching any of the given scopes.

    Exact values match exactly; values ending in '*' are prefix matches
    ('project:*' → scope LIKE 'project:%'). The wildcard is compiled into the
    SQL rather than expanded into a separate lookup query, so a prefix that
    matches nothing yields an empty result set instead of silently dropping
    the filter (which would return everything).
    """
    clauses: list[str] = []
    params: list[Any] = []
    for raw in scope:
        s = (raw or "").strip()
        if not s:
            continue
        if s.endswith("*"):
            prefix = s[:-1]
            # Escape LIKE's own wildcards so a literal % or _ in the prefix
            # can't widen the match.
            escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            clauses.append("m.scope LIKE ? ESCAPE '\\'")
            params.append(f"{escaped}%")
        else:
            clauses.append("m.scope = ?")
            params.append(s)
    if not clauses:
        # Every entry was blank — match nothing rather than everything.
        return "1=0", []
    return "(" + " OR ".join(clauses) + ")", params


def _open_db(db_path: str) -> sqlite3.Connection:
    """Open (or create) the SQLite database and apply the schema."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    # server.py and api.py start concurrently against the same file; wait for
    # locks instead of failing immediately during migrations / FTS rebuilds.
    conn.execute("PRAGMA busy_timeout=30000")
    # PRAGMA journal_mode does NOT honor busy_timeout — it fails instantly
    # when a peer holds the write lock. WAL is persistent, so check first and
    # tolerate contention: a concurrent opener sets it for everyone.
    try:
        if conn.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
            conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memories (
            id            TEXT PRIMARY KEY,
            type          TEXT NOT NULL CHECK(type IN ('fact','experience','lesson')),
            scope         TEXT NOT NULL DEFAULT 'global',
            title         TEXT NOT NULL,
            content       TEXT NOT NULL,
            embedding     BLOB,
            importance    REAL NOT NULL DEFAULT 0.5,
            access_count  INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL,
            content_hash  TEXT,
            version       INTEGER NOT NULL DEFAULT 1,
            superseded_by TEXT,
            deleted_at    TEXT,
            source        TEXT
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
    # created after migration: the column only exists once the DB is v3
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)"
    )
    return conn


def _ensure_meta(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None:
        # Fresh database — schema is already current. server.py and api.py open
        # the same file concurrently, so both may find the row missing and race
        # to insert it; the loser would hit "UNIQUE constraint failed". Let the
        # last writer win instead of raising.
        conn.execute(
            "INSERT OR IGNORE INTO meta VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),)
        )
        return

    if int(row[0]) == SCHEMA_VERSION:
        return

    # Migration path. server.py and api.py open the same file concurrently and
    # both may attempt the upgrade: BEGIN IMMEDIATE serializes them, and the
    # version is re-read under the lock so whichever loses the race sees the
    # already-migrated state and skips (otherwise: "duplicate column name").
    conn.commit()  # clear any implicit transaction before taking the write lock
    conn.execute("BEGIN IMMEDIATE")
    try:
        stored = int(
            conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
        )
        if stored == 1:
            conn.execute("ALTER TABLE memories ADD COLUMN content_hash TEXT")
            for r in conn.execute(
                "SELECT id, title, content FROM memories WHERE content_hash IS NULL"
            ):
                h = _compute_hash(r["title"], r["content"])
                conn.execute("UPDATE memories SET content_hash=? WHERE id=?", (h, r["id"]))
            conn.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
            stored = 2
        if stored == 2:
            conn.execute("ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
            conn.execute("ALTER TABLE memories ADD COLUMN superseded_by TEXT")
            conn.execute("ALTER TABLE memories ADD COLUMN deleted_at TEXT")
            conn.execute("ALTER TABLE memories ADD COLUMN source TEXT")
            conn.execute("UPDATE meta SET value='3' WHERE key='schema_version'")
            stored = 3
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    if stored != SCHEMA_VERSION:
        raise RuntimeError(
            f"DB schema version is {stored}, expected {SCHEMA_VERSION}. "
            f"Run migration or delete the DB file."
        )


def _ensure_fts(conn: sqlite3.Connection) -> bool:
    """Create the FTS5 index table. Returns False when FTS5 is unavailable."""
    try:
        conn.execute(
            """CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                   memory_id UNINDEXED,
                   title_tokens,
                   content_tokens
               )"""
        )
        return True
    except sqlite3.OperationalError:
        return False


# ---------------------------------------------------------------------------
# MemoryStore
# ---------------------------------------------------------------------------


class MemoryStore:
    """CRUD + search over memories, tags, and associations."""

    def __init__(self, db_path: str = "claude-memory.db") -> None:
        self.db_path = db_path
        self._conn = _open_db(db_path)
        self._fts = _ensure_fts(self._conn)
        if not self._fts:
            # FTS5 unavailable: record why so memory_stats can report it.
            self.set_meta("fts_enabled", "0")
            return
        # (Re)build the index once per migration, or when the tokenizer engine
        # changed (jieba vs bigram produce different tokens — index side and
        # query side must always use the same engine). BEGIN IMMEDIATE so
        # concurrent openers (server.py + api.py) serialize: the loser sees
        # fts_enabled=1 and skips instead of double-rebuilding. An index
        # problem must never block startup — degrade to LIKE instead.
        tok_status = tokenizer.get_tokenizer_status()
        try:
            self._conn.commit()
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                if (
                    self.get_meta("fts_enabled") != "1"
                    or self.get_meta("tokenizer") != tok_status
                ):
                    self._rebuild_fts()
                    # direct writes: set_meta() opens its own `with conn`
                    # block, which would commit this explicit transaction early
                    for key, value in (("fts_enabled", "1"), ("tokenizer", tok_status)):
                        self._conn.execute(
                            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                            (key, value),
                        )
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
        except Exception:
            self._fts = False
            self.set_meta("fts_enabled", "0")

    # -- helpers ------------------------------------------------------------

    def _fts_upsert(self, memory_id: str, title: str, content: str) -> None:
        """Keep the FTS row for one memory in sync (no-op without FTS5)."""
        if not self._fts:
            return
        self._conn.execute("DELETE FROM memories_fts WHERE memory_id=?", (memory_id,))
        self._conn.execute(
            "INSERT INTO memories_fts(memory_id, title_tokens, content_tokens) VALUES (?,?,?)",
            (
                memory_id,
                tokenizer.tokenize_for_index(title),
                tokenizer.tokenize_for_index(content),
            ),
        )

    def _fts_delete(self, memory_id: str) -> None:
        if not self._fts:
            return
        self._conn.execute("DELETE FROM memories_fts WHERE memory_id=?", (memory_id,))

    def _rebuild_fts(self) -> None:
        """Full re-index of every memory (including superseded/deleted rows).

        The caller must hold an open write transaction (see __init__), so
        concurrent openers serialize instead of rebuilding in parallel.
        """
        if not self._fts:
            return
        self._conn.execute("DELETE FROM memories_fts")
        for r in self._conn.execute("SELECT id, title, content FROM memories"):
            self._fts_upsert(r["id"], r["title"], r["content"])

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
        importance: float = 0.5,
        associations: Optional[list[dict[str, Any]]] = None,
        source: Optional[str] = None,
    ) -> dict[str, Any]:
        mid = _uid()
        now = _now()
        content_hash = _compute_hash(title, content)

        with self._conn:
            self._conn.execute(
                """INSERT INTO memories (id, type, scope, title, content,
                   importance, created_at, updated_at, content_hash, source)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (mid, type, scope, title, content, importance, now, now,
                 content_hash, source),
            )
            self._fts_upsert(mid, title, content)
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
    ) -> bool:
        row = self._conn.execute(
            "SELECT title, content FROM memories WHERE id=?", (memory_id,)
        ).fetchone()
        if row is None:
            return False

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
        if not sets:
            return False

        new_title = title if title is not None else row["title"]
        new_content = content if content is not None else row["content"]
        text_changed = title is not None or content is not None
        if text_changed:
            sets.append("content_hash=?")
            params.append(_compute_hash(new_title, new_content))

        sets.append("version = version + 1")
        sets.append("updated_at=?")
        params.append(_now())
        params.append(memory_id)

        with self._conn:
            self._conn.execute(
                f"UPDATE memories SET {', '.join(sets)} WHERE id=?", params
            )
            if text_changed:
                self._fts_upsert(memory_id, new_title, new_content)
        return True

    def delete_memory(self, memory_id: str) -> bool:
        with self._conn:
            cur = self._conn.execute("DELETE FROM memories WHERE id=?", (memory_id,))
            if cur.rowcount > 0:
                self._fts_delete(memory_id)
        return cur.rowcount > 0

    def soft_delete_memory(self, memory_id: str) -> bool:
        """Mark a memory as deleted without removing the row (auditable)."""
        now = _now()
        with self._conn:
            cur = self._conn.execute(
                "UPDATE memories SET deleted_at=?, updated_at=? "
                "WHERE id=? AND deleted_at IS NULL",
                (now, now, memory_id),
            )
        return cur.rowcount > 0

    def merge_supersede(
        self,
        target_ids: list[str],
        type: str,
        title: str,
        content: str,
        *,
        scope: Optional[str] = None,
        tags: Optional[list[str]] = None,
        importance: Optional[float] = None,
        source: Optional[str] = None,
    ) -> str:
        """Create a merged record and mark targets as superseded.

        Runs as one transaction: either the new record exists with every
        target retired, or nothing changes. Associations (both directions)
        and content refs of the targets are transferred to the new record so
        the knowledge graph stays connected. Returns the new memory's id.
        """
        targets = []
        for tid in target_ids:
            mem = self.get_memory(tid)
            if mem is None:
                raise ValueError(f"target id not found: {tid}")
            targets.append(mem)
        if not targets:
            raise ValueError("no target ids to merge")

        if scope is None:
            scope = targets[0].get("scope", "global")
        if tags is None:
            seen: dict[str, None] = {}
            for t in targets:
                for name in self.get_tags_for_memory(t["id"]):
                    seen[name] = None
            tags = sorted(seen)
        # A merge is at least as important as its most important part.
        target_max = max(t.get("importance", 0.5) for t in targets)
        importance = target_max if importance is None else max(importance, target_max)

        new_id = _uid()
        now = _now()
        content_hash = _compute_hash(title, content)

        with self._conn:  # single transaction — all or nothing
            self._conn.execute(
                """INSERT INTO memories (id, type, scope, title, content,
                   importance, created_at, updated_at, content_hash, source)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (new_id, type, scope, title, content, importance, now, now,
                 content_hash, source),
            )
            self._fts_upsert(new_id, title, content)
            for t in (tags or []):
                tid = self._get_tag_id(t)
                self._conn.execute(
                    "INSERT OR IGNORE INTO memory_tags(memory_id, tag_id) VALUES (?, ?)",
                    (new_id, tid),
                )

            for t in targets:
                tid = t["id"]
                for a in self._conn.execute(
                    "SELECT target_id, weight, type FROM associations WHERE source_id=?",
                    (tid,),
                ).fetchall():
                    self._conn.execute(
                        "INSERT OR REPLACE INTO associations "
                        "(source_id,target_id,weight,type,created_at) VALUES (?,?,?,?,?)",
                        (new_id, a["target_id"], a["weight"], a["type"], now),
                    )
                for a in self._conn.execute(
                    "SELECT source_id, weight, type FROM associations WHERE target_id=?",
                    (tid,),
                ).fetchall():
                    self._conn.execute(
                        "INSERT OR REPLACE INTO associations "
                        "(source_id,target_id,weight,type,created_at) VALUES (?,?,?,?,?)",
                        (a["source_id"], new_id, a["weight"], a["type"], now),
                    )
                for r in self._conn.execute(
                    "SELECT target_id FROM content_refs WHERE source_id=?", (tid,)
                ).fetchall():
                    self._conn.execute(
                        "INSERT OR IGNORE INTO content_refs(source_id,target_id) VALUES (?,?)",
                        (new_id, r["target_id"]),
                    )
                for r in self._conn.execute(
                    "SELECT source_id FROM content_refs WHERE target_id=?", (tid,)
                ).fetchall():
                    self._conn.execute(
                        "INSERT OR IGNORE INTO content_refs(source_id,target_id) VALUES (?,?)",
                        (r["source_id"], new_id),
                    )
                self._conn.execute(
                    "UPDATE memories SET superseded_by=?, updated_at=?, "
                    "version = version + 1 WHERE id=?",
                    (new_id, now, tid),
                )
        return new_id

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

    def fts_search(
        self,
        query: str,
        scope: Optional[list[str]] = None,
        type: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """BM25 full-text search over the tokenized FTS5 index.

        Returns memory dicts (same shape as other search methods) plus a
        normalized `score` in (0, 1): FTS5's bm25() is a negative relevance,
        mapped via relevance / (1 + relevance) so thresholds mean the same
        thing across retrieval channels.
        """
        if not self._fts:
            return []
        fts_q = tokenizer.build_fts_query(query)
        if not fts_q:
            return []

        conditions = [
            "memories_fts MATCH ?",
            "m.superseded_by IS NULL",
            "m.deleted_at IS NULL",
        ]
        params: list[Any] = [fts_q]
        if scope:
            cond, scope_params = _scope_condition(scope)
            conditions.append(cond)
            params.extend(scope_params)
        if type:
            conditions.append(f"m.type IN ({','.join('?' * len(type))})")
            params.extend(type)

        retrieve = max(limit * 3, limit)  # over-fetch for post-filtering
        params.append(retrieve)
        # bm25() weights follow column order: (memory_id, title_tokens,
        # content_tokens) — memory_id is UNINDEXED so its weight is inert.
        sql = f"""
            SELECT memories_fts.memory_id AS id,
                   bm25(memories_fts, 0.0, 10.0, 1.0) AS rank
            FROM memories_fts
            JOIN memories m ON m.id = memories_fts.memory_id
            WHERE {' AND '.join(conditions)}
            ORDER BY rank
            LIMIT ?
        """
        rows = self._conn.execute(sql, params).fetchall()

        results: list[dict[str, Any]] = []
        for r in rows:
            mem = self.get_memory(r["id"])
            if mem is None:
                continue
            mem.pop("embedding", None)
            relevance = -float(r["rank"])  # FTS5 bm25(): negative = more relevant
            mem["score"] = relevance / (1.0 + relevance) if relevance > 0 else 0.0
            mem["tags"] = self.get_tags_for_memory(r["id"])
            results.append(mem)
            if len(results) >= limit:
                break  # over-fetch is internal to the SQL; callers get <= limit
        return results

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
        conditions = ["m.superseded_by IS NULL", "m.deleted_at IS NULL"]
        params: list[Any] = []

        if scope:
            cond, scope_params = _scope_condition(scope)
            conditions.append(cond)
            params.extend(scope_params)
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

        conditions = [
            token_conditions,
            "m.superseded_by IS NULL",
            "m.deleted_at IS NULL",
        ]

        if scope:
            cond, scope_params = _scope_condition(scope)
            conditions.append(cond)
            params.extend(scope_params)
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

    def record_access(self, memory_id: str) -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?",
                (_now(), memory_id),
            )

    # -- stats & meta -------------------------------------------------------

    def get_capabilities(self) -> dict[str, Any]:
        """What this store can actually do — callers read this to pick a path."""
        return {
            "fts": bool(self._fts),
            "jieba": tokenizer.get_tokenizer_status() == "jieba",
            "tags": True,
            "like_fallback": not self._fts,
            "embedding": False,
        }

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

        cur = self._conn.execute(
            "SELECT COUNT(*) FROM memories WHERE superseded_by IS NOT NULL"
        )
        stats["superseded"] = cur.fetchone()[0]

        cur = self._conn.execute(
            "SELECT COUNT(*) FROM memories WHERE deleted_at IS NOT NULL"
        )
        stats["deleted"] = cur.fetchone()[0]

        stats["capabilities"] = self.get_capabilities()
        stats["tokenizer"] = self.get_meta("tokenizer") or tokenizer.get_tokenizer_status()

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
