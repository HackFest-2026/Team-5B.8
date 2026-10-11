"""Rule management.

A rule is `conditions -> adjustment`, plus a priority and a stacking policy.
Rules are versioned rather than edited in place: `/rules/update` writes a new
version and keeps the old one, because a decision made last Tuesday must still
be explainable against the rule text that produced it.

`/rules/conflicts` is static analysis — it runs with no context and no live
traffic, so an analyst finds out that two rules fight each other before
activation rather than from a strange price in production.
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import ProjectDep
from app.routers.strategies import add_rule_to_active, resync_active_strategy
from app.responses import ApiError, NotFound, ok
from core import audit, db, ids
from core.engine import (
    Guardrails,
    Rule,
    compile_rules,
    describe_rule,
    detect_conflicts,
)

router = APIRouter(tags=["rules"])

VALID_OPERATORS = {">", ">=", "<", "<=", "==", "!=", "in", "not_in", "between"}
VALID_ADJUST = {"percentage", "absolute", "multiplier", "set_price", "formula"}
VALID_FORMULA_MODES = {"percent", "amount", "price"}


def _known_fields(schema: dict) -> set[str]:
    out = {s["id"] for s in (schema.get("context_signals") or [])}
    out |= {a["id"] for a in (schema.get("attributes") or [])}
    out |= {"day_of_week", "hour_of_day", "season"}
    # Reserved, always-readable fields — usable in a condition without being
    # declared, e.g. a formula rule gated on "base_price > 0".
    out |= {"base_price", "price", "cost"}
    # Basket aggregates, available on the cart pricing endpoint. Reserved so a
    # rule like "cart_subtotal >= 5000 -> free shipping" validates even though
    # the value is computed per request, never declared.
    out |= {"cart_lines", "cart_units", "cart_subtotal", "line_quantity"}
    return out


def _parse(raw: str, field: str, limit: int = 4096):
    if len(raw) > limit:
        raise ApiError(
            f"{field} is {len(raw)} bytes; the URL budget is {limit}",
            code="payload_too_large",
        )
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(f"{field} is not valid JSON: {exc}") from exc


def _validate_clauses(clauses: list, fields: set[str]) -> list[dict]:
    if not isinstance(clauses, list) or not clauses:
        raise ApiError("conditions must be a non-empty JSON array")
    out = []
    for i, c in enumerate(clauses, 1):
        if not isinstance(c, dict):
            raise ApiError(f"condition {i} must be an object")
        f = c.get("field")
        if f not in fields:
            raise ApiError(
                f"condition {i}: '{f}' is not a signal or attribute in this project",
                known_fields=sorted(fields),
            )
        op = c.get("operator")
        if op not in VALID_OPERATORS:
            raise ApiError(f"condition {i}: unsupported operator '{op}'")

        value = c.get("value")
        value2 = c.get("value2")
        if op in ("in", "not_in"):
            if not isinstance(value, list) or not value:
                raise ApiError(f"condition {i}: '{op}' needs a non-empty list value")
        elif op == "between":
            if value is None or value2 is None:
                raise ApiError(f"condition {i}: 'between' needs value and value2")
            if float(value) >= float(value2):
                raise ApiError(f"condition {i}: 'between' bounds are reversed")
        elif value is None:
            raise ApiError(f"condition {i}: missing value")

        out.append({"field": f, "operator": op, "value": value, "value2": value2})
    return out


def _validate_adjustment(adj: dict, fields: set[str]) -> dict:
    if not isinstance(adj, dict):
        raise ApiError("adjustment must be a JSON object")
    t = adj.get("type", "percentage")
    if t not in VALID_ADJUST:
        raise ApiError(f"unsupported adjustment type '{t}'")

    # A formula carries an expression instead of a value. It is parsed and
    # whitelist-checked here, once, so an unsafe or broken formula can never be
    # saved — the hot path trusts that whatever it loads already passed.
    if t == "formula":
        expr = (adj.get("expr") or "").strip()
        mode = adj.get("formula_mode", "percent")
        if mode not in VALID_FORMULA_MODES:
            raise ApiError("formula_mode must be percent, amount or price")
        from core.engine import formula as _formula
        try:
            _formula.validate(expr, fields | {"base", "base_price", "cost"})
        except _formula.FormulaError as exc:
            raise ApiError(f"formula: {exc}") from exc
        return {"type": "formula", "value": 0.0, "direction": "increase",
                "expr": expr, "formula_mode": mode}

    try:
        value = float(adj.get("value"))
    except (TypeError, ValueError):
        raise ApiError("adjustment.value must be a number")
    if value < 0:
        raise ApiError("adjustment.value must be positive — use direction to decrease")
    if t == "percentage" and value > 1000:
        raise ApiError("a percentage adjustment above 1000% is almost certainly a typo")
    direction = adj.get("direction", "increase")
    if direction not in ("increase", "decrease"):
        raise ApiError("adjustment.direction must be 'increase' or 'decrease'")
    return {"type": t, "value": value, "direction": direction}


def _load_rules(ctx) -> list[dict]:
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id), db.sk_rule_prefix(ctx.project_id), limit=500
    )
    return rows


@router.get("/rules/create", summary="Create a pricing rule")
async def create_rule(
    ctx: ProjectDep,
    name: Annotated[str, Query()],
    conditions: Annotated[str, Query(description='URL-encoded JSON array of {field,operator,value}')],
    adjustment: Annotated[str, Query(description='URL-encoded JSON {type,value,direction}')],
    logic: Annotated[str, Query(description="all | any")] = "all",
    priority: Annotated[int, Query(ge=0, le=1000)] = 50,
    stackable: Annotated[bool, Query()] = True,
    conflict_group: Annotated[str, Query(description="Rules in one group are mutually exclusive")] = "",
    enabled: Annotated[bool, Query()] = True,
    starts_at: Annotated[int | None, Query(description="Epoch ms; rule applies only from this time")] = None,
    ends_at: Annotated[int | None, Query(description="Epoch ms; rule stops applying at this time")] = None,
    go_live: Annotated[bool, Query(description="Add to the active strategy immediately so the rule is live on create")] = True,
):
    if logic not in ("all", "any"):
        raise ApiError("logic must be 'all' or 'any'")
    if starts_at is not None and ends_at is not None and ends_at <= starts_at:
        raise ApiError("ends_at must be after starts_at")

    fields = _known_fields(ctx.schema)
    clauses = _validate_clauses(_parse(conditions, "conditions"), fields)
    adj = _validate_adjustment(_parse(adjustment, "adjustment", 512), fields)

    rule_id = ids.rule_id()
    now = db.now_ms()
    doc = {
        "pk": db.pk_tenant(ctx.tenant_id),
        "sk": db.sk_rule(ctx.project_id, rule_id),
        "project_id": ctx.project_id,
        "rule_id": rule_id,
        "name": name.strip() or rule_id,
        "clauses": clauses,
        "adjustment": adj,
        "logic": logic,
        "priority": priority,
        "stackable": stackable,
        "conflict_group": conflict_group.strip() or None,
        "enabled": enabled,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "version": "v1",
        "origin": "manual",
        "trigger_count": 0,
        "created_at": now,
        "updated_at": now,
        "created_by": ctx.session.user_id,
    }
    db.put(db.core(), doc)

    audit.record(
        tenant_id=ctx.tenant_id, action="RULE_CREATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="rule", entity_id=rule_id,
        rule_version="v1", new_value={"name": doc["name"], "priority": priority},
    )

    rule_obj = Rule.from_dict(doc)
    siblings = [Rule.from_dict(r) for r in _load_rules(ctx) if r["rule_id"] != rule_id]
    conflicts = [
        c for c in detect_conflicts(siblings + [rule_obj]) if rule_id in c["rules"]
    ]

    # Live by default: a new enabled rule joins the active strategy at once, so
    # it prices immediately (and shows in tests) without a manual republish. No
    # active strategy yet (a brand-new project) → this is a no-op and the rule
    # goes live when the first strategy is built from all rules.
    went_live = False
    if go_live and enabled:
        try:
            went_live = add_rule_to_active(ctx, rule_id)
        except Exception:  # noqa: BLE001 - a resync failure must not fail the create
            went_live = False

    return ok({
        "rule_id": rule_id,
        "rule": {k: v for k, v in doc.items() if k not in ("pk", "sk")},
        "explanation": describe_rule(rule_obj, schema=ctx.schema, currency=ctx.currency),
        "conflicts": conflicts,
        "live": went_live,
    })


@router.get("/rules/update", summary="Update a rule (creates a new version)")
async def update_rule(
    ctx: ProjectDep,
    rule_id: Annotated[str, Query()],
    name: Annotated[str, Query()] = "",
    conditions: Annotated[str, Query()] = "",
    adjustment: Annotated[str, Query()] = "",
    logic: Annotated[str, Query()] = "",
    priority: Annotated[int | None, Query(ge=0, le=1000)] = None,
    stackable: Annotated[bool | None, Query()] = None,
    conflict_group: Annotated[str | None, Query()] = None,
    enabled: Annotated[bool | None, Query()] = None,
    starts_at: Annotated[int | None, Query()] = None,
    ends_at: Annotated[int | None, Query()] = None,
    clear_window: Annotated[bool, Query(description="Remove the rule's date window")] = False,
):
    """Partial update. Omitted parameters keep their current value.

    Disabling is done here (`enabled=false`) rather than through a delete
    endpoint: a deleted rule would leave past decisions referencing something
    that no longer exists, breaking Decision Replay.
    """
    existing = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_rule(ctx.project_id, rule_id))
    if not existing:
        raise NotFound("rule")

    changes: dict = {}
    old_summary = {
        "name": existing.get("name"), "priority": existing.get("priority"),
        "enabled": existing.get("enabled"), "version": existing.get("version"),
    }

    if name.strip():
        changes["name"] = name.strip()
    if conditions:
        changes["clauses"] = _validate_clauses(
            _parse(conditions, "conditions"), _known_fields(ctx.schema)
        )
    if adjustment:
        changes["adjustment"] = _validate_adjustment(_parse(adjustment, "adjustment", 512), _known_fields(ctx.schema))
    if logic:
        if logic not in ("all", "any"):
            raise ApiError("logic must be 'all' or 'any'")
        changes["logic"] = logic
    if priority is not None:
        changes["priority"] = priority
    if stackable is not None:
        changes["stackable"] = stackable
    if conflict_group is not None:
        changes["conflict_group"] = conflict_group.strip() or None
    if enabled is not None:
        changes["enabled"] = enabled
    # A date window is an explicit choice, so it is cleared explicitly rather
    # than by sending blanks (which the GET convention drops).
    if clear_window:
        changes["starts_at"] = None
        changes["ends_at"] = None
    else:
        if starts_at is not None:
            changes["starts_at"] = starts_at
        if ends_at is not None:
            changes["ends_at"] = ends_at
    s_at = changes.get("starts_at", existing.get("starts_at"))
    e_at = changes.get("ends_at", existing.get("ends_at"))
    if s_at is not None and e_at is not None and e_at <= s_at:
        raise ApiError("ends_at must be after starts_at")

    if not changes:
        raise ApiError("nothing to update — pass at least one field")

    # Version bumps only on a semantic change. Renaming a rule or toggling it
    # does not invalidate the logic that produced historical decisions.
    semantic = {"clauses", "adjustment", "logic", "priority", "stackable", "conflict_group", "starts_at", "ends_at"}
    if semantic & changes.keys():
        n = int(str(existing.get("version", "v1")).lstrip("v") or 1)
        changes["version"] = f"v{n + 1}"

    changes["updated_at"] = db.now_ms()
    updated = db.update(db.core(), db.pk_tenant(ctx.tenant_id),
                        db.sk_rule(ctx.project_id, rule_id), changes)

    audit.record(
        tenant_id=ctx.tenant_id,
        action="RULE_DISABLED" if changes.get("enabled") is False else "RULE_UPDATED",
        actor=ctx.session.user_id, project_id=ctx.project_id,
        entity_type="rule", entity_id=rule_id,
        rule_version=changes.get("version", existing.get("version")),
        old_value=old_summary,
        new_value={k: v for k, v in changes.items() if k != "updated_at"},
    )

    rule_obj = Rule.from_dict(updated)
    return ok({
        "rule_id": rule_id,
        "rule": {k: v for k, v in (updated or {}).items() if k not in ("pk", "sk")},
        "explanation": describe_rule(rule_obj, schema=ctx.schema, currency=ctx.currency),
        "version_bumped": "version" in changes,
        "note": "Active strategies keep running their compiled snapshot until "
                "you promote a new strategy version.",
    })


@router.get("/rules/toggle", summary="Switch one rule on or off (live)")
async def toggle_rule(
    ctx: ProjectDep,
    rule_id: Annotated[str, Query()],
    enabled: Annotated[bool, Query(description="true to apply the rule, false to switch it off")],
):
    """Turn a single rule on or off, effective immediately.

    Unlike editing a rule, this does not create a new version — the rule set is
    the same, only whether this one applies changes. If the rule belongs to the
    strategy that is currently live, the active snapshot is rebuilt in place so
    the switch takes effect on the very next price request. Past decisions keep
    their own snapshots, so nothing already recorded changes.
    """
    rule_id = rule_id.strip()
    existing = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_rule(ctx.project_id, rule_id))
    if not existing:
        raise NotFound("rule")

    was = bool(existing.get("enabled", True))
    now = db.now_ms()
    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_rule(ctx.project_id, rule_id),
              {"enabled": enabled, "updated_at": now})

    # Re-sync only when the rule is part of the live strategy; otherwise there
    # is nothing running to update.
    header = None
    sid = ctx.project.get("active_strategy_id")
    if sid:
        header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                        db.sk_strategy(ctx.project_id, sid))
    in_active = bool(header and rule_id in (header.get("rule_ids") or []))
    resynced = resync_active_strategy(ctx) if in_active else False

    audit.record(
        tenant_id=ctx.tenant_id,
        action="RULE_DISABLED" if not enabled else "RULE_ENABLED",
        actor=ctx.session.user_id, project_id=ctx.project_id,
        entity_type="rule", entity_id=rule_id,
        old_value={"enabled": was}, new_value={"enabled": enabled},
        note="live re-sync" if resynced else None,
    )

    return ok({
        "rule_id": rule_id,
        "enabled": enabled,
        "in_active_strategy": in_active,
        # Honest about reach: a rule not in the live strategy is switched for
        # when it next goes live, not right now.
        "effective": (
            "immediately — the next price request reflects it" if resynced
            else "saved; applies when this rule's strategy is next activated"
        ),
    })


@router.get("/rules/delete", summary="Delete a rule (live)")
async def delete_rule(
    ctx: ProjectDep,
    rule_id: Annotated[str, Query()],
):
    """Permanently remove a rule.

    If the rule is part of the live strategy, it is dropped from it and the
    active snapshot is rebuilt in place, so it stops affecting prices on the
    very next request. Past decisions keep their own snapshots, so nothing
    already recorded changes. The rule set shrinking is what actually clears a
    duplicate/conflict — disabling leaves it in the list, deleting removes it.
    """
    rule_id = rule_id.strip()
    existing = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_rule(ctx.project_id, rule_id))
    if not existing:
        raise NotFound("rule")

    # Pull it out of the active strategy first, so a resync recompiles without
    # it. Done before the row is deleted so the header stays consistent.
    sid = ctx.project.get("active_strategy_id")
    in_active = False
    if sid:
        header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                        db.sk_strategy(ctx.project_id, sid))
        ids = list((header or {}).get("rule_ids") or [])
        if rule_id in ids:
            in_active = True
            db.update(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_strategy(ctx.project_id, sid),
                      {"rule_ids": [r for r in ids if r != rule_id]})

    db.delete(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_rule(ctx.project_id, rule_id))
    resynced = resync_active_strategy(ctx) if in_active else False

    audit.record(
        tenant_id=ctx.tenant_id, action="RULE_DELETED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="rule", entity_id=rule_id,
        old_value={"name": existing.get("name")},
    )

    return ok({
        "rule_id": rule_id,
        "deleted": True,
        "in_active_strategy": in_active,
        "effective": (
            "immediately — the next price request no longer uses it" if resynced
            else "removed"
        ),
    })


@router.get("/rules/list", summary="All rules for this project")
async def list_rules(
    ctx: ProjectDep,
    include_disabled: Annotated[bool, Query()] = True,
):
    rows = _load_rules(ctx)
    if not include_disabled:
        rows = [r for r in rows if r.get("enabled", True)]
    rows.sort(key=lambda r: (-r.get("priority", 50), r.get("rule_id", "")))

    return ok({
        "count": len(rows),
        "rules": [
            {
                "rule_id": r["rule_id"], "name": r.get("name"),
                "clauses": r.get("clauses", []), "adjustment": r.get("adjustment"),
                "logic": r.get("logic", "all"), "priority": r.get("priority", 50),
                "stackable": r.get("stackable", True),
                "conflict_group": r.get("conflict_group"),
                "enabled": r.get("enabled", True), "version": r.get("version", "v1"),
                "origin": r.get("origin", "manual"),
                "trigger_count": r.get("trigger_count", 0),
                "explanation": describe_rule(
                    Rule.from_dict(r), schema=ctx.schema, currency=ctx.currency
                ),
            }
            for r in rows
        ],
    })


@router.get("/rules/conflicts", summary="Static conflict detection")
async def rule_conflicts(
    ctx: ProjectDep,
    rule_ids: Annotated[str, Query(description="Comma-separated subset; omit to check all")] = "",
):
    """Find rules that will fight, before they go live.

    Detects ambiguous priorities inside a conflict group, overlapping
    conditions pushing opposite ways, and stackable sets whose combined effect
    would be capped by guardrails anyway.
    """
    rows = [r for r in _load_rules(ctx) if r.get("enabled", True)]
    if rule_ids:
        wanted = {x.strip() for x in rule_ids.split(",") if x.strip()}
        rows = [r for r in rows if r["rule_id"] in wanted]

    rules = compile_rules(rows)
    issues = detect_conflicts(rules)
    names = {r.rule_id: r.name for r in rules}
    for i in issues:
        i["rule_names"] = [names.get(rid, rid) for rid in i["rules"]]

    errors = [i for i in issues if i["severity"] == "error"]
    return ok({
        "rules_checked": len(rules),
        "conflicts": issues,
        "error_count": len(errors),
        "warning_count": len(issues) - len(errors),
        "safe_to_activate": not errors,
    })
