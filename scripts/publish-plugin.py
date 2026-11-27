#!/usr/bin/env python3
"""Publish a GUI plugin package to the registry server.

Usage:
  python scripts/publish-plugin.py \
      --manifest meta.yaml --zip my-plugin.zip --api-key sk-xxxx \
      [--host http://192.168.186.96:8765] [--force]

## 签名是**硬门控**（2026-11-07）

签名不可跳过：签不出来就不发。原来的 `--no-sign` 已删除。

事故经过：手工发布时漏传 signature，服务端逻辑是

    if signature: 存
    elif sig_path.exists(): unlink()      # ← 无签名覆盖会删掉旧签名

于是市场上的 config-export 从 `signed=true` 变成 `signed=false`，
用户界面上**「安装」按钮消失**，只能走「AI 安装 + 安全审查」。
一次"先传上去看看"的疏忽，直接影响所有用户。

现在本地流程：读私钥 → 签 sha256(zip) → **用 GUI 内嵌公钥验一遍** → 才允许发送。
签错密钥会在本地当场失败，而不是等用户在市场上看到「未受信任」。

## 目标白名单

发布不可逆（覆盖市场同名包、全员可见），所以只允许已知的两端：
96 / 云 / 直连云 IP。打错 host 会被拒绝。

The server endpoint: POST /api/packages (form: manifest YAML, type=plugin, skills=zip file).
Manifest metadata (name/author/version...) is the MARKET display info; the plugin's
real behaviour lives in plugin.json inside the zip (must exist at zip root).

Recommended zip contents (all UTF-8, at package root):
  plugin.json    required — manifest
  README.md      optional — human-facing docs, shown on the market detail page
  AI_NOTES.md    optional — AI-facing troubleshooting doc (failure modes, log
                 locations, diagnostics). Surfaced to AI assistants via the
                 plugin_docs MCP tool — ask your AI for the template, or see
                 the demo-widget package for a live example.

stdlib only (urllib) — no pip install needed.
"""
import argparse
import sys
import uuid
import urllib.request
import urllib.error
import os
import hashlib
import base64

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization
from cryptography.exceptions import InvalidSignature

