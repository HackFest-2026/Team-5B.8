"""Live operational views — the dashboard's real-time surface.

    /live/events        raw event feed, newest first
    /live/decisions     pricing decision feed with full driver detail
    /live/pulse         ONE call powering the whole live dashboard
    /analytics/pipeline SQS backlog, DLQ, throughput, processing time
    /live/connections   who is currently watching (diagnostic)
    /v1/p/{key}/explain customer-facing driver breakdown

These are the REST counterparts of the WebSocket channels. A dashboard uses
both: `/live/pulse` to paint the initial screen, then the socket to keep it
moving. Without the REST half, a client reconnecting after a dropped socket
would stare at an empty page until the next event happened to arrive.

`/analytics/pipeline` is the panel that makes the asynchronous architecture
visible rather than hidden. Reading SQS directly (GetQueueAttributes) rather
than via CloudWatch gives an instant depth instead of a 1-2 minute lagged one,
which matters when you are demonstrating a backlog draining in real time.
"""

from __future__ import annotations

import re

from typing import Annotated

import boto3
from fastapi import APIRouter, Path, Query

from app.deps import ProjectDep, RegisteredDep, resolve_api_key
from app.responses import ApiError, NotFound, ok
from core import db, fanout, realtime
from core.config import REGION, settings
from core.engine import describe_decision

# Decision ids are "DEC-" followed by upper-case hex. TWO generators mint them
# and they differ in length, so the check has to accept both:
#   runtime/price_handler.py  -> 10 chars (6 of the millisecond + 4 of item hash)
#   core/ids.py               ->  8 chars (random)
# Pinning this to one length rejected real ids from the hot path.
_DECISION_ID_RE = re.compile(r"^DEC-[0-9A-F]{8,10}$")

router = APIRouter(tags=["live"])

_sqs = None


def sqs():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client("sqs", region_name=REGION)
    return _sqs


