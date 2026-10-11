"""The deterministic pricing engine.

    price = evaluate(base_price, context, rules, guardrails)

This module is pure. It performs no I/O, reads no clock, consults no database
and calls no model. Given identical inputs it returns an identical decision,
on any machine, at any time, forever. Every differentiating feature in DevNexus
rests on that property:

  * Simulation is honest        — it runs this exact code, not an approximation
  * Backtesting is honest       — replaying old context reproduces old prices
  * Decision Replay is provable — /decisions/verify re-runs this on the stored
                                  snapshot and asserts the price still matches
  * Rollback is safe            — a strategy version is just a frozen ruleset

If anything in here ever reaches for `time.time()` or a DynamoDB handle, all
four of those break at once. `now_ms` arrives inside PricingContext for exactly
this reason.

Evaluation order
────────────────
    1. filter   disabled rules and rules whose signals are missing/stale
    2. match    evaluate each rule's clauses
    3. order    priority DESC, then rule_id ASC (total order -> deterministic)
    4. resolve  conflict groups, then non-stackable short-circuit
    5. apply    accumulate adjustments onto the base price
    6. clamp    guardrails
    7. explain  build the price-driver breakdown
"""

from __future__ import annotations

from . import formula as _formula

import math

from core.engine.models import (
    Adjustment,
    Clause,
    Decision,
    Guardrails,
    GuardrailHit,
    PricingContext,
    Rule,
    RuleOutcome,
)

# A signal older than this contributes nothing and marks the decision degraded.
DEFAULT_STALE_AFTER_S = 21600.0

# Prices are rounded once, at the very end, to this many decimals. Rounding at
# intermediate steps would make the result depend on evaluation order in ways
# that are hard to reason about and easy to break.
PRICE_DP = 2


# ════════════════════════════════════════════════════════════════════════
#  1-2. Clause matching
# ════════════════════════════════════════════════════════════════════════

def _as_number(v) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(float(v)) else None
    if isinstance(v, str):
        try:
            f = float(v)
            return f if math.isfinite(f) else None
        except ValueError:
            return None
    return None


def match_clause(clause: Clause, ctx: PricingContext) -> tuple[bool, dict]:
    """Evaluate one clause. Returns (matched, explanation).

    A missing signal never matches. It is not an error and must not raise: a
    half-populated context has to still produce a price, just a degraded one.
    """
    actual = ctx.get(clause.field)
    trace = {
        "field": clause.field,
        "operator": clause.operator,
        "expected": clause.value if clause.value2 is None
                    else [clause.value, clause.value2],
        "actual": actual,
    }

    if actual is None:
        trace["matched"] = False
        trace["reason"] = "signal missing from context"
        return False, trace

    op = clause.operator

    if op in ("in", "not_in"):
        allowed = clause.value if isinstance(clause.value, (list, tuple)) else [clause.value]
        hit = str(actual) in {str(a) for a in allowed}
        matched = hit if op == "in" else not hit
        trace["matched"] = matched
        return matched, trace

    if op in ("==", "!="):
        # Compare numerically when both sides look numeric, else as strings.
        a, b = _as_number(actual), _as_number(clause.value)
        eq = (abs(a - b) < 1e-9) if (a is not None and b is not None) \
             else (str(actual) == str(clause.value))
        matched = eq if op == "==" else not eq
        trace["matched"] = matched
        return matched, trace

    a = _as_number(actual)
    if a is None:
        trace["matched"] = False
        trace["reason"] = f"'{actual}' is not numeric"
        return False, trace

    if op == "between":
        lo, hi = _as_number(clause.value), _as_number(clause.value2)
        if lo is None or hi is None:
            trace["matched"] = False
            trace["reason"] = "between requires two numeric bounds"
            return False, trace
        matched = lo <= a <= hi
        trace["matched"] = matched
        return matched, trace

    b = _as_number(clause.value)
    if b is None:
        trace["matched"] = False
        trace["reason"] = "comparison value is not numeric"
        return False, trace

    matched = {
        ">": a > b, ">=": a >= b,
        "<": a < b, "<=": a <= b,
    }.get(op, False)
    trace["matched"] = matched
    return matched, trace


def _stale_fields(rule: Rule, ctx: PricingContext, stale_after_s: float) -> list[str]:
    out = []
    for c in rule.clauses:
        age = ctx.signal_age_s.get(c.field)
        if age is not None and age > stale_after_s:
            out.append(c.field)
    return out


