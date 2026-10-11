"""Strategies and their lifecycle.

    draft -> validated -> shadow -> active -> paused
                                 \\-> rolled back

A strategy version is an **immutable compiled snapshot**: the rules, frozen,
exactly as they were at compile time. That single decision buys three things:

  * rollback is instant — point `ACTIVE#<project>` at an older blob, no deploy
  * replay is exact    — the blob that priced a decision still exists byte for byte
  * the hot path is fast — it executes a precompiled ruleset, it does not assemble one

Promotion writes the active blob into the `context` table, next to the item
context rows. That is deliberate: the pricing handler fetches the item context
and the active strategy in a single BatchGetItem, so activation takes effect on
the very next request instead of waiting out a cache TTL.
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import ProjectDep
from app.responses import ApiError, Conflict, NotFound, ok
from core import audit, db, ids
from core.engine import (
    Guardrails,
    Rule,
    compile_rules,
    compile_strategy,
    describe_guardrails,
    describe_rule,
    detect_conflicts,
)

router = APIRouter(tags=["strategies"])

MODES = ("draft", "validated", "shadow", "active", "paused")


def _next_version(current: str | None) -> str:
    if not current:
        return "v1"
    try:
        return f"v{int(str(current).lstrip('v')) + 1}"
    except ValueError:
        return "v1"


def resync_active_strategy(ctx) -> bool:
    """Recompile the ACTIVE strategy from its rules' current state.

    The hot path reads a frozen compiled blob, so a change to a rule — enabling
    it, disabling it, editing it — does nothing until that blob is rebuilt. This
    rebuilds it in place for the strategy that is currently live, so the change
    is effective on the very next price request without a manual re-promote.

    It does NOT bump the strategy version: the rule SET is unchanged, and every
    past decision carries its own snapshot, so replay stays exact. Returns True
    if an active strategy was re-synced.
    """
    sid = ctx.project.get("active_strategy_id")
    if not sid:
        return False
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, sid))
    if not header:
        return False

    rule_ids = header.get("rule_ids") or []
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id), db.sk_rule_prefix(ctx.project_id), limit=500)
    by_id = {r["rule_id"]: r for r in rows}
    rules = [by_id[rid] for rid in rule_ids if rid in by_id]

    override = header.get("guardrails_override") or {}
    merged = {**(ctx.guardrails or {}), **override}
    v = ctx.project.get("active_strategy_version") or header.get("version")
    blob = compile_strategy(
        strategy={"strategy_id": sid, "version": v}, rules=rules, guardrails=merged)

    db.put(db.context(), {
        "pk": db.active_pk(ctx.project_id),
        "sk": db.active_sk(),
        "project_id": ctx.project_id,
        "strategy_id": sid,
        "strategy_name": header.get("name"),
        "version": v,
        "ruleset_version": blob.get("ruleset_version", v),
        "rules": blob.get("rules", []),
        "guardrails": blob.get("guardrails", {}),
        "guardrails_override": override,
        "signal_meta": _signal_meta(ctx.schema),
        "mode": ctx.project.get("mode", "active"),
        "activated_at": db.now_ms(),
        "resynced_at": db.now_ms(),
    })
    return True


def add_rule_to_active(ctx, rule_id: str) -> bool:
    """Add a newly created rule to the ACTIVE strategy and make it live now.

    So a rule is 'alive by default' the moment it is created, without a manual
    republish — the same live mechanism the per-rule toggle uses. It does not
    bump the version (every past decision keeps its own snapshot, so replay
    stays exact) and it is a no-op when there is no active strategy yet (a fresh
    project whose first strategy is built from all its rules at once).
    """
    sid = ctx.project.get("active_strategy_id")
    if not sid:
        return False
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, sid))
    if not header:
        return False
    rule_ids = list(header.get("rule_ids") or [])
    if rule_id in rule_ids:
        return resync_active_strategy(ctx)
    rule_ids.append(rule_id)
    db.update(db.core(), db.pk_tenant(ctx.tenant_id),
              db.sk_strategy(ctx.project_id, sid), {"rule_ids": rule_ids})
    return resync_active_strategy(ctx)


def _load_rules(ctx, rule_ids: list[str]) -> list[dict]:
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id), db.sk_rule_prefix(ctx.project_id), limit=500
    )
    by_id = {r["rule_id"]: r for r in rows}
    missing = [rid for rid in rule_ids if rid not in by_id]
    if missing:
        raise ApiError(f"unknown rule ids: {', '.join(missing)}")
    return [by_id[rid] for rid in rule_ids]


def _write_version(ctx, strategy: dict, rules: list[dict], guardrail_override: dict | None) -> dict:
    """Compile and store an immutable version snapshot."""
    merged = {**(ctx.guardrails or {}), **(guardrail_override or {})}
    blob = compile_strategy(strategy=strategy, rules=rules, guardrails=merged)
    blob["compiled_at_ms"] = db.now_ms()
    blob["rule_ids"] = [r["rule_id"] for r in rules]
    blob["guardrails_override"] = guardrail_override or {}

    db.put(db.core(), {
        "pk": db.pk_tenant(ctx.tenant_id),
        "sk": db.sk_version(ctx.project_id, strategy["strategy_id"], strategy["version"]),
        "project_id": ctx.project_id,
        **blob,
    })
    return blob


@router.get("/strategies/create", summary="Create a strategy (version v1)")
async def create_strategy(
    ctx: ProjectDep,
    name: Annotated[str, Query()],
    rule_ids: Annotated[str, Query(description="Comma-separated rule ids, in any order")],
    guardrail_override: Annotated[str, Query(description="Optional URL-encoded JSON, tighter than project guardrails")] = "",
):
    ids_list = [r.strip() for r in rule_ids.split(",") if r.strip()]
    if not ids_list:
        raise ApiError("at least one rule id is required")

    override: dict = {}
    if guardrail_override:
        try:
            override = json.loads(guardrail_override)
        except json.JSONDecodeError as exc:
            raise ApiError(f"guardrail_override is not valid JSON: {exc}") from exc

    rules = _load_rules(ctx, ids_list)
    strategy_id = ids.strategy_id()
    now = db.now_ms()

    header = {
        "pk": db.pk_tenant(ctx.tenant_id),
        "sk": db.sk_strategy(ctx.project_id, strategy_id),
        "project_id": ctx.project_id,
        "strategy_id": strategy_id,
        "name": name.strip() or strategy_id,
        "version": "v1",
        "mode": "draft",
        "rule_ids": ids_list,
        "guardrails_override": override,
        "versions": ["v1"],
        "created_at": now,
        "updated_at": now,
        "created_by": ctx.session.user_id,
    }
    db.put(db.core(), header)
    blob = _write_version(ctx, {**header, "version": "v1"}, rules, override)

    audit.record(
        tenant_id=ctx.tenant_id, action="STRATEGY_CREATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="strategy", entity_id=strategy_id,
        strategy_version="v1", new_value={"name": header["name"], "rules": len(ids_list)},
    )

    return ok({
        "strategy_id": strategy_id,
        "version": "v1",
        "mode": "draft",
        "rule_count": blob["rule_count"],
        "guardrails": blob["guardrails"],
        "next_step": "validate",
    })


@router.get("/strategies/update", summary="Update a strategy (creates a new version)")
async def update_strategy(
    ctx: ProjectDep,
    strategy_id: Annotated[str, Query()],
    rule_ids: Annotated[str, Query()] = "",
    name: Annotated[str, Query()] = "",
    guardrail_override: Annotated[str, Query()] = "",
):
    """Never mutates an existing version — always compiles a new one.

    The live strategy keeps running the version it was promoted with until a
    new version is explicitly promoted, so editing is always safe.
    """
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, strategy_id))
    if not header:
        raise NotFound("strategy")

    ids_list = [r.strip() for r in rule_ids.split(",") if r.strip()] or header["rule_ids"]
    override = header.get("guardrails_override") or {}
    if guardrail_override:
        try:
            override = json.loads(guardrail_override)
        except json.JSONDecodeError as exc:
            raise ApiError(f"guardrail_override is not valid JSON: {exc}") from exc

    rules = _load_rules(ctx, ids_list)
    new_version = _next_version(header.get("version"))

    blob = _write_version(
        ctx, {**header, "version": new_version, "name": name.strip() or header["name"]},
        rules, override,
    )

    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_strategy(ctx.project_id, strategy_id), {
        "version": new_version,
        "name": name.strip() or header["name"],
        "rule_ids": ids_list,
        "guardrails_override": override,
        "versions": (header.get("versions") or []) + [new_version],
        "mode": "draft",
        "updated_at": db.now_ms(),
    })

    audit.record(
        tenant_id=ctx.tenant_id, action="STRATEGY_UPDATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="strategy", entity_id=strategy_id,
        strategy_version=new_version,
        old_value={"version": header.get("version"), "rules": len(header.get("rule_ids", []))},
        new_value={"version": new_version, "rules": len(ids_list)},
    )

    return ok({
        "strategy_id": strategy_id, "version": new_version,
        "rule_count": blob["rule_count"], "mode": "draft",
        "note": "The live version is unchanged until you promote this one.",
    })


@router.get("/strategies/list", summary="All strategies and their lifecycle state")
async def list_strategies(ctx: ProjectDep):
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id),
        db.sk_strategy_prefix(ctx.project_id), limit=200,
    )
    rows = [r for r in rows if r.get("sk", "").count("#") == 2 or "strategy_id" in r]

    return ok({
        "count": len(rows),
        "active_strategy_id": ctx.project.get("active_strategy_id"),
        "active_version": ctx.project.get("active_strategy_version"),
        "shadow_strategy_id": ctx.project.get("shadow_strategy_id"),
        "shadow_version": ctx.project.get("shadow_strategy_version"),
        "strategies": [
            {
                "strategy_id": r["strategy_id"], "name": r.get("name"),
                "version": r.get("version"), "mode": r.get("mode", "draft"),
                "versions": r.get("versions", []),
                "rule_ids": r.get("rule_ids", []),
                "rule_count": len(r.get("rule_ids", [])),
                "updated_at": r.get("updated_at"),
            }
            for r in rows
        ],
        "lifecycle": list(MODES),
    })


@router.get("/strategies/get", summary="Strategy detail with its compiled version")
async def get_strategy(
    ctx: ProjectDep,
    strategy_id: Annotated[str, Query()],
    version: Annotated[str, Query(description="Defaults to the latest")] = "",
):
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, strategy_id))
    if not header:
        raise NotFound("strategy")

    v = version or header.get("version")
    blob = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_version(ctx.project_id, strategy_id, v))
    if not blob:
        raise NotFound(f"version {v}")

    rules = [Rule.from_dict(r) for r in blob.get("rules", [])]
    return ok({
        "strategy": {
            "strategy_id": strategy_id, "name": header.get("name"),
            "version": v, "mode": header.get("mode", "draft"),
            "versions": header.get("versions", []),
        },
        "compiled": {
            "rule_count": blob.get("rule_count"),
            "guardrails": blob.get("guardrails"),
            "compiled_at_ms": blob.get("compiled_at_ms"),
        },
        "rules": [
            {
                **r.to_dict(),
                "explanation": describe_rule(r, schema=ctx.schema, currency=ctx.currency),
            }
            for r in rules
        ],
        "guardrail_explanation": describe_guardrails(
            Guardrails.from_dict(blob.get("guardrails")), ctx.currency
        ),
    })


@router.get("/strategies/validate", summary="Pre-activation gate")
async def validate_strategy(
    ctx: ProjectDep,
    strategy_id: Annotated[str, Query()],
    version: Annotated[str, Query()] = "",
):
    """Check a version is safe to promote.

    Blocks on errors (ambiguous priorities, rules referencing signals the schema
    no longer has) and reports warnings separately. Passing flips the strategy
    to `validated`, which is the only state `/strategies/promote` accepts.
    """
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, strategy_id))
    if not header:
        raise NotFound("strategy")
    v = version or header.get("version")
    blob = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_version(ctx.project_id, strategy_id, v))
    if not blob:
        raise NotFound(f"version {v}")

    rules = [Rule.from_dict(r) for r in blob.get("rules", [])]
    issues = detect_conflicts(rules)

    known = {s["id"] for s in (ctx.schema.get("context_signals") or [])}
    known |= {a["id"] for a in (ctx.schema.get("attributes") or [])}
    known |= {"day_of_week", "hour_of_day", "season"}
    known |= {"base_price", "price", "cost"}
    known |= {"cart_lines", "cart_units", "cart_subtotal", "line_quantity"}

    for r in rules:
        for c in r.clauses:
            if c.field not in known:
                issues.append({
                    "type": "unknown_signal", "severity": "error",
                    "rules": [r.rule_id], "rule_names": [r.name],
                    "message": (
                        f"'{r.name}' tests '{c.field}', which is not in the current "
                        f"schema. It can never match. Remove the rule or re-add the signal."
                    ),
                })

    if not rules:
        issues.append({
            "type": "empty_strategy", "severity": "error", "rules": [],
            "rule_names": [], "message": "This strategy has no enabled rules.",
        })

    g = Guardrails.from_dict(blob.get("guardrails"))
    if g.min_margin_pct is not None:
        issues.append({
            "type": "margin_needs_cost", "severity": "warn", "rules": [], "rule_names": [],
            "message": "A min-margin guardrail only applies to items that have a "
                       "cost set. Items without cost will skip it.",
        })

    errors = [i for i in issues if i["severity"] == "error"]
    passed = not errors

    if passed and header.get("mode") == "draft":
        db.update(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_strategy(ctx.project_id, strategy_id),
                  {"mode": "validated", "validated_at": db.now_ms()})

    audit.record(
        tenant_id=ctx.tenant_id, action="STRATEGY_VALIDATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="strategy", entity_id=strategy_id,
        strategy_version=v, new_value={"passed": passed, "errors": len(errors)},
    )

    return ok({
        "strategy_id": strategy_id, "version": v,
        "passed": passed,
        "mode": "validated" if passed else header.get("mode"),
        "errors": errors,
        "warnings": [i for i in issues if i["severity"] != "error"],
        "rule_count": len(rules),
        "next_step": "simulate" if passed else "fix-errors",
    })


def _signal_meta(schema: dict) -> dict:
    """Field -> {scope, type}, embedded in the ACTIVE row so the price handler
    knows each signal's scope without reading the schema on the hot path.

    Frozen at promote time on purpose: the active strategy is an immutable
    snapshot, so it resolves signals by the scopes that were in force when it
    was promoted, consistent with the rules it froze at the same moment.
    """
    meta: dict = {}
    for sig in (schema.get("context_signals") or []):
        sid = sig.get("id")
        if sid:
            meta[sid] = {"scope": (sig.get("scope") or "item"), "type": sig.get("type", "number")}
    # Time fields are always available and always item-derived (from now_ms).
    for t in ("day_of_week", "hour_of_day", "season"):
        meta.setdefault(t, {"scope": "item", "type": "string"})
    return meta


def _write_active(ctx, header: dict, strategy_id: str, v: str, blob: dict, now: int) -> dict:
    """Write the ACTIVE hot-path row and return the project-row changes.

    Shared by direct activation and approved-publish activation so both paths
    produce byte-identical live state.
    """
    db.put(db.context(), {
        "pk": db.active_pk(ctx.project_id),
        "sk": db.active_sk(),
        "project_id": ctx.project_id,
        "strategy_id": strategy_id,
        "strategy_name": header.get("name"),
        "version": v,
        "ruleset_version": blob.get("ruleset_version", v),
        "rules": blob.get("rules", []),
        "guardrails": blob.get("guardrails", {}),
        "guardrails_override": blob.get("guardrails_override", {}),
        "signal_meta": _signal_meta(ctx.schema),
        "mode": "active",
        "activated_at": now,
    })
    changes = {
        "active_strategy_id": strategy_id,
        "active_strategy_version": v,
        "mode": "active",
    }
    if ctx.project.get("shadow_strategy_id") == strategy_id:
        changes |= {"shadow_strategy_id": None, "shadow_strategy_version": None}
        db.delete(db.context(), f"SHADOW#{ctx.project_id}", db.active_sk())
    return changes


@router.get("/strategies/promote", summary="Move a strategy through its lifecycle")
async def promote_strategy(
    ctx: ProjectDep,
    strategy_id: Annotated[str, Query()],
    mode: Annotated[str, Query(description="shadow | active | paused")],
    version: Annotated[str, Query()] = "",
):
    """One endpoint for every lifecycle transition.

    shadow  the strategy evaluates live traffic and records what it WOULD do,
            while customers keep seeing the current price. Zero risk.
    active  its prices become the real prices.
    paused  evaluation stops; the pricing API falls back to base price within
            guardrails. Customers always still get a price.
    """
    if mode not in ("shadow", "active", "paused"):
        raise ApiError("mode must be 'shadow', 'active' or 'paused'")

    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, strategy_id))
    if not header:
        raise NotFound("strategy")
    v = version or header.get("version")

    blob = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_version(ctx.project_id, strategy_id, v))
    if not blob:
        raise NotFound(f"version {v}")

    if mode in ("active", "shadow") and header.get("mode") == "draft":
        raise Conflict(
            "validate this version first — call /strategies/validate. "
            "Activating an unvalidated strategy is how bad prices reach customers."
        )

    now = db.now_ms()
    project_changes: dict = {"updated_at": now}

    if mode == "active":
        # Approval gate: when the project requires sign-off to publish, going
        # live does not happen here. A pending request is recorded instead, and
        # the real activation runs only once /strategies/publish/approve is
        # called. Shadow and paused are never gated — neither changes a price a
        # customer sees without review.
        if ctx.project.get("require_approval"):
            approval_id = ids.approval_id()
            db.update(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_project(ctx.project_id), {
                          "pending_publish": {
                              "approval_id": approval_id,
                              "strategy_id": strategy_id,
                              "version": v,
                              "requested_by": ctx.session.user_id,
                              "requested_at": now,
                          },
                          "updated_at": now,
                      })
            audit.record(
                tenant_id=ctx.tenant_id, action="PUBLISH_REQUESTED",
                actor=ctx.session.user_id, project_id=ctx.project_id,
                entity_type="strategy", entity_id=strategy_id, strategy_version=v,
            )
            return ok({
                "pending_approval": True,
                "approval_id": approval_id,
                "strategy_id": strategy_id,
                "version": v,
                "message": "This project requires approval to publish. The change "
                           "is waiting — approve it to go live.",
            })
        project_changes |= _write_active(ctx, header, strategy_id, v, blob, now)
    elif mode == "shadow":
        db.put(db.context(), {
            "pk": f"SHADOW#{ctx.project_id}",
            "sk": db.active_sk(),
            "project_id": ctx.project_id,
            "strategy_id": strategy_id,
            "version": v,
            "rules": blob.get("rules", []),
            "guardrails": blob.get("guardrails", {}),
            "signal_meta": _signal_meta(ctx.schema),
            "mode": "shadow",
            "activated_at": now,
        })
        project_changes |= {
            "shadow_strategy_id": strategy_id, "shadow_strategy_version": v,
        }
    else:  # paused
        if ctx.project.get("active_strategy_id") == strategy_id:
            db.update(db.context(), db.active_pk(ctx.project_id), db.active_sk(),
                      {"mode": "paused", "paused_at": now})
            project_changes |= {"mode": "paused"}

    db.update(db.core(), db.pk_tenant(ctx.tenant_id),
              db.sk_strategy(ctx.project_id, strategy_id),
              {"mode": mode, "version": v, "promoted_at": now})
    db.update(db.core(), db.pk_tenant(ctx.tenant_id),
              db.sk_project(ctx.project_id), project_changes)

    audit.record(
        tenant_id=ctx.tenant_id,
        action="STRATEGY_PAUSED" if mode == "paused" else "STRATEGY_PROMOTED",
        actor=ctx.session.user_id, project_id=ctx.project_id,
        entity_type="strategy", entity_id=strategy_id, strategy_version=v,
        old_value={"mode": header.get("mode")}, new_value={"mode": mode, "version": v},
    )

    return ok({
        "strategy_id": strategy_id, "version": v, "mode": mode,
        "effective": "immediately — the next pricing request uses it",
        "customer_impact": {
            "active": "Customer-facing prices now come from this strategy.",
            "shadow": "No customer-facing change. Recommendations are recorded for comparison.",
            "paused": "Evaluation stopped. Prices fall back to base within guardrails.",
        }[mode],
    })


@router.get("/strategies/rollback", summary="Revert to a previous version")
async def rollback_strategy(
    ctx: ProjectDep,
    strategy_id: Annotated[str, Query()],
    to_version: Annotated[str, Query()],
):
    """Instant revert, no deploy.

    Kept separate from `/strategies/promote` even though the mechanism overlaps:
    rollback carries different audit semantics, and it is the control an analyst
    reaches for under pressure. It should be one unmistakable button.
    """
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, strategy_id))
    if not header:
        raise NotFound("strategy")

    blob = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_version(ctx.project_id, strategy_id, to_version))
    if not blob:
        raise NotFound(
            f"version {to_version} (available: {', '.join(header.get('versions', []))})"
        )

    from_version = ctx.project.get("active_strategy_version")
    now = db.now_ms()

    db.put(db.context(), {
        "pk": db.active_pk(ctx.project_id),
        "sk": db.active_sk(),
        "project_id": ctx.project_id,
        "strategy_id": strategy_id,
        "strategy_name": header.get("name"),
        "version": to_version,
        "ruleset_version": blob.get("ruleset_version", to_version),
        "rules": blob.get("rules", []),
        "guardrails": blob.get("guardrails", {}),
        "signal_meta": _signal_meta(ctx.schema),
        "mode": "active",
        "activated_at": now,
        "rolled_back_from": from_version,
    })

    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id), {
        "active_strategy_id": strategy_id,
        "active_strategy_version": to_version,
        "mode": "active",
        "updated_at": now,
    })
    db.update(db.core(), db.pk_tenant(ctx.tenant_id),
              db.sk_strategy(ctx.project_id, strategy_id),
              {"mode": "active", "version": to_version, "promoted_at": now})

    audit.record(
        tenant_id=ctx.tenant_id, action="STRATEGY_ROLLED_BACK", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="strategy", entity_id=strategy_id,
        strategy_version=to_version,
        old_value={"version": from_version}, new_value={"version": to_version},
        note="rollback executed",
    )

    return ok({
        "strategy_id": strategy_id,
        "rolled_back_from": from_version,
        "now_active": to_version,
        "rule_count": blob.get("rule_count"),
        "effective": "immediately — no deployment required",
    })


# ════════════════════════════════════════════════════════════════════════
#  Publish approval
#  ----------------------------------------------------------------------
#  When a project requires approval, going live is a two-step action: a
#  request is raised at promote time, and an approver publishes it here. The
#  owner approving their own change is still a deliberate gate with a full
#  audit trail — who asked, who approved, and when.
# ════════════════════════════════════════════════════════════════════════

@router.get("/strategies/approval-policy", summary="Require approval before publishing")
async def set_approval_policy(
    ctx: ProjectDep,
    require: Annotated[bool, Query(description="true to gate going live behind an approval")],
):
    """Turn the publish-approval gate on or off for this project."""
    now = db.now_ms()
    changes: dict = {"require_approval": require, "updated_at": now}
    # Turning the gate off drops any request that was waiting — there is nothing
    # left to approve once approval is no longer needed.
    if not require and ctx.project.get("pending_publish"):
        changes["pending_publish"] = None
    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id), changes)
    audit.record(
        tenant_id=ctx.tenant_id, action="GUARDRAILS_SAVED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="project", entity_id=ctx.project_id,
        new_value={"require_approval": require},
    )
    return ok({"require_approval": require})


@router.get("/strategies/publish/pending", summary="The publish request awaiting approval")
async def pending_publish(ctx: ProjectDep):
    """Returns the pending request, if any, enriched with its strategy name."""
    pending = ctx.project.get("pending_publish")
    if not pending:
        return ok({"pending": None})
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, pending.get("strategy_id")))
    return ok({"pending": {**pending, "strategy_name": (header or {}).get("name")}})


@router.get("/strategies/publish/approve", summary="Approve and publish the pending change")
async def approve_publish(
    ctx: ProjectDep,
    approval_id: Annotated[str, Query()],
    note: Annotated[str, Query()] = "",
):
    """Approve the waiting publish request and go live.

    The approval_id must match the pending request, so a stale UI cannot
    approve a request that was already resolved or replaced.
    """
    pending = ctx.project.get("pending_publish")
    if not pending:
        raise NotFound("no publish request is waiting")
    if pending.get("approval_id") != approval_id:
        raise Conflict("that request is no longer current — reload and try again")

    strategy_id = pending["strategy_id"]
    v = pending["version"]
    header = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                    db.sk_strategy(ctx.project_id, strategy_id))
    if not header:
        raise NotFound("strategy")
    blob = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_version(ctx.project_id, strategy_id, v))
    if not blob:
        raise NotFound(f"version {v}")

    now = db.now_ms()
    changes = _write_active(ctx, header, strategy_id, v, blob, now)
    changes |= {"pending_publish": None, "updated_at": now}
    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id), changes)
    db.update(db.core(), db.pk_tenant(ctx.tenant_id),
              db.sk_strategy(ctx.project_id, strategy_id),
              {"mode": "active", "version": v, "promoted_at": now})

    audit.record(
        tenant_id=ctx.tenant_id, action="PUBLISH_APPROVED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="strategy", entity_id=strategy_id,
        strategy_version=v, note=note or None,
        old_value={"requested_by": pending.get("requested_by")},
    )
    return ok({
        "published": True, "strategy_id": strategy_id, "version": v,
        "effective": "immediately — the next price request is live",
    })


@router.get("/strategies/publish/reject", summary="Reject the pending publish request")
async def reject_publish(
    ctx: ProjectDep,
    approval_id: Annotated[str, Query()],
    note: Annotated[str, Query()] = "",
):
    """Dismiss the waiting request without going live."""
    pending = ctx.project.get("pending_publish")
    if not pending:
        raise NotFound("no publish request is waiting")
    if pending.get("approval_id") != approval_id:
        raise Conflict("that request is no longer current — reload and try again")

    now = db.now_ms()
    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id),
              {"pending_publish": None, "updated_at": now})
    audit.record(
        tenant_id=ctx.tenant_id, action="PUBLISH_REJECTED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="strategy",
        entity_id=pending.get("strategy_id"), strategy_version=pending.get("version"),
        note=note or None,
    )
    return ok({"rejected": True})
