"""Response helpers.

One non-negotiable rule lives here: **every response carries
`Cache-Control: no-store`.**

In DevNexus every API is a GET, including the ones that write. A browser, proxy
or CDN that cached one of those would silently replay a mutation — activating a
strategy twice, or serving one tenant's price to another. The GET-only design
only stays safe if caching is disabled globally, so it is enforced in the one
place no route can forget it rather than left to each handler.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from fastapi import status
from fastapi.responses import JSONResponse

NO_STORE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


class _Encoder(json.JSONEncoder):
    def default(self, o: Any) -> Any:
        if isinstance(o, Decimal):
            return int(o) if o == o.to_integral_value() else float(o)
        if isinstance(o, set):
            return sorted(o)
        if hasattr(o, "to_dict"):
            return o.to_dict()
        return super().default(o)


class ApiResponse(JSONResponse):
    """JSON response that can never be cached."""

    def __init__(self, content: Any, status_code: int = 200, headers: dict | None = None):
        super().__init__(content, status_code, {**NO_STORE, **(headers or {})})

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content, cls=_Encoder, separators=(",", ":"), allow_nan=False
        ).encode()


def ok(data: Any = None, **extra: Any) -> ApiResponse:
    body: dict[str, Any] = {"ok": True}
    if isinstance(data, dict):
        body.update(data)
    elif data is not None:
        body["data"] = data
    body.update(extra)
    return ApiResponse(body)


def fail(
    message: str,
    *,
    code: str = "bad_request",
    status_code: int = status.HTTP_400_BAD_REQUEST,
    **extra: Any,
) -> ApiResponse:
    return ApiResponse(
        {"ok": False, "error": {"code": code, "message": message, **extra}},
        status_code=status_code,
    )


class ApiError(Exception):
    """Raised anywhere in a handler; converted to a clean JSON body by the
    exception handler registered in app/main.py."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "bad_request",
        status_code: int = 400,
        **extra: Any,
    ):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.extra = extra


class NotFound(ApiError):
    def __init__(self, what: str = "resource"):
        super().__init__(f"{what} not found", code="not_found", status_code=404)


class Unauthorized(ApiError):
    def __init__(self, message: str = "invalid or expired token"):
        super().__init__(message, code="unauthorized", status_code=401)


class Forbidden(ApiError):
    def __init__(self, message: str = "not permitted for this tenant"):
        super().__init__(message, code="forbidden", status_code=403)


class Conflict(ApiError):
    def __init__(self, message: str):
        super().__init__(message, code="conflict", status_code=409)
