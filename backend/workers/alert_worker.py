"""Alert worker — where an anomaly becomes a decision waiting on a phone.

    SQS alert -> store alert -> (if it needs a human) Gemini writes the
    question and options -> store approval -> FCM push

The ordering is the point. Gemini runs HERE, on the write path, before any
notification is sent. It takes roughly a second, which would be unacceptable on
a home screen but is irrelevant in a background worker. By the time the phone
buzzes, the question and its options are already in DynamoDB, so opening the app
is a single Query.

Severity decides reach, and that is the entire anti-spam policy:

    info      stored, shown on the dashboard, never pushed
    warning   pushed to devices that opted in
    critical  pushed everywhere, and gets an approval request with real options
"""

from __future__ import annotations

import json
import logging
import os
import time

from core import audit, db, ids, realtime
from core.ai import build_approval_request
from core.ai.gemini import GeminiError
from core.approvals import service as approvals
from core.notify import fcm

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("devnexus.alert_worker")

# Alert types that warrant asking a human rather than just telling them.
NEEDS_DECISION = {
    "signal_anomaly",
    "pricing_anomaly",
    "engine_failure",
    "fallback_engaged",
    "strategy_degradation",
    "guardrail_saturation",
    "rule_conflict_live",
}

# Don't ask the same question twice in this window. An anomaly that keeps
# firing should not produce twenty notifications.
DEDUP_WINDOW_MS = 15 * 60 * 1000


def _recent_similar(tenant_id: str, project_id: str, alert_type: str, item_id: str | None) -> bool:
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(tenant_id), db.sk_approval_open_prefix(),
        limit=25, ascending=False,
    )
    cutoff = db.now_ms() - DEDUP_WINDOW_MS
    for r in rows:
        if (r.get("created_at") or 0) < cutoff:
            break
        if (
            r.get("project_id") == project_id
            and r.get("trigger", "").startswith(alert_type)
            and (not item_id or r.get("item_id") == item_id)
        ):
            return True
    return False


def _describe(alert_type: str, payload: dict) -> tuple[str, str, str]:
    """Deterministic title/message/trigger text.

    Written in code, not by the model, so the alert itself is always correct
    and readable even when Gemini is unavailable.
    """
    a = payload.get("anomaly") or {}
    if alert_type == "signal_anomaly":
        direction = "spiked" if a.get("direction") == "spike" else "dropped"
        signal = (a.get("signal") or "a signal").replace("_", " ")
        title = f"{signal.capitalize()} {direction} on {a.get('item_id', 'an item')}"
        message = (
            f"{signal.capitalize()} moved from {a.get('from')} to {a.get('to')} "
            f"({a.get('change_pct'):+.0f}%)."
        )
        trigger = f"signal_anomaly: {signal} {direction} {a.get('change_pct'):+.0f}%"
        return title, message, trigger

    if alert_type == "fallback_engaged":
        return (
            "Pricing fell back to safe mode",
            payload.get("reason", "The engine could not evaluate and the safe "
                                  "fallback price was served."),
            f"fallback_engaged: {payload.get('reason', 'unknown')}",
        )

    if alert_type == "engine_failure":
        return (
            "Pricing engine error",
            payload.get("reason", "The engine raised an error during evaluation."),
            f"engine_failure: {payload.get('reason', 'unknown')}",
        )

    if alert_type == "guardrail_saturation":
        return (
            "Guardrails are capping most prices",
            f"{payload.get('blocked_pct', '?')}% of recent decisions hit a guardrail "
            f"limit. The strategy may be trying to move prices further than allowed.",
            f"guardrail_saturation: {payload.get('blocked_pct')}% capped",
        )

    if alert_type == "data_quality":
        return (
            "Upload had validation errors",
            f"{payload.get('rows_invalid', 0)} of {payload.get('rows_total', 0)} rows "
            f"were rejected.",
            f"data_quality: {payload.get('rows_invalid')} rows rejected",
        )

    return (
        alert_type.replace("_", " ").capitalize(),
        payload.get("message", "See the dashboard for detail."),
        f"{alert_type}: {payload.get('message', '')}",
    )


def _store_alert(tenant_id, project_id, alert_type, severity, title, message, payload) -> dict:
    alert_id = ids.alert_id()
    ts = db.now_ms()
    row = {
        "pk": db.pk_tenant(tenant_id),
        "sk": db.sk_alert(ts, alert_id),
        "alert_id": alert_id,
        "project_id": project_id,
        "type": alert_type,
        "severity": severity,
        "title": title,
        "message": message,
        "problem": message,
        "telemetry": payload,
        "item_id": (payload.get("anomaly") or {}).get("item_id") or payload.get("item_id"),
        "decision_id": payload.get("decision_id"),
        "status": "open",
        "ts": ts,
    }
    db.put(db.core(), row)
    audit.record(
        tenant_id=tenant_id, action="ALERT_RAISED", actor="system",
        project_id=project_id, entity_type="alert", entity_id=alert_id,
        new_value={"type": alert_type, "severity": severity}, source="system",
    )
    return row