def match_rule(
    rule: Rule, ctx: PricingContext, *, stale_after_s: float
) -> RuleOutcome:
    outcome = RuleOutcome(
        rule_id=rule.rule_id, name=rule.name, matched=False,
        applied=False, priority=rule.priority,
        adjustment=rule.adjustment.to_dict(),
    )

    if not rule.enabled:
        outcome.skipped_reason = "rule disabled"
        return outcome

    # Calendar window. Judged against the decision's now_ms, not the wall clock,
    # so a replay sees the same window. Outside it, the rule simply does not
    # exist for this decision.
    if rule.starts_at is not None and ctx.now_ms < rule.starts_at:
        outcome.skipped_reason = "before the rule's start date"
        return outcome
    if rule.ends_at is not None and ctx.now_ms >= rule.ends_at:
        outcome.skipped_reason = "after the rule's end date"
        return outcome

    if not rule.clauses:
        outcome.skipped_reason = "rule has no conditions"
        return outcome

    stale = _stale_fields(rule, ctx, stale_after_s)
    if stale:
        # Reliability rule from the spec: stale data must reduce or remove its
        # influence rather than silently drive a price.
        outcome.skipped_reason = f"stale signal(s): {', '.join(stale)}"
        return outcome

    results = []
    for c in rule.clauses:
        ok, trace = match_clause(c, ctx)
        results.append(trace)
    outcome.clause_results = results

    hits = [r["matched"] for r in results]
    outcome.matched = all(hits) if rule.logic == "all" else any(hits)
    return outcome


# ════════════════════════════════════════════════════════════════════════
#  3-4. Ordering and conflict resolution
# ════════════════════════════════════════════════════════════════════════

def _order(rules: list[Rule]) -> list[Rule]:
    """Priority DESC, then rule_id ASC.

    The rule_id tiebreak is what makes this a TOTAL order. Sorting on priority
    alone leaves equal-priority rules in input order, so the same ruleset stored
    in a different sequence would produce a different price — reproducibility
    gone, with no error to notice it by.
    """
    return sorted(rules, key=lambda r: (-r.priority, r.rule_id))


def resolve(outcomes: list[RuleOutcome], rules_by_id: dict[str, Rule]) -> list[RuleOutcome]:
    """Decide which matched rules actually apply.

    Two mechanisms, in order:

      conflict_group  rules sharing a group are mutually exclusive. The highest
                      priority match wins; the rest are suppressed and say so.
                      Tiered rules compile into one group, which is what makes
                      bands exclusive by construction.

      stackable=False once an exclusive rule applies, nothing after it applies.
                      Because the list is in priority order, this means "this
                      rule is the final word".
    """
    claimed: dict[str, str] = {}
    exclusive_winner: str | None = None

    for oc in outcomes:
        if not oc.matched:
            continue

        if exclusive_winner:
            oc.suppressed_by = exclusive_winner
            continue

        rule = rules_by_id[oc.rule_id]
        group = rule.conflict_group
        if group:
            if group in claimed:
                oc.suppressed_by = claimed[group]
                continue
            claimed[group] = oc.rule_id

        oc.applied = True
        if not rule.stackable:
            exclusive_winner = oc.rule_id

    return outcomes


