"""SQLite database layer for the skill registry."""

import sqlite3
import json
import os
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "registry.db")
# 包根目录（与 routes.py 的 SKILLS_STORE 同源）——_plugin_meta 读包内 plugin.json 用
SKILLS_STORE = Path(os.path.dirname(os.path.dirname(__file__))) / "skills-store"


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
            type        TEXT DEFAULT 'skill',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )
    """)
    # 迁移: 老库无 type 列 → ALTER 补齐(存量包默认 skill)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(packages)").fetchall()]
    if "type" not in cols:
        conn.execute("ALTER TABLE packages ADD COLUMN type TEXT DEFAULT 'skill'")
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

def list_packages(pkg_type: str | None = None) -> list[dict]:
    """pkg_type=None 返回全部（兼容）；'skill'/'plugin' 按 type 过滤。
    旧 GUI 的 GET /packages 无 type 概念 → 端点侧默认 skill，防插件串进技能库。"""
    conn = get_conn()
    if pkg_type:
        rows = conn.execute(
            "SELECT * FROM packages WHERE type = ? ORDER BY download_count DESC",
            (pkg_type,),
        ).fetchall()
    else:
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
                   version: str, tags: list[str], skill_count: int,
                   pkg_type: str = "skill") -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn = get_conn()
    conn.execute(
        """INSERT INTO packages (slug, name, description, author, version, tags,
           skill_count, type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (slug, name, description, author, version, json.dumps(tags),
         skill_count, pkg_type, now, now),
    )
    conn.commit()
    conn.close()
    return get_package(slug)


def update_package(slug: str, name: str, description: str, author: str,
                   version: str, tags: list[str], skill_count: int) -> dict:
    """force 覆盖: 更新元数据(版本/作者/描述/技能数), 保留 download_count/created_at。"""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn = get_conn()
    conn.execute(
        """UPDATE packages SET name=?, description=?, author=?, version=?,
           tags=?, skill_count=?, updated_at=? WHERE slug=?""",
        (name, description, author, version, json.dumps(tags),
         skill_count, now, slug),
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

def _plugin_meta(slug: str) -> dict:
    """读包根 plugin.json 的扩展字段（category/dependencies/installType）。
    无 plugin.json / 字段缺失 → {}（旧包兼容, GUI 侧用默认值）。"""
    path = SKILLS_STORE / slug / "plugin.json" if SKILLS_STORE else None
    if not path or not path.exists():
        return {}
    try:
        pm = json.loads(path.read_text(encoding="utf-8"))
        out = {}
        for k in ("category", "dependencies", "installType", "platforms"):
            if k in pm:
                out[k] = pm[k]
        return out
    except (json.JSONDecodeError, OSError):
        return {}


def _row_to_pkg(row: sqlite3.Row) -> dict:
    pkg = {
        "slug": row["slug"],
        "name": row["name"],
        "description": row["description"],
        "author": row["author"],
        "version": row["version"],
        "tags": json.loads(row["tags"]),
        "download_count": row["download_count"],
        "skill_count": row["skill_count"],
        "type": row["type"] if "type" in row.keys() else "skill",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    # 插件包 enrich 扩展字段（读包内 plugin.json, 不入库——schema 零迁移, 旧包自动兼容）
    if pkg["type"] == "plugin":
        pkg.update(_plugin_meta(row["slug"]))
    return pkg
