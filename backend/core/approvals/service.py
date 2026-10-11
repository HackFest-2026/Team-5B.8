"""Approval requests — the human-in-the-loop decision flow.

The shape of it:

    something happens          alert-worker detects it
            ↓
    Gemini writes the question and the options     ← on the WRITE path
            ↓
    stored in DynamoDB, open pointer written
            ↓
    FCM push to the analyst's phone
            ↓
    analyst opens the app -> GET /approvals/pending ← one Query, ~10ms
            ↓
    analyst taps an option -> GET /approvals/answer
            ↓
    the mapped executor runs, the open pointer is deleted

The critical property: **the model runs before the notification is sent, never
while the analyst is waiting.** Gemini takes about a second; a home screen must
not. By the time the phone buzzes the question already exists, so opening the
app is a plain database read.

Storage uses two rows per approval:
    APRV#<id>              the durable record, kept forever
    APRVOPEN#<ts>#<id>     a sparse pointer carrying the full payload, deleted
                           on answer
`/approvals/pending` queries the `APRVOPEN#` prefix, so it reads only genuinely
open items instead of filtering the whole history.
"""

from __future__ import annotations

import logging

from core import audit, db, ids
from core.approvals import actions

log = logging.getLogger("devnexus.approvals")

OPEN = "open"
ANSWERED = "answered"
EXPIRED = "expired"

DEFAULT_TTL_SECONDS = 48 * 3600


def create(
    *,
    tenant_id: str,
    project_id: str,
    trigger: str,
    generated: dict,
    item_id: str | None = None,
    alert_id: str | None = None,
    strategy_id: str | None = None,
    strategy_version: str | None = None,
    decision_id: str | None = None,
    telemetry: dict | None = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> dict:
    """Persist a validated approval request and open it for answering.

    `generated` is the output of core.ai.build_approval_request — already
    validated, so every option here is guaranteed executable.
    """
    approval_id = ids.approval_id()
    ts = db.now_ms()

    record = {
        "approval_id": approval_id,
        "tenant_id": tenant_id,
        "project_id": project_id,
        "status": OPEN,
        "trigger": trigger,
        "severity": generated.get("severity", "warning"),
        "question": generated.get("question"),
        "context_summary": generated.get("context_summary"),
        "options": generated.get("options", []),
        "recommended_option_id": generated.get("recommended_option_id"),
        "notification_title": generated.get("notification_title"),
        "notification_body": generated.get("notification_body"),
        "item_id": item_id,
        "alert_id": alert_id,
        "strategy_id": strategy_id,
        "strategy_version": strategy_version,
        "decision_id": decision_id,
        "telemetry": telemetry or {},
        "ai_meta": generated.get("_meta", {}),
        "dropped_options": generated.get("dropped", []),
        "created_at": ts,
        "expires_at": db.ttl_in(ttl_seconds),
    }

    db.put(db.core(), {
        "pk": db.pk_tenant(tenant_id),
        "sk": db.sk_approval(approval_id),
        **record,
    })
    # Full payload duplicated into the pointer so the home screen needs exactly
    # one Query and no follow-up BatchGetItem.
    db.put(db.core(), {
        "pk": db.pk_tenant(tenant_id),
        "sk": db.sk_approval_open(ts, approval_id),
        **record,
        "ttl": db.ttl_in(ttl_seconds),
    })

    audit.record(
        tenant_id=tenant_id, action="APPROVAL_REQUESTED", actor="system",
        project_id=project_id, entity_type="approval", entity_id=approval_id,
        decision_id=decision_id, strategy_version=strategy_version,
        new_value={"trigger": trigger, "severity": record["severity"],
                   "options": len(record["options"])},
        source="system",
    )
    return record


def pending(tenant_id: str, *, project_id: str | None = None, limit: int = 20) -> list[dict]:
    """Open approvals, newest first. The home-screen call.

    One Query over a sparse prefix. No filter expression on history, no scan.
    """
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(tenant_id), db.sk_approval_open_prefix(),
        limit=limit * 2 if project_id else limit, ascending=False,
    )
    if project_id:
        rows = [r for r in rows if r.get("project_id") == project_id]

    now = db.now_s()
    fresh = []
    for r in rows:
        # TTL deletion lags, so expiry is enforced on read too.
        if r.get("expires_at", 0) and r["expires_at"] < now:
            continue
        fresh.append(_public(r))
    return fresh[:limit]


def get(tenant_id: str, approval_id: str) -> dict | None:
    row = db.get(db.core(), db.pk_tenant(tenant_id), db.sk_approval(approval_id))
    return _public(row) if row else None