def detect_conflicts(rules: list[Rule]) -> list[dict]:
    """Static analysis for `GET /rules/conflicts` — no context required.

    Finds rules that will fight at runtime, before they ever go live:
      * same conflict group at the same priority -> the winner is arbitrary
      * overlapping conditions pushing price in opposite directions
      * a stackable set whose combined effect exceeds a sane band
    """
    issues: list[dict] = []
    ordered = _order(rules)

    by_group: dict[str, list[Rule]] = {}
    for r in ordered:
        if r.conflict_group:
            by_group.setdefault(r.conflict_group, []).append(r)

    for group, members in by_group.items():
        seen: dict[int, str] = {}
        for r in members:
            if r.priority in seen:
                issues.append({
                    "type": "ambiguous_priority",
                    "severity": "error",
                    "rules": [seen[r.priority], r.rule_id],
                    "message": (
                        f"'{r.name}' and the other rule share conflict group "
                        f"'{group}' at priority {r.priority}. Which one wins is "
                        f"decided by rule id, not by intent — set distinct priorities."
                    ),
                })
            seen[r.priority] = r.rule_id

    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            if a.conflict_group and a.conflict_group == b.conflict_group:
                continue  # already mutually exclusive by design
            overlap = _condition_overlap(a, b)
            if overlap and a.adjustment.signed * b.adjustment.signed < 0:
                issues.append({
                    "type": "opposing_overlap",
                    "severity": "warn",
                    "rules": [a.rule_id, b.rule_id],
                    "message": (
                        f"'{a.name}' and '{b.name}' can both match (overlap on "
                        f"{', '.join(overlap)}) and push the price in opposite "
                        f"directions. They will partially cancel."
                    ),
                })

    # Two rules with identical logic both match and both apply, silently
    # doubling the adjustment. They are distinct records so nothing else flags
    # them, but an analyst who clicks "create" twice has no way to tell. Found
    # by a test fixture that created the same rule on every run and quietly
    # turned +12% into +16%.
    by_logic: dict[tuple, list[Rule]] = {}
    for r in ordered:
        if not r.enabled:
            continue
        signature = (
            r.logic,
            tuple(sorted((c.field, c.operator, str(c.value), str(c.value2))
                         for c in r.clauses)),
            r.adjustment.type, r.adjustment.value, r.adjustment.direction,
        )
        by_logic.setdefault(signature, []).append(r)

    for dupes in by_logic.values():
        if len(dupes) < 2:
            continue
        stacked = [r for r in dupes if r.stackable]
        combined = (
            f"{sum(d.adjustment.value for d in stacked):g}"
            f"{'%' if dupes[0].adjustment.type == 'percentage' else ''}"
        )
        issues.append({
            "type": "duplicate_logic",
            # A warning, not an error: duplicates may be deliberate (different
            # names, same effect) and blocking activation would be too strict.
            "severity": "warn" if len(stacked) < 2 else "error",
            "rules": [r.rule_id for r in dupes],
            "message": (
                f"{len(dupes)} rules have identical conditions and the same "
                f"adjustment ({dupes[0].adjustment.value:g}"
                f"{'%' if dupes[0].adjustment.type == 'percentage' else ''} "
                f"{dupes[0].adjustment.direction}): "
                f"{', '.join(repr(r.name) for r in dupes)}. "
                + (f"All {len(stacked)} are stackable, so they will combine to "
                   f"{combined} rather than the {dupes[0].adjustment.value:g}"
                   f"{'%' if dupes[0].adjustment.type == 'percentage' else ''} "
                   f"you probably intended."
                   if len(stacked) >= 2 else
                   "Only one can apply, so the others are dead weight.")
            ),
        })

    stacking = [r for r in ordered if r.stackable and r.adjustment.type == "percentage"]
    total = sum(abs(r.adjustment.value) for r in stacking)
    if total > 50:
        issues.append({
            "type": "stacking_runaway",
            "severity": "warn",
            "rules": [r.rule_id for r in stacking],
            "message": (
                f"{len(stacking)} stackable percentage rules can combine to "
                f"{total:.0f}%. Guardrails will cap this, but the intent is "
                f"probably not to move a price that far at once."
            ),
        })

    return issues


def _condition_overlap(a: Rule, b: Rule) -> list[str]:
    """Fields both rules test where their ranges can be simultaneously true.

    Deliberately conservative: it reports a possible overlap unless it can
    prove the two conditions are disjoint. A false positive is a warning the
    analyst dismisses; a false negative is a conflict that reaches production.
    """
    shared = []
    a_by_field = {c.field: c for c in a.clauses}
    for c in b.clauses:
        ac = a_by_field.get(c.field)
        if not ac:
            continue
        if _disjoint(ac, c):
            return []  # one shared field is provably exclusive -> rules can't co-fire
        shared.append(c.field)
    return shared


def _disjoint(x: Clause, y: Clause) -> bool:
    xv, yv = _as_number(x.value), _as_number(y.value)
    if xv is None or yv is None:
        return False
    gt = {">", ">="}
    lt = {"<", "<="}
    # e.g. x: demand > 80  and  y: demand < 50  -> can never both hold
    if x.operator in gt and y.operator in lt and yv <= xv:
        return True
    if x.operator in lt and y.operator in gt and xv <= yv:
        return True
    return False


# ════════════════════════════════════════════════════════════════════════
#  5. Applying adjustments
# ════════════════════════════════════════════════════════════════════════

