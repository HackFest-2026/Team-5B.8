"""Approval APIs — the decision loop.

    GET /approvals/pending   called the moment a home screen opens
    GET /approvals/get       deep link target from an FCM notification
    GET /approvals/answer    the analyst picks one option
    GET /approvals/history   what was asked, chosen, and what happened
    GET /notify/send         send a push (also used to re-notify)

`/approvals/pending` is the most latency-sensitive read in the product: it runs
on every app open, often on mobile data. It is one DynamoDB Query against a
sparse prefix, with no model call and no fan-out. The question and its options
were written by Gemini earlier, on the alert path, before the phone ever buzzed.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import ProjectDep, RegisteredDep
from app.responses import ApiError, NotFound, ok
from core import db
from core.approvals import service
from core.notify import fcm

router = APIRouter(tags=["approvals"])


@router.get("/approvals/pending", summary="Open decisions awaiting this analyst")
async def pending(
    session: RegisteredDep,
    project_id: Annotated[str, Query(description="Omit for all projects")] = "",
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    """Call this on every app/home-screen open.

    Returns an empty list most of the time, and that is the point: the client
    renders a decision card only when there genuinely is one.
    """
    rows = service.pending(
        session.tenant_id, project_id=project_id or None, limit=limit  # type: ignore[arg-type]
    )
    return ok({
        "count": len(rows),
        "has_pending": bool(rows),
        "approvals": rows,
        "most_urgent": next(
            (r for r in rows if r.get("severity") == "critical"),
            rows[0] if rows else None,
        ),
    })


@router.get("/approvals/get", summary="One approval in full")
async def get_approval(
    session: RegisteredDep,
    approval_id: Annotated[str, Query()],
):
    """Deep-link target for a notification tap."""
    row = service.get(session.tenant_id, approval_id)  # type: ignore[arg-type]
    if not row:
        raise NotFound("approval")
    return ok({"approval": row})


@router.get("/approvals/answer", summary="Choose an option and execute it")
async def answer(
    session: RegisteredDep,
    approval_id: Annotated[str, Query()],
    option_id: Annotated[str, Query(description="option_id from the approval's options")],
    note: Annotated[str, Query(description="Optional free-text reason, kept in the audit log")] = "",
    source: Annotated[str, Query(description="web | android")] = "web",
):
    """Record the choice and run the action behind it.

    Idempotent: answering twice returns the first outcome rather than executing
    again. Mobile clients retry on flaky connections, and rolling a strategy
    back twice would be a genuine incident.
    """
    result = service.answer(
        tenant_id=session.tenant_id,  # type: ignore[arg-type]
        approval_id=approval_id,
        option_id=option_id,
        actor=session.user_id,
        note=note,
        source=source if source in ("web", "android") else "web",
    )
    if not result.get("ok"):
        raise ApiError(result.get("error", "could not answer"),
                       **{k: v for k, v in result.items() if k not in ("ok", "error")})
    return ok(result)


@router.get("/approvals/history", summary="Past decisions and their outcomes")
async def history(
    session: RegisteredDep,
    project_id: Annotated[str, Query()] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    rows = service.history(
        session.tenant_id, project_id=project_id or None, limit=limit  # type: ignore[arg-type]
    )
    answered = [r for r in rows if r.get("status") == "answered"]
    followed = [r for r in answered if r.get("followed_recommendation")]
    times = [r["response_seconds"] for r in answered if r.get("response_seconds")]

    return ok({
        "count": len(rows),
        "approvals": rows,
        "stats": {
            "answered": len(answered),
            "followed_recommendation": len(followed),
            "recommendation_follow_rate": (
                round(len(followed) / len(answered) * 100, 1) if answered else None
            ),
            "median_response_seconds": (
                sorted(times)[len(times) // 2] if times else None
            ),
        },
    })


@router.get("/notify/send", summary="Send a push notification")
async def send_notification(
    session: RegisteredDep,
    title: Annotated[str, Query(max_length=45)],
    body: Annotated[str, Query(max_length=160)],
    severity: Annotated[str, Query(description="info | warning | critical")] = "info",
    approval_id: Annotated[str, Query(description="Deep-link target, if any")] = "",
    project_id: Annotated[str, Query()] = "",
):
    """Push to this analyst's registered devices.

    Severity controls reach, which is what stops the app becoming noise:
        info      dashboard only, no push at all
        warning   push to devices that opted in
        critical  push to every registered device, high priority
    """
    if severity not in ("info", "warning", "critical"):
        raise ApiError("severity must be info, warning or critical")

    if severity == "info":
        return ok({
            "sent": 0,
            "skipped": True,
            "reason": "info-level alerts stay on the dashboard and are never pushed",
        })

    devices, _ = db.query_prefix(
        db.core(), db.pk_tenant(session.tenant_id), db.sk_device_prefix(), limit=50  # type: ignore[arg-type]
    )
    if not devices:
        return ok({"sent": 0, "reason": "no registered devices"})

    result = fcm.send_to_devices(
        devices=devices,
        title=title,
        body=body,
        severity=severity,
        data={
            "approval_id": approval_id,
            "project_id": project_id,
            "type": "approval" if approval_id else "alert",
        },
        tenant_id=session.tenant_id,  # type: ignore[arg-type]
    )
    return ok(result)


@router.get("/approvals/raise", summary="Raise a decision for review (real approval + push)")
async def raise_approval(
    ctx: ProjectDep,
    reason: Annotated[str, Query(description="Optional headline for the decision")] = "",
):
    """Open a REAL approval for this project on demand.

    Uses the exact pipeline the alert worker uses — a genuine approval with real
    options, a real audit entry (APPROVAL_REQUESTED), answerable via
    /approvals/answer, and a real FCM push — but triggered deterministically
    instead of waiting for an anomaly heuristic to fire. For demos and drills.
    """
    project = ctx.project
    rows, _ = db.query_prefix(
        db.decisions(), db.decfeed_pk(ctx.project_id), "", limit=1, ascending=False
    )
    last = rows[0] if rows else {}
    item_id = last.get("item_id")
    decision_id = last.get("decision_id")
    sid = project.get("active_strategy_id")
    cur = project.get("active_strategy_version")
    versions: list[str] = []
    if sid:
        header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                        db.sk_strategy(ctx.project_id, sid)) or {}
        versions = [v for v in (header.get("versions") or []) if v != cur]

    name = project.get("name", "this project")
    title = (reason.strip() or f"Pricing anomaly on {name}")[:60]
    price = last.get("final_price")
    msg = (
        f"Pricing on {item_id or 'an item'} moved sharply"
        + (f" (latest {price})" if price is not None else "")
        + ". Review how pricing should respond."
    )
    options = [
        {"option_id": "monitor", "label": "Keep monitoring", "action": "KEEP_MONITORING",
         "consequence": "Nothing changes; pricing keeps adapting. The alert stays open.",
         "recommended": False},
        {"option_id": "safe_mode", "label": "Activate safe mode", "action": "ACTIVATE_SAFE_MODE",
         "consequence": "Applies conservative pricing and limits rapid swings immediately.",
         "recommended": True},
        {"option_id": "pause", "label": "Pause strategy", "action": "PAUSE_STRATEGY",
         "consequence": "Freezes pricing at base within guardrails. Reversible any time.",
         "recommended": False},
    ]
    if versions:
        options.append({
            "option_id": "rollback", "label": f"Roll back to {versions[0]}",
            "action": "ROLLBACK_STRATEGY", "param_version": versions[0],
            "consequence": f"Reverts to version {versions[0]} immediately.",
            "recommended": False,
        })
    generated = {
        "severity": "critical",
        "question": f"{title} — how do you want to respond?",
        "context_summary": msg,
        "options": options,
        "recommended_option_id": "safe_mode",
        "notification_title": "Pricing decision needed",
        "notification_body": msg[:120],
    }
    approval = service.create(
        tenant_id=ctx.tenant_id, project_id=ctx.project_id,
        trigger=f"manual_review: {title}", generated=generated,
        item_id=item_id, decision_id=decision_id,
        strategy_id=sid, strategy_version=cur,
        telemetry={"final_price": price, "change_pct": last.get("change_pct")},
    )
    push = fcm.send_approval(tenant_id=ctx.tenant_id, approval=approval)
    return ok({
        "raised": True,
        "approval_id": approval.get("approval_id"),
        "pushed": push.get("sent", 0),
        "project_id": ctx.project_id,
    })
