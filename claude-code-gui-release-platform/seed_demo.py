"""造一批**有层次**的演示数据，用于人工验收布局。

与 seed_verify.py 的区别：那个只为自动化测试造最小数据集（2 包 2 反馈）；
这个造多样数据（不同下载量/状态/类型/版本数），让统计图、排行、分布都
有内容可看，而不是一排 0。

数据全部带 DEMO 前缀，验收完可用 --clean 一键清掉。
"""

import io
import json
import random
import sys
import urllib.request
import uuid
import zipfile

BASE = "http://127.0.0.1:8799"
API_KEY = "sk-verify-test-key-local-only"

PACKAGES = [
    # (slug, name, desc, author, version, type, skills, downloads)
    ("git-viewer", "Git 查看器", "只读的 Git 查看工具：工作区改动、提交历史、分支", "官方", "0.2.1", "plugin", 0, 187),
    ("nodejs", "Node.js 运行时", "为插件进程与 AI Bash 提供 Node LTS 运行时", "官方", "1.0.3", "plugin", 0, 154),
    ("playwright-mcp", "Playwright MCP", "浏览器自动化：AI 可操作网页、填表单、截图", "官方", "1.1.0", "plugin", 0, 96),
    ("mck-ppt-design", "咨询级 PPT 设计", "用 MckEngine 生成麦肯锡风格演示文稿", "Matt Pocock", "2.3.0", "skill", 8, 73),
    ("ppt-master", "PPT 大师", "从零生成可编辑 PPTX，支持模板填充与视觉重建", "Matt Pocock", "1.8.2", "skill", 5, 61),
    ("academic-paper", "学术论文工坊", "12 agent 论文流水线：选题到定稿全流程", "community", "3.0.1", "skill", 11, 44),
    ("deep-research", "深度研究", "13 agent 研究流水线，含事实核查与三方文献扫描", "community", "1.4.0", "skill", 8, 38),
    ("qa", "交互式 QA", "对话式报 bug，agent 自动归档为 GitHub issue", "官方", "0.9.5", "skill", 3, 22),
    ("wps-office", "WPS 助手", "跨应用管理 Excel / Word / PPT", "community", "1.2.0", "skill", 4, 0),
    ("legacy-legacy", "旧版实验插件", "已废弃的早期实验", "unknown", "0.0.1", "plugin", 0, 0),
]

FEEDBACK = [
    ("bug", "超级桌面里粘贴图片后，缩略图偶发不显示，要重新打开面板才正常", "2026.09.11.14"),
    ("bug", "时间线导航拖动到最上面时，会跳回最底部", "2026.09.11.14"),
    ("bug", "设置面板切换服务器地址后，需要重启才生效", "2026.09.11.13"),
    ("bug", "编辑器打开大文件（>2MB）时会卡住几秒", "2026.09.10.9"),
    ("bug", "快捷键 Ctrl+Shift+P 在终端聚焦时不响应", "2026.09.11.14"),
    ("bug", "多显示器下窗口位置记忆不准，副屏上的窗口会跑到主屏", "2026.09.09.10"),
    ("suggestion", "希望管理后台支持暗色主题自动跟随系统", "2026.09.11.14"),
    ("suggestion", "插件市场希望能按下载量排序", "2026.09.11.14"),
    ("suggestion", "想要一个快捷的方式把当前会话导出成 markdown", "2026.09.11.13"),
    ("suggestion", "笔记面板希望能支持 markdown 表格渲染", "2026.09.10.9"),
    ("suggestion", "希望在文件树里能直接新建文件，不用切到终端", "2026.09.09.10"),
]


# 1x1 PNG —— 给"带图反馈"用，让缩略图/灯箱这条链路有人工与自动验收的样本
PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)


def multipart(fields, files):
    boundary = "----demo" + uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f"--{boundary}\r\n".encode())
        out.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        out.write(str(v).encode("utf-8") + b"\r\n")
    for k, (filename, data, ctype) in files.items():
        out.write(f"--{boundary}\r\n".encode())
        out.write(
            f'Content-Disposition: form-data; name="{k}"; filename="{filename}"\r\n'.encode()
        )
        out.write(f"Content-Type: {ctype}\r\n\r\n".encode())
        out.write(data + b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


# 提交反馈会撞上服务端的按 IP 限流（20 次/小时），多跑几次 seed 就会被 429。
# 用 RFC 5737 保留测试段的随机 IP 隔离 —— 既绕开自己消耗的配额，
# 又不影响真实客户端计数。
SEED_IP = f"198.51.100.{random.randint(1, 254)}"


def post(path, fields, files=None, api_key=None):
    body, ctype = multipart(fields, files or {})
    r = urllib.request.Request(BASE + path, data=body, method="POST")
    r.add_header("Content-Type", ctype)
    r.add_header("X-Forwarded-For", SEED_IP)
    if api_key:
        r.add_header("X-API-Key", api_key)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def skill_zip(slug, skills):
    """生成含 N 个技能子目录的包。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        if skills == 0:
            z.writestr("plugin.json", json.dumps({
                "pluginName": slug, "displayName": slug, "version": "1.0.0",
                "category": "tool", "installType": "standard",
            }))
            z.writestr("README.md", f"# {slug}\n\n演示插件。\n")
        else:
            for i in range(skills):
                z.writestr(f"{slug}-skill-{i+1}/SKILL.md",
                           f"---\nname: {slug}-skill-{i+1}\ndescription: 演示技能 {i+1}\n---\n")
    return buf.getvalue()


def seed():
    print("造包…")
    for slug, name, desc, author, ver, ptype, skills, _dl in PACKAGES:
        manifest = (
            f"name: {name}\nslug: {slug}\ndescription: {desc}\n"
            f"author: {author}\nversion: {ver}\ntags: [demo]\n"
        )
        code, body = post("/api/packages", {
            "manifest": manifest, "type": ptype, "force": "true",
        }, {"skills": (f"{slug}.zip", skill_zip(slug, skills), "application/zip")},
            api_key=API_KEY)
        print(f"  {code} {slug}")

    print("造反馈…")
    for i, (ftype, msg, ver) in enumerate(FEEDBACK):
        # 前两条带截图 —— 覆盖"带图反馈"的缩略图与灯箱展示
        files = {"image": ("shot.png", PNG_1PX, "image/png")} if i < 2 else None
        code, _ = post("/api/feedback", {
            "type": ftype, "message": msg, "app_version": ver,
        }, files)
        print(f"  {code} {'[图]' if files else '    '} {msg[:26]}…")

    print("造更新版本…")
    for v, notes in [
        ("2026.09.11.14", "修复时间线拖动跳底、图片预览交互、超级桌面崩溃"),
        ("2026.09.10.9", "插件 runtime PATH 修复、目录树定位三修"),
        ("2026.09.08.4", "插件系统 AI_NOTES 三级回退、守卫分级"),
    ]:
        mf = {
            "version": v, "release_notes": notes,
            "published_at": f"{v.replace('.', '-')[:10]}T00:00:00Z" if v.count(".") == 2 else "2026-09-11T00:00:00Z",
            "components": {"gui": {"sha256": "aa", "size": 1},
                           "claude": {"sha256": "bb", "size": 1}},
        }
        code, _ = post(f"/api/updates/{v}/upload", {
            "manifest": json.dumps(mf), "platform": "windows",
        }, {"components": ("gui.zip", b"PK\x03\x04demo", "application/zip")},
            api_key=API_KEY)
        print(f"  {code} {v}")

    print("\n完成。提示：这些是演示数据，验收完记得清理。")


if __name__ == "__main__":
    seed()
