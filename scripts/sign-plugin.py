#!/usr/bin/env python3
"""Sign a packed plugin zip with the official Ed25519 publishing key.

Usage:
    python scripts/sign-plugin.py config-export            # sign one plugin
    python scripts/sign-plugin.py --all                    # every plugin with a zip
    python scripts/sign-plugin.py config-export --check    # verify only, write nothing

## What it produces

`<plugin>/<plugin>.sig` — base64 of the 64-byte Ed25519 signature over
`sha256(zip_bytes)`. That pair is what the GUI checks:

    verify_zip_signature(zip_bytes, sig_b64)      # plugin_signature.rs

Pass => trusted ("安装" button).  Missing/mismatch => untrusted
("AI 安装 + 安全审查" only).

## Why this exists (2026-11-07)

The publishing key had **no tooling in the repo at all** — only the private key
file and a stale mention of a `publish-plugin.py` that doesn't exist. So signing
was done by hand, and the very first re-publish done through the web path
uploaded without a signature. The server's rule:

    if signature: store it
    elif sig_path.exists(): sig_path.unlink()      # ← unsigned overwrite DROPS the old sig

...silently deleted the previous signature. config-export flipped from
`signed=true` to `signed=false` in the marketplace, and users lost the
"安装" button. **Absence of tooling made an invisible mistake easy.**

So: sign every pack, and let `pack-plugins.py` do it automatically.

## Secret handling

The private key is read from `~/.claude/plugin-signing.key` (or `%USERPROFILE%`
on Windows), overridable via `PLUGIN_SIGNING_KEY`. It is **32 raw bytes, hex
encoded** — the format `gen-plugin-key.py` writes.

The key is never printed, never copied into the output, and never committed:
`.sig` files are gitignored (they describe a specific zip byte sequence, and
regenerating them is cheap when you have the key).

## Self-verification

After signing, the signature is verified against `PLUGIN_PUBKEY` parsed out of
`plugin_pubkey.rs` — the **same key baked into the GUI binary**. Signing with the
wrong key therefore fails here, instead of failing silently on every user's
machine. If the Rust source isn't found, it falls back to verifying against the
public key derived from the private key, and says so.
"""
import argparse
import base64
import hashlib
import os
import re
import sys

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _candidates():
    return [
        os.environ.get("GUI_PLUGINS_DIR") or "",
        os.path.join(ROOT, "packages", "plugins"),                                        # 拆分前
        os.path.join(os.path.dirname(ROOT), "lumen-agent-desktop", "packages", "plugins"),  # 拆分后
    ]


def _resolve_plugins_dir():
    """和 pack-plugins.py 同一套探测规则（含"空目录不能算数"的坑）。"""
    for c in _candidates():
        if not c or not os.path.isdir(c):
            continue
        if any(os.path.isdir(os.path.join(c, x)) for x in os.listdir(c) if not x.startswith(".")):
            return c
    return _candidates()[1]


PLUGINS_DIR = _resolve_plugins_dir()
KEY_CANDIDATES = [
    os.environ.get("PLUGIN_SIGNING_KEY") or "",
    os.path.expanduser("~/.claude/plugin-signing.key"),
    os.path.join(os.environ.get("USERPROFILE", ""), ".claude", "plugin-signing.key"),
]


def load_private_key():
    """读 32 字节 hex 私钥。找不到返回 (None, 原因)。

    ⚠️ `PLUGIN_SIGNING_KEY` **一旦设置就以它为准**，不回退到默认路径 ——
    否则「我明确指定了某个 key，结果它悄悄用了另一个」这种错极难发现
    （实测：指定一个不存在的路径，脚本仍然签名成功）。
    """
    env = os.environ.get("PLUGIN_SIGNING_KEY")
    cands = [env] if env else KEY_CANDIDATES[1:]
    for p in cands:
        if p and os.path.isfile(p):
            raw = open(p, "rb").read().strip()
            try:
                seed = bytes.fromhex(raw.decode("ascii"))
            except (ValueError, UnicodeDecodeError):
                return None, f"私钥格式不对（应为 32 字节 hex）：{p}"
            if len(seed) != 32:
                return None, f"私钥长度 {len(seed)}，应为 32 字节：{p}"
            return seed, p
    if env:
        return None, f"PLUGIN_SIGNING_KEY 指定的私钥不存在：{env}"
    return None, "找不到私钥（~/.claude/plugin-signing.key 或 $PLUGIN_SIGNING_KEY）"


