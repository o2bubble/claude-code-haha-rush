"""Update system — release manifest + component download endpoints."""

import io
import json
import os
import re
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import FileResponse

from .auth import require_auth

router = APIRouter(prefix="/api")

UPDATES_STORE = Path(__file__).resolve().parent.parent / "updates-store"

VALID_COMPONENTS = {"gui", "server", "claude", "bun", "tools", "python", "git", "extensions", "updater"}

# macOS 组件集：bun/tools/python 自包含(官方 darwin 二进制/pkg)，git 系统自带、updater 专属 Windows。
VALID_COMPONENTS_MAC = {"gui", "server", "claude", "bun", "tools", "python", "extensions"}

PLATFORMS = {"windows", "macos"}

VERSION_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$")


def _platform_dir(version: str, platform: str) -> Path:
    """平台目录：windows 用 {version}/（兼容旧结构），macos 用 {version}/macos/。"""
    base = UPDATES_STORE / version
    return base if platform == "windows" else base / platform


def _version_key(version: str) -> tuple:
    """Numeric sort key so 2026.08.03.10 > 2026.08.03.9 (lexical sort is wrong)."""
    return tuple(int(p) for p in version.split("."))


def _get_latest_version(platform: str = "windows") -> str | None:
    """Return the latest version string that has a manifest for the given platform."""
    if not UPDATES_STORE.exists():
        return None
    versions = []
    for entry in UPDATES_STORE.iterdir():
        if entry.is_dir() and VERSION_RE.match(entry.name):
            mf = _platform_dir(entry.name, platform) / "manifest.json"
            if mf.exists():
                versions.append(entry.name)
    if not versions:
        return None
    versions.sort(key=_version_key, reverse=True)
    return versions[0]


def _read_manifest(version: str, platform: str = "windows") -> dict | None:
    """Read a manifest.json for the given version + platform."""
    path = _platform_dir(version, platform) / "manifest.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


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


def list_versions(platform: str = "windows") -> list[dict]:
    """列出该平台所有带 manifest 的版本（新 → 旧），附组件名与体积。

    注意：上传时 _prune_old_versions 只保留最近 3 版 —— 这里不是完整发布历史，
    是「当前还在服务器上的版本」。UI 不要把它当成发布记录。
    """
    if not UPDATES_STORE.exists():
        return []
    out = []
    for entry in UPDATES_STORE.iterdir():
        if not (entry.is_dir() and VERSION_RE.match(entry.name)):
            continue
        manifest = _read_manifest(entry.name, platform)
        if not manifest:
            continue
        vdir = _platform_dir(entry.name, platform)
        components = {}
        for comp in sorted(_valid_components(platform)):
            zp = vdir / f"{comp}.zip"
            if zp.exists():
                components[comp] = zp.stat().st_size
        out.append({
            "version": entry.name,
            "published_at": manifest.get("published_at", ""),
            "release_notes": manifest.get("release_notes", ""),
            "components": components,
            "total_size": sum(components.values()),
        })
    out.sort(key=lambda d: _version_key(d["version"]), reverse=True)
    return out


def store_usage() -> int:
    """updates-store 占用字节数（2 核小盘，值得盯着）。"""
    if not UPDATES_STORE.exists():
        return 0
    total = 0
    for root, _, files in os.walk(UPDATES_STORE):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


# ── Public Endpoints ──

@router.get("/updates/latest")
async def get_latest_update(platform: str = "windows"):
    """Return the latest version manifest for the given platform."""
    _check_platform(platform)
    version = _get_latest_version(platform)
    if not version:
        raise HTTPException(status_code=404, detail=f"No {platform} updates available")
    manifest = _read_manifest(version, platform)
    if not manifest:
        raise HTTPException(status_code=404, detail="Manifest not found")
    return {"ok": True, "data": manifest}


@router.get("/updates/{version}/manifest")
async def get_update_manifest(version: str, platform: str = "windows"):
    """Return the manifest for a specific version + platform."""
    _check_platform(platform)
    manifest = _read_manifest(version, platform)
    if not manifest:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"ok": True, "data": manifest}


def _check_platform(platform: str):
    if platform not in PLATFORMS:
        raise HTTPException(status_code=400, detail=f"Invalid platform: {platform}. Valid: {', '.join(sorted(PLATFORMS))}")


def _valid_components(platform: str) -> set:
    return VALID_COMPONENTS_MAC if platform == "macos" else VALID_COMPONENTS


@router.get("/updates/{version}/components/{component}/download")
async def download_component(version: str, component: str, platform: str = "windows"):
    """Stream a component zip for download (platform-scoped)."""
    _check_platform(platform)
    valid = _valid_components(platform)
    if component not in valid:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown component: {component}. Valid: {', '.join(sorted(valid))}",
        )

    # Resolve the zip path — may be a symlink/hardlink to a shared file
    comp_zip = _platform_dir(version, platform) / f"{component}.zip"
    if not comp_zip.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Component '{component}' not found for version {version} platform {platform}",
        )

    # FileResponse 自动带 Content-Length（固定长度传输，避免 chunked 被代理/防火墙掐断）
    return FileResponse(
        comp_zip,
        media_type="application/zip",
        filename=f"{component}.zip",
    )


# ── Upload (API key required) ──