def _key_module():
    """复用 sign-plugin.py 的私钥解析（含 PLUGIN_SIGNING_KEY 优先级）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_sign_plugin", os.path.join(os.path.dirname(os.path.abspath(__file__)), "sign-plugin.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sign_zip(zip_path: str) -> str:
    """Sign the zip bytes with the publisher's Ed25519 private key.
    Returns base64 signature (64 bytes). Raises if no key.

    ⚠️ 走 sign-plugin.py 的 `load_private_key()`，**不要**自己写死路径：
    原来这里硬编码 `~/.claude/plugin-signing.key`，导致
    `PLUGIN_SIGNING_KEY=/nonexistent` 时它照样悄咪咪用默认私钥签成功 ——
    「指定了 A 却用了 B」这种错最难发现（2026-11-07 实测踩到）。
    """
    seed, where = _key_module().load_private_key()
    if seed is None:
        raise FileNotFoundError(f"签名私钥不可用：{where}")
    key = Ed25519PrivateKey.from_private_bytes(seed)
    with open(zip_path, "rb") as f:
        zip_bytes = f.read()
    digest = hashlib.sha256(zip_bytes).digest()
    sig = key.sign(digest)
    return base64.b64encode(sig).decode()


def verify_zip(zip_path: str, sig_b64: str, pub_b64: str) -> bool:
    """Optional self-check: verify (zip, sig) against a public key b64. """
    try:
        pub_bytes = base64.b64decode(pub_b64)
        pub = Ed25519PublicKey.from_public_bytes(pub_bytes)
        sig = base64.b64decode(sig_b64)
        digest = hashlib.sha256(open(zip_path, "rb").read()).digest()
        pub.verify(sig, digest)
        return True
    except Exception:
        return False


def _self_verify(zip_path: str, sig_b64: str):
    """用 **GUI 内嵌公钥** 验签（与用户机器上同一把钥匙）。

    返回 (ok, note)。拿不到 Rust 源码时退回「私钥派生公钥自比」并说明 ——
    自比只能证明签名格式对，不能证明 key 与 GUI 一致，所以要把话说清楚。
    """
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "_sign_plugin", os.path.join(os.path.dirname(os.path.abspath(__file__)), "sign-plugin.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        digest = hashlib.sha256(open(zip_path, "rb").read()).digest()
        return mod._verify(digest, base64.b64decode(sig_b64))
    except Exception as e:  # noqa: BLE001
        return False, f"无法执行本地验签：{e}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Publish a GUI plugin package")
    ap.add_argument("--manifest", required=True, help="Path to manifest YAML (name/author/version/...)")
    ap.add_argument("--zip", required=True, help="Path to plugin zip (must contain plugin.json at root)")
    ap.add_argument("--api-key", required=True, help="Registry API key (sk-...)")
    ap.add_argument("--host", default="http://192.168.186.96:8765", help="Registry base URL")
    # 🔴 `--no-sign` 已移除（2026-11-07）：签名是不可跳过的发布门控。
    # 服务端规则 `elif sig_path.exists(): unlink()` —— 无签名覆盖会**删掉原有签名**，
    # 市场上的包从 signed=true 变 signed=false，用户直接失去「安装」按钮。
    # 拿不准就**不发**，别为了"先传上去看看"把签名扔掉。
    ap.add_argument("--force", action="store_true", help="Overwrite existing package (re-sign/re-publish).")
    ap.add_argument("--type", default="plugin", choices=["plugin", "skill"],
                    help="Package type (default: plugin). Skill packages use the same endpoint.")
    args = ap.parse_args()

    # ── 目标白名单 ──
    #
    # 发布是**不可逆的共享操作**（覆盖市场里的同名包，所有用户可见）。
    # 打错 host 就会把包推到别的地方，所以只允许已知的两端。
    # 白名单存 `host[:port]`，比较时两端都归一化（https 默认 443 / http 默认 80）
    ALLOWED_HOSTS = {"192.168.186.96:8765", "release.17lumen.cloud", "123.56.66.84:8765"}
    from urllib.parse import urlparse
    _hp = urlparse(args.host)
    _port = _hp.port or (443 if _hp.scheme == "https" else 80)
    _candidates = {f"{_hp.hostname}:{_port}"}
    if _port in (80, 443):          # 默认端口时也接受不带端口的写法
        _candidates.add(_hp.hostname)
    if not (_candidates & ALLOWED_HOSTS):
        print(f"拒绝发布：未知目标 {args.host}")
        print(f"允许的 host：{sorted(ALLOWED_HOSTS)}")
        return 2

    with open(args.manifest, encoding="utf-8") as f:
        manifest_text = f.read()
    with open(args.zip, "rb") as f:
        zip_bytes = f.read()

    # ── 签名是**硬门控**：签不出来就不发 ──
    #
    # 2026-11-07 事故：手工发布时漏了 signature，服务端把原有签名删了，
    # 市场上 config-export 从 signed=true 变 signed=false，
    # 用户失去「安装」按钮。**宁可发不出去，也不要发一个未签名的包。**
    try:
        sig = sign_zip(args.zip)
    except FileNotFoundError as e:
        print(f"ERROR: {e}")
        print("拒绝发布：没有签名私钥。发布不签名 = 用户拿不到「安装」按钮。")
        return 1
    except Exception as e:
        print(f"Signing failed: {e}")
        print("拒绝发布：签名失败。")
        return 1

    # 本地先用**GUI 内嵌公钥**验一遍 —— 签错密钥当场失败，
    # 而不是等用户在市场上看到「未受信任」。
    ok, why = _self_verify(args.zip, sig)
    if not ok:
        print(f"拒绝发布：本地验签失败 → {why}")
        return 1
    print(f"Signed & verified: sha256(zip) → Ed25519 sig "
          f"({len(base64.b64decode(sig))} 字节){'' if why == '' else '  ' + why}")

    # multipart/form-data (stdlib)
    boundary = uuid.uuid4().hex

    def field(name: str, val: str) -> bytes:
        return (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{val}\r\n').encode()

    body = b""
    body += field("manifest", manifest_text)
    body += field("type", args.type)
    # 无条件带上 —— 上面已经是硬门控，走到这里必定有 sig
    body += field("signature", sig)  # server stores as <slug>.sig
    if args.force:
        body += field("force", "true")  # server overwrites existing package
    filename = args.zip.replace("\\", "/").split("/")[-1]
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="skills"; filename="{filename}"\r\n'
             f'Content-Type: application/zip\r\n\r\n').encode()
    body += zip_bytes + b"\r\n"
    body += f'--{boundary}--\r\n'.encode()

    req = urllib.request.Request(f"{args.host.rstrip('/')}/api/packages", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("X-API-Key", args.api_key)
    # 云市场挂在 Cloudflare 后面，它按浏览器指纹拦截 urllib 的默认 UA
    # （实测：默认 UA → 403 error code 1010；换 curl/浏览器形态即通）。
    # 必须显式声明一个非 Python-urllib 的 UA，否则只能发到 96、发不到云。
    req.add_header("User-Agent", "Mozilla/5.0 (compatible; claude-plugin-publisher/1.0)")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            print(f"HTTP {resp.status}")
            print(resp.read().decode(errors="replace")[:1000])
            return 0 if resp.status < 400 else 1
    except urllib.error.HTTPError as e:
        print(f"HTTP ERROR {e.code}")
        print(e.read().decode(errors="replace")[:1000])
        return 1
    except Exception as e:
        print(f"FAIL: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
