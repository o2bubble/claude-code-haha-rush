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
    # 迁移: 老库无 note/updated_at → ALTER 补齐（管理后台的「处理备注」用）。
    # 常量默认值 → SQLite 只改元数据，2 核小机上瞬时完成，无重写表风险。
    # 这是本文件第 2 处补丁；再出现第 3 处就该引入 schema_version 表了。
    fb_cols = [r[1] for r in conn.execute("PRAGMA table_info(feedback)").fetchall()]
    if "note" not in fb_cols:
        conn.execute("ALTER TABLE feedback ADD COLUMN note TEXT DEFAULT ''")
    if "updated_at" not in fb_cols:
        conn.execute("ALTER TABLE feedback ADD COLUMN updated_at TEXT DEFAULT ''")
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


def update_feedback(fid: int, status: str | None = None, note: str | None = None) -> dict | None:
    """状态与备注的局部更新（None = 该项不动）。管理后台 PATCH 用。"""
    sets, params = [], []
    if status is not None:
        sets.append("status = ?")
        params.append(status)
    if note is not None:
        sets.append("note = ?")
        params.append(note)
    if not sets:
        return get_feedback(fid)
    sets.append("updated_at = ?")
    params.append(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    params.append(fid)
    conn = get_conn()
    conn.execute(f"UPDATE feedback SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    conn.close()
    return get_feedback(fid)


# ── Admin queries (分页 / 搜索 / 统计) ──
# 与上面的 GUI 查询分开：GUI 侧要全量、要稳定（改动会打断客户端）；
# 管理后台要分页、搜索、总数、聚合。两者互不影响。

_PKG_SORTS = {
    "download": "download_count DESC",
    "name": "name ASC",
    "created": "created_at DESC",
    "updated": "updated_at DESC",
}


def list_packages_admin(
    pkg_type: str | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
    sort: str = "updated",
) -> dict:
    """管理后台分页列表 → {items, total, page, page_size, pages}。"""
    where, params = [], []
    if pkg_type:
        where.append("type = ?")
        params.append(pkg_type)
    if q:
        where.append("(slug LIKE ? OR name LIKE ? OR author LIKE ? OR description LIKE ?)")
        like = f"%{q}%"
        params += [like, like, like, like]
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    # sort 经白名单字典映射 —— 不拼接用户输入，无注入面
    order = _PKG_SORTS.get(sort, _PKG_SORTS["updated"])

    conn = get_conn()
    total = conn.execute(f"SELECT COUNT(*) FROM packages {clause}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM packages {clause} ORDER BY {order} LIMIT ? OFFSET ?",
        params + [page_size, (page - 1) * page_size],
    ).fetchall()
    conn.close()
    return {
        "items": [_row_to_pkg(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


def list_feedback_admin(
    status: str | None = None,
    fb_type: str | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """管理后台反馈分页列表（比 GUI 版多 type/关键字筛选与总数）。"""
    where, params = [], []
    if status:
        where.append("status = ?")
        params.append(status)
    if fb_type:
        where.append("type = ?")
        params.append(fb_type)
    if q:
        where.append("(message LIKE ? OR note LIKE ?)")
        like = f"%{q}%"
        params += [like, like]
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    conn = get_conn()
    total = conn.execute(f"SELECT COUNT(*) FROM feedback {clause}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM feedback {clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        params + [page_size, (page - 1) * page_size],
    ).fetchall()
    conn.close()
    return {
        "items": [_row_to_feedback(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


def stats_packages() -> dict:
    """包聚合统计。全部来自现有列 —— 无下载明细，故做不了趋势。"""
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM packages").fetchone()[0]
    by_type = {r["type"]: r["c"] for r in conn.execute(
        "SELECT type, COUNT(*) AS c FROM packages GROUP BY type").fetchall()}
    sums = conn.execute(
        "SELECT COALESCE(SUM(download_count),0) AS dl, COALESCE(SUM(skill_count),0) AS sk "
        "FROM packages").fetchone()
    top = conn.execute(
        "SELECT slug, name, type, download_count FROM packages "
        "ORDER BY download_count DESC LIMIT 10").fetchall()
    by_author = conn.execute(
        "SELECT author, COUNT(*) AS c, COALESCE(SUM(download_count),0) AS dl FROM packages "
        "GROUP BY author ORDER BY c DESC LIMIT 10").fetchall()
    zero = conn.execute("SELECT COUNT(*) FROM packages WHERE download_count = 0").fetchone()[0]
    recent = conn.execute(
        "SELECT slug, name, type, version, updated_at FROM packages "
        "ORDER BY updated_at DESC LIMIT 5").fetchall()
    conn.close()
    return {
        "total": total,
        "by_type": by_type,
        "download_total": sums["dl"],
        "skill_total": sums["sk"],
        "top_downloads": [dict(r) for r in top],
        "by_author": [dict(r) for r in by_author],
        "zero_download": zero,
        "recent_updated": [dict(r) for r in recent],
    }


def stats_feedback(days: int = 30) -> dict:
    """反馈聚合统计。created_at 是 UTC（Z 后缀），按日分桶也是 UTC —— 前端需标注。"""
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
    by_status = {r["status"]: r["c"] for r in conn.execute(
        "SELECT status, COUNT(*) AS c FROM feedback GROUP BY status").fetchall()}
    by_type = {r["type"]: r["c"] for r in conn.execute(
        "SELECT type, COUNT(*) AS c FROM feedback GROUP BY type").fetchall()}
    with_image = conn.execute(
        "SELECT COUNT(*) FROM feedback WHERE image_path IS NOT NULL AND image_path != ''"
    ).fetchone()[0]
    # 哪个版本最招 bug —— 发布质量的高价值信号
    by_version = conn.execute(
        "SELECT COALESCE(NULLIF(app_version,''),'(未上报)') AS version, COUNT(*) AS c "
        "FROM feedback GROUP BY version ORDER BY c DESC LIMIT 10").fetchall()
    by_day = conn.execute(
        "SELECT substr(created_at,1,10) AS day, COUNT(*) AS c FROM feedback "
        "GROUP BY day ORDER BY day DESC LIMIT ?", (days,)).fetchall()
    conn.close()
    return {
        "total": total,
        "by_status": by_status,
        "by_type": by_type,
        "backlog": by_status.get("open", 0) + by_status.get("in_progress", 0),
        "with_image": with_image,
        "by_version": [dict(r) for r in by_version],
        "by_day": [dict(r) for r in by_day],
        "timezone": "UTC",
    }


def _row_to_feedback(row: sqlite3.Row) -> dict:
    keys = row.keys()
    return {
        "id": row["id"],
        "type": row["type"],
        "message": row["message"],
        "image_path": row["image_path"],
        "app_version": row["app_version"],
        "status": row["status"],
        "created_at": row["created_at"],
        # 老库（迁移前建的）可能没有这两列，用 keys() 兜底 —— 同 _row_to_pkg 的写法
        "note": row["note"] if "note" in keys else "",
        "updated_at": row["updated_at"] if "updated_at" in keys else "",
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
