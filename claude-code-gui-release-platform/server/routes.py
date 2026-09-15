"""FastAPI route handlers for the skill registry."""

import os
import io
import time
import zipfile
import shutil
import re
import uuid
import yaml
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends, Query, Request
from fastapi.responses import JSONResponse, FileResponse, Response
from . import models
from .auth import client_ip, require_auth

router = APIRouter(prefix="/api")

SKILLS_STORE = Path(__file__).resolve().parent.parent / "skills-store"
FEEDBACK_IMAGES = Path(__file__).resolve().parent.parent / "feedback-images"

# Allowed image MIME types and their magic bytes
ALLOWED_IMAGE_TYPES = {
    "image/png": b"\x89PNG\r\n\x1a\n",
    "image/jpeg": b"\xff\xd8\xff",
    "image/gif": b"GIF8",
    "image/webp": b"RIFF",
}


def _validate_image(data: bytes) -> str | None:
    """Validate image by magic bytes. Returns MIME type or None."""
    for mime, magic in ALLOWED_IMAGE_TYPES.items():
        if data[:len(magic)] == magic:
            # WebP: check WEBP marker at offset 8
            if mime == "image/webp" and data[8:12] != b"WEBP":
                return None
            return mime
    return None

def _get_image_extension(mime: str) -> str:
    return { "image/png": ".png", "image/jpeg": ".jpg",
             "image/gif": ".gif", "image/webp": ".webp" }.get(mime, ".bin")


def _slugify(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff\-]", "-", s)
    s = re.sub(r"-{2,}", "-", s)
    return s.strip("-")


def _read_skill_meta(skill_dir: Path) -> dict:
    """Read SKILL.md frontmatter from a skill directory."""
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return None
    content = skill_md.read_text(encoding="utf-8", errors="replace")
    meta = {"name": skill_dir.name, "description": "", "type": "skill"}
    # Try to parse YAML frontmatter
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            try:
                fm = yaml.safe_load(parts[1])
                if isinstance(fm, dict):
                    if fm.get("name"):
                        meta["name"] = fm["name"]
                    if fm.get("description"):
                        meta["description"] = fm["description"]
            except yaml.YAMLError:
                pass
    return meta