@router.get("/live/events", summary="Live raw event feed")
async def live_events(
    ctx: ProjectDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    item_id: Annotated[str, Query()] = "",
    event_type: Annotated[str, Query()] = "",
):
    """The last hour of raw business events, newest first.

    Deliberately a one-hour TTL'd window, not a permanent log: this is a display
    buffer. The durable record of what the system DID is the decision log.
    """
    rows, _ = db.query_prefix(
        db.context(), f"EVTFEED#{ctx.project_id}", "",
        limit=limit * 3 if (item_id or event_type) else limit,
        ascending=False,
    )
    if item_id:
        rows = [r for r in rows if r.get("item_id") == item_id]
    if event_type:
        rows = [r for r in rows if r.get("event_type") == event_type]
    rows = rows[:limit]

    now = db.now_ms()
    by_type: dict[str, int] = {}
    for r in rows:
        t = r.get("event_type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1

    return ok({
        "count": len(rows),
        "events": [
            {
                "ts": r.get("ts"),
                "age_seconds": round((now - (r.get("ts") or now)) / 1000, 1),
                "item_id": r.get("item_id"),
                "event_type": r.get("event_type"),
                "quantity": r.get("quantity"),
                "value": r.get("value"),
                "synthetic": r.get("synthetic", False),
            }
            for r in rows
        ],
        "by_type": by_type,
        "window": "1 hour (TTL'd display buffer)",
        "realtime_channel": "events",
    })


@router.get("/live/decisions", summary="Live pricing decision feed")
async def live_decisions(
    ctx: ProjectDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    changed_only: Annotated[bool, Query()] = False,
):
    """Recent decisions with the full driver breakdown, ready to render.

    Richer than /decisions/list, which is a compact index. This returns what a
    live "why did that price move" panel needs without a follow-up call per row.
    """
    rows, _ = db.query_prefix(
        db.decisions(), db.decfeed_pk(ctx.project_id), "",
        limit=limit * 3 if changed_only else limit, ascending=False,
    )
    if changed_only:
        rows = [r for r in rows if r.get("changed")]
    rows = rows[:limit]

    now = db.now_ms()
    return ok({
        "count": len(rows),
        "currency": ctx.currency,
        "decisions": [
            {
                "decision_id": r.get("decision_id"),
                "item_id": r.get("item_id"),
                "ts": r.get("ts"),
                "age_seconds": round((now - (r.get("ts") or now)) / 1000, 1),
                "base_price": r.get("base_price"),
                "previous_price": r.get("previous_price"),
                "price": r.get("final_price"),
                "changed": r.get("changed"),
                "change_pct": r.get("change_pct"),
                "signals": r.get("signals", {}),
                "rules_fired": r.get("rules_fired", []),
                "rules_detail": r.get("rules_detail", []),
                "guardrails_applied": r.get("guardrail_names", []),
                "guardrail_passed": not r.get("guardrail_names"),
                "strategy_version": r.get("strategy_version"),
                "degraded": r.get("degraded", False),
                "fallback": r.get("fallback", False),
                "latency_ms": r.get("latency_ms"),
                "replay_url": (
                    f"/decisions/replay?project_id={ctx.project_id}"
                    f"&decision_id={r.get('decision_id')}"
                ),
            }
            for r in rows
        ],
        "realtime_channel": "decisions",
    })


def _queue_depth(queue_url: str) -> dict:
    """Instant depth straight from SQS, not from lagged CloudWatch metrics."""
    if not queue_url:
        return {"configured": False}
    try:
        attrs = sqs().get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=[
                "ApproximateNumberOfMessages",
                "ApproximateNumberOfMessagesNotVisible",
                "ApproximateNumberOfMessagesDelayed",
            ],
        )["Attributes"]
        return {
            "configured": True,
            "backlog": int(attrs.get("ApproximateNumberOfMessages", 0)),
            "in_flight": int(attrs.get("ApproximateNumberOfMessagesNotVisible", 0)),
            "delayed": int(attrs.get("ApproximateNumberOfMessagesDelayed", 0)),
        }
    except Exception as exc:  # noqa: BLE001
        return {"configured": True, "error": str(exc)[:120]}


def _dlq_url(queue_url: str) -> str:
    """DLQ URL by naming convention: devnexus-events-dev -> devnexus-events-dlq-dev."""
    if not queue_url or "/" not in queue_url:
        return ""
    base, name = queue_url.rsplit("/", 1)
    parts = name.rsplit("-", 1)
    if len(parts) != 2:
        return ""
    return f"{base}/{parts[0]}-dlq-{parts[1]}"


@router.get("/analytics/pipeline", summary="Event pipeline health")
async def pipeline_health(ctx: ProjectDep):
    # The whole body is cached for 5s, not just the SQS reads: the event-feed,
    # decision-feed, item and freshness reads were the remaining cost once the
    # queue depths were cached. Backlog is meaningful at second granularity, so
    # 5s keeps the panel live while a polling dashboard stops paying for it.
    return fanout.cached(
        f"pipeline:{ctx.project_id}", 5.0, lambda: _pipeline_body(ctx)
    )


