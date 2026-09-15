"""阶段 1 验收脚本 —— 本地起服务后运行，验证 admin API 与公开 API 回归。

覆盖计划里的验收清单：
  1. 三条公开 API 回归（不带认证头必须可访问）
  2. 错口令 -> 401；对口令 -> 拿到 token
  3. **无 token 访问 admin GET 必须 401**（证明没抄 require_auth 的 GET 放行）
  4. 带 token -> 200，且统计数字与数据库对得上
  5. 删除包（DB 行 + 文件）
  6. 反馈备注写入
"""

import json
import os
import pathlib
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:8799")
DB = os.environ.get("VERIFY_DB", "registry.db")

# 口令从环境变量读，不硬编码。缺失时直接退出 —— 绝不用空口令去测，
# 那会让「错口令 -> 401」变成假绿（空口令当然也 401），掩盖真实问题。
PASSWORD = os.environ.get("VERIFY_ADMIN_PASSWORD", "")
if not PASSWORD:
    print("缺少 VERIFY_ADMIN_PASSWORD —— 需与启动服务时的 ADMIN_PASSWORD 一致。")
    print("  ADMIN_PASSWORD=<口令> VERIFY_ADMIN_PASSWORD=<口令> python verify_admin.py")
    sys.exit(2)

passed, failed = [], []


def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  <- {detail}" if detail else ""))


def req(method, path, body=None, token=None, raw=False):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            payload = resp.read().decode("utf-8")
            return resp.status, (payload if raw else json.loads(payload))
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8")
        try:
            return e.code, json.loads(payload)
        except json.JSONDecodeError:
            return e.code, payload


print("\n[1] 公开 API 回归（不带任何认证头）")
for path in ("/api/packages", "/api/plugins"):
    code, _ = req("GET", path)
    check(f"{path} 免认证可访问", code == 200, f"HTTP {code}")

# updates 端点：有数据 -> 200 带 manifest；无数据 -> 404 且 detail 说明原因。
# 两种都算「路由正常」，只有既非 200 又非该 404 才是真问题。
code, body = req("GET", "/api/updates/latest")
detail = body.get("detail", "") if isinstance(body, dict) else str(body)
ok = (code == 200 and isinstance(body, dict) and "data" in body) or \
     (code == 404 and "updates available" in detail)
check("/api/updates/latest 正常（200 有数据 / 404 无数据）", ok,
      f"HTTP {code} detail={detail!r}" if code != 200 else "HTTP 200")

print("\n[2] 登录")
code, _ = req("POST", "/api/admin/login", {"password": "wrong-password"})
check("错口令 -> 401", code == 401, f"HTTP {code}")

code, body = req("POST", "/api/admin/login", {"password": PASSWORD})
token = body.get("data", {}).get("token") if isinstance(body, dict) else None
check("对口令 -> 200 且拿到 token", code == 200 and bool(token), f"HTTP {code}")

if not token:
    print("\n拿不到 token，后续测试无法进行")
    sys.exit(1)

print("\n[3] 无 token 访问 admin（最关键 —— 证明没抄 GET 放行）")
for path in ("/api/admin/stats", "/api/admin/packages", "/api/admin/feedback",
             "/api/admin/updates/versions"):
    code, _ = req("GET", path)
    check(f"无 token GET {path} -> 401", code == 401, f"HTTP {code}")

code, _ = req("GET", "/api/admin/stats", token="garbage.token")
check("伪造 token -> 401", code == 401, f"HTTP {code}")

print("\n[4] 带 token 访问 admin")
code, stats = req("GET", "/api/admin/stats", token=token)
ok = code == 200 and isinstance(stats, dict) and stats.get("ok")
check("GET /api/admin/stats -> 200", ok, f"HTTP {code}")