def _gather_context(tenant_id: str, project_id: str) -> tuple[dict, dict, list[str], list[dict]]:
    """Everything the model is allowed to reference.

    Versions and rule ids are enumerated explicitly because validation will
    reject any option naming an identifier that is not in this list.
    """
    project = db.get(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id)) or {}

    strategy: dict = {}
    versions: list[str] = []
    sid = project.get("active_strategy_id")
    if sid:
        header = db.get(db.core(), db.pk_tenant(tenant_id), db.sk_strategy(project_id, sid)) or {}
        current = project.get("active_strategy_version")
        strategy = {
            "strategy_id": sid,
            "name": header.get("name"),
            "version": current,
            "mode": project.get("mode"),
            "guardrails": project.get("guardrails", {}),
        }
        # Only offer versions other than the one already live.
        versions = [v for v in (header.get("versions") or []) if v != current]

    rules, _ = db.query_prefix(
        db.core(), db.pk_tenant(tenant_id), db.sk_rule_prefix(project_id), limit=50
    )
    involved = [
        {
            "rule_id": r["rule_id"], "name": r.get("name"),
            "trigger_count": r.get("trigger_count", 0),
            "effect": f"{r.get('adjustment', {}).get('direction', '')} "
                      f"{r.get('adjustment', {}).get('value', '')}"
                      f"{'%' if r.get('adjustment', {}).get('type') == 'percentage' else ''}",
        }
        for r in rules if r.get("enabled", True)
    ][:12]

    return project, strategy, versions, involved


def _fallback_approval(title: str, message: str, versions: list[str]) -> dict:
    """A usable approval when Gemini is unavailable.

    Hand-written, deterministic, and deliberately conservative. An on-call
    analyst must never be left without options because a model was down.
    """
    options = [
        {
            "option_id": "monitor", "label": "Keep monitoring",
            "action": "KEEP_MONITORING",
            "consequence": "Nothing changes. The alert stays open.",
            "recommended": True,
        },
        {
            "option_id": "pause", "label": "Pause strategy",
            "action": "PAUSE_STRATEGY",
            "consequence": "Prices freeze at base within guardrails. Reversible any time.",
            "recommended": False,
        },
    ]
    if versions:
        options.insert(1, {
            "option_id": "rollback", "label": f"Roll back to {versions[0]}",
            "action": "ROLLBACK_STRATEGY", "param_version": versions[0],
            "consequence": f"Reverts to version {versions[0]} immediately. Reversible.",
            "recommended": False,
        })
    return {
        "severity": "critical",
        "question": f"{title} — how do you want to respond?",
        "context_summary": message,
        "options": options,
        "recommended_option_id": "monitor",
        "notification_title": title[:45],
        "notification_body": message[:120],
        "_meta": {"model": "none", "fallback": True},
    }


def handler(event, _context):
    failures: list[dict] = []

    for record in event.get("Records", []):
        message_id = record.get("messageId")
        try:
            payload = json.loads(record["body"])
            tenant_id = payload["tenant_id"]
            project_id = payload["project_id"]
            alert_type = payload.get("type", "unknown")
            severity = payload.get("severity", "info")

            title, message, trigger = _describe(alert_type, payload)
            alert = _store_alert(
                tenant_id, project_id, alert_type, severity, title, message, payload
            )

            # Push to any connected dashboard immediately — including info,
            # which belongs on screen even though it is never sent to a phone.
            try:
                realtime.publish_alert(project_id, alert)
            except Exception as exc:  # noqa: BLE001
                log.debug("realtime publish skipped: %s", exc)

            # info never leaves the dashboard.
            if severity == "info":
                continue

            needs_decision = alert_type in NEEDS_DECISION and severity == "critical"

            if needs_decision and _recent_similar(
                tenant_id, project_id, alert_type, alert.get("item_id")
            ):
                log.info("suppressing duplicate approval for %s/%s", project_id, alert_type)
                needs_decision = False

            approval = None
            if needs_decision:
                project, strategy, versions, rules = _gather_context(tenant_id, project_id)
                try:
                    generated = build_approval_request(
                        trigger=trigger,
                        project={
                            "name": project.get("name"),
                            "domain_name": project.get("domain_name"),
                            "entity_label": project.get("entity_label"),
                        },
                        telemetry=payload,
                        strategy=strategy,
                        available_versions=versions,
                        rules_involved=rules,
                        currency=project.get("currency", "INR"),
                    )
                except (GeminiError, Exception) as exc:  # noqa: BLE001
                    # The analyst still gets a decision, just a hand-written one.
                    log.warning("approval generation failed, using fallback: %s", exc)
                    generated = _fallback_approval(title, message, versions)

                approval = approvals.create(
                    tenant_id=tenant_id,
                    project_id=project_id,
                    trigger=trigger,
                    generated=generated,
                    item_id=alert.get("item_id"),
                    alert_id=alert["alert_id"],
                    strategy_id=strategy.get("strategy_id"),
                    strategy_version=strategy.get("version"),
                    decision_id=payload.get("decision_id"),
                    telemetry=payload,
                )
                db.update(
                    db.core(), db.pk_tenant(tenant_id),
                    db.sk_alert(alert["ts"], alert["alert_id"]),
                    {"approval_id": approval["approval_id"]},
                )
                # Re-publish now that the alert carries a decision, so the
                # dashboard can surface the question without a refetch.
                try:
                    realtime.publish_alert(
                        project_id, alert, approval_id=approval["approval_id"]
                    )
                except Exception:  # noqa: BLE001
                    pass

            # Push last, so the notification only ever points at something that
            # already exists.
            if approval:
                result = fcm.send_approval(tenant_id=tenant_id, approval=approval)
            else:
                devices, _ = db.query_prefix(
                    db.core(), db.pk_tenant(tenant_id), db.sk_device_prefix(), limit=50
                )
                result = fcm.send_to_devices(
                    devices=devices, title=title, body=message, severity=severity,
                    data={"type": "alert", "alert_id": alert["alert_id"],
                          "project_id": project_id},
                    tenant_id=tenant_id,
                )
            log.info(
                "alert %s (%s) stored; approval=%s; push=%s",
                alert["alert_id"], severity,
                (approval or {}).get("approval_id"), result.get("sent"),
            )

        except Exception as exc:  # noqa: BLE001
            log.exception("alert processing failed for %s: %s", message_id, exc)
            failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": failures}
