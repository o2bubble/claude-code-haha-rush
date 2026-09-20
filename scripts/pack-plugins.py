#!/usr/bin/env python3
"""Pack GUI plugins into marketplace zips.

Usage:
    python scripts/pack-plugins.py pointer mouse-keyboard ...     # specific plugins
    python scripts/pack-plugins.py --all                          # every plugin
    python scripts/pack-plugins.py --check                        # verify only, write nothing

## Why this exists (2026-09-20)

The zips used to be packed by hand, and **files silently went missing**.
Worst case: `pointer.zip` shipped WITHOUT `render.py` — the script that actually
draws. `server.cjs` degrades to the WebView2 fallback when it can't find it
(`if (!fs.existsSync(script)) return ...`), so every marketplace user got an
**opaque overlay that blocks their screen** — the exact bug `render.py` was
written to fix. Nobody noticed because the dev machine had the file.

So this script is **self-verifying**: after packing it re-opens the zip and
fails loudly if anything the plugin actually needs is missing.

## Exclusion rules

What goes in is **the plugin directory's real content**, minus:
  · `.zip`            — the output itself
  · `__pycache__`, `*.pyc`
  · `node_modules`
  · dev-only files    — see DEV_ONLY below

`DEV_ONLY` is explicit (not a glob) so that adding a source file can never
accidentally ship or hide. If you add a helper that shouldn't ship, list it here.
"""
import argparse
import io
import os
import sys
import zipfile

# Windows 控制台默认 GBK —— 中文和 ✓/✗ 都会 UnicodeEncodeError 打死脚本。
# 强制 stdout/stderr 走 UTF-8（Python 3.7+）。
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGINS_DIR = os.path.join(ROOT, "plugins")

# 目录名 / 扩展名级别的排除
SKIP_DIRS = {"node_modules", "__pycache__", ".git"}
SKIP_EXT = {".zip", ".pyc"}

# 打包时按 LF 归一化的文本扩展名（见 pack() 里 write 处的说明）
# 工作树在 Windows 上是 CRLF，直接写进 zip 会让"重新打包"产生一堆二进制
# diff（实测：一次打包 4 个 zip 全变脏，还挡住 git 分支切换）。
TEXT_EXTS = {".md", ".yaml", ".yml", ".json", ".cjs", ".mjs", ".js",
             ".html", ".css", ".py", ".txt", ".svg"}

# zip entry 的固定时间戳（1980-01-01 = zip 格式最早合法值）。
# 不固定的话，同样内容每次打包的字节都不同（mtime 参与），git 里全是噪音 diff。
FIXED_TIME = (1980, 1, 1, 0, 0, 0)

# 明确列出的"开发用、不进包"文件（相对插件目录）。
# 之所以逐个列而不是用通配：新增源文件时**默认进包**，漏发比多发的代价大得多。
DEV_ONLY = {
    "screenshot": set(),
    "pointer": set(),
    "mouse-keyboard": set(),
    "computer-use": set(),
    "gui-manual": set(),
    "git-viewer": set(),
    "nodejs": set(),
    "playwright-mcp": set(),
}

# 每个插件**必须**在包里的关键文件（缺了就是坏包）。
# 这些是"缺了插件功能会退化或失效"的文件 —— 不是随便挑的。
REQUIRED = {
    "pointer": {"plugin.json", "server.cjs", "render.py"},
    "mouse-keyboard": {"plugin.json", "server.cjs", "vendor/win32-x64/koffi.node",
                       "vendor/win32-x64/robotjs.node"},
    "screenshot": {"plugin.json", "server.cjs"},
    "computer-use": {"plugin.json", "skill/SKILL.md"},
    "gui-manual": {"plugin.json", "skill/SKILL.md"},
    "git-viewer": {"plugin.json"},
}


def collect(plugin: str):
    """Return [(abs_path, zip_rel_path)] for everything that should ship."""
    d = os.path.join(PLUGINS_DIR, plugin)
    dev = DEV_ONLY.get(plugin, set())
    out = []
    for root, dirs, names in os.walk(d):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for n in sorted(names):
            if os.path.splitext(n)[1] in SKIP_EXT:
                continue
            full = os.path.join(root, n)
            rel = os.path.relpath(full, d).replace(os.sep, "/")
            if rel in dev:
                continue
            out.append((full, rel))
    out.sort(key=lambda x: x[1])
    return out


def pack(plugin: str, check_only: bool = False) -> bool:
    files = collect(plugin)
    if not files:
        print(f"  [FAIL] {plugin}: 目录为空或不存在")
        return False

    # ── 打包前：关键文件在不在 ──
    present = {rel for _, rel in files}
    missing = REQUIRED.get(plugin, set()) - present
    if missing:
        print(f"  [FAIL] {plugin}: 源目录就缺关键文件 → {sorted(missing)}")
        return False

    out = os.path.join(PLUGINS_DIR, plugin, f"{plugin}.zip")
    if not check_only:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for full, rel in files:
                with open(full, "rb") as f:
                    data = f.read()
                # 文本按 LF 归一化：工作树在 Windows 上是 CRLF（core.autocrlf），
                # 原样打包会让"重新打包"产生一堆二进制 diff（实测挡住过 git 分支切换）。
                if os.path.splitext(rel)[1].lower() in TEXT_EXTS:
                    data = data.replace(b"\r\n", b"\n")
                # ⚠️ 时间戳也要固定住：zip 的每个 entry 都带 mtime（writestr 用"当前时刻"、
                # write 用文件 mtime），不固定的话**同样内容每次打包字节都不同** ——
                # 行尾归一化只解决了一半问题。
                zi = zipfile.ZipInfo(rel, date_time=FIXED_TIME)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16  # 可读权限位（Windows 忽略）
                z.writestr(zi, data)

        # ── 打包后：把 zip 重新读回来核对（防止 write 阶段出问题）──
        with zipfile.ZipFile(out) as z:
            if z.testzip() is not None:
                print(f"  [FAIL] {plugin}: zip 损坏")
                return False
            in_zip = set(z.namelist())
        lost = present - in_zip
        if lost:
            print(f"  [FAIL] {plugin}: 写进 zip 时丢了 → {sorted(lost)}")
            return False

    size = os.path.getsize(out) if not check_only else 0
    tag = "检查" if check_only else f"{size:,}B"
    print(f"  [ok]   {plugin}: {len(files)} 个文件  {tag}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Pack GUI plugins into marketplace zips")
    ap.add_argument("plugins", nargs="*", help="plugin directory names")
    ap.add_argument("--all", action="store_true", help="pack every plugin under plugins/")
    ap.add_argument("--check", action="store_true", help="verify only; write no zip")
    args = ap.parse_args()

    if args.all:
        targets = sorted(
            n for n in os.listdir(PLUGINS_DIR)
            if os.path.isdir(os.path.join(PLUGINS_DIR, n)) and not n.startswith("_")
        )
    elif args.plugins:
        targets = args.plugins
    else:
        ap.error("给插件名，或用 --all")

    print(f"{'检查' if args.check else '打包'} {len(targets)} 个插件：")
    ok = all(pack(p, args.check) for p in targets)
    if not ok:
        print("\n有插件未通过 —— 上面标 [FAIL] 的就是要修的地方。")
        return 1
    print("\n全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