if ok:
    data = stats["data"]
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    db_pkgs = conn.execute("SELECT COUNT(*) FROM packages").fetchone()[0]
    db_skills = conn.execute("SELECT COUNT(*) FROM packages WHERE type='skill'").fetchone()[0]
    db_plugins = conn.execute("SELECT COUNT(*) FROM packages WHERE type='plugin'").fetchone()[0]
    db_fb = conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
    db_dl = conn.execute("SELECT COALESCE(SUM(download_count),0) FROM packages").fetchone()[0]
    conn.close()

    check("包总数与 DB 一致",
          data["packages"]["total"] == db_pkgs,
          f"api={data['packages']['total']} db={db_pkgs}")
    check("skill 数一致",
          data["packages"]["by_type"].get("skill", 0) == db_skills,
          f"api={data['packages']['by_type'].get('skill',0)} db={db_skills}")
    check("plugin 数一致",
          data["packages"]["by_type"].get("plugin", 0) == db_plugins,
          f"api={data['packages']['by_type'].get('plugin',0)} db={db_plugins}")
    check("下载总数一致",
          data["packages"]["download_total"] == db_dl,
          f"api={data['packages']['download_total']} db={db_dl}")
    check("反馈总数一致",
          data["feedback"]["total"] == db_fb,
          f"api={data['feedback']['total']} db={db_fb}")
    # 期望值也走环境变量（与服务端 SITE_NAME 对应）；未设则只要求非空。
    expected_site = os.environ.get("VERIFY_SITE_NAME", "")
    got_site = data["site_name"]
    check("site_name 正确反映服务端 SITE_NAME",
          (got_site == expected_site) if expected_site else bool(got_site),
          f"got={got_site!r}" + (f" expect={expected_site!r}" if expected_site else ""))
    check("updates 段结构完整",
          {"windows_versions", "macos_versions", "platforms_in_sync", "store_bytes"} <= set(data["updates"]))

print("\n[5] 包列表分页与搜索")
code, body = req("GET", "/api/admin/packages?page_size=2", token=token)
d = body.get("data", {}) if isinstance(body, dict) else {}
check("分页返回 items/total/pages",
      code == 200 and len(d.get("items", [])) <= 2 and "total" in d and "pages" in d,
      f"HTTP {code} n={len(d.get('items', []))} total={d.get('total')}")

code, body = req("GET", "/api/admin/packages?type=plugin", token=token)
d = body.get("data", {}) if isinstance(body, dict) else {}
check("按 type 过滤生效",
      code == 200 and all(i["type"] == "plugin" for i in d.get("items", [])),
      f"HTTP {code}")

print("\n[6] 反馈备注写入")
conn = sqlite3.connect(DB)
row = conn.execute("SELECT id FROM feedback ORDER BY id LIMIT 1").fetchone()
conn.close()
if row:
    fid = row[0]
    code, body = req("PATCH", f"/api/admin/feedback/{fid}",
                     {"note": "验收测试备注", "status": "in_progress"}, token=token)
    d = body.get("data", {}) if isinstance(body, dict) else {}
    check("PATCH 备注+状态 -> 200",
          code == 200 and d.get("note") == "验收测试备注" and d.get("status") == "in_progress",
          f"HTTP {code}")
    check("updated_at 已写入", bool(d.get("updated_at")), f"got={d.get('updated_at')!r}")
    code, _ = req("PATCH", f"/api/admin/feedback/{fid}", {"note": "x"})
    check("无 token PATCH -> 401", code == 401, f"HTTP {code}")
    # 还原
    req("PATCH", f"/api/admin/feedback/{fid}", {"note": "", "status": "open"}, token=token)
else:
    check("有反馈数据可测（本地库为空则跳过）", True, "skipped")

print("\n[7] 更新版本列表（有 seed 数据时）")
code, body = req("GET", "/api/admin/updates/versions?platform=windows", token=token)
d = body.get("data", {}) if isinstance(body, dict) else {}
vers = d.get("versions", [])
check("windows 版本列表 -> 200", code == 200, f"HTTP {code}")
if vers:
    v0 = vers[0]
    check("版本项含 version/published_at/components/total_size",
          {"version", "published_at", "components", "total_size"} <= set(v0),
          f"keys={sorted(v0)}")
    check("组件体积已统计", v0["total_size"] > 0, f"total_size={v0['total_size']}")
    check("版本按新→旧排序",
          vers == sorted(vers, key=lambda x: tuple(int(p) for p in x["version"].split(".")), reverse=True))
else:
    check("有版本数据可测（空则跳过）", True, "skipped")

code, body = req("GET", "/api/admin/updates/versions?platform=linux", token=token)
check("非法 platform -> 422", code == 422, f"HTTP {code}")

print("\n[8] 删除包（DB 行 + 文件）")
# 自建临时目标，不依赖外部 seed —— 删除不可重复，靠外部数据会导致这个测试
# 只能跑一次，第二次就"跳过"，长期下来等于没测。
_TEMP_SLUG = "verify-temp-pkg"
_TEMP_DIR = pathlib.Path("skills-store") / _TEMP_SLUG
_TEMP_ZIP = pathlib.Path("skills-store") / f"{_TEMP_SLUG}.zip"

