"""Compiling stored configuration into an executable ruleset.

Two jobs:

  compile_rules()     stored rule dicts -> Rule objects the engine can run
  expand_tiers()      one tiered_rule   -> N mutually-exclusive Rule objects
  compile_strategy()  a strategy version -> the frozen blob the hot path reads

The hot path must never do this work. A strategy version is compiled once, at
activation, and stored in `ACTIVE#<project>` ready to execute. `price-fn` reads
that blob and runs it; it does not assemble rules per request.
"""

from __future__ import annotations

from core.engine.models import Adjustment, Clause, Guardrails, Rule


def compile_rules(raw_rules: list[dict]) -> list[Rule]:
    """Turn stored rule documents into Rule objects, expanding tiers."""
    out: list[Rule] = []
    for raw in raw_rules:
        if raw.get("kind") == "tiered_rule" or raw.get("tiers"):
            out.extend(expand_tiers(raw))
        else:
            out.append(Rule.from_dict(raw))
    return out


def expand_tiers(raw: dict) -> list[Rule]:
    """A tiered rule becomes N rules sharing one conflict group.

    Banding is expressed through the existing conflict mechanism rather than a
    special case in the engine. The engine stays simple, and the bands are
    exclusive by construction: at most one can ever apply.

    Bands are ordered narrowest-first (highest `from_value` gets the highest
    priority) so the most specific band wins if bounds ever touch.
    """
    tiers = sorted(raw.get("tiers") or [], key=lambda t: t.get("from_value", 0))
    group = f"tier:{raw['rule_id']}"
    base_priority = int(raw.get("priority", 50))
    out: list[Rule] = []

    for i, t in enumerate(tiers):
        field = t.get("field") or raw.get("field")
        lo = t.get("from_value")
        hi = t.get("to_value")

        if hi is None:
            clauses = (Clause(field=field, operator=">=", value=lo),)
            label = f"{lo}+"
        else:
            # Half-open [lo, hi) so adjacent bands can share a boundary without
            # both matching at exactly that value.
            clauses = (
                Clause(field=field, operator=">=", value=lo),
                Clause(field=field, operator="<", value=hi),
            )
            label = f"{lo}-{hi}"

        out.append(Rule(
            rule_id=f"{raw['rule_id']}#t{i + 1}",
            name=f"{raw.get('name', 'Tier')} ({label})",
            clauses=clauses,
            adjustment=Adjustment(
                type=t.get("adjustment_type", "percentage"),
                value=float(t.get("adjustment_value", 0)),
                direction=t.get("direction", "increase"),
            ),
            logic="all",
            priority=base_priority + i,  # narrower band -> higher priority
            stackable=bool(raw.get("stackable", True)),
            conflict_group=group,
            enabled=bool(raw.get("enabled", True)),
            version=raw.get("version", "v1"),
        ))
    return out


def compile_strategy(
    *, strategy: dict, rules: list[dict], guardrails: dict | None
) -> dict:
    """Freeze a strategy version into the blob the hot path executes.

    Stored verbatim and never mutated. Rollback is therefore just pointing
    `ACTIVE#<project>` at a different frozen blob — no recompilation, no code
    deploy, and the old blob is byte-identical to what produced past decisions.
    """
    compiled = compile_rules([r for r in rules if r.get("enabled", True)])
    return {
        "strategy_id": strategy["strategy_id"],
        "strategy_name": strategy.get("name", ""),
        "version": strategy["version"],
        "ruleset_version": strategy.get("ruleset_version", strategy["version"]),
        "mode": strategy.get("mode", "draft"),
        "rules": [r.to_dict() for r in compiled],
        "guardrails": Guardrails.from_dict(guardrails).to_dict(),
        "rule_count": len(compiled),
        "compiled_at_ms": strategy.get("compiled_at_ms"),
    }


def rules_from_compiled(blob: dict) -> list[Rule]:
    """Rehydrate Rule objects from a compiled blob. Hot path and replay both
    use this, which is precisely why replay reproduces the original price."""
    return [Rule.from_dict(r) for r in blob.get("rules", [])]
