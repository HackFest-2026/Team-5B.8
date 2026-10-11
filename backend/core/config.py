"""DevNexus runtime configuration.

Everything is env-driven (CloudFormation injects it) with a single exception:
secrets live in SSM Parameter Store and are fetched once per Lambda cold start,
then cached in module scope for the life of the execution environment.

Why module-scope caching matters: a warm Lambda reuses this process for minutes
to hours. Fetching SSM per request would add ~20-40ms to every call and burn
Parameter Store throughput for data that never changes mid-invocation.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from functools import lru_cache

import boto3

REGION = os.environ.get("AWS_REGION", "ap-south-1")
STAGE = os.environ.get("STAGE", "dev")


@dataclass(frozen=True)
class Settings:
    # ── DynamoDB ────────────────────────────────────────────────────────
    table_core: str = os.environ.get("TABLE_CORE", f"devnexus-core-{STAGE}")
    table_context: str = os.environ.get("TABLE_CONTEXT", f"devnexus-context-{STAGE}")
    table_decisions: str = os.environ.get("TABLE_DECISIONS", f"devnexus-decisions-{STAGE}")

    # ── S3 ──────────────────────────────────────────────────────────────
    bucket_data: str = os.environ.get("BUCKET_DATA", f"devnexus-data-{STAGE}")
    presign_ttl_seconds: int = int(os.environ.get("PRESIGN_TTL", "900"))

    # ── SQS ─────────────────────────────────────────────────────────────
    queue_events: str = os.environ.get("QUEUE_EVENTS", "")
    queue_data: str = os.environ.get("QUEUE_DATA", "")
    queue_decisions: str = os.environ.get("QUEUE_DECISIONS", "")
    queue_alerts: str = os.environ.get("QUEUE_ALERTS", "")
    queue_backtest: str = os.environ.get("QUEUE_BACKTEST", "")

    # ── Realtime ────────────────────────────────────────────────────────
    ws_endpoint: str = os.environ.get("WS_ENDPOINT", "")

    # ── Sessions ────────────────────────────────────────────────────────
    session_ttl_seconds: int = int(os.environ.get("SESSION_TTL", str(24 * 3600)))

    # ── Pricing engine ──────────────────────────────────────────────────
    # How long a warm Lambda may reuse a compiled strategy before re-reading it.
    strategy_cache_seconds: int = int(os.environ.get("STRATEGY_CACHE_TTL", "30"))
    # Context older than this is considered stale -> signals get down-weighted.
    context_stale_seconds: int = int(os.environ.get("CONTEXT_STALE_SECONDS", "21600"))

    # ── Gemini ──────────────────────────────────────────────────────────
    gemini_keys_param: str = os.environ.get(
        "GEMINI_KEYS_PARAM", f"/devnexus/{STAGE}/gemini/keys"
    )
    gemini_models_param: str = os.environ.get(
        "GEMINI_MODELS_PARAM", f"/devnexus/{STAGE}/gemini/models"
    )
    gemini_timeout_seconds: float = float(os.environ.get("GEMINI_TIMEOUT", "12"))
    # Hedging: fire N parallel attempts on different keys, take the first win.
    # Cuts p99 hard when a single key/model is slow. Costs N x tokens, so we
    # only hedge the user-visible paths.
    gemini_hedge: int = int(os.environ.get("GEMINI_HEDGE", "2"))

    # ── FCM ─────────────────────────────────────────────────────────────
    fcm_sa_param: str = os.environ.get(
        "FCM_SA_PARAM", f"/devnexus/{STAGE}/fcm/service-account"
    )
    fcm_project_id: str = os.environ.get("FCM_PROJECT_ID", "")

    stage: str = STAGE
    region: str = REGION


@lru_cache(maxsize=1)
def settings() -> Settings:
    return Settings()


# ── SSM access ──────────────────────────────────────────────────────────

_ssm = None


def _ssm_client():
    global _ssm
    if _ssm is None:
        _ssm = boto3.client("ssm", region_name=REGION)
    return _ssm


@lru_cache(maxsize=32)
def ssm_param(name: str, *, decrypt: bool = True) -> str:
    """Fetch an SSM parameter. Cached for the life of the execution env."""
    resp = _ssm_client().get_parameter(Name=name, WithDecryption=decrypt)
    return resp["Parameter"]["Value"]


def gemini_keys() -> list[str]:
    """The Gemini key pool, newline- or comma-separated in SSM (SecureString).

    An env override exists for local/CI smoke runs only; production always
    reads SSM so keys never appear in a CloudFormation template or the Lambda
    console's environment-variable panel.
    """
    raw = os.environ.get("GEMINI_KEYS")
    if not raw:
        raw = ssm_param(settings().gemini_keys_param)
    parts = [p.strip() for p in raw.replace(",", "\n").split("\n")]
    # Strip paste artifacts (trailing dots) that silently invalidate AQ. keys.
    return [p.rstrip(".").strip() for p in parts if p and not p.startswith("#")]


def gemini_model_chain() -> list[str]:
    """Ordered model fallback chain.

    Lives in SSM, not code, because Gemini model availability is volatile:
    models get retired for new accounts (404) and saturate under load (503).
    When that happens we re-point this parameter instead of redeploying.
    """
    raw = os.environ.get("GEMINI_MODELS")
    if not raw:
        try:
            raw = ssm_param(settings().gemini_models_param, decrypt=False)
        except Exception:
            raw = ""
    if not raw:
        raw = "gemini-3.6-flash,gemini-3.5-flash,gemini-flash-latest,gemini-2.5-flash"
    return [m.strip() for m in raw.split(",") if m.strip()]


def fcm_service_account() -> dict:
    """Firebase service-account JSON from SSM (SecureString)."""
    return json.loads(ssm_param(settings().fcm_sa_param))
