"""Concurrency and caching helpers for read-heavy endpoints.

Measured on the deployed stack, the control plane's slow endpoints were all
doing the same thing: N independent AWS calls, one after another.

    /analytics/pipeline   10 SQS GetQueueAttributes + 25 GetItem  = 35 serial
    /mobile/home          one 500-row Query per project           = 18 serial
    /analytics/domains    the same, per project                   = 18+ serial
    /analytics/overview   two full window scans back to back      = up to 8

Each call is only a handful of milliseconds of compute but 5-15ms of round
trip inside the VPC-less Lambda, so the endpoint's latency was a SUM of
latencies rather than a MAX. These helpers turn those sums into maxes.

boto3 is synchronous, so this is a thread pool rather than asyncio. That is
the right tool here: the work is I/O-bound, the GIL is released during socket
waits, and boto3 clients are thread-safe for calls (only resource objects are
not).
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterable, TypeVar

T = TypeVar("T")
R = TypeVar("R")

# Lambda gets ~2 vCPU at 1769MB. The work is network-bound, so oversubscribing
# threads is correct — but not unboundedly, or we trade latency for throttling.
MAX_WORKERS = 12


def gather(tasks: dict[str, Callable[[], Any]], *, workers: int = MAX_WORKERS) -> dict:
    """Run independent thunks concurrently, keyed by name.

        results = gather({
            "queues":   lambda: read_all_queues(),
            "freshness": lambda: read_freshness(),
        })

    An exception is returned in place of its result rather than raised, so one
    slow or broken dependency degrades a panel instead of failing the request.
    Callers check isinstance(value, Exception).
    """
    if not tasks:
        return {}
    if len(tasks) == 1:
        name, fn = next(iter(tasks.items()))
        try:
            return {name: fn()}
        except Exception as exc:  # noqa: BLE001
            return {name: exc}

    def guarded(item):
        name, fn = item
        try:
            return name, fn()
        except Exception as exc:  # noqa: BLE001
            return name, exc

    with ThreadPoolExecutor(max_workers=min(workers, len(tasks))) as pool:
        return dict(pool.map(guarded, tasks.items()))


def pmap(items: Iterable[T], fn: Callable[[T], R], *,
         workers: int = MAX_WORKERS) -> list[R | Exception]:
    """Map fn over items concurrently, preserving order.

    Exceptions are returned in place, for the same reason as gather().
    """
    items = list(items)
    if not items:
        return []
    if len(items) == 1:
        try:
            return [fn(items[0])]
        except Exception as exc:  # noqa: BLE001
            return [exc]

    def guarded(x):
        try:
            return fn(x)
        except Exception as exc:  # noqa: BLE001
            return exc

    with ThreadPoolExecutor(max_workers=min(workers, len(items))) as pool:
        return list(pool.map(guarded, items))


def ok(value: Any, default: Any = None) -> Any:
    """Unwrap a gather/pmap result, substituting a default for an exception."""
    return default if isinstance(value, Exception) else value


# ── short-TTL in-process cache ──────────────────────────────────────────
#
# A live dashboard polls the same aggregate every few seconds. Recomputing a
# 24-hour rollup from scratch each time is wasted work: the answer cannot have
# changed meaningfully in 10 seconds, and the dashboard also receives a
# WebSocket push the moment anything actually does change.
#
# Cached in module scope, so it lives as long as the execution environment and
# is per-container. That is deliberate: a cross-container cache would need
# another network hop and defeat the purpose. The cost is that two containers
# can briefly disagree by up to the TTL, which is acceptable for a dashboard
# number and never used for a pricing decision.

_cache: dict[str, tuple[float, Any]] = {}
_CACHE_MAX = 512


def cached(key: str, ttl: float, producer: Callable[[], Any]) -> Any:
    """Memoise producer() under key for ttl seconds."""
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and now < hit[0]:
        return hit[1]

    value = producer()

    # Crude bound: a warm container serving many tenants must not grow forever.
    if len(_cache) >= _CACHE_MAX:
        for stale in [k for k, (exp, _) in _cache.items() if exp < now][:128]:
            _cache.pop(stale, None)
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()

    _cache[key] = (now + ttl, value)
    return value


def invalidate(prefix: str = "") -> int:
    """Drop cache entries. Called after a write that changes an aggregate."""
    if not prefix:
        n = len(_cache)
        _cache.clear()
        return n
    doomed = [k for k in _cache if k.startswith(prefix)]
    for k in doomed:
        _cache.pop(k, None)
    return len(doomed)
