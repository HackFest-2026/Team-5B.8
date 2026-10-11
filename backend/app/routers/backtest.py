"""Backtesting and shadow mode.

Backtesting replays historical context through a strategy version and compares
what it would have charged against what actually happened. Shadow mode does the
same thing against live traffic, without touching customer-facing prices.

Together they are the two safe ways to gain confidence before activation:
backtest tells you what a strategy would have done, shadow tells you what it is
doing right now. Neither can change a price.

Backtests run asynchronously through SQS — replaying 90 days across thousands
of items is minutes of work, not a request.
"""

from __future__ import annotations

import json
from typing import Annotated

import boto3
from fastapi import APIRouter, Query

from app.deps import ProjectDep
from app.responses import ApiError, NotFound, ok
from core import audit, db, ids, pricing
from core.config import REGION, settings

router = APIRouter(tags=["backtesting"])

_sqs = None


def sqs():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client("sqs", region_name=REGION)
    return _sqs


@router.get("/backtest/run", summary="Replay a strategy over a historical window")
async def run_backtest(
    ctx: ProjectDep,
    strategy_id: Annotated[str, Query()],
    date_from: Annotated[str, Query(description="ISO date, e.g. 2026-07-01")],
    date_to: Annotated[str, Query(description="ISO date, e.g. 2026-09-30")],
    version: Annotated[str, Query(description="Defaults to the latest version")] = "",
    item_ids: Annotated[str, Query(description="Comma-separated; omit for all items")] = "",
):
    """Queue a backtest. Returns a job_id to poll with /backtest/result."""
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, strategy_id))
    if not header:
        raise NotFound("strategy")

    v = version or header.get("version")
    blob = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_version(ctx.project_id, strategy_id, v))
    if not blob:
        raise NotFound(f"strategy version {v}")

    import datetime as dt
    try:
        start = dt.date.fromisoformat(date_from)
        end = dt.date.fromisoformat(date_to)
    except ValueError as exc:
        raise ApiError(f"dates must be ISO format (YYYY-MM-DD): {exc}") from exc
    if start >= end:
        raise ApiError("date_from must be before date_to")
    if (end - start).days > 365:
        raise ApiError("backtest window is capped at 365 days")

    job_id = ids.job_id()
    now = db.now_ms()
    items = [i.strip() for i in item_ids.split(",") if i.strip()]

    db.put(db.core(), {
        "pk": db.pk_tenant(ctx.tenant_id),
        "sk": db.sk_job(ctx.project_id, job_id),
        "job_id": job_id,
        "project_id": ctx.project_id,
        "type": "backtest",
        "status": "queued",
        "strategy_id": strategy_id,
        "strategy_version": v,
        "date_from": date_from,
        "date_to": date_to,
        "item_ids": items,
        "created_at": now,
        "created_by": ctx.session.user_id,
    })

    queue = settings().queue_backtest
    if queue:
        sqs().send_message(
            QueueUrl=queue,
            MessageBody=json.dumps({
                "job_id": job_id, "tenant_id": ctx.tenant_id,
                "project_id": ctx.project_id, "strategy_id": strategy_id,
                "version": v, "date_from": date_from, "date_to": date_to,
                "item_ids": items,
            }),
        )
    else:
        db.update(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_job(ctx.project_id, job_id),
                  {"status": "failed", "error": "backtest queue is not configured"})
        raise ApiError("backtest queue is not configured", status_code=503)

    audit.record(
        tenant_id=ctx.tenant_id, action="BACKTEST_RUN", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="backtest", entity_id=job_id,
        strategy_version=v, new_value={"from": date_from, "to": date_to},
    )

    return ok({
        "job_id": job_id,
        "status": "queued",
        "strategy_id": strategy_id,
        "version": v,
        "window": {"from": date_from, "to": date_to, "days": (end - start).days},
        "poll": f"/backtest/result?project_id={ctx.project_id}&job_id={job_id}",
    })


