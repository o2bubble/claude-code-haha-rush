"""API key authentication middleware for FastAPI."""

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
