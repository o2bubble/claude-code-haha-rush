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
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8765, reload=True)
