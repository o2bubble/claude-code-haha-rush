#!/usr/bin/env python3
"""发布 macOS 版到更新服务器（首次 mac 发布）。

用法:
  python release_mac.py make      # 生成 manifest.json（从 gui.zip 内嵌 manifest 派生）
  python release_mac.py cloud     # 上传到云服务器
  python release_mac.py verify    # 验证

背景（详见 docs/macos-build-playbook.md §3）：
  · gui.zip 内嵌 manifest 的 version 是 "ci-build"，服务端 VERSION_RE 要求
    YYYY.MM.DD[.N] → 必须改正式号。
  · **sha 一律沿用内嵌 manifest 的值，绝不重算**（2026-09-14 定论）。客户端读的
    本地 manifest 就是 .app 内嵌的那份（update.rs: local_manifest_path =
    Contents/MacOS/manifest.json），算法是 dirMetaHash(path,size)。发布侧若改用
    内容 hash，同一份内容两边算出不同值 → **每次检查都误报"有更新"**（实测：
    6 个组件全亮）。"算法更敏感"必须让位给"算法与客户端一致"。
  · 代价：放弃"内容变但 size 不变也能检测"的能力（.25.5 场景，极罕见）。真遇到
    时用**版本号**区分即可（客户端按版本号取最新，不依赖 sha 变化触发）。
  · size 仍修正为 zip 实际大小 —— 内嵌值是**解压后目录**大小（gui 427MB vs zip
    144MB），客户端下载的是 zip，用错会让下载进度显示异常。size 不参与比对。
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import zipfile

VERSION = "2026.09.15.1"
# ⚠️ 本次必须**全量**：云上 macos 版本目录已被 _prune_old_versions(keep=3) 剪空
# （Windows 连发 .14.4/.14.5/.15.1 把 mac 的 .14.1/.14.2 挤掉了），没有上一版
# 可供服务端复制未传组件 —— 只传 gui 会让其余 5 个组件在服务端缺失。
UPLOAD_ONLY = {"gui", "claude", "bun", "tools", "python", "extensions"}
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
    "gui": "gui.zip",
    "claude": "claude.zip",
    "bun": "bun.zip",
    "tools": "tools.zip",
    "python": "python.zip",
    "extensions": "extensions.zip",
}
GUI_ZIP = os.path.join(DL, COMPONENTS["gui"])

RELEASE_NOTES = """v2026.09.15.1

macOS 版本（arm64 / Apple Silicon）。本版对齐 Windows 2026.09.15.1，
一次补齐 mac 侧此前积压的多版 GUI 改动。

### 新增
- 会话面板支持一键复制会话名称 — 从行内 ⋯ 菜单或右键取用
- 会话分叉 — 可从任意会话复制出一份独立的新会话继续对话，原会话不受影响；
  分叉后不自动跳转，新会话出现在列表里，由你决定何时切过去
- 会话行按钮折叠 — 原本每行堆 5 个按钮（收藏 / 移文件夹 / 重命名 / 删除 /
  新窗口），现只留收藏与 ⋯，其余收进菜单；右键与 ⋯ 是同一份菜单
- 设置面板的服务器地址改为三档切换 — 「内网 96 / 公网云 / 自定义」一键选定，
  不再需要自己猜公网该填哪个域名

### 修复
- 连续发消息偶发 400 报错卡死会话（推理模型）— 只输出思考块的消息被剥离思考
  内容后留成空数组，遭服务端拒绝；现补占位内容，会话不再卡死
- 「公网」服务器档改用 Cloudflare Tunnel 域名 — 云主机裸 IP 在受限网络
  （企业网等）会被静默丢弃，选「公网」却完全连不上；已设过旧地址的自动迁移
- 自动更新地址与技能库地址不同步 — 改服务器地址只写了技能库那个字段，
  自动更新仍指向旧地址
- 工作区保存范围下服务器地址会静默丢失 — 现固定按全局保存

### 说明
mac 侧此前积压多版未发，本次 6 个组件全部有更新，安装全部组件即可。
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

    # 其余组件同理：**sha 仍沿用内嵌值**（与客户端本地 manifest 的算法一致），
    # 只把 size 修正成 zip 实际大小。非 gui 组件的 sha 由 build.ts 在 CI 期算好，
    # 与本次上传的 zip 同批产物，天然自洽。
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