def _pipeline_body(ctx: ProjectDep):
    """Makes the asynchronous architecture visible instead of hiding it.

    Backlog, in-flight, DLQ depth and data freshness. A growing backlog with a
    responsive API is the system working as designed — absorbing a spike — and
    this panel is how you show that rather than assert it.
    """
    s = settings()
    queues = {
        "events": s.queue_events,
        "decisions": s.queue_decisions,
        "alerts": s.queue_alerts,
        "data": s.queue_data,
        "backtest": s.queue_backtest,
    }

    # Sequential on purpose. Fanning these ten SQS reads across threads
    # MEASURED SLOWER (270ms vs 207ms): thread startup plus contention on the
    # shared boto3 client costs more than the round trips it saves, because
    # each GetQueueAttributes is only a few milliseconds to begin with.
    def read_depths():
        out = {}
        for name, url in queues.items():
            out[name] = {"queue": _queue_depth(url),
                         "dlq": _queue_depth(_dlq_url(url))}
        return out

    # Ten SQS GetQueueAttributes calls at ~25ms each were the whole cost of
    # this endpoint. A 5-second cache keeps the panel genuinely live — backlog
    # is read at second granularity, not millisecond — while removing nine of
    # every ten calls from a polling dashboard.
    pipeline = fanout.cached(f"pipe:{settings().stage}", 5.0, read_depths)
    total_backlog = sum((v["queue"].get("backlog", 0) or 0) for v in pipeline.values())
    total_dlq = sum((v["dlq"].get("backlog", 0) or 0) for v in pipeline.values())

    now = db.now_ms()

    # Throughput and freshness, all independent of each other and of the queues.
    reads = fanout.gather({
        "events": lambda: db.query_prefix(
            db.context(), f"EVTFEED#{ctx.project_id}", "", limit=500, ascending=False)[0],
        "decisions": lambda: db.query_prefix(
            db.decisions(), db.decfeed_pk(ctx.project_id), "",
            limit=500, ascending=False)[0],
        "items": lambda: db.query_prefix(
            db.core(), db.pk_tenant(ctx.tenant_id),
            db.sk_item_prefix(ctx.project_id), limit=25)[0],
    })
    events = fanout.ok(reads["events"], []) or []
    decisions = fanout.ok(reads["decisions"], []) or []
    items = fanout.ok(reads["items"], []) or []

    recent_events = [e for e in events if (e.get("ts") or 0) > now - 60_000]
    recent_decisions = [d for d in decisions if (d.get("ts") or 0) > now - 60_000]

    # Per-signal freshness: ONE BatchGetItem instead of 25 sequential GetItems.
    ages: dict[str, list[float]] = {}
    if items:
        rows = db.batch_get(
            db.context(),
            [(db.ctx_pk(ctx.project_id, it["item_id"]), db.ctx_sk()) for it in items],
        )
        for row in rows:
            for sig, stamp in ((row or {}).get("signal_updated_at") or {}).items():
                ages.setdefault(sig, []).append((now - float(stamp)) / 1000.0)

    stale_after = s.context_stale_seconds
    freshness = sorted(
        (
            {
                "signal": sig,
                "age_seconds": round(min(v), 1),
                "median_age_seconds": round(sorted(v)[len(v) // 2], 1),
                "stale": min(v) > stale_after,
            }
            for sig, v in ages.items() if v
        ),
        key=lambda f: -f["age_seconds"],
    )

    latencies = sorted(d["latency_ms"] for d in recent_decisions if d.get("latency_ms"))
    healthy = total_dlq == 0 and total_backlog < 1000

    return ok({
        "healthy": healthy,
        "summary": {
            "events_per_min": len(recent_events),
            "decisions_per_min": len(recent_decisions),
            "price_changes_per_min": sum(1 for d in recent_decisions if d.get("changed")),
            "total_backlog": total_backlog,
            "total_dlq": total_dlq,
            "avg_decision_latency_ms": (
                round(sum(latencies) / len(latencies), 2) if latencies else None
            ),
        },
        "queues": pipeline,
        "data_freshness": {
            "stale_after_seconds": stale_after,
            "signals": freshness,
            "any_stale": any(f["stale"] for f in freshness),
            "oldest_signal": freshness[0] if freshness else None,
        },
        "realtime": {
            "connected_dashboards": realtime.connection_count(ctx.project_id),
            "channels": list(realtime.CHANNELS),
            "websocket_configured": bool(s.ws_endpoint),
        },
        "interpretation": (
            "A growing backlog with a responsive API is the system absorbing a "
            "spike by design. A non-zero DLQ means something is failing "
            "repeatedly and needs attention."
        ),
    })


def _strategy_status(project: dict) -> dict:
    """The project's strategy state, with a meaningless shadow filtered out.

    A strategy that is BOTH active and shadowing itself is not a shadow run —
    there is nothing being compared. That state is produced by promoting a
    shadow strategy straight to active: activation used to leave the shadow
    pointer behind, so the dashboard rendered "v1  SHADOW v1".

    Activation now clears the pointer, but that fix is forward-only: every
    project activated before it still carries the stale value. Resolving it
    here, at the read boundary, repairs those projects immediately and costs
    nothing, instead of requiring a data migration or a re-activation.

    A genuine shadow run — a DIFFERENT strategy evaluating alongside the live
    one — is reported exactly as before.
    """
    active_id = project.get("active_strategy_id")
    shadow_id = project.get("shadow_strategy_id")
    is_real_shadow = bool(shadow_id) and shadow_id != active_id

    return {
        "mode": project.get("mode", "draft"),
        "active_strategy_id": active_id,
        "active_version": project.get("active_strategy_version"),
        # Exposed so a client can make the same judgement without guessing from
        # version numbers, which are not unique across strategies.
        "shadow_strategy_id": shadow_id if is_real_shadow else None,
        "shadow_version": project.get("shadow_strategy_version") if is_real_shadow else None,
        "live": project.get("mode") == "active",
    }


@router.get("/live/pulse", summary="One call that paints the whole live dashboard")
async def pulse(
    ctx: ProjectDep,
    events: Annotated[int, Query(ge=0, le=50)] = 15,
    decisions: Annotated[int, Query(ge=0, le=50)] = 10,
):
    """Everything the live dashboard needs for its first paint.

    One request instead of six. A client calls this on load and when a socket
    reconnects, then relies on the WebSocket for updates — so a dropped
    connection never leaves a blank screen.
    """
    now = db.now_ms()

    # Sequential on purpose: this endpoint was already 26ms and fanning three
    # short reads across threads measured SLOWER (33ms). Concurrency only pays
    # when the individual calls are slow enough to amortise the thread cost.
    event_rows = db.query_prefix(
        db.context(), f"EVTFEED#{ctx.project_id}", "",
        limit=max(events, 1), ascending=False)[0] if events else []
    decision_rows = db.query_prefix(
        db.decisions(), db.decfeed_pk(ctx.project_id), "",
        limit=max(decisions, 1), ascending=False)[0] if decisions else []
    alerts = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id), db.sk_alert_prefix(),
        limit=20, ascending=False)[0]

    window = [d for d in decision_rows if (d.get("ts") or 0) > now - 3_600_000]
    open_alerts = [
        a for a in alerts
        if a.get("project_id") == ctx.project_id and a.get("status", "open") == "open"
    ]

    return ok({
        "status": _strategy_status(ctx.project),
        "counters": {
            "decisions_last_hour": len(window),
            "price_changes_last_hour": sum(1 for d in window if d.get("changed")),
            "fallbacks_last_hour": sum(1 for d in window if d.get("fallback")),
            "degraded_last_hour": sum(1 for d in window if d.get("degraded")),
            "open_alerts": len(open_alerts),
            "critical_alerts": sum(
                1 for a in open_alerts if a.get("severity") == "critical"
            ),
        },
        "live_events": [
            {
                "ts": e.get("ts"),
                "item_id": e.get("item_id"),
                "event_type": e.get("event_type"),
                "quantity": e.get("quantity"),
            }
            for e in event_rows
        ],
        "live_decisions": [
            {
                "decision_id": d.get("decision_id"),
                "item_id": d.get("item_id"),
                "previous_price": d.get("previous_price"),
                "price": d.get("final_price"),
                "changed": d.get("changed"),
                "change_pct": d.get("change_pct"),
                "rules_fired": d.get("rules_fired", []),
                "guardrails_applied": d.get("guardrail_names", []),
                "ts": d.get("ts"),
            }
            for d in decision_rows
        ],
        "alerts": [
            {
                "alert_id": a.get("alert_id"),
                "severity": a.get("severity"),
                "title": a.get("title"),
                "approval_id": a.get("approval_id"),
                "needs_decision": bool(a.get("approval_id")),
                "ts": a.get("ts"),
            }
            for a in open_alerts[:5]
        ],
        "currency": ctx.currency,
        "server_time_ms": now,
        "realtime": {
            "connected": realtime.connection_count(ctx.project_id),
            "channels": list(realtime.CHANNELS),
        },
    })


