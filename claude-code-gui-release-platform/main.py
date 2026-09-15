"""Skill Registry — FastAPI server for Claude Code skill marketplace."""

import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from server import admin, models, routes, updates

models.init_db()

app = FastAPI(title="Skill Registry", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)
app.include_router(updates.router)
# 管理后台（/api/admin/*）。auth_router 无认证依赖（登录本身），router 需 token。
app.include_router(admin.auth_router)
app.include_router(admin.router)

# Ensure directories exist
BASE_DIR = Path(__file__).resolve().parent
(BASE_DIR / "skills-store").mkdir(exist_ok=True)
(BASE_DIR / "feedback-images").mkdir(exist_ok=True)
(BASE_DIR / "static").mkdir(exist_ok=True)
(BASE_DIR / "updates-store").mkdir(exist_ok=True)


# ── 管理后台（Vite + React SPA）──
# 产物由 web/ 构建而来（Dockerfile 多阶段构建产出；本地开发时手动 copy 到
# static/admin/）。目录不存在时降级到旧页面，不影响既有服务。
SPA_DIR = BASE_DIR / "static" / "admin"

# SPA 入口 HTML 必须每次向服务端验证，不能走缓存。
#
# 踩过的坑（2026-09-15 上线当天）：`FileResponse` 只带 last-modified/etag、
# **不带 Cache-Control**，浏览器于是走「启发式缓存」——按
# (现在 − last-modified) × 10% 估算可缓存时长。旧 admin.html 的修改时间很老，
# 算出来能缓存好几天，结果发布后用户仍看到部署前的旧页面（服务端明明已是新的）。
#
# 这里用 no-cache（**不是** no-store）：允许缓存但每次必须回源验证 ——
# 命中 304 时省流量，内容变了立刻生效。静态资源不用管：它们文件名带 hash，
# 内容变则 URL 变，可安全长缓存。
_NO_CACHE = {"Cache-Control": "no-cache, must-revalidate"}


@app.get("/admin-legacy")
async def admin_legacy_page():
    """旧版反馈管理页（单文件手写）。

    新后台稳定前保留作回滚路径与应急入口 —— 它无需登录、直连公开 API，
    在 ADMIN_PASSWORD 配错导致进不去新后台时仍可用。
    """
    return FileResponse(BASE_DIR / "static" / "admin.html", headers=_NO_CACHE)


if (SPA_DIR / "index.html").exists():
    # 静态资源单独挂载 —— 必须先于下面的 catch-all 注册（Starlette 按注册顺序匹配）
    app.mount("/admin/assets", StaticFiles(directory=SPA_DIR / "assets"), name="admin-assets")

    # SPA fallback：**只覆盖 /admin 前缀**，绝不用全局 {path:path} ——
    # 那会吞掉 /api/*，直接打断 GUI 客户端的技能市场与自动更新。
    @app.get("/admin")
    @app.get("/admin/{rest:path}")
    async def admin_page(rest: str = ""):
        return FileResponse(SPA_DIR / "index.html", headers=_NO_CACHE)

    # 公网反馈提交页：同一份 SPA 产物，路由在 /feedback（前端按路径分发）
    @app.get("/feedback")
    async def public_feedback_page():
        return FileResponse(SPA_DIR / "index.html", headers=_NO_CACHE)

else:
    # 无 SPA 产物（如未构建就直接跑源码）→ /admin 退回旧页面，功能不中断
    @app.get("/admin")
    async def admin_page_fallback():
        return FileResponse(BASE_DIR / "static" / "admin.html", headers=_NO_CACHE)


@app.on_event("startup")
async def startup():
    key = models.bootstrap_api_key()
    if key:
        print(f"\n{'='*60}")
        print(f"  INITIAL API KEY: {key}")
        print(f"  Save this key — it will not be shown again.")
        print(f"{'='*60}\n")


if __name__ == "__main__":
    import os
    import uvicorn

    # reload=True 是开发用的（改代码自动重启）：它起一个 StatReload 进程**持续扫描
    # 整个 /app 目录树**。本项目 skills-store 有 160MB，在 2 核小机上实测：
    # 持续 ~18% CPU、5 天累计 22 小时 CPU，内存紧张时 stat 还会引发 inode 缺页读盘，
    # 把 cloud_essd_entry（IOPS 上限仅 2520）的磁盘打满 → 所有进程卡在 D 状态、
    # 容器健康检查超时。生产环境必须关掉。
    # 本地开发需要热重载时设 RELOAD=1 显式开启。
    _reload = os.environ.get("RELOAD") == "1"
    uvicorn.run("main:app", host="0.0.0.0", port=8765, reload=_reload)
