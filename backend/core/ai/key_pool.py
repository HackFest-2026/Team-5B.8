"""Gemini key pool with per-key health tracking.

Design is driven by measured behaviour of the AQ.* Auth keys, not guesswork.
We probed 23 keys and found FOUR distinct failure modes that demand FOUR
different reactions. Most clients collapse these into one retry loop and end up
either burning the whole pool on a model-side outage or giving up on keys that
were only briefly throttled.

    503  model overloaded          -> rotate MODEL, keep the key
    429  key rate-limited          -> cool down the KEY, keep the model
    403  project denied access     -> key is DEAD, never retry it
    404  model retired for account -> this (key, model) pair is dead forever
    400  malformed request         -> our bug; do not blame the key

Observed in the real pool:
  * all 23 keys authenticate (62 models visible on each)
  * 2 keys return a hard 403 on every model -> 21 usable
  * gemini-3.6-flash / 3.8-flash were globally 503 at probe time
  * gemini-2.5-flash answered on a subset in ~1.0-1.5s

State is per execution environment (module scope). A cold start re-learns it in
a few calls, which is cheaper and simpler than a shared health table, and a
warm container converges immediately.
"""

from __future__ import annotations

import itertools
import threading
import time
from dataclasses import dataclass, field

from core.config import gemini_keys, gemini_model_chain

# Cooldowns, in seconds.
KEY_COOLDOWN_429 = 45.0    # free-tier RPM windows are ~60s; 45s is a safe probe
KEY_COOLDOWN_5XX = 5.0     # transient; the model is the likely culprit, not us
MODEL_COOLDOWN_503 = 20.0  # saturation clears in tens of seconds
MODEL_SOFT_429 = 3.0       # a brief nudge so a 429 rotates to another model
MAX_CONSECUTIVE_FAILS = 6  # after this, quarantine the key for a longer spell
KEY_QUARANTINE = 300.0


def _mask(key: str) -> str:
    return f"{key[:12]}…{key[-6:]}" if len(key) > 20 else "…"


@dataclass
class KeyState:
    key: str
    cooldown_until: float = 0.0
    dead: bool = False               # 403/401 -> permanent
    dead_reason: str = ""
    consecutive_fails: int = 0
    dead_models: set[str] = field(default_factory=set)  # 404 per (key, model)
    # Short-lived per-model cooldowns, so a 429 on one model for this key does
    # NOT take the key out for every other model — free-tier quota is per model.
    model_cooldown: dict = field(default_factory=dict)
    successes: int = 0
    failures: int = 0
    total_latency_ms: float = 0.0

    @property
    def available(self) -> bool:
        return not self.dead and time.monotonic() >= self.cooldown_until

    def supports(self, model: str) -> bool:
        if model in self.dead_models:
            return False
        return time.monotonic() >= self.model_cooldown.get(model, 0.0)

    @property
    def avg_latency_ms(self) -> float:
        return self.total_latency_ms / self.successes if self.successes else 0.0


@dataclass
class ModelState:
    model: str
    cooldown_until: float = 0.0
    successes: int = 0
    failures: int = 0

    @property
    def available(self) -> bool:
        return time.monotonic() >= self.cooldown_until


class ExhaustedError(RuntimeError):
    """Every (key, model) combination is unavailable right now."""


