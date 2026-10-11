"""A safe, deterministic arithmetic evaluator for formula-based pricing.

Some pricing is genuinely continuous — "charge 0.5% more for every point of
demand", "sit 5% under the competitor", "price = cost x 1.4". A fixed per-rule
adjustment can only approximate that with brackets, so this closes the gap with
a real expression over the decision's signals.

It is NOT `eval`. The expression is parsed to an AST and walked against a strict
whitelist: numbers, + - * / %, parentheses, unary minus, a handful of pure
functions, and names that resolve to signal values. Anything else — attribute
access, calls to unknown names, comprehensions, power towers — is rejected at
rule-creation time, so a malicious or broken expression can never reach the
hot path, and the hot path itself stays a pure function of its inputs.

Determinism is the whole point: the same signals always yield the same number,
which is what keeps simulation, backtesting and Decision Replay honest.
"""

from __future__ import annotations

import ast
import math
from typing import Any

# Pure, total-ish functions. Each is deterministic and has no I/O. `clamp` and
# `lerp` are here because they are what pricing formulas actually reach for.
_FUNCS = {
    "min": min,
    "max": max,
    "abs": abs,
    "round": lambda x, n=0: round(x, int(n)),
    "floor": math.floor,
    "ceil": math.ceil,
    "sqrt": lambda x: math.sqrt(x) if x >= 0 else float("nan"),
    "clamp": lambda x, lo, hi: max(lo, min(hi, x)),
    # Linear interpolation: lerp(a, b, t) walks from a to b as t goes 0→1.
    "lerp": lambda a, b, t: a + (b - a) * t,
}

# Caps so a pathological-but-valid expression cannot burn CPU or overflow.
_MAX_NODES = 120
_MAX_POW = 8


class FormulaError(ValueError):
    """Raised when an expression is unsafe, malformed or references nothing."""


def validate(expr: str, allowed_names: set[str]) -> None:
    """Parse and whitelist-check an expression WITHOUT evaluating it.

    Called once at rule-creation time. `allowed_names` is the set of signal ids
    the project declares, plus the reserved ones (base, cost, …). A name outside
    it is a typo or a reach for data the engine does not have, and is refused
    now rather than silently never-matching later.
    """
    if not expr or not expr.strip():
        raise FormulaError("formula expression is empty")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"formula is not valid arithmetic: {exc.msg}") from exc

    count = 0
    for node in ast.walk(tree):
        count += 1
        if count > _MAX_NODES:
            raise FormulaError("formula is too complex")
        _check_node(node, allowed_names)


def _check_node(node: ast.AST, allowed_names: set[str]) -> None:
    if isinstance(node, ast.Expression):
        return
    if isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float)) or isinstance(node.value, bool):
            raise FormulaError("only numbers are allowed as literals")
        return
    if isinstance(node, ast.Name):
        if node.id in _FUNCS:
            return
        if node.id not in allowed_names:
            raise FormulaError(
                f"'{node.id}' is not a signal in this project — a formula can only "
                f"use declared signals, base and cost"
            )
        return
    if isinstance(node, ast.BinOp):
        if not isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow)):
            raise FormulaError("only + - * / % ** are allowed")
        if isinstance(node.op, ast.Pow):
            # A constant, small exponent only — no `x ** y` blow-ups.
            exp = node.right
            if not (isinstance(exp, ast.Constant) and isinstance(exp.value, (int, float))
                    and abs(exp.value) <= _MAX_POW):
                raise FormulaError(f"** exponent must be a constant up to {_MAX_POW}")
        return
    if isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, (ast.UAdd, ast.USub)):
            raise FormulaError("only unary + and - are allowed")
        return
    if isinstance(node, ast.Call):
        if not (isinstance(node.func, ast.Name) and node.func.id in _FUNCS):
            raise FormulaError("only min, max, abs, round, floor, ceil, sqrt, clamp, lerp are allowed")
        if node.keywords:
            raise FormulaError("formula functions take positional arguments only")
        return
    if isinstance(node, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow,
                         ast.USub, ast.UAdd, ast.Load)):
        return
    raise FormulaError(f"{type(node).__name__} is not allowed in a formula")


def evaluate(expr: str, variables: dict[str, Any]) -> float:
    """Evaluate a validated expression against signal values.

    Raises on a missing name, a divide-by-zero or a non-finite result, so the
    caller can skip the rule safely rather than let a broken formula move a real
    price. It never runs arbitrary code — the walk only does arithmetic.
    """
    tree = ast.parse(expr, mode="eval")
    value = _eval(tree.body, variables)
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise FormulaError("formula did not produce a finite number")
    return float(value)


def _eval(node: ast.AST, env: dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _FUNCS:
            return _FUNCS[node.id]
        if node.id not in env or env[node.id] is None:
            raise FormulaError(f"'{node.id}' has no value in this decision")
        v = env[node.id]
        # Only numbers take part in arithmetic; a string signal in a formula is
        # a configuration error, surfaced as a skipped rule rather than a crash.
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            try:
                return float(v)
            except (TypeError, ValueError):
                raise FormulaError(f"'{node.id}' is not numeric")
        return v
    if isinstance(node, ast.BinOp):
        left, right = _eval(node.left, env), _eval(node.right, env)
        op = node.op
        if isinstance(op, ast.Add):
            return left + right
        if isinstance(op, ast.Sub):
            return left - right
        if isinstance(op, ast.Mult):
            return left * right
        if isinstance(op, ast.Div):
            if right == 0:
                raise FormulaError("division by zero")
            return left / right
        if isinstance(op, ast.Mod):
            if right == 0:
                raise FormulaError("modulo by zero")
            return left % right
        if isinstance(op, ast.Pow):
            return left ** right
    if isinstance(node, ast.UnaryOp):
        operand = _eval(node.operand, env)
        return -operand if isinstance(node.op, ast.USub) else +operand
    if isinstance(node, ast.Call):
        func = _FUNCS[node.func.id]
        args = [_eval(a, env) for a in node.args]
        return func(*args)
    raise FormulaError("unsupported expression")
