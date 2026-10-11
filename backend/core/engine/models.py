"""Value types for the pricing engine.

Everything here is a frozen dataclass with no AWS imports, no I/O and no clock
access. That is not stylistic: the engine must be a pure function of its inputs
so that the same (base_price, context, ruleset_version, guardrails) always
produces the same price. Determinism is what makes simulation, backtesting and
Decision Replay honest rather than approximate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Operator = Literal[">", ">=", "<", "<=", "==", "!=", "in", "not_in", "between"]
AdjustType = Literal["percentage", "absolute", "multiplier", "set_price", "formula"]
# How a formula's computed number is applied: as a percentage added to the
# running total, a flat amount, or the final price (an override).
FormulaMode = Literal["percent", "amount", "price"]
Direction = Literal["increase", "decrease"]
Logic = Literal["all", "any"]


@dataclass(frozen=True, slots=True)
class Clause:
    field: str
    operator: Operator
    value: Any = None          # number for scalar ops, list for in/not_in
    value2: float | None = None  # upper bound for `between`

    @staticmethod
    def from_dict(d: dict) -> "Clause":
        v = d.get("value")
        if v is None:
            v = d.get("value_list") if d.get("value_list") else d.get("value_number")
        return Clause(
            field=d["field"],
            operator=d["operator"],
            value=v,
            value2=d.get("value2", d.get("value_number_2")),
        )

    def to_dict(self) -> dict:
        return {
            "field": self.field, "operator": self.operator,
            "value": self.value, "value2": self.value2,
        }


@dataclass(frozen=True, slots=True)
class Adjustment:
    type: AdjustType
    value: float
    direction: Direction = "increase"
    # Only for type == "formula": a safe arithmetic expression over the signals,
    # and how its result is applied. Validated at rule-creation, evaluated by
    # core.engine.formula at price time.
    expr: str | None = None
    formula_mode: FormulaMode = "percent"

    @property
    def signed(self) -> float:
        """Value with its sign applied. Stored unsigned so the UI can show
        'decrease by 5%' rather than 'apply -5%'."""
        return self.value if self.direction == "increase" else -self.value

    @staticmethod
    def from_dict(d: dict) -> "Adjustment":
        return Adjustment(
            type=d.get("type", "percentage"),
            value=float(d.get("value", 0)),
            direction=d.get("direction", "increase"),
            expr=d.get("expr"),
            formula_mode=d.get("formula_mode", "percent"),
        )

    def to_dict(self) -> dict:
        out = {"type": self.type, "value": self.value, "direction": self.direction}
        if self.type == "formula":
            out["expr"] = self.expr
            out["formula_mode"] = self.formula_mode
        return out


@dataclass(frozen=True, slots=True)
class Rule:
    rule_id: str
    name: str
    clauses: tuple[Clause, ...]
    adjustment: Adjustment
    logic: Logic = "all"
    priority: int = 50
    stackable: bool = True
    conflict_group: str | None = None
    enabled: bool = True
    version: str = "v1"
    # Optional calendar window, epoch ms. A rule only applies while
    # starts_at <= now_ms < ends_at. Either side may be None (open-ended). This
    # is how a Black-Friday or festival-season rule turns itself on and off
    # without anyone remembering to activate and pause it — and because it is
    # judged against the decision's now_ms, a replay of a past decision still
    # sees the window exactly as it was.
    starts_at: int | None = None
    ends_at: int | None = None

    @staticmethod
    def from_dict(d: dict) -> "Rule":
        return Rule(
            rule_id=d["rule_id"],
            name=d.get("name", d["rule_id"]),
            clauses=tuple(Clause.from_dict(c) for c in (d.get("clauses") or [])),
            adjustment=Adjustment.from_dict(d.get("adjustment") or {}),
            logic=d.get("logic", "all"),
            priority=int(d.get("priority", 50)),
            stackable=bool(d.get("stackable", True)),
            conflict_group=d.get("conflict_group"),
            enabled=bool(d.get("enabled", True)),
            version=d.get("version", "v1"),
            starts_at=d.get("starts_at"),
            ends_at=d.get("ends_at"),
        )

    def to_dict(self) -> dict:
        out = {
            "rule_id": self.rule_id, "name": self.name,
            "clauses": [c.to_dict() for c in self.clauses],
            "adjustment": self.adjustment.to_dict(),
            "logic": self.logic, "priority": self.priority,
            "stackable": self.stackable, "conflict_group": self.conflict_group,
            "enabled": self.enabled, "version": self.version,
        }
        if self.starts_at is not None:
            out["starts_at"] = self.starts_at
        if self.ends_at is not None:
            out["ends_at"] = self.ends_at
        return out


@dataclass(frozen=True, slots=True)
class Guardrails:
    """Hard limits applied AFTER rules. The last line of defence against a bad
    rule, a bad feature value or a bad ML suggestion producing an absurd price."""

    min_price: float | None = None
    max_price: float | None = None
    max_increase_pct: float | None = None
    max_decrease_pct: float | None = None
    min_margin_pct: float | None = None

    @staticmethod
    def from_dict(d: dict | None) -> "Guardrails":
        d = d or {}
        def num(k):
            v = d.get(k)
            return float(v) if v is not None else None
        return Guardrails(
            min_price=num("min_price"),
            max_price=num("max_price"),
            max_increase_pct=num("max_increase_pct"),
            max_decrease_pct=num("max_decrease_pct"),
            min_margin_pct=num("min_margin_pct"),
        )

    def to_dict(self) -> dict:
        return {
            "min_price": self.min_price, "max_price": self.max_price,
            "max_increase_pct": self.max_increase_pct,
            "max_decrease_pct": self.max_decrease_pct,
            "min_margin_pct": self.min_margin_pct,
        }


@dataclass(frozen=True, slots=True)
class PricingContext:
    """The precomputed state the engine reads. Never computed inside the engine.

    `signal_age_s` carries per-signal freshness so a stale competitor feed can
    be down-weighted without disabling the whole decision. `now_ms` is passed
    in rather than read from the clock — otherwise replaying a decision from
    last Tuesday would evaluate today's day_of_week and produce a different
    price, which would make Decision Replay a lie.
    """

    base_price: float
    signals: dict[str, Any] = field(default_factory=dict)
    signal_age_s: dict[str, float] = field(default_factory=dict)
    cost: float | None = None
    previous_price: float | None = None
    now_ms: int = 0
    currency: str = "INR"

    def get(self, name: str) -> Any:
        # base_price and cost are always-available reserved fields, so a rule
        # can say "base_price > 10000" or "cost >= base_price" directly. They
        # are never stale. Signals still win if one shadows the name.
        if name in self.signals:
            return self.signals[name]
        if name in ("base_price", "price"):
            return self.base_price
        if name == "cost":
            return self.cost
        return None


@dataclass(slots=True)
class RuleOutcome:
    """What happened to one rule during one evaluation. This is the raw material
    for both the price-driver breakdown and Decision Replay."""

    rule_id: str
    name: str
    matched: bool
    applied: bool
    priority: int
    adjustment: dict | None = None
    impact_amount: float = 0.0
    impact_label: str = ""
    skipped_reason: str | None = None
    suppressed_by: str | None = None
    clause_results: list[dict] = field(default_factory=list)


@dataclass(slots=True)
class GuardrailHit:
    rule: str
    limit: Any
    before: float
    after: float

    def to_dict(self) -> dict:
        return {
            "rule": self.rule, "limit": self.limit,
            "before": round(self.before, 2), "after": round(self.after, 2),
        }


@dataclass(slots=True)
class Decision:
    """The complete, replayable result of one pricing evaluation."""

    final_price: float
    base_price: float
    recommended_price: float          # before guardrails
    previous_price: float | None
    currency: str

    drivers: list[dict] = field(default_factory=list)
    rules: list[RuleOutcome] = field(default_factory=list)
    guardrails_applied: list[GuardrailHit] = field(default_factory=list)

    degraded: bool = False            # ran on stale or partial context
    fallback: bool = False            # engine could not run; safe price returned
    notes: list[str] = field(default_factory=list)

    strategy_id: str | None = None
    strategy_version: str | None = None
    ruleset_version: str | None = None
    evaluated_at_ms: int = 0

    @property
    def changed(self) -> bool:
        if self.previous_price is None:
            return False
        return abs(self.final_price - self.previous_price) > 1e-9

    @property
    def change_pct(self) -> float:
        if not self.previous_price:
            return 0.0
        return round((self.final_price - self.previous_price) / self.previous_price * 100, 4)

    def to_dict(self) -> dict:
        return {
            "final_price": self.final_price,
            "base_price": self.base_price,
            "recommended_price": self.recommended_price,
            "previous_price": self.previous_price,
            "currency": self.currency,
            "changed": self.changed,
            "change_pct": self.change_pct,
            "drivers": self.drivers,
            "rules": [
                {
                    "rule_id": r.rule_id, "name": r.name,
                    "matched": r.matched, "applied": r.applied,
                    "priority": r.priority, "adjustment": r.adjustment,
                    "impact_amount": round(r.impact_amount, 2),
                    "impact_label": r.impact_label,
                    "skipped_reason": r.skipped_reason,
                    "suppressed_by": r.suppressed_by,
                    "clause_results": r.clause_results,
                }
                for r in self.rules
            ],
            "guardrails_applied": [g.to_dict() for g in self.guardrails_applied],
            "degraded": self.degraded,
            "fallback": self.fallback,
            "notes": self.notes,
            "strategy_id": self.strategy_id,
            "strategy_version": self.strategy_version,
            "ruleset_version": self.ruleset_version,
            "evaluated_at_ms": self.evaluated_at_ms,
        }