@router.get("/live/connections", summary="Who is currently watching")
async def live_connections(ctx: ProjectDep):
    """Diagnostic for the realtime layer."""
    conns = realtime.connections(ctx.project_id)
    now = db.now_ms()
    return ok({
        "count": len(conns),
        "websocket_configured": bool(settings().ws_endpoint),
        "connections": [
            {
                "connection_id": (c.get("connection_id") or "")[:12] + "…",
                "channels": c.get("channels", []),
                "connected_seconds": round((now - (c.get("connected_at") or now)) / 1000),
            }
            for c in conns
        ],
        "channels": list(realtime.CHANNELS),
    })


# ── customer-facing explain ─────────────────────────────────────────────

@router.get("/v1/p/{project_key}/explain", summary="Customer-facing price explanation")
async def explain(
    project_key: Annotated[str, Path(description="Your project API key")],
    decision_id: Annotated[str, Query()],
):
    """Why a price was what it was, for the customer's own systems.

    Authenticated by API key, like the other /v1/p routes — a customer's backend
    must never need an analyst session token.

    Served by the control-plane Lambda rather than price-fn on purpose: it reads
    the decisions table, and widening the hot path's IAM permissions for a
    non-latency-critical endpoint would be a poor trade.

    Deliberately less detailed than /decisions/replay. It returns the drivers
    and the guardrail outcome, but not rule IDs, priorities or the ruleset —
    a customer should not learn your pricing logic from an API response.
    """
    project = resolve_api_key(project_key)
    project_id = project["project_id"]

    # A malformed id can be rejected outright. For a WELL-FORMED id the server
    # cannot tell "never existed" from "not written yet" — both are a missing
    # row, and the embedded millisecond wraps every ~4.6 hours, so it is not a
    # reliable age signal. Checking the shape at least stops a typo being
    # reported as a propagation delay.
    if not _DECISION_ID_RE.match(decision_id):
        raise NotFound("decision")

    row = db.get(db.decisions(), db.dec_pk(project_id, decision_id), db.sk_meta())
    if not row:
        # Decisions are persisted by a worker off a queue, so a decision_id the
        # price API returned a moment ago is genuinely not readable yet —
        # measured at 5-20s. A bare "not found" reads as "that id is invalid"
        # and sent people hunting for a bug in ID generation. Say which it is.
        raise ApiError(
            "that decision is not readable yet — decisions are persisted "
            "asynchronously and usually become available within 5 seconds "
            "(up to 20). Retry before treating this as a missing decision.",
            code="not_ready",
            status_code=404,
            decision_id=decision_id,
            retry_after_seconds=5,
        )

    d = row.get("decision") or {}
    guardrails = d.get("guardrails_applied") or []

    return ok({
        "decision_id": decision_id,
        "item_id": row.get("item_id"),
        "price": d.get("final_price"),
        "previous_price": d.get("previous_price"),
        "currency": d.get("currency"),
        "changed": d.get("changed"),
        "change_pct": d.get("change_pct"),
        "drivers": [
            {"factor": dr.get("factor"), "impact": dr.get("impact")}
            for dr in d.get("drivers", [])
        ],
        "capped_by_guardrail": bool(guardrails),
        "guardrails_applied": [g.get("rule") for g in guardrails],
        "degraded": d.get("degraded", False),
        "fallback": d.get("fallback", False),
        "explanation": describe_decision(d),
        "generated_at": row.get("ts"),
    })
