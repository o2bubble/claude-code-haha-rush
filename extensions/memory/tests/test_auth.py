"""Unit tests for the bearer-token middleware.

Run from extensions/memory:
    python -m unittest discover -s tests -v

Why these exist: `_needs_auth` decides what is public. A regression here either
locks users out (everything 401) or exposes the whole store (everything 200) —
both silent. The landing-page incident (2026-09-15) was exactly this class of
bug: protect_prefixes mode ignored the `exempt` set, so /api/public-stats was
guarded and the public landing page could never load its counts.
"""

import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MEMDIR = os.path.dirname(_HERE)
if _MEMDIR not in sys.path:
    sys.path.insert(0, _MEMDIR)

from auth import DEFAULT_EXEMPT, BearerAuthMiddleware, _extract_token  # noqa: E402


def _mw(**kw) -> BearerAuthMiddleware:
    return BearerAuthMiddleware(None, token="secret", **kw)


class TestNeedsAuthDefaultMode(unittest.TestCase):
    """MCP server: everything requires a token except the exempt set."""

    def setUp(self):
        self.mw = _mw()

    def test_health_is_public(self):
        self.assertFalse(self.mw._needs_auth("/health"))

    def test_everything_else_is_guarded(self):
        for path in ("/mcp", "/api/stats", "/", "/anything"):
            with self.subTest(path=path):
                self.assertTrue(self.mw._needs_auth(path))


class TestNeedsAuthRestMode(unittest.TestCase):
    """REST app: only /api/* is guarded; the SPA bundle stays public so the
    browser can load the login page before it holds a token."""

    def setUp(self):
        self.mw = _mw(
            exempt=DEFAULT_EXEMPT | {"/api/public-stats"},
            protect_prefixes=("/api/",),
        )

    def test_api_requires_token(self):
        for path in ("/api/stats", "/api/memories", "/api/tags", "/api/export"):
            with self.subTest(path=path):
                self.assertTrue(self.mw._needs_auth(path))

    def test_public_stats_is_exempt(self):
        # The landing page calls this before anyone has logged in.
        self.assertFalse(self.mw._needs_auth("/api/public-stats"))

    def test_static_and_landing_are_public(self):
        for path in ("/", "/index.html", "/landing", "/assets/index-abc.js"):
            with self.subTest(path=path):
                self.assertFalse(self.mw._needs_auth(path))

    def test_exempt_is_exact_not_prefix(self):
        # A path that merely *starts with* an exempt name must not slip through.
        self.assertTrue(self.mw._needs_auth("/api/public-stats-secret"))
        self.assertTrue(self.mw._needs_auth("/api/public-stats/../../memories"))


class TestExtractToken(unittest.TestCase):
    def _scope(self, *headers):
        return {"headers": [(k.lower().encode(), v.encode()) for k, v in headers]}

    def test_bearer_header(self):
        self.assertEqual(
            _extract_token(self._scope(("Authorization", "Bearer abc123"))), "abc123"
        )

    def test_bearer_is_case_insensitive_in_scheme(self):
        self.assertEqual(
            _extract_token(self._scope(("Authorization", "bearer abc123"))), "abc123"
        )

    def test_x_api_key_header(self):
        self.assertEqual(_extract_token(self._scope(("X-API-Key", "abc123"))), "abc123")

    def test_missing_header_yields_empty(self):
        self.assertEqual(_extract_token(self._scope()), "")

    def test_non_bearer_authorization_yields_empty(self):
        # Basic auth must not be mistaken for a bearer token.
        self.assertEqual(_extract_token(self._scope(("Authorization", "Basic xyz"))), "")

    def test_extra_spacing_tolerated(self):
        self.assertEqual(
            _extract_token(self._scope(("Authorization", "Bearer   abc123  "))), "abc123"
        )


if __name__ == "__main__":
    unittest.main()