@router.get("/backtest/result", summary="Backtest outcome")
async def backtest_result(
    ctx: ProjectDep,
    job_id: Annotated[str, Query()],
):
    """Actual vs simulated, plus the correctness check.

    `pricing_correctness` re-runs a sample of the replayed decisions and
    confirms each one reproduces. A backtest whose own results are not
    reproducible would not be evidence of anything.
    """
    row = db.get(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_job(ctx.project_id, job_id))
    if not row or row.get("type") != "backtest":
        raise NotFound("backtest job")

    if row.get("status") != "completed":
        return ok({
            "job_id": job_id,
            "status": row.get("status"),
            "progress_pct": row.get("progress_pct", 0),
            "items_processed": row.get("items_processed", 0),
            "error": row.get("error"),
        })

    actual = row.get("actual", {})
    simulated = row.get("simulated", {})

    def uplift(key: str) -> float | None:
        a, s = actual.get(key), simulated.get(key)
        if not a:
            return None
        return round((s - a) / a * 100, 2)

    return ok({
        "job_id": job_id,
        "status": "completed",
        "strategy_id": row.get("strategy_id"),
        "version": row.get("strategy_version"),
        "window": {"from": row.get("date_from"), "to": row.get("date_to")},
        "comparison": {
            "revenue": {"actual": actual.get("revenue"), "simulated": simulated.get("revenue"),
                        "uplift_pct": uplift("revenue")},
            "margin": {"actual": actual.get("margin"), "simulated": simulated.get("margin"),
                       "uplift_pct": uplift("margin")},
            "orders": {"actual": actual.get("orders"), "simulated": simulated.get("orders"),
                       "uplift_pct": uplift("orders")},
            "avg_price": {"actual": actual.get("avg_price"), "simulated": simulated.get("avg_price"),
                          "uplift_pct": uplift("avg_price")},
        },
        "activity": {
            "decisions_replayed": row.get("decisions_replayed", 0),
            "price_changes": row.get("price_changes", 0),
            "guardrail_blocks": row.get("guardrail_blocks", 0),
            "items_covered": row.get("items_processed", 0),
        },
        "rules_triggered": row.get("rules_triggered", {}),
        "pricing_correctness": row.get("correctness", {
            "checked": 0, "reproduced": 0,
            "note": "no correctness sample recorded for this run",
        }),
        # The elasticity assumption behind every simulated revenue figure. The
        # worker records it; returning it is the whole point — an uplift number
        # without its assumption stated is not a result anyone can judge.
        "assumptions": row.get("assumptions", {
            "note": "no assumptions recorded for this run",
        }),
        "currency": ctx.currency,
        "completed_at": row.get("completed_at"),
    })


@router.get("/backtest/list", summary="Backtest history")
async def list_backtests(
    ctx: ProjectDep,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id), db.sk_job_prefix(ctx.project_id),
        limit=limit * 3, ascending=False,
    )
    rows = [r for r in rows if r.get("type") == "backtest"][:limit]

    return ok({
        "count": len(rows),
        "backtests": [
            {
                "job_id": r["job_id"],
                "strategy_id": r.get("strategy_id"),
                "version": r.get("strategy_version"),
                "status": r.get("status"),
                "window": {"from": r.get("date_from"), "to": r.get("date_to")},
                "revenue_uplift_pct": (
                    round(
                        (r["simulated"]["revenue"] - r["actual"]["revenue"])
                        / r["actual"]["revenue"] * 100, 2
                    )
                    if r.get("actual", {}).get("revenue") and r.get("simulated", {}).get("revenue")
                    else None
                ),
                "created_at": r.get("created_at"),
                "completed_at": r.get("completed_at"),
            }
            for r in rows
        ],
    })


@router.get("/shadow/comparison", summary="Shadow mode: what it would have charged")
async def shadow_comparison(
    ctx: ProjectDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """Live actual price vs the shadow strategy's recommendation.

    No customer sees the shadow price. This is the last confidence check before
    activation, run against real traffic rather than a historical sample.
    """
    shadow = pricing.load_shadow(ctx.project_id)
    if not shadow:
        return ok({
            "shadow_active": False,
            "message": "No strategy is in shadow mode. "
                       "Promote one with /strategies/promote?mode=shadow.",
        })

    rows, _ = db.query_prefix(
        db.decisions(), db.decfeed_pk(ctx.project_id), "", limit=limit, ascending=False
    )
    rows = [r for r in rows if r.get("shadow_price") is not None]

    comparisons = []
    total_delta_pct = 0.0
    higher = lower = same = 0

    for r in rows:
        actual = r.get("final_price")
        shadow_price = r.get("shadow_price")
        if not actual:
            continue
        delta = shadow_price - actual
        delta_pct = round(delta / actual * 100, 2)
        total_delta_pct += delta_pct
        if delta > 0.005:
            higher += 1
        elif delta < -0.005:
            lower += 1
        else:
            same += 1
        comparisons.append({
            "decision_id": r.get("decision_id"),
            "item_id": r.get("item_id"),
            "actual_price": actual,
            "shadow_price": shadow_price,
            "difference": round(delta, 2),
            "difference_pct": delta_pct,
            "shadow_rules_fired": r.get("shadow_rules_fired", []),
            "ts": r.get("ts"),
        })

    n = len(comparisons)
    return ok({
        "shadow_active": True,
        "shadow_strategy": {
            "strategy_id": shadow.get("strategy_id"),
            "version": shadow.get("version"),
            "since": shadow.get("activated_at"),
        },
        "sample_size": n,
        "summary": {
            "avg_difference_pct": round(total_delta_pct / n, 2) if n else 0.0,
            "would_price_higher": higher,
            "would_price_lower": lower,
            "would_match": same,
        },
        "comparisons": comparisons,
        "customer_impact": "None. Shadow prices are recorded, never served.",
        "currency": ctx.currency,
    })
