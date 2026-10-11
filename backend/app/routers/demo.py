"""Demo and chaos endpoints.

Two jobs:

  /demo/traffic  generate synthetic events so the live dashboard actually moves
  /demo/chaos    inject a failure and show the system degrade safely

The chaos endpoint is the more valuable of the two. Claiming resilience is
cheap; breaking something on purpose in front of an audience and showing that
customers still get a safe price is not. Each scenario maps to a real failure
mode from the reliability spec.

Chaos is confined to one project, is always reversible, and never produces an
unsafe price — that is the point being demonstrated.
"""

from __future__ import annotations

import json
import random
from typing import Annotated

import boto3
from fastapi import APIRouter, Query

from app.deps import ProjectDep
from app.responses import ApiError, ok
from core import audit, db, ids
from core.config import REGION, settings

router = APIRouter(tags=["demo"])

SCENARIOS = {
    "stale_data": "Freeze signal timestamps so the engine sees stale context.",
    "engine_error": "Corrupt the compiled ruleset so evaluation throws.",
    "sqs_delay": "Hold event processing to simulate a backlog.",
    "duplicate_event": "Replay the same event_id repeatedly.",
    "traffic_spike": "Burst synthetic events well above normal volume.",
    "clear": "Undo every injected fault for this project.",
}

_sqs = None


def sqs():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client("sqs", region_name=REGION)
    return _sqs


@router.get("/demo/traffic", summary="Generate synthetic business events")
async def generate_traffic(
    ctx: ProjectDep,
    events_per_sec: Annotated[int, Query(ge=1, le=500)] = 20,
    duration: Annotated[int, Query(ge=1, le=120, description="Seconds")] = 10,
    item_ids: Annotated[str, Query(description="Comma-separated; omit to use all items")] = "",
    pattern: Annotated[str, Query(description="steady | spike | decay")] = "steady",
):
    """Push synthetic events through the real ingestion path.

    These go through SQS and the feature worker exactly like customer events —
    no special casing. The dashboard moves because the pipeline genuinely ran,
    not because a demo flag faked a number.
    """
    if pattern not in ("steady", "spike", "decay"):
        raise ApiError("pattern must be steady, spike or decay")

    items = [i.strip() for i in item_ids.split(",") if i.strip()]
    if not items:
        rows, _ = db.query_prefix(
            db.core(), db.pk_tenant(ctx.tenant_id),
            db.sk_item_prefix(ctx.project_id), limit=50,
        )
        items = [r["item_id"] for r in rows]
    if not items:
        raise ApiError("this project has no items — create some first")

    queue = settings().queue_events
    if not queue:
        raise ApiError("event queue is not configured", status_code=503)

    total = events_per_sec * duration
    if total > 5000:
        raise ApiError(
            f"{total} events exceeds the 5000 demo cap — "
            f"lower events_per_sec or duration"
        )

    event_types = ["view", "search", "add_to_cart", "purchase", "inventory_update"]
    weights = [50, 25, 15, 8, 2]
    now = db.now_ms()
    sent = 0

    for second in range(duration):
        if pattern == "spike":
            # Triple the rate in the middle third, so the dashboard shows a
            # demand spike the rules can actually react to.
            factor = 3.0 if duration / 3 <= second < 2 * duration / 3 else 1.0
        elif pattern == "decay":
            factor = max(0.2, 1.0 - second / duration)
        else:
            factor = 1.0

        batch = []
        for _ in range(int(events_per_sec * factor)):
            item = random.choice(items)
            etype = random.choices(event_types, weights=weights)[0]
            batch.append({
                "Id": str(len(batch)),
                "MessageBody": json.dumps({
                    "tenant_id": ctx.tenant_id,
                    "project_id": ctx.project_id,
                    "item_id": item,
                    "event_type": etype,
                    "event_id": ids.event_id(),
                    "quantity": random.randint(1, 3) if etype == "purchase" else 1,
                    "ts": now + second * 1000,
                    "synthetic": True,
                }),
            })
            if len(batch) == 10:
                sqs().send_message_batch(QueueUrl=queue, Entries=batch)
                sent += len(batch)
                batch = []
        if batch:
            sqs().send_message_batch(QueueUrl=queue, Entries=batch)
            sent += len(batch)

    return ok({
        "events_sent": sent,
        "pattern": pattern,
        "items_targeted": len(items),
        "note": "Events went through the real SQS pipeline. Watch the dashboard "
                "update as the feature worker processes them.",
    })