def _apply_adjustments(
    base: float, outcomes: list[RuleOutcome], rules_by_id: dict[str, Rule],
    ctx: "PricingContext",
) -> tuple[float, list[dict]]:
    """Accumulate applied adjustments onto the base price.

    Percentages are summed and applied ONCE against the base, not compounded
    one after another. Two +10% rules therefore give +20%, not +21%. Compounding
    makes the outcome depend on evaluation order, which an analyst cannot
    predict from reading the rules.

    `set_price` overrides everything that came before it, since it is an
    absolute instruction rather than a modifier.
    """
    # A formula rule needs the signal values to evaluate against. base and cost
    # are exposed under reserved names so a formula can reference them directly.
    env = dict(ctx.signals)
    env["base"] = base
    env["base_price"] = base
    if ctx.cost is not None:
        env["cost"] = ctx.cost

    # Resolve every applied rule into a normalised contribution first, so a
    # formula is evaluated exactly once and its result drives both the price and
    # the explanation. A formula that cannot evaluate (missing signal, divide by
    # zero) drops to a zero contribution and says why — it never moves a price
    # on a number it could not compute.
    pct_total = 0.0
    absolute_total = 0.0
    multiplier = 1.0
    override: float | None = None
    override_rule: str | None = None
    resolved: dict[str, tuple[str, float]] = {}

    for oc in outcomes:
        if not oc.applied:
            continue
        adj = rules_by_id[oc.rule_id].adjustment

        if adj.type == "formula":
            try:
                computed = _formula.evaluate(adj.expr or "", env)
            except _formula.FormulaError as exc:
                oc.skipped_reason = f"formula could not be evaluated: {exc}"
                resolved[oc.rule_id] = ("skip", 0.0)
                continue
            if adj.formula_mode == "amount":
                absolute_total += computed
                resolved[oc.rule_id] = ("amount", computed)
            elif adj.formula_mode == "price":
                override = computed
                override_rule = oc.rule_id
                resolved[oc.rule_id] = ("override", computed)
            else:  # percent
                pct_total += computed
                resolved[oc.rule_id] = ("percent", computed)
        elif adj.type == "percentage":
            pct_total += adj.signed
            resolved[oc.rule_id] = ("percent", adj.signed)
        elif adj.type == "absolute":
            absolute_total += adj.signed
            resolved[oc.rule_id] = ("amount", adj.signed)
        elif adj.type == "multiplier":
            m = adj.value if adj.direction == "increase" else (1 / adj.value)
            multiplier *= m
            resolved[oc.rule_id] = ("mult", m)
        elif adj.type == "set_price":
            override = adj.value
            override_rule = oc.rule_id
            resolved[oc.rule_id] = ("override", adj.value)

    if override is not None:
        price = override
    else:
        price = (base * (1 + pct_total / 100.0) + absolute_total) * multiplier

    # Attribute the final movement back to individual rules, proportionally.
    # Without this the explanation would show percentages that don't add up to
    # the actual price change, which analysts notice immediately and distrust.
    drivers: list[dict] = []
    delta_total = price - base
    for oc in outcomes:
        if not oc.applied:
            continue
        kind, val = resolved.get(oc.rule_id, ("skip", 0.0))
        if kind == "skip":
            continue
        if override is not None:
            share = delta_total if oc.rule_id == override_rule else 0.0
            label = f"set to {override:,.2f}" if oc.rule_id == override_rule else "overridden"
        elif kind == "percent":
            share = base * (val / 100.0) * multiplier
            label = f"{val:+.2f}%"
        elif kind == "amount":
            share = val * multiplier
            label = f"{val:+,.2f}"
        else:  # mult
            share = base * (multiplier - 1) if multiplier != 1 else 0.0
            label = f"x{val:g}"
        oc.impact_amount = share
        oc.impact_label = label
        drivers.append({
            "factor": oc.name,
            "rule_id": oc.rule_id,
            "impact": label,
            "amount": round(share, PRICE_DP),
        })

    return price, drivers


# ════════════════════════════════════════════════════════════════════════
#  6. Guardrails
# ════════════════════════════════════════════════════════════════════════