def answer(
    *,
    tenant_id: str,
    approval_id: str,
    option_id: str,
    actor: str,
    note: str = "",
    source: str = "web",
) -> dict:
    """Record the analyst's choice and execute the action behind it.

    Answering is idempotent: a second attempt returns the original outcome
    rather than running the action twice. Phones retry on flaky networks, and
    rolling a strategy back twice would be a real incident.
    """
    row = db.get(db.core(), db.pk_tenant(tenant_id), db.sk_approval(approval_id))
    if not row:
        return {"ok": False, "error": "approval not found"}

    if row.get("status") == ANSWERED:
        return {
            "ok": True,
            "already_answered": True,
            "chosen_option_id": row.get("chosen_option_id"),
            "outcome": row.get("outcome"),
            "answered_at": row.get("answered_at"),
            "answered_by": row.get("answered_by"),
        }

    option = next(
        (o for o in row.get("options", []) if o.get("option_id") == option_id), None
    )
    if not option:
        return {
            "ok": False,
            "error": f"unknown option '{option_id}'",
            "valid_options": [o.get("option_id") for o in row.get("options", [])],
        }

    outcome = actions.execute(
        option["action"],
        tenant_id=tenant_id,
        project_id=row.get("project_id"),
        actor=actor,
        item_id=row.get("item_id"),
        param_version=option.get("param_version"),
        param_rule_id=option.get("param_rule_id"),
        param_pct=option.get("param_pct"),
        param_price=option.get("param_price"),
    )

    now = db.now_ms()
    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_approval(approval_id), {
        "status": ANSWERED,
        "chosen_option_id": option_id,
        "chosen_action": option["action"],
        "chosen_label": option.get("label"),
        "followed_recommendation": option_id == row.get("recommended_option_id"),
        "outcome": outcome,
        "answered_at": now,
        "answered_by": actor,
        "answered_from": source,
        "answer_note": note,
    })

    # Drop the open pointer so the home screen stops showing it immediately.
    db.delete(db.core(), db.pk_tenant(tenant_id),
              db.sk_approval_open(row.get("created_at", now), approval_id))

    audit.record(
        tenant_id=tenant_id, action="APPROVAL_ANSWERED", actor=actor,
        project_id=row.get("project_id"), entity_type="approval",
        entity_id=approval_id, decision_id=row.get("decision_id"),
        old_value={"status": OPEN},
        new_value={"option": option_id, "action": option["action"],
                   "applied": outcome.get("applied")},
        note=note or None, source=source,
    )

    return {
        "ok": True,
        "approval_id": approval_id,
        "chosen_option_id": option_id,
        "chosen_action": option["action"],
        "chosen_label": option.get("label"),
        "followed_recommendation": option_id == row.get("recommended_option_id"),
        "outcome": outcome,
        "answered_at": now,
    }


def history(
    tenant_id: str, *, project_id: str | None = None, limit: int = 50
) -> list[dict]:
    """Answered and expired approvals — what was asked, what was chosen, what happened."""
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(tenant_id), "APRV#", limit=limit * 2, ascending=False
    )
    if project_id:
        rows = [r for r in rows if r.get("project_id") == project_id]
    rows.sort(key=lambda r: r.get("created_at", 0), reverse=True)

    return [
        {
            "approval_id": r["approval_id"],
            "project_id": r.get("project_id"),
            "status": r.get("status"),
            "severity": r.get("severity"),
            "question": r.get("question"),
            "trigger": r.get("trigger"),
            "chosen_option_id": r.get("chosen_option_id"),
            "chosen_label": r.get("chosen_label"),
            "chosen_action": r.get("chosen_action"),
            "followed_recommendation": r.get("followed_recommendation"),
            "outcome": r.get("outcome"),
            "created_at": r.get("created_at"),
            "answered_at": r.get("answered_at"),
            "answered_by": r.get("answered_by"),
            "answered_from": r.get("answered_from"),
            "response_seconds": (
                round((r["answered_at"] - r["created_at"]) / 1000)
                if r.get("answered_at") and r.get("created_at") else None
            ),
        }
        for r in rows[:limit]
    ]


def _public(row: dict) -> dict:
    """Strip storage keys; keep everything the client renders."""
    return {
        "approval_id": row.get("approval_id"),
        "project_id": row.get("project_id"),
        "status": row.get("status"),
        "severity": row.get("severity"),
        "trigger": row.get("trigger"),
        "question": row.get("question"),
        "context_summary": row.get("context_summary"),
        "options": [
            {
                "option_id": o.get("option_id"),
                "label": o.get("label"),
                "action": o.get("action"),
                "consequence": o.get("consequence"),
                "recommended": o.get("recommended", False),
            }
            for o in row.get("options", [])
        ],
        "recommended_option_id": row.get("recommended_option_id"),
        "item_id": row.get("item_id"),
        "decision_id": row.get("decision_id"),
        "strategy_id": row.get("strategy_id"),
        "strategy_version": row.get("strategy_version"),
        "telemetry": row.get("telemetry", {}),
        "created_at": row.get("created_at"),
        "expires_at": row.get("expires_at"),
        "age_seconds": (
            round((db.now_ms() - row["created_at"]) / 1000) if row.get("created_at") else None
        ),
    }
