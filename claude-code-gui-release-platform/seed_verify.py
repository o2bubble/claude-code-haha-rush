"""给本地验收库造真实数据 —— 走**公开端点本身**（而非直接写库），
这样同时验证了「已有链路没被我的改动打断」。

造：2 条反馈（1 条带图）+ 2 个包（1 skill / 1 plugin）+ 1 个更新版本。
"""

import hashlib
import io
import json
import os
import secrets
import sqlite3
import sys
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:8799")
DB = os.environ.get("VERIFY_DB", "registry.db")
# key 从环境变量读；未提供则临时生成一个并插进本地库（仅本地验收用途）。
API_KEY = os.environ.get("VERIFY_API_KEY", "")


def provision_api_key() -> str:
    """未提供 key 时，生成一个并写进本地 registry.db 的 api_keys 表。"""
    if API_KEY:
        return API_KEY
    if not Path(DB).exists():
        print(f"本地库 {DB} 不存在 —— 请先启动服务（它会 init_db）再跑本脚本。")
        sys.exit(2)
    raw = "sk-verify-" + secrets.token_hex(16)
    conn = sqlite3.connect(DB)
    conn.execute(
        "INSERT OR IGNORE INTO api_keys (key_hash, label, created_at) VALUES (?,?,?)",
        (hashlib.sha256(raw.encode()).hexdigest(), "verify-seed",
         datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")),
    )
    conn.commit()
    conn.close()
    print(f"  （已生成临时 API key 并写入 {DB}）")
    return raw


API_KEY = provision_api_key()


def multipart(fields, files):
    """极简 multipart/form-data 构造（避免引 requests 依赖）。"""
    boundary = "----verify" + uuid.uuid4().hex
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


def post_form(path, fields, files=None, api_key=None):
    body, ctype = multipart(fields, files or {})
    r = urllib.request.Request(BASE + path, data=body, method="POST")
    r.add_header("Content-Type", ctype)
    if api_key:
        r.add_header("X-API-Key", api_key)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def make_skill_zip():
    """skill 包：zip 内需有含 SKILL.md 的子目录。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("demo-skill/SKILL.md",
                   "---\nname: demo-skill\ndescription: 验收用示例技能\n---\n\n# Demo\n")
        z.writestr("demo-skill/helper.py", "print('hi')\n")
    return buf.getvalue()


def make_plugin_zip():
    """plugin 包：zip 内需有 plugin.json（含 pluginName）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("plugin.json", json.dumps({
            "pluginName": "verify-plugin", "displayName": "验收插件",
            "version": "1.0.0", "category": "tool", "installType": "standard",
        }))
        z.writestr("README.md", "# 验收插件\n\n用于验证管理后台。\n")
    return buf.getvalue()


PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)

print("[seed] 反馈（公开端点 POST /api/feedback）")
code, body = post_form("/api/feedback", {
    "type": "bug", "message": "验收用：点击设置面板时偶发白屏", "app_version": "2026.09.11.14",
})
print("  无图反馈:", code, body if code != 200 else "ok")

code, body = post_form("/api/feedback", {
    "type": "suggestion", "message": "验收用：希望管理后台支持暗色主题", "app_version": "2026.09.11.14",
}, {"image": ("shot.png", PNG, "image/png")})
print("  带图反馈:", code, body if code != 200 else "ok")

print("[seed] 包（公开端点 POST /api/packages）")
code, body = post_form("/api/packages", {
    "manifest": "name: Demo Skill\nslug: demo-skill\ndescription: 验收用示例技能\n"
                "author: verify-bot\nversion: 1.0.0\ntags: [demo, test]\n",
    "type": "skill", "force": "true",
}, {"skills": ("demo-skill.zip", make_skill_zip(), "application/zip")}, api_key=API_KEY)
print("  skill 包:", code, body if code != 200 else "ok")

code, body = post_form("/api/packages", {
    "manifest": "name: Verify Plugin\nslug: verify-plugin\ndescription: 验收用示例插件\n"
                "author: verify-bot\nversion: 1.0.0\ntags: [demo]\n",
    "type": "plugin", "force": "true",
}, {"skills": ("verify-plugin.zip", make_plugin_zip(), "application/zip")}, api_key=API_KEY)
print("  plugin 包:", code, body if code != 200 else "ok")

print("[seed] 更新版本（公开端点 POST /api/updates/{v}/upload）")
manifest = {
    "version": "2026.01.01", "release_notes": "验收用假版本", "published_at": "2026-01-01T00:00:00Z",
    "components": {"gui": {"sha256": "deadbeef", "size": 4}, "claude": {"sha256": "cafe", "size": 4}},
}
code, body = post_form("/api/updates/2026.01.01/upload", {
    "manifest": json.dumps(manifest), "platform": "windows",
}, {
    "components": ("gui.zip", b"PK\x03\x04fake", "application/zip"),
}, api_key=API_KEY)
print("  版本上传:", code, body if code != 200 else "ok")

print("\n[seed] 完成")
