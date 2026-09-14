#!/usr/bin/env python3
"""发布 macOS 版到更新服务器（首次 mac 发布）。

用法:
  python release_mac.py make      # 生成 manifest.json（从 gui.zip 内嵌 manifest 派生）
  python release_mac.py cloud     # 上传到云服务器
  python release_mac.py verify    # 验证

背景（详见 docs/macos-build-playbook.md）：
  · gui.zip 内嵌 manifest 的 version 是 "ci-build"，服务端 VERSION_RE 要求
    YYYY.MM.DD[.N] → 必须改正式号。
  · 内嵌 gui.sha256 是 dirMetaHash(path,size)，(path,size) 相同但内容变时不敏感
    （"size-only 漏检"，.25.5 事故）→ 用 dir_content_hash（逐文件内容 sha 聚合）
    覆盖，保证内容变则 sha 必变。
  · sha 对客户端只是"版本标识"（update.rs: 不做文件系统 hash，安装后把服务端
    sha 原样写进本地 manifest），所以算法自洽即可。
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import zipfile

VERSION = "2026.09.14.2"
# 只上传这些组件（其余由服务端从同平台上一版自动复制）。
# 全量发布时改成 set(COMPONENTS)。
UPLOAD_ONLY = {"gui"}
DL = os.path.expanduser("~/Downloads")
ART = os.path.dirname(os.path.abspath(__file__))
HOST = "http://localhost:8765"                 # 经 workbench 隧道
# 上传 key 从环境变量读，**不要硬编码**（曾硬编码并提交 → 被 sync 脚本的密钥闸拦下，
# 虽未进 GitHub，但 key 出现在 git 历史里需要清理）。值见 `.private/api-keys.md`。
API_KEY = os.environ.get("RELEASE_API_KEY", "")
if not API_KEY:
    print("!! 未设置 RELEASE_API_KEY（见 .private/api-keys.md）", file=sys.stderr)
    sys.exit(1)

# 组件 → 本地 zip 文件名。改了 VERSION 后**只需改这里**（文件名带浏览器加的 " (N)"
# 后缀没关系 —— 上传时会映射成规范 <component>.zip，见 cloud()）。
COMPONENTS = {
    "gui": "gui (4).zip",
    "claude": "claude.zip",
    "bun": "bun.zip",
    "tools": "tools.zip",
    "python": "python.zip",
    "extensions": "extensions.zip",
}
GUI_ZIP = os.path.join(DL, COMPONENTS["gui"])

RELEASE_NOTES = """v2026.09.14.2

macOS 版本（arm64 / Apple Silicon）。

### 修复
- 更新面板把已装的 GUI 误报「未安装」—— 路径解析少算了两级（GUI 是 .app 本身，
  不在 Contents/MacOS 里）。同一错误也会让 GUI 自动更新写到不存在的路径。
- 不再生成 .app 里跑不起来的三个命令（kill-claude / claude-profile / memory-setup）
  —— 它们引用的 scripts/ 目录不打进 .app，属于死文件

