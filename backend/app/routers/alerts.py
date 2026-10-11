"""Alert centre.

Severity decides reach, and that is the whole anti-spam policy:

    info      dashboard only, never pushed
    warning   dashboard + push to devices that opted in
    critical  dashboard + push to every device, and usually an approval request

Alerts are raised by workers (feature-worker on anomalies, price-fn on
fallbacks, data-worker on bad uploads), not by this router. This router is the
read and acknowledge surface.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import RegisteredDep
from app.responses import ApiError, NotFound, ok
from core import audit, db

router = APIRouter(tags=["alerts"])

STATUSES = ("open", "acked", "resolved", "dismissed")


@router.get("/alerts/list", summary="Alert centre")
async def list_alerts(
    session: RegisteredDep,
    project_id: Annotated[str, Query(description="Omit for all projects — mobile uses this")] = "",
    severity: Annotated[str, Query(description="info | warning | critical")] = "",
    status: Annotated[str, Query(description="open | acked | resolved | dismissed")] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(session.tenant_id), db.sk_alert_prefix(),  # type: ignore[arg-type]
        limit=limit * 3, ascending=False,
    )
    if project_id:
        rows = [r for r in rows if r.get("project_id") == project_id]
    if severity:
        rows = [r for r in rows if r.get("severity") == severity]
    if status:
        rows = [r for r in rows if r.get("status", "open") == status]

    counts = {s: 0 for s in STATUSES}
    by_severity = {"info": 0, "warning": 0, "critical": 0}
    for r in rows:
        counts[r.get("status", "open")] = counts.get(r.get("status", "open"), 0) + 1
        sev = r.get("severity", "info")
        by_severity[sev] = by_severity.get(sev, 0) + 1

    return ok({
        "count": len(rows[:limit]),
        "alerts": [
            {
                "alert_id": r.get("alert_id"),
                "project_id": r.get("project_id"),
                "severity": r.get("severity"),
                "type": r.get("type"),
                "title": r.get("title"),
                "message": r.get("message"),
                "item_id": r.get("item_id"),
                "decision_id": r.get("decision_id"),
                "approval_id": r.get("approval_id"),
                "status": r.get("status", "open"),
                "ts": r.get("ts"),
            }
            for r in rows[:limit]
        ],
        "summary": {"by_status": counts, "by_severity": by_severity},
    })


@router.get("/alerts/get", summary="Alert detail")
async def get_alert(
    session: RegisteredDep,
    alert_id: Annotated[str, Query()],
    ts: Annotated[int, Query(description="Alert timestamp from the list response")] = 0,
):
    """Problem, reason, impact, recommended action.

    `ts` is part of the sort key, so passing it makes this a direct GetItem.
    Without it we fall back to a bounded Query — convenient for a deep link
    where only the id is available.
    """
    row = None
    if ts:
        row = db.get(db.core(), db.pk_tenant(session.tenant_id),  # type: ignore[arg-type]
                     db.sk_alert(ts, alert_id))
    if not row:
        rows, _ = db.query_prefix(
            db.core(), db.pk_tenant(session.tenant_id), db.sk_alert_prefix(),  # type: ignore[arg-type]
            limit=300, ascending=False,
        )
        row = next((r for r in rows if r.get("alert_id") == alert_id), None)
    if not row:
        raise NotFound("alert")

    return ok({
        "alert": {
            "alert_id": alert_id,
            "project_id": row.get("project_id"),
            "severity": row.get("severity"),
            "type": row.get("type"),
            "title": row.get("title"),
            "message": row.get("message"),
            "problem": row.get("problem") or row.get("message"),
            "reason": row.get("reason"),
            "impact": row.get("impact"),
            "recommended_action": row.get("recommended_action"),
            "telemetry": row.get("telemetry", {}),
            "item_id": row.get("item_id"),
            "decision_id": row.get("decision_id"),
            "approval_id": row.get("approval_id"),
            "status": row.get("status", "open"),
            "ts": row.get("ts"),
            "acked_by": row.get("acked_by"),
            "acked_at": row.get("acked_at"),
        },
        "links": {
            "replay": (
                f"/decisions/replay?project_id={row.get('project_id')}"
                f"&decision_id={row.get('decision_id')}"
                if row.get("decision_id") else None
            ),
            "approval": (
                f"/approvals/get?approval_id={row.get('approval_id')}"
                if row.get("approval_id") else None
            ),
        },
    })


@router.get("/alerts/ack", summary="Acknowledge, resolve or dismiss")
async def ack_alert(
    session: RegisteredDep,
    alert_id: Annotated[str, Query()],
    action: Annotated[str, Query(description="ack | resolve | dismiss")] = "ack",
    ts: Annotated[int, Query()] = 0,
    note: Annotated[str, Query()] = "",
):
    if action not in ("ack", "resolve", "dismiss"):
        raise ApiError("action must be ack, resolve or dismiss")

    if not ts:
        rows, _ = db.query_prefix(
            db.core(), db.pk_tenant(session.tenant_id), db.sk_alert_prefix(),  # type: ignore[arg-type]
            limit=300, ascending=False,
        )
        found = next((r for r in rows if r.get("alert_id") == alert_id), None)
        if not found:
            raise NotFound("alert")
        ts = found["ts"]

    status = {"ack": "acked", "resolve": "resolved", "dismiss": "dismissed"}[action]
    updated = db.update(
        db.core(), db.pk_tenant(session.tenant_id), db.sk_alert(ts, alert_id),  # type: ignore[arg-type]
        {
            "status": status, "acked_by": session.user_id,
            "acked_at": db.now_ms(), "ack_note": note,
        },
    )
    if not updated:
        raise NotFound("alert")

    audit.record(
        tenant_id=session.tenant_id, action="ALERT_ACKED", actor=session.user_id,  # type: ignore[arg-type]
        project_id=updated.get("project_id"), entity_type="alert", entity_id=alert_id,
        new_value={"status": status}, note=note or None,
    )

    return ok({"alert_id": alert_id, "status": status, "acked_by": session.user_id})
