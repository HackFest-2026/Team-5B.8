"""DevNexus control-plane API.

A single FastAPI app behind one Lambda (a "Lambdalith"), adapted by Mangum.
That is deliberate: the control plane has ~45 endpoints that share
configuration, auth and database code, and splitting them into 45 functions
would multiply cold starts and deployment complexity for no benefit.

The hot path is NOT here. `/v1/p/{key}/price` and `/v1/t/{key}/event` run as
separate, dependency-free Lambdas (see runtime/) precisely so they never pay
FastAPI's import cost or share a cold start with analytics.

Every route is a GET and every response carries `Cache-Control: no-store` — see
app/responses.py for why that pairing is load-bearing rather than stylistic.
"""

from __future__ import annotations

import logging
import os
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from app.responses import ApiError, ApiResponse, NO_STORE, ok
from app.routers import (
    ai,
    alerts,
    analytics,
    approvals,
    audit,
    auth,
    backtest,
    data,
    decisions,
    demo,
    devices,
    items,
    live,
    projects,
    rules,
    simulate,
    strategies,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("devnexus")

app = FastAPI(
    title="DevNexus — Universal Dynamic Pricing Platform",
    version="1.0.0",
    description=(
        "Configure, test, deploy and operate real-time pricing strategies for "
        "any business domain through a low-latency API.\n\n"
        "**Every endpoint is a GET.** There are no request bodies anywhere. "
        "Complex objects travel as one URL-encoded JSON query parameter. The "
        "only non-GET traffic in the whole system is the browser uploading a "
        "file straight to S3 using a presigned URL.\n\n"
        "Authentication is an opaque session token passed as `?token=`. There "
        "are no JWTs: sessions live in DynamoDB, which makes them instantly "
        "revocable."
    ),
    docs_url="/docs",
    redoc_url=None,
    openapi_url="/openapi.json",
)

# The SPA is served from a different origin to the API. That separation is also
# what keeps session tokens out of the Referer header on cross-origin requests.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_credentials=False,   # auth travels in the query string, not cookies
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
    max_age=600,
)


@app.middleware("http")
async def observability(request: Request, call_next):
    """Per-request timing, plus a belt-and-braces no-store header.

    `X-Response-Time` is what `/analytics/system` reports as self-measured
    latency, alongside the CloudWatch numbers.
    """
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000

    response.headers["X-Response-Time"] = f"{elapsed_ms:.1f}ms"
    for k, v in NO_STORE.items():
        response.headers[k] = v

    if elapsed_ms > 1000:
        log.warning("slow %s %s %.0fms", request.method, request.url.path, elapsed_ms)
    return response


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError):
    return ApiResponse(
        {"ok": False, "error": {"code": exc.code, "message": exc.message, **exc.extra}},
        status_code=exc.status_code,
    )


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError):
    """Flatten FastAPI's validation errors into the same envelope as everything
    else, so clients parse one error shape rather than two."""
    problems = [
        {
            "parameter": ".".join(str(p) for p in e.get("loc", []) if p != "query"),
            "problem": e.get("msg"),
        }
        for e in exc.errors()
    ]
    return ApiResponse(
        {
            "ok": False,
            "error": {
                "code": "invalid_parameters",
                "message": "one or more query parameters are missing or invalid",
                "problems": problems,
            },
        },
        status_code=422,
    )


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    """Never leak a stack trace to a caller; always leave one in CloudWatch."""
    log.exception("unhandled error on %s", request.url.path)
    return ApiResponse(
        {
            "ok": False,
            "error": {
                "code": "internal_error",
                "message": "something went wrong on our side",
            },
        },
        status_code=500,
    )


# ── routes ──────────────────────────────────────────────────────────────

for router in (
    auth.router,        # 1-4   signup, login, complete-profile, me
    projects.router,    # 5-10  projects, domain schema, guardrails, api keys
    items.router,       # 11-13 pricing items
    data.router,        # 14-16 historical upload + validation
    rules.router,       # 22-25 rules and conflict detection
    strategies.router,  # 26-31 strategy lifecycle
    simulate.router,    # 32-33 what-if and comparison
    backtest.router,    # 34-37 backtesting and shadow mode
    decisions.router,   # 38-40 decision feed, replay, determinism proof
    analytics.router,   # 41-45 dashboard, charts, system health
    live.router,        # live event/decision feeds, pipeline health, explain
    alerts.router,      # 46-48 alert centre
    audit.router,       # 49    audit trail
    approvals.router,   # the human-in-the-loop decision flow + notifications
    devices.router,     # 50-51 FCM registration, mobile home
    ai.router,          # 53-54 natural language -> configuration
    demo.router,        # 55-56 synthetic traffic and chaos injection
):
    app.include_router(router)


@app.get("/", include_in_schema=False)
async def root():
    return ok({
        "service": "DevNexus",
        "description": "Universal Dynamic Pricing Platform",
        "docs": "/docs",
        "convention": "every endpoint is a GET; parameters travel in the URL",
        "start_here": "/auth/signup?email=you@company.com&password=yourpassword",
    })


@app.get("/health", include_in_schema=False)
async def health():
    """Shallow by design: no database round trip.

    This is wired to the API Gateway health check, which must not fail just
    because DynamoDB is briefly slow. Deep dependency status lives in
    /analytics/system, where a slow answer is acceptable.
    """
    return ok({
        "status": "healthy",
        "stage": os.environ.get("STAGE", "dev"),
        "version": app.version,
    })


# ── Lambda entry point ──────────────────────────────────────────────────

try:
    from mangum import Mangum

    handler = Mangum(app, lifespan="off")
except ImportError:  # pragma: no cover - local/dev without the adapter
    handler = None
