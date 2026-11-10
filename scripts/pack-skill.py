#!/usr/bin/env python3
"""Pack a skill from `skills-src/<name>/` into a marketplace zip.

Usage:
    python scripts/pack-skill.py multi-nic-routing
    python scripts/pack-skill.py --all

Produces `dist/skills/<name>.zip`, ready for:
    python scripts/publish-plugin.py --manifest skills-src/<name>/meta.yaml \
        --zip dist/skills/<name>.zip --api-key <key> --type skill

## Zip layout (the server and client both depend on this)

    meta.yaml                  ← at ROOT (marketplace metadata)
    <name>/SKILL.md            ← the skill itself, in its own directory

Unlike plugins (which need plugin.json at root), skills are just a directory of
markdown. The `meta.yaml` at root is what the marketplace lists; the inner
directory is what gets installed to `~/.claude/skills/<name>/`.
"""

import argparse
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "packages" / "skills-src"
OUT = ROOT / "dist" / "skills"


def pack(name: str) -> bool:
    skill_dir = SRC / name
    if not skill_dir.is_dir():
        print(f"[skip] {name}: 目录不存在 {skill_dir}")
        return False

    skill_md = skill_dir / "SKILL.md"
    meta = skill_dir / "meta.yaml"
    missing = [str(p.name) for p in (skill_md, meta) if not p.is_file()]
    if missing:
        print(f"[fail] {name}: 缺少 {', '.join(missing)}")
        return False

    # SKILL.md 必须有 frontmatter 的 name，否则客户端装不上
    head = skill_md.read_text(encoding="utf-8")[:400]
    if not head.startswith("---") or f"name: {name}" not in head:
        print(f"[fail] {name}: SKILL.md frontmatter 缺 name: {name}")
        return False

    OUT.mkdir(parents=True, exist_ok=True)
    out_zip = OUT / f"{name}.zip"

    files = sorted(
        p for p in skill_dir.rglob("*")
        if p.is_file() and p.name != "meta.yaml" and "__pycache__" not in p.parts
    )
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(meta, "meta.yaml")
        for p in files:
            z.write(p, f"{name}/{p.relative_to(skill_dir).as_posix()}")

    print(f"[ok] {out_zip.relative_to(ROOT)}  ({out_zip.stat().st_size} B, {len(files) + 1} files)")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    names = args.names
    if args.all:
        names = sorted(p.name for p in SRC.iterdir() if p.is_dir())
    if not names:
        ap.print_help()
        return 2

    ok = all(pack(n) for n in names)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