### 安装/更新
本版改动集中在 GUI，'gui' 组件单独更新即可；其余组件与 2026.09.14.1 相同。
"""


def _dir_content_hash(zip_path: str) -> str:
    """对 zip 内每个文件算内容 sha 并按路径聚合。

    ⚠️ **当前发布流程不使用它** —— 发布时 sha 一律沿用内嵌 manifest 的
    `dirMetaHash`（与客户端本地 manifest 算法一致；换算法会导致全量误报，
    详见 docs/macos-build-playbook.md §3）。保留此函数仅供诊断/对比
    （例：确认某次构建的 .app 内容是否真的变了）。"""
    z = zipfile.ZipFile(zip_path)
    entries = []
    for info in z.infolist():
        if info.is_dir():
            continue
        h = hashlib.sha256(z.read(info.filename)).hexdigest()
        entries.append((info.filename, h))
    entries.sort()
    blob = "\n".join(f"{p}\0{h}" for p, h in entries).encode()
    return hashlib.sha256(blob).hexdigest()


def make() -> int:
    if not os.path.exists(GUI_ZIP):
        print(f"找不到 {GUI_ZIP}", file=sys.stderr)
        return 1
    z = zipfile.ZipFile(GUI_ZIP)
    mf = json.loads(z.read("Claude Code.app/Contents/MacOS/manifest.json"))

    mf["version"] = VERSION
    mf["release_notes"] = RELEASE_NOTES

    # ⚠️ **sha 一律沿用内嵌 manifest 的值，不覆盖**（策略选择，2026-09-14）。
    #
    # 原因：客户端读的本地 manifest **就是 .app 内嵌的这份**（update.rs 的
    # local_manifest_path = Contents/MacOS/manifest.json），其 sha 是构建期算的
    # dirMetaHash(path,size)。若发布时改用别的算法（如 dir_content_hash），
    # 同一份内容两边算出不同值 → **客户端永远认为"有更新"**（实测：6 个组件全亮）。
    #
    # 代价：放弃 dir_content_hash 的"内容变但 size 不变也能检测到"能力
    # （playbook 记的 .25.5 坑）。权衡后接受 —— 该场景极罕见，而算法不一致
    # 会导致**每次检查都误报**，代价大得多。
    #
    # size 仍修正为 zip 实际大小：内嵌值是**解压后目录**大小（gui 427MB vs zip 137MB），
    # 客户端下载的是 zip，用错会让下载进度显示异常。size 不参与比对，纯展示。
    mf["components"]["gui"]["size"] = os.path.getsize(GUI_ZIP)
    print(f"gui sha: {mf['components']['gui']['sha256'][:16]}… (沿用内嵌 dirMetaHash)")
    print(f"gui size: {mf['components']['gui']['size']} (zip 实际大小)")

    # 其余组件：sha 取 zip 内主文件的 sha（与 Windows 约定一致：文件内容 sha）
    # mac 单文件组件（claude/bun）zip 内就一个文件；目录组件（tools/python/extensions）
    # 用 zip 内所有文件的聚合（同 dir_content_hash 思路）。
    # 其余组件同理：sha 沿用内嵌值（与客户端本地 manifest 的算法一致），
    # 只把 size 修正成 zip 实际大小。
    for name, fname in COMPONENTS.items():
        if name == "gui":
            continue
        p = os.path.join(DL, fname)
        if not os.path.exists(p):
            print(f"!! 缺组件 {name}: {p}", file=sys.stderr)
            return 1
        mf["components"][name]["size"] = os.path.getsize(p)

    out = os.path.join(ART, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(mf, f, ensure_ascii=False, indent=2)
    print(f"写出 {out}")
    print("components:", sorted(mf["components"].keys()))
    return 0


def _workbench(cmd: str) -> int:
    """经由 workbench 在云 ECS 上执行（私网机器无公网 IP）。"""
    r = subprocess.run(
        ["workbench", "exec", "-i", "i-2ze2rouoikcqrlbseu8a", "-r", "cn-beijing", "-c", cmd],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
    )
    print(r.stdout[-2000:] if r.stdout else "", end="")
    if r.stderr:
        print(r.stderr[-500:], file=sys.stderr, end="")
    return r.returncode


def cloud() -> int:
    # workbench upload **不会自动创建目标目录**，缺目录报
    # [FileTransfer.PathNoWritePermission]（不指向真因，容易误判成权限问题）。
    # 先清空目录：workbench upload 遇到同名文件会**交互式**问 "Overwrite? [y/N]"，
    # 非交互环境下直接当作取消 → 上传失败。每次从干净目录开始。
    if _workbench("rm -rf /tmp/macrel && mkdir -p /tmp/macrel && chmod 777 /tmp/macrel") != 0:
        print("准备远端目录失败", file=sys.stderr)
        return 1
    # 组装上传命令：先上传文件到 ECS /tmp，再 curl POST
    files = ["manifest.json"] + [COMPONENTS[n] for n in COMPONENTS if n in UPLOAD_ONLY]
    up_cmds = []
    # ⚠️ 远端文件名必须是**规范组件名**（<component>.zip）：服务端用
    # `upload.filename.rsplit(".",1)[0]` 判定组件，不在 valid 集合里就**静默跳过**
    # （接口仍返回 ok:true，只是 components 列表少一项 —— 极难察觉）。
    # 浏览器下载的包带 " (N)" 后缀（gui (4).zip → 解析出 "gui (4)" ≠ "gui"）。
    # 映射**按组件名派生**，不要再写死文件名 —— 写死过一版 "gui (3).zip"，换成
    # (4) 后映射失配、gui 被静默丢弃，但接口看起来是成功的。
    local_to_comp = {COMPONENTS[n]: n for n in COMPONENTS}
    remote_names = {f: (f if f == "manifest.json" else f"{local_to_comp[f]}.zip") for f in files}
    for f in files:
        local = os.path.join(ART, f) if f == "manifest.json" else os.path.join(DL, f)
        remote = remote_names[f]
        r = subprocess.run(
            ["workbench", "upload", "-i", "i-2ze2rouoikcqrlbseu8a", "-r", "cn-beijing",
             local, f"/tmp/macrel/{remote}"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
        )
        if r.returncode != 0:
            detail = (r.stderr or r.stdout or "")[-400:]
            print(f"上传 {f} 失败 rc={r.returncode}: {detail}", file=sys.stderr)
            return 1
        print(f"上传 {f} ok")

    # curl 提交
    comp_args = " ".join(
        f'-F "components=@/tmp/macrel/{remote_names[COMPONENTS[n]]};type=application/zip"'
        for n in COMPONENTS if n in UPLOAD_ONLY
    )
    cmd = (
        f'curl -s -X POST "{HOST}/api/updates/{VERSION}/upload" '
        f'-H "X-API-Key: {API_KEY}" '
        f'-F "manifest=</tmp/macrel/manifest.json" '
        f'-F "platform=macos" '
        f'{comp_args}'
    )
    return _workbench(cmd)


def verify() -> int:
    return _workbench(
        f'curl -s "{HOST}/api/updates/latest?platform=macos" | head -c 400; echo'
    )


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "make"
    sys.exit({"make": make, "cloud": cloud, "verify": verify}[action]())
