"""The DevNexus deterministic pricing engine.

Pure, dependency-free, and the single implementation used by every path that
needs a price:

    runtime/price_handler.py   live pricing API
    app/routers/simulate.py    what-if
    workers/backtest_worker.py historical replay
    app/routers/decisions.py   /decisions/verify

They all call `evaluate()`. That is why a simulated price, a backtested price
and a live price for the same inputs are the same number — not approximately,
exactly.
"""

from core.engine.compile import (
    compile_rules,
    compile_strategy,
    expand_tiers,
    rules_from_compiled,
)
from core.engine.describe import (
    describe_adjustment,
    describe_clause,
    describe_decision,
    describe_guardrails,
    describe_rule,
)
from core.engine.evaluate import (
    DEFAULT_STALE_AFTER_S,
    apply_guardrails,
    detect_conflicts,
    evaluate,
    match_clause,
    match_rule,
    resolve,
    safe_fallback,
)
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

__all__ = [
    "Adjustment", "Clause", "Decision", "Guardrails", "GuardrailHit",
    "PricingContext", "Rule", "RuleOutcome",
    "evaluate", "safe_fallback", "apply_guardrails", "detect_conflicts",
    "match_clause", "match_rule", "resolve", "DEFAULT_STALE_AFTER_S",
    "compile_rules", "compile_strategy", "expand_tiers", "rules_from_compiled",
    "describe_rule", "describe_clause", "describe_adjustment",
    "describe_guardrails", "describe_decision",
]