def _remove_platform_version(version: str, platform: str) -> None:
    """删掉某版本的**单个平台**内容，保留另一平台。

    ⚠️ windows 的内容（manifest.json + *.zip）就在版本目录**顶层**，与 macos/
    子目录同级 —— 所以只能逐个删文件，不能 rmtree 整个目录（那会连 macos 一起删，
    正是本函数存在的原因）。
    """
    pdir = _platform_dir(version, platform)
    if not pdir.exists():
        return
    if platform != "windows":
        # macos 独占 {version}/macos/ 子目录，整目录删安全
        shutil.rmtree(pdir, ignore_errors=True)
        return
    for f in pdir.iterdir():
        if f.is_file() and (f.name == "manifest.json" or f.suffix == ".zip"):
            f.unlink(missing_ok=True)


def _prune_old_versions(current: str, keep: int = 3) -> None:
    """上传成功后按**平台各自**保留最近 keep 个版本，清掉更旧的。

    防止 updates-store 无限累积把磁盘撑满（2 核小盘）；同时避免「按版本号整体删」
    把另一平台的版本误伤。

    ⚠️ 为什么必须按平台分开算（2026-09-15 修复）：
    版本目录由两平台共享 —— windows 用 {version}/、macos 用 {version}/macos/。
    旧实现对超额版本直接 `rmtree(UPDATES_STORE / v)`，会把**另一个平台**的内容
    一并删除。而 mac 发版频率天然低于 windows、版本号永远更旧，于是每次 windows
    发布都把它挤出保留窗口 → 「程序更新」页 mac 列表最终全空，
    `/api/updates/latest?platform=macos` 返回 404（mac 客户端检查更新直接失效）。

    现在各平台独立算保留集，只删该平台自己的内容；某版本两平台都清空了才删目录。

    `current` 是刚落盘的版本：它在自己的平台上必然是最新，但**可能比该平台其它
    已有版本号更旧**（重传旧版本号的场景）—— 那种情况下它也会落进淘汰区，故仍需
    显式放行，不能顺手清掉调用方刚上传的东西。
    """
    try:
        vers = sorted(
            (d.name for d in UPDATES_STORE.iterdir()
             if d.is_dir() and VERSION_RE.match(d.name)),
            key=_version_key,
            reverse=True,
        )

        for platform in sorted(PLATFORMS):
            have = [v for v in vers if _read_manifest(v, platform)]
            for v in have[keep:]:
                if v == current:
                    continue
                _remove_platform_version(v, platform)

        # 两个平台都已清空的版本目录 → 整个删掉，不留空壳
        for v in vers:
            vdir = UPDATES_STORE / v
            if vdir.exists() and not any(
                (_platform_dir(v, p) / "manifest.json").exists() for p in PLATFORMS
            ):
                shutil.rmtree(vdir, ignore_errors=True)
    except Exception:
        pass


@router.post("/updates/{version}/upload")
async def upload_release(
    version: str,
    manifest: str = Form(...),
    components: list[UploadFile] = File(...),
    platform: str = Form("windows"),
    _auth=Depends(require_auth),
):
    """Upload a new release (manifest + component zips) for a platform."""
    _check_platform(platform)
    valid = _valid_components(platform)
    if not VERSION_RE.match(version):
        raise HTTPException(
            status_code=400,
            detail="Version must be YYYY.MM.DD or YYYY.MM.DD.N format",
        )

    # Parse manifest
    try:
        manifest_data = json.loads(manifest)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid manifest JSON: {e}")

    if manifest_data.get("version") != version:
        raise HTTPException(
            status_code=400,
            detail=f"Manifest version '{manifest_data.get('version')}' does not match URL '{version}'",
        )

    # Create platform-scoped version directory.
    # ⚠️ 覆盖重传时**只清本平台的内容**，不能 rmtree 整个目录 ——
    # windows 的 version_dir 是版本目录顶层，与 macos/ 子目录同级，整体删会连
    # 另一平台一起端掉（2026-09-15 mac 被误删就是这个：发 windows 同版本号时
    # 把当天刚发的 macos/ 一并 rmtree 了）。详见 _remove_platform_version。
    version_dir = _platform_dir(version, platform)
    if version_dir.exists():
        _remove_platform_version(version, platform)
    version_dir.mkdir(parents=True, exist_ok=True)

    # Save manifest
    (version_dir / "manifest.json").write_text(
        json.dumps(manifest_data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Save component zips
    saved = []
    for upload in components:
        name = upload.filename.rsplit(".", 1)[0] if upload.filename else ""
        if name not in valid:
            continue

        zip_bytes = await upload.read()
        target = version_dir / f"{name}.zip"
        target.write_bytes(zip_bytes)
        saved.append(name)

    # If no zips uploaded but manifest references components from a previous version,
    # copy those zips from the previous version of the SAME platform (dedup by sha256)
    prev_version = None
    versions = sorted(
        [d.name for d in UPDATES_STORE.iterdir() if d.is_dir() and VERSION_RE.match(d.name) and d.name != version],
        key=_version_key,
        reverse=True,
    )
    for v in versions:
        if _read_manifest(v, platform):
            prev_version = v
            break

    if prev_version:
        prev_manifest = _read_manifest(prev_version, platform)
        if prev_manifest:
            for comp_name in manifest_data.get("components", {}):
                if comp_name not in saved and comp_name in valid:
                    prev_zip = _platform_dir(prev_version, platform) / f"{comp_name}.zip"
                    if prev_zip.exists():
                        target = version_dir / f"{comp_name}.zip"
                        shutil.copy2(prev_zip, target)
                        saved.append(comp_name)

    # 保留最近 N 版，清掉更旧的，避免 updates-store 无限累积
    _prune_old_versions(version)

    return {
        "ok": True,
        "data": {"version": version, "components": saved},
    }