class KeyPool:
    def __init__(self, keys: list[str] | None = None, models: list[str] | None = None):
        keys = keys or gemini_keys()
        if not keys:
            raise RuntimeError("Gemini key pool is empty — check SSM parameter")
        self._keys: dict[str, KeyState] = {k: KeyState(k) for k in keys}
        self._models: dict[str, ModelState] = {
            m: ModelState(m) for m in (models or gemini_model_chain())
        }
        self._lock = threading.Lock()
        # Round-robin rather than random: spreads load evenly across accounts so
        # no single project burns its RPM budget while others sit idle.
        self._cursor = itertools.cycle(list(self._keys))
        self._n = len(self._keys)

    # ── selection ───────────────────────────────────────────────────────

    def lease(self, *, exclude: set[str] | None = None) -> tuple[str, str]:
        """Pick an available (key, model) pair.

        Models are tried in configured preference order; the first model with at
        least one healthy key wins. `exclude` lets a hedged batch avoid handing
        the same key to two parallel attempts.
        """
        exclude = exclude or set()
        with self._lock:
            for model in self._preferred_models():
                # One full rotation of the cursor, so we stay round-robin
                # instead of restarting at key 0 for every call.
                for _ in range(self._n):
                    key = next(self._cursor)
                    if key in exclude:
                        continue
                    st = self._keys[key]
                    if st.available and st.supports(model):
                        return key, model
            raise ExhaustedError(self._diagnose())

    def lease_many(self, n: int) -> list[tuple[str, str]]:
        """Distinct (key, model) pairs for hedged parallel attempts."""
        out: list[tuple[str, str]] = []
        used: set[str] = set()
        for _ in range(n):
            try:
                key, model = self.lease(exclude=used)
            except ExhaustedError:
                break
            used.add(key)
            out.append((key, model))
        if not out:
            raise ExhaustedError(self._diagnose())
        return out

    def _preferred_models(self) -> list[str]:
        avail = [m for m, s in self._models.items() if s.available]
        # If every model is cooling down, ignore cooldowns rather than fail the
        # request outright — a stale 503 marker must not cause a hard outage.
        return avail or list(self._models)

    # ── feedback ────────────────────────────────────────────────────────

    def record_success(self, key: str, model: str, latency_ms: float) -> None:
        with self._lock:
            k = self._keys[key]
            k.consecutive_fails = 0
            k.cooldown_until = 0.0
            k.model_cooldown.pop(model, None)
            k.successes += 1
            k.total_latency_ms += latency_ms
            m = self._models.get(model)
            if m:
                m.successes += 1
                m.cooldown_until = 0.0

    def record_failure(self, key: str, model: str, status: int | str, message: str = "") -> None:
        """Apply the right penalty for the right failure. See module docstring."""
        now = time.monotonic()
        with self._lock:
            k = self._keys[key]
            k.failures += 1
            k.consecutive_fails += 1
            m = self._models.get(model)
            if m:
                m.failures += 1

            if status in (401, 403):
                k.dead = True
                k.dead_reason = f"{status}: {message[:80]}"

            elif status == 404:
                # Model retired for this account. The key is fine.
                k.dead_models.add(model)
                k.consecutive_fails = 0

            elif status == 429:
                # Per-(key, model) quota, not a dead key. Cool THIS model for
                # THIS key, and briefly nudge the model so the very next lease
                # prefers a different one. Both recover on their own, and the key
                # stays usable for every other model right away — which is what
                # lets 23 keys x several models actually fail over instead of
                # burning four keys on one rate-limited model.
                k.model_cooldown[model] = now + KEY_COOLDOWN_429
                if m:
                    m.cooldown_until = now + MODEL_SOFT_429
                k.consecutive_fails = max(0, k.consecutive_fails - 1)

            elif status == 503 or status == 500 or status == "TIMEOUT":
                # Model-side problem: penalise the MODEL, barely touch the key.
                if m:
                    m.cooldown_until = now + MODEL_COOLDOWN_503
                k.cooldown_until = now + KEY_COOLDOWN_5XX
                k.consecutive_fails = max(0, k.consecutive_fails - 1)

            elif status == 400:
                # Our payload is wrong. Penalising the key would mask the bug.
                k.consecutive_fails = max(0, k.consecutive_fails - 1)

            if k.consecutive_fails >= MAX_CONSECUTIVE_FAILS and not k.dead:
                k.cooldown_until = now + KEY_QUARANTINE
                k.consecutive_fails = 0

    # ── introspection (powers GET /ai/health) ───────────────────────────

    def _diagnose(self) -> str:
        dead = sum(1 for s in self._keys.values() if s.dead)
        cooling = sum(1 for s in self._keys.values() if not s.dead and not s.available)
        return (
            f"no (key, model) available: {len(self._keys)} keys "
            f"({dead} dead, {cooling} cooling), "
            f"models={[m for m, s in self._models.items() if s.available]}"
        )

    def health(self) -> dict:
        now = time.monotonic()
        with self._lock:
            return {
                "keys": {
                    "total": len(self._keys),
                    "usable": sum(1 for s in self._keys.values() if s.available),
                    "dead": sum(1 for s in self._keys.values() if s.dead),
                    "cooling": sum(
                        1 for s in self._keys.values() if not s.dead and not s.available
                    ),
                },
                "models": [
                    {
                        "model": m,
                        "available": s.available,
                        "cooldown_s": round(max(0.0, s.cooldown_until - now), 1),
                        "ok": s.successes,
                        "fail": s.failures,
                    }
                    for m, s in self._models.items()
                ],
                "detail": [
                    {
                        "key": _mask(s.key),
                        "state": "dead" if s.dead else ("cooling" if not s.available else "ready"),
                        "reason": s.dead_reason or None,
                        "ok": s.successes,
                        "fail": s.failures,
                        "avg_ms": round(s.avg_latency_ms),
                        "unsupported_models": sorted(s.dead_models) or None,
                    }
                    for s in self._keys.values()
                ],
                "capacity_rpm_estimate": sum(1 for s in self._keys.values() if s.available) * 10,
            }


_pool: KeyPool | None = None
_pool_lock = threading.Lock()


def pool() -> KeyPool:
    """Process-wide singleton, built on first use."""
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = KeyPool()
    return _pool