conn = sqlite3.connect(DB)
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
conn.execute(
    "INSERT OR REPLACE INTO packages (slug,name,description,author,version,tags,"
    "download_count,skill_count,type,created_at,updated_at) "
    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    (_TEMP_SLUG, "临时验收包", "", "verify", "1.0.0", "[]", 0, 0, "skill", now, now),
)
conn.commit()
conn.close()
_TEMP_DIR.mkdir(parents=True, exist_ok=True)
(_TEMP_DIR / "SKILL.md").write_text("---\nname: temp\n---\n", encoding="utf-8")
_TEMP_ZIP.write_bytes(b"PK\x03\x04temp")

code, body = req("DELETE", f"/api/admin/packages/{_TEMP_SLUG}?purge_files=true", token=token)
d = body.get("data", {}) if isinstance(body, dict) else {}
check("删除包 -> 200", code == 200, f"HTTP {code}")
if code == 200:
    conn = sqlite3.connect(DB)
    gone = conn.execute("SELECT COUNT(*) FROM packages WHERE slug=?", (_TEMP_SLUG,)).fetchone()[0]
    conn.close()
    check("DB 行已删", gone == 0, f"remaining={gone}")
    check("包目录已清", not _TEMP_DIR.exists())
    check("zip 已清", not _TEMP_ZIP.exists())
    check("purged_files 有回执", len(d.get("purged_files", [])) >= 2, f"got={d.get('purged_files')}")

# 默认（不带 purge_files）只删 DB 行，文件保留 —— 这是刻意的两步语义
conn = sqlite3.connect(DB)
conn.execute(
    "INSERT OR REPLACE INTO packages (slug,name,description,author,version,tags,"
    "download_count,skill_count,type,created_at,updated_at) "
    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    (_TEMP_SLUG, "临时验收包", "", "verify", "1.0.0", "[]", 0, 0, "skill", now, now),
)
conn.commit()
conn.close()
code, body = req("DELETE", f"/api/admin/packages/{_TEMP_SLUG}", token=token)
d = body.get("data", {}) if isinstance(body, dict) else {}
check("不带 purge_files 删除 -> 200", code == 200, f"HTTP {code}")
check("返回了孤儿文件提示", bool(d.get("orphan_hint")), f"got={d.get('orphan_hint')!r}")

print("\n[9] 反馈提交限流（用保留测试段 IP，不占真实配额）")
import random as _random
import urllib.parse as _urlparse


def post_feedback_as(ip: str) -> int:
    data = _urlparse.urlencode(
        {"type": "bug", "message": "限流测试（可安全删除）", "app_version": "verify"}
    ).encode()
    r = urllib.request.Request(BASE + "/api/feedback", data=data, method="POST")
    r.add_header("Content-Type", "application/x-www-form-urlencoded")
    r.add_header("X-Forwarded-For", ip)  # 伪造来源 IP，隔离于真实配额
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


# 203.0.113.0/24 是 RFC 5737 保留的文档用网段，不会与真实客户端撞车。
# 用随机 IP 是为了重跑脚本时避开上一轮已消耗的配额。
test_ip = f"203.0.113.{_random.randint(1, 254)}"
codes = [post_feedback_as(test_ip) for _ in range(23)]
first_429 = next((i for i, c in enumerate(codes) if c == 429), None)
check("限流生效（出现 429）", first_429 is not None,
      f"第 {first_429 + 1} 次起被拒" if first_429 is not None else "23 次全部放行")
check("限流前正常放行", all(c == 200 for c in codes[: min(first_429 or 23, 5)]),
      f"前几次={codes[:5]}")

# 清理：限流测试会真往库里写 20 条。留着会把真实反馈挤到第二页，
# 让其它测试（和人工验收）看不到数据。
conn = sqlite3.connect(DB)
cleaned = conn.execute(
    "DELETE FROM feedback WHERE message = ?", ("限流测试（可安全删除）",)
).rowcount
conn.commit()
conn.close()
print(f"  （已清理 {cleaned} 条限流测试数据）")

print("\n[10] 无效输入")
code, _ = req("GET", "/api/admin/feedback?status=bogus", token=token)
check("非法 status 值 -> 422", code == 422, f"HTTP {code}")
code, _ = req("PATCH", "/api/admin/feedback/999999", {"status": "open"}, token=token)
check("不存在的反馈 -> 404", code == 404, f"HTTP {code}")
code, _ = req("DELETE", "/api/admin/packages/__no_such_pkg__", token=token)
check("删除不存在的包 -> 404", code == 404, f"HTTP {code}")

print(f"\n{'='*50}")
print(f"通过 {len(passed)}  失败 {len(failed)}")
if failed:
    print("失败项:")
    for f in failed:
        print("  -", f)
sys.exit(1 if failed else 0)
