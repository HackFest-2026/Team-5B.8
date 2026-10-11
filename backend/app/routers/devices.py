"""Mobile companion — device registration and the aggregated home screen.

The Android app is a companion, not a second admin console. It does three
things: show what is happening, surface critical alerts, and let the analyst
make an emergency decision.

Emergency actions reuse `/strategies/promote`, `/strategies/rollback` and
`/approvals/answer`. There are no mobile-only mutation endpoints — a second
code path for the same action is a second place for them to disagree.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import RegisteredDep
from app.responses import ok
from core import audit, db, fanout, ids, rollup
from core.approvals import service as approvals

router = APIRouter(tags=["mobile"])


@router.get("/devices/register", summary="Register a device for push")
async def register_device(
    session: RegisteredDep,
    fcm_token: Annotated[str, Query(description="FCM registration token")],
    platform: Annotated[str, Query()] = "android",
    device_name: Annotated[str, Query()] = "",
    warnings_enabled: Annotated[bool, Query(description="Receive warning-level pushes too")] = True,
):
    """Register or refresh a push target.

    Keyed by a hash of the FCM token, so an app restart that returns the same
    token updates the existing row rather than creating duplicates — otherwise
    one phone would accumulate rows and receive the same alert several times.

    There is no unregister endpoint: FCM reports dead tokens on send, and
    core/notify/fcm.py prunes them automatically.
    """
    import hashlib

    device_id = "dev_" + hashlib.sha256(fcm_token.encode()).hexdigest()[:20]
    existing = db.get(db.core(), db.pk_tenant(session.tenant_id),  # type: ignore[arg-type]
                      db.sk_device(device_id))
    now = db.now_ms()

    db.put(db.core(), {
        "pk": db.pk_tenant(session.tenant_id),
        "sk": db.sk_device(device_id),
        "device_id": device_id,
        "user_id": session.user_id,
        "fcm_token": fcm_token,
        "platform": platform,
        "device_name": device_name.strip(),
        "warnings_enabled": warnings_enabled,
        "created_at": (existing or {}).get("created_at", now),
        "last_seen": now,
    })

    if not existing:
        audit.record(
            tenant_id=session.tenant_id, action="DEVICE_REGISTERED",  # type: ignore[arg-type]
            actor=session.user_id, entity_type="device", entity_id=device_id,
            new_value={"platform": platform}, source="android",
        )

    return ok({
        "device_id": device_id,
        "registered": True,
        "new_device": not existing,
        "notification_policy": {
            "critical": "always pushed",
            "warning": "pushed" if warnings_enabled else "dashboard only",
            "info": "dashboard only, never pushed",
        },
    })


@router.get("/mobile/home", summary="Everything the Android home screen needs")
async def mobile_home(
    session: RegisteredDep,
    project_id: Annotated[str, Query(description="Omit to aggregate all projects")] = "",
):
    """One aggregated call for the whole home screen.

    Deliberately one request rather than five. On mobile data, five sequential
    round trips is the difference between a screen that feels instant and one
    that visibly assembles itself.

    It also answers the question the app opens with: is there a decision waiting
    for me? `pending_decision` is non-null exactly when the analyst needs to act,
    and the client renders a decision card from it immediately — the question and
    its options were already written when the alert fired.
    """
    tenant_id = session.tenant_id  # type: ignore[assignment]

    head = fanout.gather({
        "projects": lambda: db.query_prefix(
            db.core(), db.pk_tenant(tenant_id), "PROJECT#", limit=50)[0],
        "pending": lambda: approvals.pending(
            tenant_id, project_id=project_id or None, limit=10),
        "alerts": lambda: db.query_prefix(
            db.core(), db.pk_tenant(tenant_id), db.sk_alert_prefix(),
            limit=40, ascending=False)[0],
    })
    projects = fanout.ok(head["projects"], []) or []
    if project_id:
        projects = [p for p in projects if p["project_id"] == project_id]
    pending = fanout.ok(head["pending"], []) or []
    alerts = fanout.ok(head["alerts"], []) or []
    if project_id:
        alerts = [a for a in alerts if a.get("project_id") == project_id]
    open_alerts = [a for a in alerts if a.get("status", "open") == "open"]

    # Roll up today's activity across the selected projects.
    since = db.now_ms() - 24 * 3600 * 1000

    # Pre-aggregated hourly counters, one small Query per project, fanned out.
    # This screen is the first thing the Android app loads, often on mobile
    # data, so it must not scan decision rows for every project the tenant has.
    now_ms = db.now_ms()
    per_project = fanout.pmap(
        projects, lambda pr: rollup.read_window(pr["project_id"], since, now_ms)
    )

    revenue = margin = decisions_n = changes_n = 0
    for res in per_project:
        t = (fanout.ok(res, {}) or {}).get("totals", {})
        sm = rollup.summarise(t)
        decisions_n += sm["decisions"]
        changes_n += sm["price_changes"]
        revenue += sm["revenue"]
        margin += sm["margin"]

    active = [p for p in projects if p.get("mode") == "active"]
    degraded = [p for p in projects if p.get("mode") in ("paused", "safe")]

    return ok({
        "status": {
            "live": bool(active) and not degraded,
            "label": (
                "Degraded" if degraded else ("Live" if active else "No active strategy")
            ),
            "active_projects": len(active),
            "paused_projects": len(degraded),
        },
        "pending_decision": pending[0] if pending else None,
        "pending_decision_count": len(pending),
        "metrics": {
            "decisions_24h": decisions_n,
            "price_changes_24h": changes_n,
            "change_rate_pct": (
                round(changes_n / decisions_n * 100, 1) if decisions_n else 0.0
            ),
            "revenue_24h": round(revenue, 2),
            "margin_24h": round(margin, 2),
        },
        "alerts": {
            "open": len(open_alerts),
            "critical": sum(1 for a in open_alerts if a.get("severity") == "critical"),
            "latest": [
                {
                    "alert_id": a.get("alert_id"),
                    "severity": a.get("severity"),
                    "title": a.get("title"),
                    "project_id": a.get("project_id"),
                    "ts": a.get("ts"),
                }
                for a in open_alerts[:5]
            ],
        },
        "projects": [
            {
                "project_id": p["project_id"],
                "name": p.get("name"),
                "domain_name": p.get("domain_name"),
                "mode": p.get("mode", "draft"),
                "active_strategy_version": p.get("active_strategy_version"),
                "item_count": p.get("item_count", 0),
            }
            for p in projects
        ],
        "emergency_actions": {
            "pause": "/strategies/promote?mode=paused",
            "rollback": "/strategies/rollback",
            "answer_decision": "/approvals/answer",
        },
    })
