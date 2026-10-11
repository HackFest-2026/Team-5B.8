"""Simulation — what-if and version comparison.

What-if answers "what happens if demand becomes 90?" immediately. Backtesting
(a separate router) answers "what would this strategy have done over 90 days?".
Both exist because they answer different questions.

These endpoints run the **real engine**, not an approximation of it. The
analyst's hypothetical values are layered over the live context snapshot and
the same `price_with()` the production API calls is invoked. If a simulation
and production ever disagreed, "simulate before you activate" would be theatre.
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import ProjectDep
from app.responses import ApiError, NotFound, ok
from core import db, pricing
from core.engine import describe_decision

router = APIRouter(tags=["simulation"])


def _overrides(raw: str, schema: dict) -> dict:
    if not raw:
        return {}
    if len(raw) > 4096:
        raise ApiError("overrides exceed the 4 KB URL budget", code="payload_too_large")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(f"overrides is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ApiError("overrides must be a JSON object of {signal: value}")

    known = {s["id"] for s in (schema.get("context_signals") or [])}
    known |= {a["id"] for a in (schema.get("attributes") or [])}
    known |= {"day_of_week", "hour_of_day", "season"}
    unknown = sorted(set(parsed) - known)
    if unknown:
        raise ApiError(
            f"unknown signals in overrides: {', '.join(unknown)}",
            known_signals=sorted(known),
        )
    return parsed


def _load_version_blob(ctx, strategy_id: str | None, version: str | None) -> dict | None:
    """A specific version, or whatever is currently active."""
    if not strategy_id:
        return pricing.load_active(ctx.project_id)
    if not version:
        header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                        db.sk_strategy(ctx.project_id, strategy_id))
        if not header:
            raise NotFound("strategy")
        version = header.get("version")
    blob = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_version(ctx.project_id, strategy_id, version))
    if not blob:
        raise NotFound(f"strategy version {version}")
    return {**blob, "mode": "active"}  # simulate as if live


@router.get("/simulate/whatif", summary="Price one item under hypothetical conditions")
async def whatif(
    ctx: ProjectDep,
    item_id: Annotated[str, Query()],
    overrides: Annotated[str, Query(description='URL-encoded JSON, e.g. {"demand_score":90,"inventory":10}')] = "",
    strategy_id: Annotated[str, Query(description="Defaults to the active strategy")] = "",
    version: Annotated[str, Query()] = "",
):
    """Compare the current price with the price under changed conditions.

    Returns both evaluations plus the rules that fired in each, so the analyst
    can see not just that the price moved but which rule moved it.
    """
    item = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_item(ctx.project_id, item_id))
    if not item:
        raise NotFound("item")

    over = _overrides(overrides, ctx.schema)
    blob = _load_version_blob(ctx, strategy_id or None, version or None)
    ctx_row = pricing.load_item_context(ctx.project_id, item_id)

    # Same timestamp for both runs, so any difference is attributable to the
    # overrides rather than to a clock tick between evaluations.
    now_ms = db.now_ms()

    base_ctx = pricing.build_context(
        ctx_row=ctx_row, item=item, currency=ctx.currency, now_ms=now_ms
    )
    current = pricing.price_with(
        ctx=base_ctx, strategy_blob=blob, project_guardrails=ctx.guardrails
    )

    sim_ctx = pricing.build_context(
        ctx_row=ctx_row, item=item, overrides=over,
        currency=ctx.currency, now_ms=now_ms,
    )
    simulated = pricing.price_with(
        ctx=sim_ctx, strategy_blob=blob, project_guardrails=ctx.guardrails
    )

    delta = simulated.final_price - current.final_price
    fired_now = {r.rule_id for r in current.rules if r.applied}
    fired_sim = {r.rule_id for r in simulated.rules if r.applied}
    names = {r.rule_id: r.name for r in simulated.rules}

    return ok({
        "item_id": item_id,
        "currency": ctx.currency,
        "strategy": {
            "strategy_id": (blob or {}).get("strategy_id"),
            "version": (blob or {}).get("version"),
        },
        "current": {
            "price": current.final_price,
            "signals": {k: v for k, v in base_ctx.signals.items()},
            "rules_fired": [r.name for r in current.rules if r.applied],
            "explanation": describe_decision(current.to_dict(), schema=ctx.schema),
        },
        "simulated": {
            "price": simulated.final_price,
            "recommended_before_guardrails": simulated.recommended_price,
            "overrides_applied": over,
            "rules_fired": [r.name for r in simulated.rules if r.applied],
            "guardrails_applied": [g.to_dict() for g in simulated.guardrails_applied],
            "drivers": simulated.drivers,
            "explanation": describe_decision(simulated.to_dict(), schema=ctx.schema),
        },
        "difference": {
            "amount": round(delta, 2),
            "percent": round(delta / current.final_price * 100, 2) if current.final_price else 0.0,
            "newly_triggered": [names.get(r, r) for r in sorted(fired_sim - fired_now)],
            "no_longer_triggered": [names.get(r, r) for r in sorted(fired_now - fired_sim)],
        },
        "note": "This ran the production engine. A live request with these "
                "signals would return the same price.",
    })


@router.get("/simulate/compare", summary="Same scenario across strategy versions")
async def compare(
    ctx: ProjectDep,
    item_id: Annotated[str, Query()],
    strategy_id: Annotated[str, Query()],
    versions: Annotated[str, Query(description="Comma-separated, e.g. v1,v2,v3")],
    overrides: Annotated[str, Query()] = "",
):
    """Price one scenario under several versions side by side.

    This is the evidence for promoting a version: identical inputs, different
    rulesets, visible difference.
    """
    item = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_item(ctx.project_id, item_id))
    if not item:
        raise NotFound("item")

    wanted = [v.strip() for v in versions.split(",") if v.strip()]
    if not wanted:
        raise ApiError("at least one version is required")
    if len(wanted) > 6:
        raise ApiError("compare at most 6 versions at once")

    over = _overrides(overrides, ctx.schema)
    ctx_row = pricing.load_item_context(ctx.project_id, item_id)
    now_ms = db.now_ms()

    results = []
    for v in wanted:
        blob = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_version(ctx.project_id, strategy_id, v))
        if not blob:
            results.append({"version": v, "error": "version not found"})
            continue

        pc = pricing.build_context(
            ctx_row=ctx_row, item=item, overrides=over,
            currency=ctx.currency, now_ms=now_ms,
        )
        d = pricing.price_with(
            ctx=pc, strategy_blob={**blob, "mode": "active"},
            project_guardrails=ctx.guardrails,
        )
        results.append({
            "version": v,
            "price": d.final_price,
            "recommended_before_guardrails": d.recommended_price,
            "rules_fired": [r.name for r in d.rules if r.applied],
            "rule_count": blob.get("rule_count"),
            "guardrails_applied": [g.rule for g in d.guardrails_applied],
            "drivers": d.drivers,
        })

    priced = [r for r in results if "price" in r]
    spread = None
    if len(priced) > 1:
        lo = min(r["price"] for r in priced)
        hi = max(r["price"] for r in priced)
        spread = {
            "lowest": lo, "highest": hi, "range": round(hi - lo, 2),
            "range_pct": round((hi - lo) / lo * 100, 2) if lo else 0.0,
        }

    return ok({
        "item_id": item_id,
        "strategy_id": strategy_id,
        "currency": ctx.currency,
        "scenario": over or "current live context",
        "results": results,
        "spread": spread,
    })