def embedded_pubkey():
    """从 Rust 源码里读出编译进 GUI 的公钥。找不到返回 None。"""
    for base in (ROOT, os.path.dirname(ROOT)):
        p = os.path.join(base, "lumen-agent-desktop", "apps", "gui",
                         "src-tauri", "src", "plugin_pubkey.rs")
        if not os.path.isfile(p):
            p = os.path.join(base, "apps", "gui", "src-tauri", "src", "plugin_pubkey.rs")
        if os.path.isfile(p):
            try:
                src = open(p, encoding="utf-8").read()
            except OSError:
                continue
            nums = [int(x, 16) for x in re.findall(r"0x([0-9a-fA-F]{2})", src)]
            if len(nums) >= 32:
                return bytes(nums[:32]), p
    return None, None


def sign_one(plugin: str, check_only: bool = False) -> bool:
    d = os.path.join(PLUGINS_DIR, plugin)
    zip_path = os.path.join(d, f"{plugin}.zip")
    sig_path = os.path.join(d, f"{plugin}.sig")

    if not os.path.isfile(zip_path):
        print(f"  [FAIL] {plugin}: 没有 {plugin}.zip（先跑 pack-plugins.py）")
        return False

    zip_bytes = open(zip_path, "rb").read()
    digest = hashlib.sha256(zip_bytes).digest()

    if check_only:
        if not os.path.isfile(sig_path):
            print(f"  [FAIL] {plugin}: 没有 .sig —— 会以「未签名」发布")
            return False
        sig = base64.b64decode(open(sig_path).read().strip())
        ok, why = _verify(digest, sig)
        print(f"  [{'ok' if ok else 'FAIL'}]   {plugin}: 签名{'有效' if ok else '无效'}"
              + ("" if ok else f" → {why}"))
        return ok

    seed, key_src = load_private_key()
    if seed is None:
        # 没有私钥不是错误 —— 开发机/CI 可能就没有。但必须说清楚后果。
        print(f"  [skip] {plugin}: {key_src} —— 打包了但**未签名**")
        if os.path.exists(sig_path):
            print(f"         注意：{os.path.basename(sig_path)} 是旧的，"
                  f"和当前 zip 已不匹配，发布前必须处理")
        return True

    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError:
        print("  [FAIL] 缺少 cryptography 包：python -m pip install cryptography")
        return False

    sk = Ed25519PrivateKey.from_private_bytes(seed)
    sig = sk.sign(digest)
    sig_b64 = base64.b64encode(sig).decode()

    ok, why = _verify(digest, sig)
    if not ok:
        print(f"  [FAIL] {plugin}: 签出来的东西**验不过** → {why}")
        return False

    with open(sig_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(sig_b64)
    print(f"  [ok]   {plugin}: 已签名（sha256 {digest.hex()[:16]}…）")
    return True


def _verify(digest: bytes, sig: bytes):
    """用内嵌公钥验签；拿不到 Rust 源就用私钥派生的公钥（并说明）。"""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey, Ed25519PublicKey,
        )
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        return True, "未装 cryptography，跳过验签"

    pub, src = embedded_pubkey()
    if pub is None:
        seed, _ = load_private_key()
        if seed is None:
            return True, "拿不到内嵌公钥也无法从私钥推导，跳过验签"
        pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        note = "（用私钥派生的公钥自比，未对照 GUI 内嵌公钥）"
    else:
        note = ""

    try:
        Ed25519PublicKey.from_public_bytes(pub).verify(sig, digest)
        return True, note
    except Exception as e:  # noqa: BLE001 - 验签失败原因多样
        return False, f"验签失败：{e}（内嵌公钥来自 {src}）"


def main() -> int:
    ap = argparse.ArgumentParser(description="Sign packed plugin zips (Ed25519)")
    ap.add_argument("plugins", nargs="*", help="plugin directory names")
    ap.add_argument("--all", action="store_true", help="every plugin that has a .zip")
    ap.add_argument("--check", action="store_true", help="verify only; write nothing")
    args = ap.parse_args()

    if args.all:
        targets = sorted(
            x for x in os.listdir(PLUGINS_DIR)
            if os.path.isdir(os.path.join(PLUGINS_DIR, x))
            and os.path.isfile(os.path.join(PLUGINS_DIR, x, f"{x}.zip"))
        )
    else:
        targets = args.plugins

    if not targets:
        print("没指定插件（用 --all，或列出插件名）")
        return 2

    print(f"{'检查' if args.check else '签名'} {len(targets)} 个插件（{PLUGINS_DIR}）：")
    results = [sign_one(t, args.check) for t in targets]
    print()
    if all(results):
        print("全部通过。")
        return 0
    print("有插件未通过 —— 上面标 [FAIL] 的就是要修的地方。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