def _zip_dir(dir_path: Path) -> io.BytesIO:
    """Zip a directory into an in-memory BytesIO stream."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(dir_path):
            for f in files:
                fp = Path(root) / f
                arcname = fp.relative_to(dir_path)
                zf.write(fp, arcname)
    buf.seek(0)
    return buf


# ── Endpoints ──

@router.get("/packages")
async def list_packages():
    # 只返回技能包——旧 GUI 无 type 过滤概念，插件混进来会被当技能展示/安装。
    # 插件走独立端点 GET /plugins。
    packages = models.list_packages(pkg_type="skill")
    return {"ok": True, "data": packages}


@router.get("/plugins")
async def list_plugins():
    packages = models.list_packages(pkg_type="plugin")
    return {"ok": True, "data": packages}


@router.get("/packages/{slug}")
async def get_package(slug: str):
    pkg = models.get_package(slug)
    if not pkg:
        raise HTTPException(status_code=404, detail="Package not found")
    # Read skills from filesystem
    pkg_dir = SKILLS_STORE / slug
    skills = []
    if pkg_dir.exists():
        for entry in sorted(pkg_dir.iterdir()):
            if entry.is_dir():
                meta = _read_skill_meta(entry)
                if meta:
                    skills.append(meta)
    pkg["skills"] = skills
    trans_dir = pkg_dir / "translations"
    pkg["translations"] = [p.stem for p in trans_dir.glob("*.json")] if trans_dir.exists() else []
    # 插件详情页: 包根 README.md 透传（skill 包无此约定, 缺省 None）
    readme_path = pkg_dir / "README.md"
    if pkg.get("type") == "plugin" and readme_path.exists():
        try:
            pkg["readme"] = readme_path.read_text(encoding="utf-8")
        except OSError:
            pass
    # AI 排查文档透传（作者写给 AI 的故障排查说明, MCP plugin_docs 远端回退源）
    ai_notes_path = pkg_dir / "AI_NOTES.md"
    if pkg.get("type") == "plugin" and ai_notes_path.exists():
        try:
            pkg["ai_notes"] = ai_notes_path.read_text(encoding="utf-8")
        except OSError:
            pass
    return {"ok": True, "data": pkg}


# ── Translations ──

@router.get("/packages/{slug}/translations/{lang}")
async def get_translations(slug: str, lang: str):
    pkg = models.get_package(slug)
    if not pkg:
        raise HTTPException(status_code=404, detail="Package not found")
    trans_path = SKILLS_STORE / slug / "translations" / f"{lang}.json"
    if not trans_path.exists():
        raise HTTPException(status_code=404, detail=f"No {lang} translations for this package")
    import json
    return JSONResponse(json.loads(trans_path.read_text(encoding="utf-8")))


@router.get("/packages/{slug}/translations")
async def list_translations(slug: str):
    pkg = models.get_package(slug)
    if not pkg:
        raise HTTPException(status_code=404, detail="Package not found")
    trans_dir = SKILLS_STORE / slug / "translations"
    if not trans_dir.exists():
        return {"ok": True, "data": []}
    langs = [p.stem for p in trans_dir.glob("*.json")]
    return {"ok": True, "data": langs}


@router.get("/packages/{slug}/download")
async def download_package(slug: str):
    pkg = models.get_package(slug)
    pkg_dir = SKILLS_STORE / slug
    if not pkg or not pkg_dir.exists():
        raise HTTPException(status_code=404, detail="Package not found")
    models.increment_download(slug)
    # 优先返回原始上传 zip(签名绑定原始字节, 不能重打包); 无则重打包兜底
    raw_zip = SKILLS_STORE / f"{slug}.zip"
    if raw_zip.exists():
        content = raw_zip.read_bytes()
        media = "application/zip"
    else:
        buf = _zip_dir(pkg_dir)
        content = buf.getvalue()
        media = "application/zip"
    # 带 Content-Length 走固定长度传输（避免 chunked 被代理/防火墙掐断）
    return Response(
        content=content,
        media_type=media,
        headers={
            "Content-Disposition": f"attachment; filename={slug}.zip",
            "Content-Length": str(len(content)),
        },
    )

@router.get("/packages/{slug}/signature")
async def download_package_signature(slug: str):
    """官方签名(Ed25519, base64). GUI 安装时与 zip 一起验证:
    验证通过=受信任(可安装), 缺失/不通过=未受信任(仅 AI 安装+安全审查)."""
    pkg = models.get_package(slug)
    if not pkg:
        raise HTTPException(status_code=404, detail="Package not found")
    sig_path = SKILLS_STORE / f"{slug}.sig"
    if not sig_path.exists():
        raise HTTPException(status_code=404, detail="No signature (untrusted)")
    return Response(
        content=sig_path.read_text(encoding="utf-8").strip(),
        media_type="text/plain",
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )


@router.get("/packages/{slug}/skills/{skill_name}/download")
async def download_skill(slug: str, skill_name: str):
    pkg = models.get_package(slug)
    skill_dir = SKILLS_STORE / slug / skill_name
    if not pkg or not skill_dir.exists():
        raise HTTPException(status_code=404, detail="Skill not found")
    if not (skill_dir / "SKILL.md").exists():
        raise HTTPException(status_code=404, detail="Not a valid skill (no SKILL.md)")
    models.increment_download(slug)
    buf = _zip_dir(skill_dir)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename={skill_name}.zip",
            "Content-Length": str(buf.getbuffer().nbytes),
        },
    )


@router.post("/packages")
async def upload_package(
    manifest: str = Form(...),
    skills: UploadFile = File(...),
    type: str = Form("skill"),
    signature: str = Form(None),
    force: bool = Form(False),
    _auth=Depends(require_auth),
):
    # Parse manifest
    try:
        meta = yaml.safe_load(manifest)
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=f"Invalid manifest YAML: {e}")
    if not isinstance(meta, dict):
        raise HTTPException(status_code=400, detail="Manifest must be a YAML mapping")
    required = ["name", "author", "version"]
    for field in required:
        if not meta.get(field):
            raise HTTPException(status_code=400, detail=f"Missing required field: {field}")
    if type not in ("skill", "plugin"):
        raise HTTPException(status_code=400, detail="type must be 'skill' or 'plugin'")

    slug = _slugify(meta["name"])
    if not slug:
        raise HTTPException(status_code=400, detail="Cannot generate slug from name")

    # Check if slug already exists
    existing = models.get_package(slug)
    if existing and not force:
        raise HTTPException(status_code=409, detail=f"Package '{slug}' already exists")

    # Extract zip to skills-store
    pkg_dir = SKILLS_STORE / slug
    if pkg_dir.exists():
        shutil.rmtree(pkg_dir)

    try:
        zip_bytes = await skills.read()
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            zf.extractall(pkg_dir)
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Invalid zip file")

    # 保留原始上传 zip 字节(下载端点返回它——签名绑定原始字节, 不能重打包)
    raw_zip_path = SKILLS_STORE / f"{slug}.zip"
    raw_zip_path.write_bytes(zip_bytes)

    # 官方签名: 随发布提交, 存为 <slug>.sig(与 zip 一起由下载端点提供, GUI 验证)
    sig_path = SKILLS_STORE / f"{slug}.sig"
    if signature:
        sig_path.write_text(signature.strip(), encoding="utf-8")
    elif sig_path.exists():
        sig_path.unlink()  # 未签名覆盖 → 移除旧签名(强制未受信任)

    # 按 type 分叉校验:
    if type == "plugin":
        # 插件包: 根必须含 plugin.json, 且 pluginName 声明在 manifest.name 对应(可选校验)
        if not (pkg_dir / "plugin.json").exists():
            shutil.rmtree(pkg_dir)
            raise HTTPException(status_code=400, detail="Plugin zip missing plugin.json at root")
        try:
            import json as _json
            pm = _json.loads((pkg_dir / "plugin.json").read_text(encoding="utf-8"))
        except Exception:
            shutil.rmtree(pkg_dir)
            raise HTTPException(status_code=400, detail="plugin.json is not valid JSON")
        if not pm.get("pluginName"):
            shutil.rmtree(pkg_dir)
            raise HTTPException(status_code=400, detail="plugin.json missing pluginName")
        skill_count = 0  # 插件包无 skill 数
    else:
        # 技能包: 必须含 SKILL.md 子目录
        skill_count = 0
        if pkg_dir.exists():
            for entry in pkg_dir.iterdir():
                if entry.is_dir() and (entry / "SKILL.md").exists():
                    skill_count += 1
        if skill_count == 0:
            shutil.rmtree(pkg_dir)
            raise HTTPException(status_code=400, detail="No skills found in zip (need SKILL.md in each skill dir)")

    # Write manifest.yaml for later reference
    manifest_path = pkg_dir / "manifest.yaml"
    manifest_path.write_text(manifest, encoding="utf-8")

    # Insert or update DB (force 覆盖重签场景)
    if existing:
        pkg = models.update_package(
            slug=slug,
            name=meta["name"],
            description=meta.get("description", ""),
            author=meta["author"],
            version=meta["version"],
            tags=meta.get("tags", []),
            skill_count=skill_count,
        )
    else:
        pkg = models.insert_package(
            slug=slug,
            name=meta["name"],
            description=meta.get("description", ""),
            author=meta["author"],
            version=meta["version"],
            tags=meta.get("tags", []),
            skill_count=skill_count,
            pkg_type=type,
        )

    return {"ok": True, "data": pkg}


# ── Feedback ──

# 提交限流：公网反馈页开放后，这是唯一的垃圾提交闸门。
# 纯内存计数（2 核小机上绝不能为此打盘），进程重启即清零 —— 目的是挡住高频
# 灌水，不是精确配额。
#
# 阈值刻意宽松：**GUI 客户端也用这个端点**，且公司 NAT 下多个用户可能共享出口 IP。
# 正常用户一天几条，20/小时不会误伤，但足以让脚本灌水失去意义。
_FEEDBACK_RATE: dict[str, list] = {}
_FEEDBACK_MAX_PER_WINDOW = 20
_FEEDBACK_WINDOW_SECS = 3600


def _allow_feedback(ip: str) -> bool:
    now = time.time()
    # 定期清理过期条目，避免长期运行下 dict 无界增长
    if len(_FEEDBACK_RATE) > 5000:
        for k in [k for k, v in _FEEDBACK_RATE.items() if now - v[1] > _FEEDBACK_WINDOW_SECS]:
            _FEEDBACK_RATE.pop(k, None)
    entry = _FEEDBACK_RATE.get(ip)
    if not entry or now - entry[1] > _FEEDBACK_WINDOW_SECS:
        _FEEDBACK_RATE[ip] = [1, now]
        return True
    if entry[0] >= _FEEDBACK_MAX_PER_WINDOW:
        return False
    entry[0] += 1
    return True


@router.post("/feedback")
async def submit_feedback(
    request: Request,
    type: str = Form(...),
    message: str = Form(...),
    app_version: str = Form(""),
    image: UploadFile | None = File(None),
):
    if not _allow_feedback(client_ip(request)):
        raise HTTPException(
            status_code=429,
            detail="Too many submissions from this address, please try again later",
        )
    if type not in ("bug", "suggestion"):
        raise HTTPException(status_code=400, detail="type must be 'bug' or 'suggestion'")
    if not message.strip():
        raise HTTPException(status_code=400, detail="message is required")
    if len(message) > 5000:
        raise HTTPException(status_code=400, detail="message too long (max 5000 chars)")

    image_path = None
    if image and image.filename:
        data = await image.read()
        if len(data) > 10 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="image too large (max 10MB)")
        mime = _validate_image(data)
        if not mime:
            raise HTTPException(status_code=400, detail="Invalid image file")
        ext = _get_image_extension(mime)
        filename = f"{uuid.uuid4().hex}{ext}"
        FEEDBACK_IMAGES.mkdir(parents=True, exist_ok=True)
        (FEEDBACK_IMAGES / filename).write_bytes(data)
        image_path = filename

    fb = models.insert_feedback(type, message.strip(), image_path, app_version)
    return {"ok": True, "data": fb}


@router.get("/feedback")
async def list_feedback(
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    status: str | None = Query(None),
):
    items = models.list_feedback(offset, limit, status)
    return {"ok": True, "data": items}


@router.get("/feedback/{fid}")
async def get_feedback(fid: int):
    fb = models.get_feedback(fid)
    if not fb:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"ok": True, "data": fb}


@router.patch("/feedback/{fid}")
async def update_feedback_status(fid: int, status: str = Query(...), _auth=Depends(require_auth)):
    if status not in ("open", "in_progress", "resolved", "closed"):
        raise HTTPException(status_code=400, detail="Invalid status")
    fb = models.update_feedback_status(fid, status)
    if not fb:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"ok": True, "data": fb}


@router.get("/feedback/images/{filename}")
async def serve_feedback_image(filename: str):
    path = FEEDBACK_IMAGES / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    if not any(filename.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp")):
        raise HTTPException(status_code=403, detail="Forbidden")
    return FileResponse(path)
