"""Audit trail.

Every state change writes one record. The spec requires who / what / when /
old value / new value / strategy version / rule version / decision id, and
rollback depends on this being complete — you cannot revert what you did not
record.

Audit writes are deliberately synchronous and in the same request as the change
they describe. Queueing them would make the trail eventually-consistent, and an
audit log that might be missing the last few entries is not an audit log.
"""

from __future__ import annotations

from typing import Any

from core import db, ids

# Actions are a closed vocabulary so the UI can filter and label them without
# string-matching free text.
ACTIONS = {
    "TENANT_CREATED", "USER_SIGNED_UP",
    "PROJECT_CREATED", "DOMAIN_SAVED", "GUARDRAILS_SAVED", "APIKEY_ROTATED",
    "ITEM_CREATED", "ITEM_UPDATED",
    "DATA_UPLOADED", "DATA_PROCESSED",
    "RULE_CREATED", "RULE_UPDATED", "RULE_DISABLED", "RULE_ENABLED",
    "STRATEGY_CREATED", "STRATEGY_UPDATED", "STRATEGY_VALIDATED",
    "STRATEGY_PROMOTED", "STRATEGY_PAUSED", "STRATEGY_ROLLED_BACK",
    "BACKTEST_RUN",
    "PRICE_GENERATED", "FALLBACK_ENGAGED",
    "ALERT_RAISED", "ALERT_ACKED",
    "APPROVAL_REQUESTED", "APPROVAL_ANSWERED", "APPROVAL_EXPIRED",
    "PUBLISH_REQUESTED", "PUBLISH_APPROVED", "PUBLISH_REJECTED",
    "AI_CONFIG_GENERATED",
    "DEVICE_REGISTERED",
    "CHAOS_INJECTED",
}


def record(
    *,
    tenant_id: str,
    action: str,
    actor: str,
    project_id: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    old_value: Any = None,
    new_value: Any = None,
    strategy_version: str | None = None,
    rule_version: str | None = None,
    decision_id: str | None = None,
    note: str | None = None,
    source: str = "web",
) -> dict:
    """Write one audit entry. Returns it so callers can echo the id."""
    ts = db.now_ms()
    audit_id = ids.audit_id()
    item = {
        "pk": db.pk_tenant(tenant_id),
        "sk": db.sk_audit(ts, audit_id),
        "audit_id": audit_id,
        "action": action,
        "actor": actor,
        "source": source,          # web | android | api | system
        "project_id": project_id,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "old_value": old_value,
        "new_value": new_value,
        "strategy_version": strategy_version,
        "rule_version": rule_version,
        "decision_id": decision_id,
        "note": note,
        "ts": ts,
    }
    db.put(db.core(), {k: v for k, v in item.items() if v is not None})
    return item


MAX_FILTER_PAGES = 12


def listing(
    tenant_id: str,
    *,
    project_id: str | None = None,
    entity_type: str | None = None,
    limit: int = 50,
    cursor: dict | None = None,
) -> tuple[list[dict], dict | None]:
    """Newest first, filtered server-side.

    Audit entries live in one partition per TENANT, so a per-project view has
    to filter. Filtering a single bounded page is wrong once a tenant has more
    than a handful of projects: the newest page fills up with whichever project
    is busiest and every other project reports zero history even though its
    entries exist a page or two deeper. That is how this looked in testing —
    seven projects each with real activity returning an empty audit trail.

    So we page until `limit` matches are found or the partition is exhausted,
    capped so one request cannot walk an unbounded history.
    """
    out: list[dict] = []
    nxt = cursor
    pages = 0
    filtering = bool(project_id or entity_type)

    while True:
        rows, nxt = db.query_prefix(
            db.core(), db.pk_tenant(tenant_id), db.sk_audit_prefix(),
            limit=max(limit, 100) if filtering else limit,
            cursor=nxt, ascending=False,
        )
        if project_id:
            rows = [r for r in rows if r.get("project_id") == project_id]
        if entity_type:
            rows = [r for r in rows if r.get("entity_type") == entity_type]
        out.extend(rows)
        pages += 1

        if len(out) >= limit or not nxt or not filtering or pages >= MAX_FILTER_PAGES:
            break

    return out[:limit], nxt
