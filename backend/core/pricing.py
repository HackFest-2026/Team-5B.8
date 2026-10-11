"""Shared pricing orchestration.

Loads state, builds a PricingContext, calls the engine. Used by:

    runtime/price_handler.py   live API
    app/routers/simulate.py    what-if
    app/routers/decisions.py   replay + determinism verification
    workers/backtest_worker.py historical replay

They share this module so that a simulated price and a live price for the same
inputs are produced by literally the same code. If simulation had its own copy
it would drift, and "simulate before you activate" would quietly stop meaning
anything.

The engine itself (core/engine/) stays pure. This module does the I/O and hands
it plain values.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from core import db
from core.config import settings
from core.engine import (
    Decision,
    Guardrails,
    PricingContext,
    Rule,
    evaluate,
    rules_from_compiled,
    safe_fallback,
)

_DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]


def time_signals(now_ms: int, tz_offset_minutes: int = 330) -> dict[str, Any]:
    """Derive day_of_week / hour_of_day from the evaluation timestamp.

    Derived from `now_ms`, never from the system clock. Replaying a decision
    from last Saturday must evaluate SAT, not whatever today is — otherwise a
    weekend rule would silently change the replayed price and Decision Replay
    would be wrong in exactly the cases people check it.

    Default offset is +05:30 (IST); projects can override per tenant later.
    """
    stamp = dt.datetime.fromtimestamp(now_ms / 1000, dt.timezone.utc) + dt.timedelta(
        minutes=tz_offset_minutes
    )
    return {
        "day_of_week": _DAYS[stamp.weekday()],
        "hour_of_day": stamp.hour,
    }


def build_context(
    *,
    ctx_row: dict | None,
    item: dict | None = None,
    overrides: dict | None = None,
    now_ms: int | None = None,
    currency: str = "INR",
) -> PricingContext:
    """Assemble the engine's input from a stored context row.

    `overrides` is how what-if works: the analyst's hypothetical values are
    layered over the real snapshot, and everything downstream is identical to a
    live evaluation.
    """
    now_ms = now_ms or db.now_ms()
    ctx_row = ctx_row or {}
    signals = dict(ctx_row.get("signals") or {})

    # Per-signal age drives the stale-data policy in the engine.
    ages: dict[str, float] = {}
    for key, stamp in (ctx_row.get("signal_updated_at") or {}).items():
        try:
            ages[key] = max(0.0, (now_ms - float(stamp)) / 1000.0)
        except (TypeError, ValueError):
            continue

    signals.update(time_signals(now_ms))

    if overrides:
        for key, value in overrides.items():
            if value is None:
                continue
            signals[key] = value
            # A hypothetical value is fresh by definition — otherwise a what-if
            # over a stale signal would be skipped and return a confusing result.
            ages[key] = 0.0

    base_price = ctx_row.get("base_price")
    if base_price is None and item:
        base_price = item.get("base_price")

    cost = ctx_row.get("cost")
    if cost is None and item:
        cost = item.get("cost")

    return PricingContext(
        base_price=float(base_price or 0.0),
        signals=signals,
        signal_age_s=ages,
        cost=float(cost) if cost is not None else None,
        previous_price=(
            float(ctx_row["previous_price"])
            if ctx_row.get("previous_price") is not None else None
        ),
        now_ms=now_ms,
        currency=currency,
    )


def load_active(project_id: str) -> dict | None:
    """The compiled active strategy blob from the hot-path table."""
    return db.get(db.context(), db.active_pk(project_id), db.active_sk())


def load_shadow(project_id: str) -> dict | None:
    return db.get(db.context(), f"SHADOW#{project_id}", db.active_sk())


def load_item_context(project_id: str, item_id: str) -> dict | None:
    return db.get(db.context(), db.ctx_pk(project_id, item_id), db.ctx_sk())


def price_with(
    *,
    ctx: PricingContext,
    strategy_blob: dict | None,
    project_guardrails: dict | None = None,
    stale_after_s: float | None = None,
) -> Decision:
    """Run the engine against a compiled strategy blob.

    Every failure mode returns a price. A customer's checkout page must never
    receive an error because our strategy table had a bad day.
    """
    guardrails = Guardrails.from_dict(
        (strategy_blob or {}).get("guardrails") or project_guardrails or {}
    )
    stale = stale_after_s if stale_after_s is not None else settings().context_stale_seconds

    if not strategy_blob:
        return safe_fallback(ctx=ctx, guardrails=guardrails, reason="no active strategy")

    mode = strategy_blob.get("mode")
    if mode in ("paused", "safe"):
        return safe_fallback(
            ctx=ctx, guardrails=guardrails,
            reason=f"strategy is {mode}; serving base price within guardrails",
        )

    try:
        rules = rules_from_compiled(strategy_blob)
    except Exception as exc:  # noqa: BLE001
        return safe_fallback(
            ctx=ctx, guardrails=guardrails, reason=f"ruleset could not be loaded: {exc}"
        )

    try:
        return evaluate(
            ctx=ctx,
            rules=rules,
            guardrails=guardrails,
            strategy_id=strategy_blob.get("strategy_id"),
            strategy_version=strategy_blob.get("version"),
            ruleset_version=strategy_blob.get("ruleset_version"),
            stale_after_s=stale,
        )
    except Exception as exc:  # noqa: BLE001
        return safe_fallback(
            ctx=ctx, guardrails=guardrails, reason=f"engine error: {exc}"
        )


def price_item(
    *,
    project_id: str,
    item_id: str,
    overrides: dict | None = None,
    currency: str = "INR",
    strategy_blob: dict | None = None,
    project_guardrails: dict | None = None,
    now_ms: int | None = None,
) -> tuple[Decision, dict]:
    """Convenience wrapper: load everything for one item and price it.

    The live handler does NOT use this — it batches its reads. This exists for
    the control-plane callers, where an extra round trip is irrelevant.
    """
    ctx_row = load_item_context(project_id, item_id)
    blob = strategy_blob if strategy_blob is not None else load_active(project_id)
    ctx = build_context(
        ctx_row=ctx_row, overrides=overrides, currency=currency, now_ms=now_ms
    )
    decision = price_with(
        ctx=ctx, strategy_blob=blob, project_guardrails=project_guardrails
    )
    return decision, (ctx_row or {})


def snapshot_for_replay(ctx: PricingContext, blob: dict | None) -> dict:
    """Everything needed to recompute a decision later, byte for byte.

    This is what makes `/decisions/verify` a real proof rather than a claim: the
    engine is re-run on exactly these inputs and the price must match.
    """
    return {
        "base_price": ctx.base_price,
        "cost": ctx.cost,
        "previous_price": ctx.previous_price,
        "signals": ctx.signals,
        "signal_age_s": ctx.signal_age_s,
        "now_ms": ctx.now_ms,
        "currency": ctx.currency,
        "strategy_id": (blob or {}).get("strategy_id"),
        "strategy_version": (blob or {}).get("version"),
        "ruleset_version": (blob or {}).get("ruleset_version"),
        "rules": (blob or {}).get("rules", []),
        "guardrails": (blob or {}).get("guardrails", {}),
    }


def replay(snapshot: dict) -> Decision:
    """Re-run the engine on a stored snapshot. Used by /decisions/verify."""
    ctx = PricingContext(
        base_price=float(snapshot.get("base_price", 0)),
        signals=snapshot.get("signals") or {},
        signal_age_s=snapshot.get("signal_age_s") or {},
        cost=snapshot.get("cost"),
        previous_price=snapshot.get("previous_price"),
        now_ms=int(snapshot.get("now_ms", 0)),
        currency=snapshot.get("currency", "INR"),
    )
    blob = {
        "strategy_id": snapshot.get("strategy_id"),
        "version": snapshot.get("strategy_version"),
        "ruleset_version": snapshot.get("ruleset_version"),
        "rules": snapshot.get("rules", []),
        "guardrails": snapshot.get("guardrails", {}),
        "mode": "active",
    }
    return price_with(ctx=ctx, strategy_blob=blob)
