"""Configuration -> plain English, deterministically.

This is the reverse of the AI layer and it is deliberately NOT a model call.

The text produced here narrates live rules inside Decision Replay and the audit
trail. A model that misdescribed an active rule would make the audit trail lie,
and the audit trail is the one artefact in this system that has to be exactly
right. A template renderer is instant, free, offline and always correct.

The rule of thumb across DevNexus:
    AI for the fuzzy direction   (English -> structure)
    Code for the exact direction (structure -> English)
"""

from __future__ import annotations

from core.engine.models import Adjustment, Clause, Guardrails, Rule

_OPERATOR_WORDS = {
    ">": "is above",
    ">=": "is at least",
    "<": "is below",
    "<=": "is at most",
    "==": "is",
    "!=": "is not",
    "in": "is one of",
    "not_in": "is not one of",
    "between": "is between",
}


def label_for(field: str, schema: dict | None) -> str:
    """Human label from the project schema, falling back to a prettified id."""
    if schema:
        for group in ("context_signals", "attributes"):
            for item in schema.get(group) or []:
                if item.get("id") == field and item.get("label"):
                    return item["label"]
    return field.replace("_", " ").strip().capitalize()


def describe_clause(clause: Clause, schema: dict | None = None) -> str:
    name = label_for(clause.field, schema)
    word = _OPERATOR_WORDS.get(clause.operator, clause.operator)

    if clause.operator == "between":
        return f"{name} {word} {_num(clause.value)} and {_num(clause.value2)}"
    if clause.operator in ("in", "not_in"):
        vals = clause.value if isinstance(clause.value, (list, tuple)) else [clause.value]
        return f"{name} {word} {_join(list(vals))}"
    return f"{name} {word} {_num(clause.value)}"


def describe_adjustment(adj: Adjustment, currency: str = "INR") -> str:
    verb = "increase" if adj.direction == "increase" else "reduce"
    if adj.type == "percentage":
        return f"{verb} the price by {_num(adj.value)}%"
    if adj.type == "absolute":
        return f"{verb} the price by {currency} {_num(adj.value)}"
    if adj.type == "multiplier":
        return f"multiply the price by {_num(adj.value)}"
    if adj.type == "set_price":
        return f"set the price to {currency} {_num(adj.value)}"
    return f"{verb} the price"


def describe_rule(rule: Rule, *, schema: dict | None = None, currency: str = "INR") -> str:
    """One sentence an analyst can verify at a glance."""
    if not rule.clauses:
        return describe_adjustment(rule.adjustment, currency).capitalize() + " unconditionally."

    joiner = " and " if rule.logic == "all" else " or "
    conditions = joiner.join(describe_clause(c, schema) for c in rule.clauses)
    action = describe_adjustment(rule.adjustment, currency)
    return f"When {conditions}, {action}."


def describe_guardrails(g: Guardrails, currency: str = "INR") -> list[str]:
    out: list[str] = []
    if g.min_price is not None:
        out.append(f"Never price below {currency} {_num(g.min_price)}.")
    if g.max_price is not None:
        out.append(f"Never price above {currency} {_num(g.max_price)}.")
    if g.max_increase_pct is not None:
        out.append(f"Never raise the price by more than {_num(g.max_increase_pct)}% at once.")
    if g.max_decrease_pct is not None:
        out.append(f"Never cut the price by more than {_num(g.max_decrease_pct)}% at once.")
    if g.min_margin_pct is not None:
        out.append(f"Never let the margin fall below {_num(g.min_margin_pct)}%.")
    return out or ["No guardrails configured."]


def describe_decision(decision: dict, *, schema: dict | None = None) -> str:
    """A paragraph explaining one price, for Decision Replay and the audit log."""
    cur = decision.get("currency", "INR")
    final = decision.get("final_price")
    prev = decision.get("previous_price")
    base = decision.get("base_price")

    if decision.get("fallback"):
        return (
            f"Priced at {cur} {_num(final)} by the safe fallback strategy. "
            f"{'; '.join(decision.get('notes') or ['The engine was unavailable.'])}"
        )

    applied = [r for r in decision.get("rules", []) if r.get("applied")]
    if not applied:
        head = f"No rules matched, so the price stayed at the base of {cur} {_num(base)}."
    else:
        parts = [f"{r['name']} ({r.get('impact_label', '')})" for r in applied]
        head = (
            f"{len(applied)} rule{'s' if len(applied) > 1 else ''} applied: "
            f"{_join(parts)}, moving the base {cur} {_num(base)} to a recommended "
            f"{cur} {_num(decision.get('recommended_price'))}."
        )

    tail = ""
    hits = decision.get("guardrails_applied") or []
    if hits:
        names = _join([h["rule"].replace("_", " ") for h in hits])
        tail = f" Guardrails ({names}) then capped it to {cur} {_num(final)}."
    elif final is not None:
        tail = f" Guardrails made no change, so the final price is {cur} {_num(final)}."

    move = ""
    if prev:
        pct = decision.get("change_pct", 0)
        direction = "up" if final > prev else ("down" if final < prev else "unchanged")
        move = (
            f" That is {direction} from {cur} {_num(prev)}"
            + (f" ({pct:+.2f}%)." if direction != "unchanged" else ".")
        )

    suppressed = [r for r in decision.get("rules", []) if r.get("suppressed_by")]
    note = ""
    if suppressed:
        note = (
            f" {len(suppressed)} matching rule"
            f"{'s were' if len(suppressed) > 1 else ' was'} suppressed by a "
            f"higher-priority rule."
        )

    return head + tail + move + note


# ── formatting helpers ─────────────────────────────────────────────────

def _num(v) -> str:
    if v is None:
        return "?"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if f == int(f):
        return f"{int(f):,}"
    return f"{f:,.2f}"


def _join(items: list) -> str:
    items = [str(i) for i in items]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]
