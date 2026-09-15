"""API key authentication middleware for FastAPI."""

import base64
import hashlib
import hmac
import json
import os
import time

from fastapi import Request, HTTPException
from . import models


def require_auth(request: Request) -> None:
    """Raise 401 if the request requires auth and the key is invalid/missing."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    api_key = request.headers.get("X-API-Key", "")
    if not api_key:
        raise HTTPException(status_code=401, detail="X-API-Key header required")
    if not models.validate_api_key(api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")


def client_ip(request: Request) -> str:
    """取客户端真实 IP（限流用）。

    云侧走 Cloudflare Tunnel，request.client.host 恒为 127.0.0.1 —— 直接用它会让
    所有请求共享一个计数器，限流形同虚设。优先取隧道透传的真实 IP。
    """
    for header in ("cf-connecting-ip", "x-forwarded-for"):
        value = request.headers.get(header, "")
        if value:
            return value.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ── Admin session ──────────────────────────────────────────────────────────
# 管理后台（/api/admin/*）用「口令换 token」的无状态方案。刻意不引 PyJWT/passlib：
# 只有一个共享口令、无用户表、无密码哈希需求，加依赖只增镜像体积与攻击面。
#
# token 不落库也不落内存 —— 无迁移、无清理、无单进程假设（多 worker 也能用）。

ADMIN_TOKEN_TTL_SECS = 12 * 3600

# 登录失败限速（IP → [失败次数, 窗口起点]）。2 核小机上纯内存计数，不打盘；
# 进程重启即清零 —— 锁定只是提高暴力破解成本，不是持久安全策略。
LOGIN_MAX_FAILURES = 5
LOGIN_LOCK_SECS = 60
_login_failures: dict[str, list] = {}


def _admin_password() -> str:
    return os.environ.get("ADMIN_PASSWORD", "")


def _token_secret() -> bytes:
    """签名密钥：显式 ADMIN_TOKEN_SECRET 优先，否则从口令派生。"""
    explicit = os.environ.get("ADMIN_TOKEN_SECRET", "")
    if explicit:
        return explicit.encode()
    return hashlib.sha256(_admin_password().encode()).digest()


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def issue_token() -> str:
    """签发 token：base64url(payload).base64url(hmac_sha256(payload))。"""
    payload = {"exp": int(time.time()) + ADMIN_TOKEN_TTL_SECS, "nonce": os.urandom(8).hex()}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(_token_secret(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64e(sig)}"


def verify_token(token: str) -> bool:
    """校验签名与有效期；任何解析/签名/过期问题一律 False。"""
    parts = token.split(".", 1)
    if len(parts) != 2:
        return False
    body, sig = parts
    expected = hmac.new(_token_secret(), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(expected, _b64d(sig)):
            return False
        payload = json.loads(_b64d(body))
    except Exception:
        return False
    return int(payload.get("exp", 0)) > int(time.time())


def check_admin_password(password: str) -> bool:
    """常量时间比较。未配置口令时返回 False（由调用方转 503）。"""
    configured = _admin_password()
    if not configured:
        return False
    return hmac.compare_digest(password, configured)


def login_locked(client_ip: str) -> bool:
    entry = _login_failures.get(client_ip)
    if not entry:
        return False
    count, since = entry
    if time.time() - since > LOGIN_LOCK_SECS:
        _login_failures.pop(client_ip, None)
        return False
    return count >= LOGIN_MAX_FAILURES


def record_login_failure(client_ip: str) -> None:
    now = time.time()
    entry = _login_failures.get(client_ip)
    if not entry or now - entry[1] > LOGIN_LOCK_SECS:
        _login_failures[client_ip] = [1, now]
    else:
        entry[0] += 1


def clear_login_failures(client_ip: str) -> None:
    _login_failures.pop(client_ip, None)


def require_admin(request: Request) -> None:
    """⚠️ 与 require_auth 的关键区别：**所有方法（含 GET）都要求 token**。

    require_auth 对 GET/HEAD/OPTIONS 直接放行（见上），那是给公开读端点用的。
    admin 数据（统计/反馈/包列表）同样敏感，照抄那句会让管理接口全部裸奔 ——
    这是本次升级最需要盯死的一点。
    """
    if not _admin_password():
        raise HTTPException(status_code=503, detail="ADMIN_PASSWORD not configured on server")
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Bearer token required")
    if not verify_token(header[7:].strip()):
        raise HTTPException(status_code=401, detail="Invalid or expired token")