@router.get("/demo/chaos", summary="Inject a failure and watch it degrade safely")
async def chaos(
    ctx: ProjectDep,
    scenario: Annotated[str, Query(description=" | ".join(SCENARIOS))],
    duration: Annotated[int, Query(ge=10, le=600, description="Seconds before auto-clearing")] = 60,
):
    """Break something on purpose, within one project, reversibly.

    Every scenario exercises a documented reliability behaviour. The thing to
    watch is that the pricing API keeps answering throughout — degraded and
    clearly labelled, never erroring and never unbounded.
    """
    if scenario not in SCENARIOS:
        raise ApiError(f"unknown scenario", scenarios=SCENARIOS)

    now = db.now_ms()
    chaos_key = f"CHAOS#{ctx.project_id}"

    if scenario == "clear":
        db.delete(db.context(), chaos_key, db.sk_meta())
        return ok({
            "scenario": "clear",
            "message": "All injected faults removed. Normal operation restored.",
        })

    db.put(db.context(), {
        "pk": chaos_key,
        "sk": db.sk_meta(),
        "project_id": ctx.project_id,
        "scenario": scenario,
        "injected_at": now,
        "expires_at": now + duration * 1000,
        "ttl": db.ttl_in(duration + 60),
        "injected_by": ctx.session.user_id,
    })

    audit.record(
        tenant_id=ctx.tenant_id, action="CHAOS_INJECTED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="chaos", entity_id=scenario,
        new_value={"scenario": scenario, "duration_s": duration},
    )

    expected = {
        "stale_data": {
            "what_happens": "Signals read as older than the stale threshold.",
            "system_response": "Rules depending on stale signals are skipped; the "
                               "decision is flagged degraded and the dashboard shows "
                               "the stale signal.",
            "customer_impact": "Still gets a price — computed from fresh signals only.",
        },
        "engine_error": {
            "what_happens": "The compiled ruleset fails to load.",
            "system_response": "Safe fallback engages, a CRITICAL alert fires, and "
                               "an approval request is raised.",
            "customer_impact": "Still gets a price — the last known good one, "
                               "within guardrails.",
        },
        "sqs_delay": {
            "what_happens": "Event processing pauses; the backlog grows.",
            "system_response": "Ingestion stays responsive; data freshness degrades "
                               "visibly on the dashboard.",
            "customer_impact": "Prices keep flowing from the last known context.",
        },
        "duplicate_event": {
            "what_happens": "The same event_id is delivered repeatedly.",
            "system_response": "Idempotency check makes every repeat a no-op.",
            "customer_impact": "None. Demand is not double-counted.",
        },
        "traffic_spike": {
            "what_happens": "Event volume jumps far above normal.",
            "system_response": "SQS absorbs the burst; the API stays responsive.",
            "customer_impact": "None, beyond slightly older context during the peak.",
        },
    }[scenario]

    return ok({
        "scenario": scenario,
        "description": SCENARIOS[scenario],
        "active_for_seconds": duration,
        "expires_at": now + duration * 1000,
        "expected_behaviour": expected,
        "watch": [
            f"/analytics/system?project_id={ctx.project_id}",
            f"/alerts/list?project_id={ctx.project_id}",
            f"/decisions/list?project_id={ctx.project_id}",
        ],
        "clear_with": f"/demo/chaos?project_id={ctx.project_id}&scenario=clear",
        "guarantee": "No unsafe price can be produced. Guardrails and the safe "
                     "fallback remain in force throughout.",
    })
