"""Admin backend — login + management APIs for the release platform.

两个 router：
  auth_router —— 仅 /login，无认证依赖（登录本身当然不能要求先登录）
  router      —— 其余全部挂在 require_admin 之后

**公开 API 一律不在这里** —— /api/packages、/api/plugins、/api/updates/* 仍由
routes.py / updates.py 提供且保持免认证（GUI 技能市场与自动更新依赖它们）。
本模块只做「原本没有的能力」：登录、统计、分页管理、删除。
"""

import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from . import models, updates
from .auth import (
    check_admin_password,
    clear_login_failures,
    client_ip,
    issue_token,
    login_locked,
    record_login_failure,
    require_admin,
)

SKILLS_STORE = Path(__file__).resolve().parent.parent / "skills-store"


def site_name() -> str:
    """本实例标识。两侧服务器的 registry.db 是两份独立库，统计天然不同 ——
    header 显示这个，避免看串台。"""
    return os.environ.get("SITE_NAME", "") or "release-platform"


# ── Login (no auth dependency) ──

auth_router = APIRouter(prefix="/api/admin", tags=["admin"])


class LoginBody(BaseModel):
    password: str = ""


@auth_router.post("/login")
async def login(body: LoginBody, request: Request):
    if not os.environ.get("ADMIN_PASSWORD"):
        raise HTTPException(status_code=503, detail="ADMIN_PASSWORD not configured on server")

    ip = client_ip(request)
    if login_locked(ip):
        raise HTTPException(status_code=429, detail="Too many failed attempts, try again later")

    if not check_admin_password(body.password):
        record_login_failure(ip)
        raise HTTPException(status_code=401, detail="Invalid password")

    clear_login_failures(ip)
    return {"ok": True, "data": {"token": issue_token(), "site_name": site_name()}}


@auth_router.get("/site")
async def site_info():
    """公开的实例标识 —— 登录页在拿到 token 前就要显示「你正在登录哪一台」。"""
    return {"ok": True, "data": {"site_name": site_name()}}


# ── Everything below requires a valid admin token ──

router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)], tags=["admin"])


@router.get("/stats")
async def get_stats():
    """总览聚合。数据源跨越 DB（包/反馈）与文件系统（更新版本）。"""
    pkg = models.stats_packages()
    fb = models.stats_feedback()

    versions_win = updates.list_versions("windows")
    versions_mac = updates.list_versions("macos")
    latest_win = versions_win[0] if versions_win else None
    latest_mac = versions_mac[0] if versions_mac else None

    return {
        "ok": True,
        "data": {
            "site_name": site_name(),
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "packages": pkg,
            "feedback": fb,
            "updates": {
                "windows_versions": len(versions_win),
                "macos_versions": len(versions_mac),
                "latest_windows": latest_win["version"] if latest_win else None,
                "latest_macos": latest_mac["version"] if latest_mac else None,
                # 两平台是否同步到同一版 —— 发版时最容易忘的一步
                "platforms_in_sync": bool(
                    latest_win and latest_mac and latest_win["version"] == latest_mac["version"]
                ),
                "store_bytes": updates.store_usage(),
            },
        },
    }


# ── Packages ──

@router.get("/packages")
async def admin_list_packages(
    type: str | None = Query(None, pattern="^(skill|plugin)$"),
    q: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort: str = Query("updated", pattern="^(updated|created|download|name)$"),
):
    data = models.list_packages_admin(
        pkg_type=type, q=q, page=page, page_size=page_size, sort=sort
    )
    return {"ok": True, "data": data}


@router.delete("/packages/{slug}")
async def admin_delete_package(
    slug: str,
    purge_files: bool = Query(
        False,
        description="也删除磁盘上的包目录与 zip/sig。默认 false 只删数据库行，"
                    "文件会变成不可达的孤儿（get_package 已 404）—— 前端确认框后传 true。",
    ),
):
    pkg = models.get_package(slug)
    if not pkg:
        raise HTTPException(status_code=404, detail="Package not found")

    models.delete_package(slug)

    removed: list[str] = []
    if purge_files:
        pkg_dir = SKILLS_STORE / slug
        if pkg_dir.exists():
            shutil.rmtree(pkg_dir, ignore_errors=True)
            removed.append(str(pkg_dir.name) + "/")
        for suffix in (".zip", ".sig"):
            fp = SKILLS_STORE / f"{slug}{suffix}"
            if fp.exists():
                fp.unlink(missing_ok=True)
                removed.append(fp.name)

    return {
        "ok": True,
        "data": {
            "slug": slug,
            "purged_files": removed,
            # 未清文件时明确告知残留在哪，避免「以为删干净了」
            "orphan_hint": None if purge_files else f"skills-store/{slug}/ 与 {slug}.zip/.sig 仍在磁盘上",
        },
    }


# ── Feedback ──

@router.get("/feedback")
async def admin_list_feedback(
    status: str | None = Query(None, pattern="^(open|in_progress|resolved|closed)$"),
    type: str | None = Query(None, pattern="^(bug|suggestion)$"),
    q: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    data = models.list_feedback_admin(
        status=status, fb_type=type, q=q, page=page, page_size=page_size
    )
    return {"ok": True, "data": data}


class FeedbackPatch(BaseModel):
    status: str | None = None
    note: str | None = None


@router.patch("/feedback/{fid}")
async def admin_update_feedback(fid: int, body: FeedbackPatch):
    if body.status is None and body.note is None:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if body.status is not None and body.status not in (
        "open", "in_progress", "resolved", "closed"
    ):
        raise HTTPException(status_code=400, detail="Invalid status")
    if body.note is not None and len(body.note) > 2000:
        raise HTTPException(status_code=400, detail="note too long (max 2000 chars)")

    fb = models.update_feedback(fid, status=body.status, note=body.note)
    if not fb:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"ok": True, "data": fb}


# ── Updates ──

@router.get("/updates/versions")
async def admin_list_versions(platform: str = Query("windows", pattern="^(windows|macos)$")):
    versions = updates.list_versions(platform)
    return {
        "ok": True,
        "data": {
            "platform": platform,
            "versions": versions,
            # 服务器只留最近 3 版（上传时自动清理）—— 这不是完整发布历史
            "note": "仅列出当前仍保留在服务器上的版本（上传时自动只留最近 3 版）",
        },
    }
