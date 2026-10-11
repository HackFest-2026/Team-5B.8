"""Gemini client tuned for latency.

Four things make this fast enough that the UI feels instant:

1. thinkingBudget=0      — these are extraction tasks, not reasoning tasks.
                           Thinking tokens would double or triple latency for
                           no accuracy gain on "parse this sentence into JSON".
2. hedged requests       — fire N attempts on DIFFERENT keys in parallel and
                           take the first to answer. Gemini latency has a long
                           tail (measured 0.9s -> 1.5s spread on identical
                           prompts), so hedging collapses p99 toward p50.
3. responseSchema        — server-side structured output. No markdown fences to
                           strip, no "sure, here's your JSON" preamble, no
                           repair parse. Either valid JSON or an error.
4. keep-alive pooling    — one module-scope AsyncClient. TLS handshakes to
                           generativelanguage.googleapis.com cost ~100-200ms,
                           and a warm Lambda should pay that once, not per call.

Everything here is still too slow to sit in a user-visible request path. See
core/ai/__init__.py: AI runs on the WRITE path (when an alert fires), never on
the READ path (when the analyst opens a screen).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

from core.ai.key_pool import ExhaustedError, pool
from core.config import settings

log = logging.getLogger("devnexus.gemini")

BASE = "https://generativelanguage.googleapis.com/v1beta"
MAX_ROUNDS = 12  # distinct (key, model) pairs to try before giving up — with
                 # 23 keys and several models, 4 was far too few to survive a
                 # 429 burst on the top model; 12 gives real key+model failover

_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings().gemini_timeout_seconds, connect=3.0),
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=40),
            http2=False,  # h2 adds negotiation cost; we issue one request at a time per conn
        )
    return _client


async def aclose() -> None:
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
    _client = None


@dataclass
class GenResult:
    data: Any                 # parsed JSON (dict/list) when a schema was given
    text: str                 # raw text
    model: str
    key_masked: str
    latency_ms: int
    attempts: int
    hedged: bool


class GeminiError(RuntimeError):
    def __init__(self, message: str, *, status: int | str | None = None):
        super().__init__(message)
        self.status = status


def _mask(k: str) -> str:
    return f"{k[:12]}…{k[-6:]}"


def _body(
    *,
    system: str,
    user: str,
    schema: dict | None,
    max_tokens: int,
    temperature: float,
) -> dict:
    gen: dict[str, Any] = {
        "temperature": temperature,
        "maxOutputTokens": max_tokens,
        "thinkingConfig": {"thinkingBudget": 0},
        "candidateCount": 1,
    }
    if schema is not None:
        gen["responseMimeType"] = "application/json"
        gen["responseSchema"] = schema
    return {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": gen,
        # Pricing text is benign; the default thresholds occasionally trip on
        # words like "kill" in "kill the strategy". Relax, don't disable.
        "safetySettings": [
            {"category": c, "threshold": "BLOCK_ONLY_HIGH"}
            for c in (
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
            )
        ],
    }


async def _attempt(key: str, model: str, payload: dict) -> GenResult:
    """One (key, model) call. Raises GeminiError carrying the HTTP status."""
    t0 = time.perf_counter()
    try:
        resp = await _http().post(
            f"{BASE}/models/{model}:generateContent",
            headers={"x-goog-api-key": key, "content-type": "application/json"},
            json=payload,
        )
    except (httpx.TimeoutException, httpx.ConnectError) as exc:
        pool().record_failure(key, model, "TIMEOUT", str(exc))
        raise GeminiError(f"transport: {exc}", status="TIMEOUT") from exc

    ms = int((time.perf_counter() - t0) * 1000)

    if resp.status_code != 200:
        try:
            msg = resp.json().get("error", {}).get("message", "")
        except Exception:
            msg = resp.text[:200]
        pool().record_failure(key, model, resp.status_code, msg)
        raise GeminiError(f"{model} [{resp.status_code}] {msg[:160]}", status=resp.status_code)

    body = resp.json()
    cands = body.get("candidates") or []
    if not cands:
        reason = (body.get("promptFeedback") or {}).get("blockReason", "no candidates")
        pool().record_failure(key, model, 400, str(reason))
        raise GeminiError(f"{model}: {reason}", status=400)

    cand = cands[0]
    finish = cand.get("finishReason")
    text = "".join(
        p.get("text", "") for p in (cand.get("content", {}).get("parts") or [])
    ).strip()

    if finish == "MAX_TOKENS" and not text:
        pool().record_failure(key, model, 400, "truncated with no output")
        raise GeminiError(f"{model}: truncated before producing output", status=400)

    pool().record_success(key, model, ms)
    return GenResult(
        data=None, text=text, model=model, key_masked=_mask(key),
        latency_ms=ms, attempts=1, hedged=False,
    )


async def generate(
    *,
    system: str,
    user: str,
    schema: dict | None = None,
    max_tokens: int = 2048,
    temperature: float = 0.0,
    hedge: int | None = None,
) -> GenResult:
    """Generate once, with hedging and (key, model) failover.

    `hedge=1` disables hedging (one attempt at a time). Default comes from the
    GEMINI_HEDGE setting. Hedging multiplies token cost by the hedge factor, so
    use it for interactive paths and leave it at 1 for bulk/background work.
    """
    payload = _body(
        system=system, user=user, schema=schema,
        max_tokens=max_tokens, temperature=temperature,
    )
    n = settings().gemini_hedge if hedge is None else max(1, hedge)
    p = pool()
    attempts = 0
    errors: list[str] = []

    for _round in range(MAX_ROUNDS):
        try:
            leases = p.lease_many(n)
        except ExhaustedError as exc:
            if attempts:
                break
            raise GeminiError(f"key pool exhausted: {exc}", status="EXHAUSTED") from exc

        attempts += len(leases)
        tasks = [asyncio.create_task(_attempt(k, m, payload)) for k, m in leases]

        winner: GenResult | None = None
        try:
            # Resolve as results arrive; first success wins, losers get cancelled.
            for fut in asyncio.as_completed(tasks):
                try:
                    winner = await fut
                    break
                except GeminiError as exc:
                    errors.append(str(exc))
                except Exception as exc:  # noqa: BLE001 - never let one attempt kill the batch
                    errors.append(repr(exc))
        finally:
            for t in tasks:
                if not t.done():
                    t.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

        if winner is None:
            continue

        winner.attempts = attempts
        winner.hedged = len(leases) > 1
        if schema is not None:
            try:
                winner.data = json.loads(winner.text)
            except json.JSONDecodeError as exc:
                # responseSchema makes this rare; treat as a soft failure and
                # let the next round try a different (key, model).
                errors.append(f"invalid JSON from {winner.model}: {exc}")
                log.warning("gemini returned non-JSON despite schema: %s", winner.text[:200])
                continue
        return winner

    raise GeminiError(
        f"all {attempts} attempt(s) failed: " + " | ".join(errors[-6:]),
        status="FAILED",
    )


def generate_sync(**kwargs) -> GenResult:
    """Blocking wrapper for SQS workers, which have no running event loop."""
    return asyncio.run(generate(**kwargs))


def health() -> dict:
    return pool().health()
