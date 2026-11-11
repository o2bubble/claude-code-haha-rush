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

# 2026-11-04 仓库拆分后，插件目录搬到了 GUI 仓：
#   本仓（引擎）   → bin/claude-haha、src/
#   GUI 仓         → packages/plugins/
# 这个脚本还留在引擎仓（它同时服务两边），所以插件目录要能指向外面。
# 默认按老布局找；拆分后布局用 GUI_PLUGINS_DIR 覆盖，本仓下不存在就自动探测。
def _resolve_plugins_dir():
    """找到真正放着插件的目录。

    ⚠️ 不能只判 `isdir`（2026-11-07 踩到）：仓库拆分后本仓残留了一个
    **空的** `packages/plugins/`，`isdir` 为真 → 探测被它骗过去 →
    报「目录为空或不存在」，而真正的内容在同级 GUI 仓里。
    所以按「该插件目录下确实有插件」来判定。
    """
    cands = [
        os.environ.get("GUI_PLUGINS_DIR") or "",
        os.path.join(ROOT, "packages", "plugins"),                                        # 拆分前
        os.path.join(os.path.dirname(ROOT), "lumen-agent-desktop", "packages", "plugins"),  # 拆分后
    ]
    for c in cands:
        if not c or not os.path.isdir(c):
            continue
        if any(os.path.isdir(os.path.join(c, x)) for x in os.listdir(c) if not x.startswith(".")):
            return c
    return cands[1]


PLUGINS_DIR = _resolve_plugins_dir()

# 目录名 / 扩展名级别的排除
SKIP_DIRS = {"node_modules", "__pycache__", ".git"}
# `.sig` 必须排除：它是**对 zip 内容的签名**，若打进 zip 就成了循环依赖
# （签名要覆盖含签名的 zip → 永远不自洽）。2026-11-07 实测踩到：
# 加了自动签名后 zip 里多出一个 config-export.sig，sha256 每次都变。
SKIP_EXT = {".zip", ".pyc", ".sig"}

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
    "screenshot": {"capture.test.cjs"},
    "office-preview": {"server.test.cjs"},
    "pointer": set(),
    "mouse-keyboard": set(),
    "computer-use": set(),
    "gui-manual": set(),
    "git-viewer": set(),
    "nodejs": set(),
    "playwright-mcp": set(),
    # 测试文件不进包 —— 用户下载到一堆 .test.cjs 没意义，只占体积
    "config-export": {
        "export.test.cjs", "export.e2e.test.cjs",
        "custom.test.cjs", "custom.e2e.test.cjs",
        "rehearsal.test.cjs", "restore-guide.test.cjs",
        "tools.test.cjs", "audit.test.cjs", "ai-flow.test.cjs",
        "cors.test.cjs", "single-file.test.cjs", "panel-static.test.cjs", "tar-writer.test.cjs",
        "zip-sync.test.cjs",
    },
}

# 每个插件**必须**在包里的关键文件（缺了就是坏包）。
# 这些是"缺了插件功能会退化或失效"的文件 —— 不是随便挑的。
REQUIRED = {
    "pointer": {"plugin.json", "server.cjs", "render.py"},
    "mouse-keyboard": {"plugin.json", "server.cjs", "vendor/win32-x64/koffi.node",
                       "vendor/win32-x64/robotjs.node"},
    "screenshot": {"plugin.json", "server.cjs", "win32.cjs",
                      "vendor/win32-x64/koffi.node"},
    # vendor 里的两个库是运行时依赖：少一个预览就白屏（docx-preview 依赖 JSZip）
    "office-preview": {"plugin.json", "server.cjs", "preview.html", "sheet.html",
                       "slides.html", "meta.yaml",
                       "vendor/docx-preview.min.js", "vendor/jszip.min.js",
                       "vendor/pptx-renderer.es.js", "vendor/ooxml/core.js"},
    "computer-use": {"plugin.json", "skill/SKILL.md"},
    "gui-manual": {"plugin.json", "skill/SKILL.md"},
    "git-viewer": {"plugin.json"},
    # 这三个是恢复端的全部工具：少了 restore-tools 或 tar-writer，
    # 用户拿到包却无法校验/解压（2026-11-07：包内曾打的是旧版 tar-writer，
    # 读 manifest 要 172 秒，恢复端白等半小时）
    "config-export": {"plugin.json", "meta.yaml", "export-server.cjs",
                      "restore-tools.cjs", "tar-writer.cjs", "extract.py"},
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


def sign(plugin: str, check_only: bool = False) -> bool:
    """打包后立刻签名。

    🔴 **为什么必须自动化**（2026-11-07 事故）：
    签名一直是靠人手做的（仓库里甚至没有签名脚本）。第一次改走 web 发布路径时
    上传没带 signature，服务端 `elif sig_path.exists(): unlink()` 把**原有签名删了** ——
    marketplace 里 config-export 从 signed=true 变 signed=false，
    用户直接失去「安装」按钮，只能走「AI 安装 + 安全审查」。

    失败不阻断打包（没私钥的机器照样要能打包），但会**大声提示**未签名。
    """
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "_sign_plugin", os.path.join(os.path.dirname(os.path.abspath(__file__)), "sign-plugin.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] {plugin}: 加载签名脚本失败（{e}），跳过了签名")
        return True
    return mod.sign_one(plugin, check_only)


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
    # 打包完顺手签名 —— 让「漏签」变成不可能，而不是靠人记得
    if not args.check:
        for p in targets:
            sign(p)
    print("\n全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
