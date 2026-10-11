"""Decisions — feed, replay, and the determinism proof.

`/decisions/verify` is the one that matters. It takes a stored decision, re-runs
the engine on the exact snapshot that produced it, and asserts the price still
matches. That turns "our pricing is deterministic and reproducible" from a claim
on a slide into something a machine checks on demand.

It works because of choices made elsewhere:
  * the engine is pure and takes `now_ms` as an input rather than reading a clock
  * strategy versions are immutable, so the ruleset that priced it still exists
  * the full input snapshot is stored with every decision
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import ProjectDep
from app.responses import ApiError, NotFound, ok
from core import db, pricing
from core.engine import describe_decision

router = APIRouter(tags=["decisions"])


@router.get("/decisions/list", summary="Recent pricing decisions")
async def list_decisions(
    ctx: ProjectDep,
    item_id: Annotated[str, Query(description="Omit for the project-wide feed")] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: Annotated[str, Query()] = "",
    changed_only: Annotated[bool, Query(description="Only decisions that moved the price")] = False,
):
    start = None
    if cursor:
        try:
            start = json.loads(cursor)
        except json.JSONDecodeError:
            raise ApiError("invalid cursor")

    pk = (
        db.decidx_pk(ctx.project_id, item_id) if item_id
        else db.decfeed_pk(ctx.project_id)
    )
    rows, nxt = db.query_prefix(
        db.decisions(), pk, "", limit=limit * 2 if changed_only else limit,
        cursor=start, ascending=False,
    )
    if changed_only:
        rows = [r for r in rows if r.get("changed")]

    return ok({
        "count": len(rows[:limit]),
        "decisions": [
            {
                "decision_id": r.get("decision_id"),
                "item_id": r.get("item_id"),
                "price": r.get("final_price"),
                "previous_price": r.get("previous_price"),
                "changed": r.get("changed"),
                "change_pct": r.get("change_pct"),
                "strategy_version": r.get("strategy_version"),
                "rules_fired": r.get("rules_fired", []),
                "guardrails_applied": r.get("guardrail_names", []),
                "degraded": r.get("degraded", False),
                "fallback": r.get("fallback", False),
                "latency_ms": r.get("latency_ms"),
                "ts": r.get("ts"),
            }
            for r in rows[:limit]
        ],
        "cursor": json.dumps(nxt) if nxt else None,
        "currency": ctx.currency,
    })


@router.get("/decisions/replay", summary="Reconstruct exactly why a price happened")
async def replay_decision(
    ctx: ProjectDep,
    decision_id: Annotated[str, Query(description="e.g. DEC-7K2P9X4M")],
):
    """The full story behind one price.

    Inputs, feature values and their ages, every rule that matched, which ones
    applied, which were suppressed and by what, each rule's contribution, the
    guardrails that fired, and the strategy and ruleset versions in force.
    """
    row = db.get(db.decisions(), db.dec_pk(ctx.project_id, decision_id), db.sk_meta())
    if not row:
        raise NotFound("decision")

    decision = row.get("decision") or {}
    snapshot = row.get("snapshot") or {}

    return ok({
        "decision_id": decision_id,
        "item_id": row.get("item_id"),
        "generated_at": row.get("ts"),
        "price": {
            "final": decision.get("final_price"),
            "recommended_before_guardrails": decision.get("recommended_price"),
            "previous": decision.get("previous_price"),
            "base": decision.get("base_price"),
            "currency": decision.get("currency", ctx.currency),
            "changed": decision.get("changed"),
            "change_pct": decision.get("change_pct"),
        },
        "strategy": {
            "strategy_id": decision.get("strategy_id"),
            "version": decision.get("strategy_version"),
            "ruleset_version": decision.get("ruleset_version"),
        },
        "context_used": {
            "signals": snapshot.get("signals", {}),
            "signal_age_seconds": snapshot.get("signal_age_s", {}),
            "base_price": snapshot.get("base_price"),
            "cost": snapshot.get("cost"),
            "evaluated_at_ms": snapshot.get("now_ms"),
        },
        "rules": decision.get("rules", []),
        "drivers": decision.get("drivers", []),
        "guardrails": {
            "configured": snapshot.get("guardrails", {}),
            "applied": decision.get("guardrails_applied", []),
        },
        "degraded": decision.get("degraded", False),
        "fallback": decision.get("fallback", False),
        "notes": decision.get("notes", []),
        "explanation": describe_decision(decision, schema=ctx.schema),
        "verify_url": f"/decisions/verify?project_id={ctx.project_id}&decision_id={decision_id}",
    })


@router.get("/decisions/verify", summary="Prove the decision is reproducible")
async def verify_decision(
    ctx: ProjectDep,
    decision_id: Annotated[str, Query()],
):
    """Re-run the engine on the stored snapshot and compare.

    A pass means: these inputs, this ruleset version and these guardrails still
    produce this exact price. Not approximately — to the cent.

    A failure is a real finding, not a glitch. It would mean the stored snapshot
    is incomplete, or that engine behaviour changed between then and now. Either
    way the analyst should know, so the endpoint reports the mismatch in detail
    rather than smoothing it over.
    """
    row = db.get(db.decisions(), db.dec_pk(ctx.project_id, decision_id), db.sk_meta())
    if not row:
        raise NotFound("decision")

    original = row.get("decision") or {}
    snapshot = row.get("snapshot") or {}
    if not snapshot:
        raise ApiError(
            "this decision has no stored input snapshot and cannot be verified",
            code="not_verifiable",
        )

    recomputed = pricing.replay(snapshot)

    original_price = float(original.get("final_price", 0))
    matches = abs(recomputed.final_price - original_price) < 0.01

    original_rules = sorted(
        r["rule_id"] for r in original.get("rules", []) if r.get("applied")
    )
    recomputed_rules = sorted(r.rule_id for r in recomputed.rules if r.applied)
    rules_match = original_rules == recomputed_rules

    body = {
        "decision_id": decision_id,
        "deterministic": matches and rules_match,
        "price": {
            "original": original_price,
            "recomputed": recomputed.final_price,
            "difference": round(recomputed.final_price - original_price, 4),
            "matches": matches,
        },
        "rules_applied": {
            "original": original_rules,
            "recomputed": recomputed_rules,
            "matches": rules_match,
        },
        "verified_against": {
            "strategy_version": snapshot.get("strategy_version"),
            "ruleset_version": snapshot.get("ruleset_version"),
            "rule_count": len(snapshot.get("rules", [])),
            "signals": list((snapshot.get("signals") or {}).keys()),
        },
    }

    if body["deterministic"]:
        body["conclusion"] = (
            "Reproduced exactly. The same inputs, ruleset version and guardrails "
            "still produce the same price."
        )
    else:
        body["conclusion"] = (
            "Did NOT reproduce. The stored snapshot is incomplete, or engine "
            "behaviour has changed since this decision was made."
        )
        body["recomputed_detail"] = recomputed.to_dict()
    return ok(body)
