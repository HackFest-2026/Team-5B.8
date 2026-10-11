"""Executors for approval actions.

Every action an approval option can carry is implemented here, and the registry
at the bottom is the complete list. `core/ai/prompts.py` offers Gemini exactly
these names and `core/ai/__init__.validate_approval` drops any option whose
action is not in this registry.

That is the whole safety story for the notification flow: the model writes the
words on the button, code decides what the button does. A model that invents
`DELETE_EVERYTHING` produces an option that never renders.
"""

from __future__ import annotations

from typing import Callable

from core import audit, db

Executor = Callable[..., dict]


def _project(tenant_id: str, project_id: str) -> dict:
    return db.get(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id)) or {}


# ── executors ───────────────────────────────────────────────────────────

def pause_strategy(*, tenant_id: str, project_id: str, actor: str, **_) -> dict:
    proj = _project(tenant_id, project_id)
    sid = proj.get("active_strategy_id")
    if not sid:
        return {"applied": False, "detail": "no active strategy to pause"}

    db.update(db.context(), db.active_pk(project_id), db.active_sk(),
              {"mode": "paused", "paused_at": db.now_ms()})
    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id),
              {"mode": "paused", "updated_at": db.now_ms()})
    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_strategy(project_id, sid),
              {"mode": "paused"})

    audit.record(tenant_id=tenant_id, action="STRATEGY_PAUSED", actor=actor,
                 project_id=project_id, entity_type="strategy", entity_id=sid,
                 source="approval", note="paused via approval request")
    return {
        "applied": True,
        "detail": f"Strategy {sid} paused. Prices now fall back to base within guardrails.",
    }


def resume_strategy(*, tenant_id: str, project_id: str, actor: str, **_) -> dict:
    proj = _project(tenant_id, project_id)
    sid = proj.get("active_strategy_id")
    if not sid:
        return {"applied": False, "detail": "no strategy to resume"}

    db.update(db.context(), db.active_pk(project_id), db.active_sk(),
              {"mode": "active", "resumed_at": db.now_ms()})
    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id),
              {"mode": "active", "updated_at": db.now_ms()})
    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_strategy(project_id, sid),
              {"mode": "active"})

    audit.record(tenant_id=tenant_id, action="STRATEGY_PROMOTED", actor=actor,
                 project_id=project_id, entity_type="strategy", entity_id=sid,
                 source="approval", note="resumed via approval request")
    return {"applied": True, "detail": f"Strategy {sid} is live again."}


def rollback_strategy(
    *, tenant_id: str, project_id: str, actor: str, param_version: str | None = None, **_
) -> dict:
    proj = _project(tenant_id, project_id)
    sid = proj.get("active_strategy_id")
    if not sid or not param_version:
        return {"applied": False, "detail": "no active strategy or no target version"}

    blob = db.get(db.core(), db.pk_tenant(tenant_id),
                  db.sk_version(project_id, sid, param_version))
    if not blob:
        return {"applied": False, "detail": f"version {param_version} no longer exists"}

    previous = proj.get("active_strategy_version")
    now = db.now_ms()
    db.put(db.context(), {
        "pk": db.active_pk(project_id), "sk": db.active_sk(),
        "project_id": project_id, "strategy_id": sid,
        "strategy_name": blob.get("strategy_name"),
        "version": param_version,
        "ruleset_version": blob.get("ruleset_version", param_version),
        "rules": blob.get("rules", []), "guardrails": blob.get("guardrails", {}),
        "mode": "active", "activated_at": now, "rolled_back_from": previous,
    })
    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id), {
        "active_strategy_version": param_version, "mode": "active", "updated_at": now,
    })

    audit.record(tenant_id=tenant_id, action="STRATEGY_ROLLED_BACK", actor=actor,
                 project_id=project_id, entity_type="strategy", entity_id=sid,
                 strategy_version=param_version, old_value={"version": previous},
                 new_value={"version": param_version}, source="approval")
    return {
        "applied": True,
        "detail": f"Rolled back from {previous} to {param_version}. Effective immediately.",
    }


def activate_safe_mode(*, tenant_id: str, project_id: str, actor: str, **_) -> dict:
    """Strongest available containment short of switching pricing off.

    Rules stop evaluating and every item is served its base price, still bounded
    by guardrails. Customers keep getting prices; the prices just stop moving.
    """
    db.update(db.context(), db.active_pk(project_id), db.active_sk(),
              {"mode": "safe", "safe_mode_at": db.now_ms()})
    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id),
              {"mode": "safe", "updated_at": db.now_ms()})

    audit.record(tenant_id=tenant_id, action="FALLBACK_ENGAGED", actor=actor,
                 project_id=project_id, entity_type="project", entity_id=project_id,
                 source="approval", note="safe mode activated via approval request")
    return {
        "applied": True,
        "detail": "Safe mode on. Every item serves base price within guardrails.",
    }