def apply_guardrails(
    price: float, *, base: float, previous: float | None, cost: float | None, g: Guardrails
) -> tuple[float, list[GuardrailHit]]:
    """Clamp a recommendation into the allowed band.

    Order matters and is fixed: percentage movement limits first (they are
    relative to the reference price), then margin, then absolute floor/ceiling.
    Absolute bounds are applied last so they always have the final word.

    The reference for movement limits is the previous price when we have one,
    else the base price — "maximum increase" means increase from what the
    customer saw last, not from a catalogue number they never saw.
    """
    hits: list[GuardrailHit] = []
    reference = previous if previous is not None else base

    if g.max_increase_pct is not None and reference > 0:
        ceiling = reference * (1 + g.max_increase_pct / 100.0)
        if price > ceiling:
            hits.append(GuardrailHit("max_increase_pct", g.max_increase_pct, price, ceiling))
            price = ceiling

    if g.max_decrease_pct is not None and reference > 0:
        floor = reference * (1 - g.max_decrease_pct / 100.0)
        if price < floor:
            hits.append(GuardrailHit("max_decrease_pct", g.max_decrease_pct, price, floor))
            price = floor

    if g.min_margin_pct is not None and cost is not None and g.min_margin_pct < 100:
        # margin = (price - cost) / price  =>  price >= cost / (1 - m/100)
        floor = cost / (1 - g.min_margin_pct / 100.0)
        if price < floor:
            hits.append(GuardrailHit("min_margin_pct", g.min_margin_pct, price, floor))
            price = floor

    if g.min_price is not None and price < g.min_price:
        hits.append(GuardrailHit("min_price", g.min_price, price, g.min_price))
        price = g.min_price

    if g.max_price is not None and price > g.max_price:
        hits.append(GuardrailHit("max_price", g.max_price, price, g.max_price))
        price = g.max_price

    return price, hits


# ════════════════════════════════════════════════════════════════════════
#  The entry point
# ════════════════════════════════════════════════════════════════════════

def evaluate(
    *,
    ctx: PricingContext,
    rules: list[Rule],
    guardrails: Guardrails,
    strategy_id: str | None = None,
    strategy_version: str | None = None,
    ruleset_version: str | None = None,
    stale_after_s: float = DEFAULT_STALE_AFTER_S,
) -> Decision:
    """Evaluate one price. Pure, total, and never raises on bad context."""
    base = float(ctx.base_price)
    ordered = _order(rules)
    by_id = {r.rule_id: r for r in ordered}

    outcomes = [match_rule(r, ctx, stale_after_s=stale_after_s) for r in ordered]
    outcomes = resolve(outcomes, by_id)

    recommended, drivers = _apply_adjustments(base, outcomes, by_id, ctx)

    final, hits = apply_guardrails(
        recommended, base=base, previous=ctx.previous_price,
        cost=ctx.cost, g=guardrails,
    )

    notes: list[str] = []
    stale_any = any(oc.skipped_reason and "stale" in oc.skipped_reason for oc in outcomes)
    missing_any = any(
        t.get("reason") == "signal missing from context"
        for oc in outcomes for t in oc.clause_results
    )
    if stale_any:
        notes.append("one or more rules were skipped because their signals were stale")
    if missing_any:
        notes.append("one or more signals were missing from the context snapshot")

    return Decision(
        final_price=round(final, PRICE_DP),
        base_price=round(base, PRICE_DP),
        recommended_price=round(recommended, PRICE_DP),
        previous_price=ctx.previous_price,
        currency=ctx.currency,
        drivers=drivers,
        rules=outcomes,
        guardrails_applied=hits,
        degraded=stale_any or missing_any,
        fallback=False,
        notes=notes,
        strategy_id=strategy_id,
        strategy_version=strategy_version,
        ruleset_version=ruleset_version,
        evaluated_at_ms=ctx.now_ms,
    )


def safe_fallback(
    *, ctx: PricingContext, guardrails: Guardrails, reason: str
) -> Decision:
    """Last resort: the engine could not run.

    Never return an error, a null or an unbounded number to a customer's
    checkout page. Fall back to the previous price if we know it, else the base
    price, still clamped by absolute guardrails.
    """
    price = ctx.previous_price if ctx.previous_price else ctx.base_price
    if guardrails.min_price is not None:
        price = max(price, guardrails.min_price)
    if guardrails.max_price is not None:
        price = min(price, guardrails.max_price)

    return Decision(
        final_price=round(float(price), PRICE_DP),
        base_price=round(float(ctx.base_price), PRICE_DP),
        recommended_price=round(float(price), PRICE_DP),
        previous_price=ctx.previous_price,
        currency=ctx.currency,
        drivers=[{"factor": "safe_fallback", "rule_id": None, "impact": "0%", "amount": 0.0}],
        degraded=True,
        fallback=True,
        notes=[f"safe fallback engaged: {reason}"],
        evaluated_at_ms=ctx.now_ms,
    )
