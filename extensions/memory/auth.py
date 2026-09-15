"""Shared bearer-token auth for the memory service (MCP + REST).

Both `server.py` (raw ASGI) and `api.py` (FastAPI) mount the same middleware, so
one token protects every endpoint. Without it the service is wide open: anyone
who can reach the port can read memories, write poisoned ones, or hard-delete
the whole store — the ports are public and there is no other gate.

Token resolution:
  - `MEMORY_AUTH_TOKEN` — the expected bearer token.
  - If it is unset, the service **refuses to start** rather than silently
    serving unauthenticated traffic (fail-closed, matching Login.jsx's stance).
  - `MEMORY_AUTH_DISABLED=1` is the explicit opt-out for local/dev use. It must
    be set deliberately; it never happens by omission.

Accepted header forms (either works):
  - `Authorization: Bearer <token>`
  - `X-API-Key: <token>`   (matches the release-platform convention)
"""

from __future__ import annotations

import os
import secrets
import sys

ENV_TOKEN = "MEMORY_AUTH_TOKEN"
ENV_DISABLED = "MEMORY_AUTH_DISABLED"

# Reachable without a token by default:
#   /health       — the Docker HEALTHCHECK runs against this from inside the
#                   container and it exposes nothing beyond liveness.
# The REST app additionally exempts its static assets (see api.py): the browser
# must be able to load the login page before it can present a token.
DEFAULT_EXEMPT = frozenset({"/health"})

_UNAUTHORIZED_BODY = b'{"error":"unauthorized","message":"Missing or invalid credentials."}'


def resolve_token() -> str | None:
    """Return the configured token, or None when auth is explicitly disabled.

    Raises SystemExit when the token is missing and auth was not explicitly
    turned off — starting an open memory server on a public port is worse than
    failing to start.
    """
    token = (os.environ.get(ENV_TOKEN) or "").strip()
    if token:
        return token
    if os.environ.get(ENV_DISABLED) == "1":
        print(
            f"[memory-auth] WARNING: {ENV_DISABLED}=1 — authentication is OFF, "
            "every endpoint is public. Never use this on a reachable host.",
            file=sys.stderr,
        )
        return None
    print(
        f"[memory-auth] FATAL: {ENV_TOKEN} is not set. Refusing to start an "
        f"unauthenticated server. Set {ENV_TOKEN}, or set {ENV_DISABLED}=1 to "
        "explicitly run without auth (local development only).",
        file=sys.stderr,
    )
    raise SystemExit(2)


def _extract_token(scope) -> str:
    """Pull the token from the request headers, or '' when absent."""
    for name, value in scope.get("headers") or []:
        lname = name.lower()
        if lname == b"authorization":
            raw = value.decode("latin-1").strip()
            # Case-insensitive scheme match; tolerate "Bearer  <t>" spacing.
            if raw[:7].lower() == "bearer ":
                return raw[7:].strip()
            return ""
        if lname == b"x-api-key":
            return value.decode("latin-1").strip()
    return ""


class BearerAuthMiddleware:
    """ASGI middleware enforcing a bearer token on every protected request.

    Two modes, chosen by whether `protect_prefixes` is given:

      - default (no `protect_prefixes`): everything requires a token except the
        `exempt` paths / `exempt_prefixes` prefixes. Used by the MCP endpoint,
        which serves nothing but /mcp.
      - only-prefixes: ONLY paths under `protect_prefixes` require a token;
        everything else is public. Used by the REST app, which must serve the
        SPA bundle (so the browser can load the login page) while guarding
        /api/*.
    """

    def __init__(self, app, token: str, *, exempt=DEFAULT_EXEMPT, exempt_prefixes=(),
                 protect_prefixes=None):
        self.app = app
        self.token = token
        self.exempt = frozenset(exempt)
        self.exempt_prefixes = tuple(exempt_prefixes)
        self.protect_prefixes = tuple(protect_prefixes) if protect_prefixes else None

    def _needs_auth(self, path: str) -> bool:
        # `exempt` (exact paths) applies in BOTH modes — it is the explicit
        # "this single endpoint is public" escape hatch. Without this,
        # protect_prefixes mode ignores exempt entirely and every /api/* path
        # forces a token, which is exactly what broke the public landing page
        # (it fetches aggregate counts before the user has any token).
        if path in self.exempt:
            return False
        if self.protect_prefixes is not None:
            return path.startswith(self.protect_prefixes)
        return not path.startswith(self.exempt_prefixes)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not self._needs_auth(scope.get("path", "")):
            await self.app(scope, receive, send)
            return

        presented = _extract_token(scope)
        # compare_digest keeps the check constant-time so the token can't be
        # guessed one character at a time.
        if not presented or not secrets.compare_digest(presented, self.token):
            await send({
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"www-authenticate", b"Bearer"),
                    (b"content-length", str(len(_UNAUTHORIZED_BODY)).encode()),
                ],
            })
            await send({"type": "http.response.body", "body": _UNAUTHORIZED_BODY})
            return

        await self.app(scope, receive, send)