def disable_rule(
    *, tenant_id: str, project_id: str, actor: str, param_rule_id: str | None = None, **_
) -> dict:
    if not param_rule_id:
        return {"applied": False, "detail": "no rule id supplied"}

    updated = db.update(db.core(), db.pk_tenant(tenant_id),
                        db.sk_rule(project_id, param_rule_id),
                        {"enabled": False, "updated_at": db.now_ms()})
    if not updated:
        return {"applied": False, "detail": f"rule {param_rule_id} not found"}

    audit.record(tenant_id=tenant_id, action="RULE_DISABLED", actor=actor,
                 project_id=project_id, entity_type="rule", entity_id=param_rule_id,
                 source="approval", note="disabled via approval request")
    return {
        "applied": True,
        "detail": (
            f"Rule '{updated.get('name', param_rule_id)}' disabled. The live strategy "
            f"keeps its compiled snapshot until a new version is promoted."
        ),
    }


def _set_guardrail(tenant_id, project_id, actor, pct, *, widen: bool) -> dict:
    if pct is None:
        return {"applied": False, "detail": "no percentage supplied"}
    proj = _project(tenant_id, project_id)
    g = dict(proj.get("guardrails") or {})
    old = g.get("max_increase_pct")
    g["max_increase_pct"] = float(pct)

    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id),
              {"guardrails": g, "updated_at": db.now_ms()})
    active = db.get(db.context(), db.active_pk(project_id), db.active_sk())
    if active:
        merged = {**(active.get("guardrails") or {}), "max_increase_pct": float(pct)}
        db.update(db.context(), db.active_pk(project_id), db.active_sk(),
                  {"guardrails": merged})

    audit.record(tenant_id=tenant_id, action="GUARDRAILS_SAVED", actor=actor,
                 project_id=project_id, entity_type="guardrails", entity_id=project_id,
                 old_value={"max_increase_pct": old},
                 new_value={"max_increase_pct": pct}, source="approval")
    verb = "widened" if widen else "tightened"
    return {"applied": True, "detail": f"Max increase {verb} from {old}% to {pct}%."}


def widen_guardrail(*, tenant_id, project_id, actor, param_pct=None, **_) -> dict:
    return _set_guardrail(tenant_id, project_id, actor, param_pct, widen=True)


def tighten_guardrail(*, tenant_id, project_id, actor, param_pct=None, **_) -> dict:
    return _set_guardrail(tenant_id, project_id, actor, param_pct, widen=False)


def approve_price_change(
    *, tenant_id: str, project_id: str, actor: str,
    param_price: float | None = None, item_id: str | None = None, **_
) -> dict:
    """Accept a recommended price for one item.

    Writes the approved price as the item's previous_price so the next
    evaluation treats it as the reference point for movement guardrails.
    """
    if not item_id:
        return {"applied": False, "detail": "approval is not tied to an item"}
    if param_price is None:
        return {"applied": False, "detail": "no price supplied"}

    db.update(db.context(), db.ctx_pk(project_id, item_id), db.ctx_sk(),
              {"previous_price": float(param_price), "updated_at": db.now_ms()})

    audit.record(tenant_id=tenant_id, action="PRICE_GENERATED", actor=actor,
                 project_id=project_id, entity_type="item", entity_id=item_id,
                 new_value={"approved_price": param_price}, source="approval")
    return {"applied": True, "detail": f"Price {param_price} approved for {item_id}."}


def reject_price_change(*, item_id: str | None = None, **_) -> dict:
    return {
        "applied": True,
        "detail": f"Recommendation rejected{f' for {item_id}' if item_id else ''}. "
                  f"The current price stands.",
    }


def keep_monitoring(**_) -> dict:
    return {"applied": True, "detail": "No change made. The situation stays under watch."}


def acknowledge(**_) -> dict:
    return {"applied": True, "detail": "Acknowledged."}


# ── registry ────────────────────────────────────────────────────────────

REGISTRY: dict[str, Executor] = {
    "PAUSE_STRATEGY": pause_strategy,
    "RESUME_STRATEGY": resume_strategy,
    "ROLLBACK_STRATEGY": rollback_strategy,
    "ACTIVATE_SAFE_MODE": activate_safe_mode,
    "DISABLE_RULE": disable_rule,
    "WIDEN_GUARDRAIL": widen_guardrail,
    "TIGHTEN_GUARDRAIL": tighten_guardrail,
    "APPROVE_PRICE_CHANGE": approve_price_change,
    "REJECT_PRICE_CHANGE": reject_price_change,
    "KEEP_MONITORING": keep_monitoring,
    "ACKNOWLEDGE": acknowledge,
}


def execute(action: str, **kwargs) -> dict:
    """Run one action. Never raises — a failed action returns applied=False so
    the analyst sees why rather than a 500."""
    fn = REGISTRY.get(action)
    if not fn:
        return {"applied": False, "detail": f"unknown action '{action}'"}
    try:
        return fn(**kwargs)
    except Exception as exc:  # noqa: BLE001
        return {"applied": False, "detail": f"action failed: {exc}"}
