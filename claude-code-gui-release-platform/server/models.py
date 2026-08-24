"""SQLite database layer for the skill registry."""

import sqlite3
import json
import os
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "registry.db")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS packages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            slug        TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL,
            description TEXT DEFAULT '',
            author      TEXT NOT NULL,
            version     TEXT NOT NULL,
            tags        TEXT DEFAULT '[]',
            download_count INTEGER DEFAULT 0,
            skill_count INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS api_keys (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            key_hash   TEXT UNIQUE NOT NULL,
            label      TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS feedback (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            type        TEXT NOT NULL CHECK(type IN ('bug', 'suggestion')),
            message     TEXT NOT NULL,
            image_path  TEXT,
            app_version TEXT DEFAULT '',
            status      TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
            created_at  TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


# ── Packages ──

def list_packages() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM packages ORDER BY download_count DESC"
    ).fetchall()
    conn.close()
    return [_row_to_pkg(r) for r in rows]


def get_package(slug: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM packages WHERE slug = ?", (slug,)).fetchone()
    conn.close()
    return _row_to_pkg(row) if row else None


def insert_package(slug: str, name: str, description: str, author: str,
                   version: str, tags: list[str], skill_count: int) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn = get_conn()
    conn.execute(
        """INSERT INTO packages (slug, name, description, author, version, tags,
           skill_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (slug, name, description, author, version, json.dumps(tags),
         skill_count, now, now),
    )
    conn.commit()
    conn.close()
    return get_package(slug)


def increment_download(slug: str) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE packages SET download_count = download_count + 1 WHERE slug = ?",
        (slug,),
    )
    conn.commit()
    conn.close()


def delete_package(slug: str) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM packages WHERE slug = ?", (slug,))
    conn.commit()
    deleted = cur.rowcount > 0
    conn.close()
    return deleted


# ── API Keys ──

def validate_api_key(key: str) -> bool:
    import hashlib
    h = hashlib.sha256(key.encode()).hexdigest()
    conn = get_conn()
    row = conn.execute("SELECT 1 FROM api_keys WHERE key_hash = ?", (h,)).fetchone()
    conn.close()
    return row is not None


def bootstrap_api_key() -> str:
    """Generate a random API key if none exist. Returns the raw key (only shown once)."""
    conn = get_conn()
    existing = conn.execute("SELECT COUNT(*) FROM api_keys").fetchone()[0]
    if existing > 0:
        conn.close()
        return ""
    import secrets
    import hashlib
    raw = "sk-" + secrets.token_hex(24)
    h = hashlib.sha256(raw.encode()).hexdigest()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute(
        "INSERT INTO api_keys (key_hash, label, created_at) VALUES (?, ?, ?)",
        (h, "auto-generated", now),
    )
    conn.commit()
    conn.close()
    return raw


# ── Feedback ──

def insert_feedback(type: str, message: str, image_path: str | None,
                    app_version: str) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO feedback (type, message, image_path, app_version, status, created_at)
           VALUES (?, ?, ?, ?, 'open', ?)""",
        (type, message, image_path, app_version, now),
    )
    fid = cur.lastrowid
    conn.commit()
    conn.close()
    return get_feedback(fid)


def list_feedback(offset: int = 0, limit: int = 20, status: str | None = None) -> list[dict]:
    conn = get_conn()
    if status:
        rows = conn.execute(
            "SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (status, limit, offset),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM feedback ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    conn.close()
    return [_row_to_feedback(r) for r in rows]


def get_feedback(fid: int) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM feedback WHERE id = ?", (fid,)).fetchone()
    conn.close()
    return _row_to_feedback(row) if row else None


def update_feedback_status(fid: int, status: str) -> dict | None:
    conn = get_conn()
    conn.execute("UPDATE feedback SET status = ? WHERE id = ?", (status, fid))
    conn.commit()
    conn.close()
    return get_feedback(fid)


def _row_to_feedback(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "type": row["type"],
        "message": row["message"],
        "image_path": row["image_path"],
        "app_version": row["app_version"],
        "status": row["status"],
        "created_at": row["created_at"],
    }


# ── Helpers ──

def _row_to_pkg(row: sqlite3.Row) -> dict:
    return {
        "slug": row["slug"],
        "name": row["name"],
        "description": row["description"],
        "author": row["author"],
        "version": row["version"],
        "tags": json.loads(row["tags"]),
        "download_count": row["download_count"],
        "skill_count": row["skill_count"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
