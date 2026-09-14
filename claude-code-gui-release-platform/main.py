"""Skill Registry — FastAPI server for Claude Code skill marketplace."""

import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from server import models, routes, updates

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

# Ensure directories exist
BASE_DIR = Path(__file__).resolve().parent
(BASE_DIR / "skills-store").mkdir(exist_ok=True)
(BASE_DIR / "feedback-images").mkdir(exist_ok=True)
(BASE_DIR / "static").mkdir(exist_ok=True)
(BASE_DIR / "updates-store").mkdir(exist_ok=True)


@app.get("/admin")
async def admin_page():
    return FileResponse(BASE_DIR / "static" / "admin.html")


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
