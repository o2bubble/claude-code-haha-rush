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

VALID_COMPONENTS = {"gui", "claude", "bun", "tools", "python", "git", "extensions", "updater"}

VERSION_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$")


def _version_key(version: str) -> tuple:
    """Numeric sort key so 2026.08.03.10 > 2026.08.03.9 (lexical sort is wrong)."""
    return tuple(int(p) for p in version.split("."))


def _get_latest_version() -> str | None:
    """Return the latest version string from the updates-store directory."""
    if not UPDATES_STORE.exists():
        return None
    versions = []
    for entry in UPDATES_STORE.iterdir():
        if entry.is_dir() and VERSION_RE.match(entry.name):
            versions.append(entry.name)
    if not versions:
        return None
    versions.sort(key=_version_key, reverse=True)
    return versions[0]


def _read_manifest(version: str) -> dict | None:
    """Read a manifest.json for the given version."""
    path = UPDATES_STORE / version / "manifest.json"
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


# ── Public Endpoints ──

@router.get("/updates/latest")
async def get_latest_update():
    """Return the latest version manifest."""
    version = _get_latest_version()
    if not version:
        raise HTTPException(status_code=404, detail="No updates available")
    manifest = _read_manifest(version)
    if not manifest:
        raise HTTPException(status_code=404, detail="Manifest not found")
    return {"ok": True, "data": manifest}


@router.get("/updates/{version}/manifest")
async def get_update_manifest(version: str):
    """Return the manifest for a specific version."""
    manifest = _read_manifest(version)
    if not manifest:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"ok": True, "data": manifest}


@router.get("/updates/{version}/components/{component}/download")
async def download_component(version: str, component: str):
    """Stream a component zip for download."""
    if component not in VALID_COMPONENTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown component: {component}. Valid: {', '.join(sorted(VALID_COMPONENTS))}",
        )

    # Resolve the zip path — may be a symlink/hardlink to a shared file
    comp_zip = UPDATES_STORE / version / f"{component}.zip"
    if not comp_zip.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Component '{component}' not found for version {version}",
        )

    # FileResponse 自动带 Content-Length（固定长度传输，避免 chunked 被代理/防火墙掐断）
    return FileResponse(
        comp_zip,
        media_type="application/zip",
        filename=f"{component}.zip",
    )


# ── Upload (API key required) ──

@router.post("/updates/{version}/upload")
async def upload_release(
    version: str,
    manifest: str = Form(...),
    components: list[UploadFile] = File(...),
    _auth=Depends(require_auth),
):
    """Upload a new release (manifest + component zips)."""
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

    # Create version directory
    version_dir = UPDATES_STORE / version
    if version_dir.exists():
        shutil.rmtree(version_dir)
    version_dir.mkdir(parents=True)

    # Save manifest
    (version_dir / "manifest.json").write_text(
        json.dumps(manifest_data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Save component zips
    saved = []
    for upload in components:
        name = upload.filename.rsplit(".", 1)[0] if upload.filename else ""
        if name not in VALID_COMPONENTS:
            continue

        zip_bytes = await upload.read()
        target = version_dir / f"{name}.zip"
        target.write_bytes(zip_bytes)
        saved.append(name)

    # If no zips uploaded but manifest references components from a previous version,
    # copy those zips from the previous version (dedup by sha256)
    prev_version = None
    versions = sorted(
        [d.name for d in UPDATES_STORE.iterdir() if d.is_dir() and VERSION_RE.match(d.name) and d.name != version],
        key=_version_key,
        reverse=True,
    )
    if versions:
        prev_version = versions[0]

    if prev_version:
        prev_manifest = _read_manifest(prev_version)
        if prev_manifest:
            for comp_name in manifest_data.get("components", {}):
                if comp_name not in saved and comp_name in VALID_COMPONENTS:
                    prev_zip = UPDATES_STORE / prev_version / f"{comp_name}.zip"
                    if prev_zip.exists():
                        target = version_dir / f"{comp_name}.zip"
                        shutil.copy2(prev_zip, target)
                        saved.append(comp_name)

    return {
        "ok": True,
        "data": {"version": version, "components": saved},
    }
