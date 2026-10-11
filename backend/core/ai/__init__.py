"""High-level AI operations, with the validation gate that makes them safe.

Nothing outside this module talks to Gemini directly. Two entry points:

    nl_to_config(...)        analyst sentence  -> validated draft config
    build_approval_request() fired alert       -> validated question + options

"Validated" is the whole point. The model's raw output is treated as an
untrusted proposal: every field name is checked against the project's schema,
every action against a fixed enum, every number against declared ranges. A
hallucination therefore becomes a rejected draft with a readable reason, not a
live pricing change.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from core.ai import prompts as P
from core.ai.gemini import GeminiError, generate, generate_sync, health  # noqa: F401

log = logging.getLogger("devnexus.ai")

BUILTIN_SIGNALS = {
    "day_of_week": {"type": "enum", "enum": ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]},
    "hour_of_day": {"type": "number", "min": 0, "max": 23},
    "season": {"type": "string"},
}


class ValidationReject(ValueError):
    """AI output failed mechanical validation. Carries reasons for the UI."""

    def __init__(self, reasons: list[str], raw: Any = None):
        super().__init__("; ".join(reasons))
        self.reasons = reasons
        self.raw = raw


def prompt_cache_key(prompt: str, schema_version: str, kind: str) -> str:
    """Stable cache key. Identical prompt + schema -> identical draft.

    Makes a repeated demo prompt return in ~15ms from DynamoDB instead of ~1.2s
    from Gemini, and costs nothing.
    """
    h = hashlib.sha256(f"{kind}\x00{schema_version}\x00{prompt.strip().lower()}".encode())
    return h.hexdigest()[:40]


# ════════════════════════════════════════════════════════════════════════
#  A.  natural language -> pricing configuration
# ════════════════════════════════════════════════════════════════════════

def _field_index(schema: dict) -> dict[str, dict]:
    idx: dict[str, dict] = {}
    for item in list(schema.get("context_signals") or []) + list(schema.get("attributes") or []):
        if item.get("id"):
            idx[item["id"]] = item
    for name, spec in BUILTIN_SIGNALS.items():
        idx.setdefault(name, {"id": name, **spec})
    return idx


def _validate_clauses(clauses: list[dict], fields: dict[str, dict]) -> tuple[list[str], list[str]]:
    """Returns (hard_errors, soft_warnings)."""
    errors: list[str] = []
    warnings: list[str] = []
    for i, c in enumerate(clauses):
        fid = c.get("field")
        if fid not in fields:
            errors.append(
                f"clause {i + 1}: unknown field '{fid}' — not in this project's schema"
            )
            continue
        spec = fields[fid]
        op = c.get("operator")
        if op not in P.OPERATORS:
            errors.append(f"clause {i + 1}: unsupported operator '{op}'")
            continue

        if op in ("in", "not_in"):
            if not c.get("value_list"):
                errors.append(f"clause {i + 1}: operator '{op}' needs value_list")
            elif spec.get("enum"):
                bad = [v for v in c["value_list"] if v not in spec["enum"]]
                if bad:
                    errors.append(
                        f"clause {i + 1}: {bad} not allowed for '{fid}' "
                        f"(allowed: {spec['enum']})"
                    )
        elif op == "between":
            if c.get("value_number") is None or c.get("value_number_2") is None:
                errors.append(f"clause {i + 1}: 'between' needs two numbers")
            elif c["value_number"] >= c["value_number_2"]:
                errors.append(f"clause {i + 1}: 'between' bounds are reversed")
        else:
            if c.get("value_number") is None and not c.get("value_list"):
                errors.append(f"clause {i + 1}: missing a comparison value")

        v = c.get("value_number")
        if v is not None:
            lo, hi = spec.get("min"), spec.get("max")
            if lo is not None and hi is not None and not (lo <= v <= hi):
                # Soft: the analyst may genuinely mean an out-of-range probe.
                warnings.append(
                    f"'{fid}' is declared {lo}..{hi} but the threshold is {v} — "
                    f"this condition may never match"
                )
    return errors, warnings


def _validate_tiers(tiers: list[dict], fields: dict[str, dict]) -> list[str]:
    """Tier arithmetic is checked in code, never trusted to the model."""
    errors: list[str] = []
    if not tiers:
        return ["tiered_rule has no tiers"]
    fids = {t.get("field") for t in tiers}
    if len(fids) > 1:
        errors.append(f"tiers must all use one field, got {sorted(fids)}")
    for t in tiers:
        if t.get("field") not in fields:
            errors.append(f"tier field '{t.get('field')}' is not in this project's schema")

    ordered = sorted(tiers, key=lambda t: t.get("from_value", 0))
    for a, b in zip(ordered, ordered[1:]):
        a_to = a.get("to_value")
        if a_to is None:
            errors.append("only the last tier may have an open upper bound")
            continue
        if a_to > b.get("from_value", 0):
            errors.append(f"tiers overlap at {a_to}")
        elif a_to < b.get("from_value", 0):
            errors.append(f"gap between tiers at {a_to}..{b.get('from_value')}")
    return errors


def _validate_constraint(con: dict) -> list[str]:
    errors: list[str] = []
    lo, hi = con.get("min_price"), con.get("max_price")
    if lo is not None and hi is not None and lo >= hi:
        errors.append(f"min_price {lo} is not below max_price {hi}")
    for k in ("max_increase_pct", "max_decrease_pct", "min_margin_pct"):
        v = con.get(k)
        if v is not None and (v < 0 or v > 100):
            errors.append(f"{k} must be between 0 and 100, got {v}")
    if not any(v is not None for v in con.values()):
        errors.append("constraint has no limits set")
    return errors


def validate_config(raw: dict, *, schema: dict, guardrails: dict | None = None) -> dict:
    """Mechanically check a model-produced config. Raises ValidationReject."""
    fields = _field_index(schema)
    kind = raw.get("kind")
    errors: list[str] = []
    warnings: list[str] = []

    if kind == "unsupported":
        raise ValidationReject(
            [raw.get("clarification") or
             "This needs a signal the project doesn't have: "
             f"{', '.join(raw.get('unmapped') or []) or 'unspecified'}"],
            raw,
        )

    if kind in ("rule", "schedule", "strategy"):
        clauses = raw.get("clauses") or []
        if not clauses:
            errors.append(f"{kind} has no conditions")
        e, w = _validate_clauses(clauses, fields)
        errors += e
        warnings += w
        if not raw.get("adjustment"):
            errors.append(f"{kind} has no adjustment")

    elif kind == "tiered_rule":
        errors += _validate_tiers(raw.get("tiers") or [], fields)

    elif kind == "constraint":
        errors += _validate_constraint(raw.get("constraint") or {})

    else:
        errors.append(f"unknown kind '{kind}'")

    # Guardrail awareness: a warning, never a block. The analyst may be
    # deliberately proposing a rule the guardrail will then cap.
    adj = raw.get("adjustment")
    if adj and guardrails and adj.get("type") == "percentage":
        cap_key = "max_increase_pct" if adj.get("direction") == "increase" else "max_decrease_pct"
        cap = guardrails.get(cap_key)
        if cap is not None and adj.get("value", 0) >= cap:
            warnings.append(
                f"{adj['value']}% meets or exceeds the project {cap_key} of {cap}% — "
                f"some decisions will be capped by guardrails"
            )

    if raw.get("unmapped"):
        warnings.append(
            "not mapped to any signal: " + ", ".join(raw["unmapped"])
        )

    if errors:
        raise ValidationReject(errors, raw)

    raw["warnings"] = warnings
    return raw


async def nl_to_config(
    *,
    prompt: str,
    schema: dict,
    currency: str = "INR",
    guardrails: dict | None = None,
) -> dict:
    """Analyst sentence -> validated draft config.

    One repair retry: the validation errors are fed back verbatim so the model
    can correct a wrong field id. Bounded at one retry on purpose — a longer
    loop trades unbounded latency for a marginal success-rate gain.
    """
    user = P.build_pricing_config_user(
        prompt=prompt, schema=schema, currency=currency, guardrails=guardrails
    )

    last: ValidationReject | None = None
    for attempt in range(2):
        res = await generate(
            system=P.PRICING_CONFIG_SYSTEM,
            user=user if attempt == 0 else (
                f"{user}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED\n"
                f"───────────────────────────────────\n"
                + "\n".join(f"- {r}" for r in last.reasons)
                + "\n\nUse only field ids from the schema above. Emit corrected JSON."
            ),
            schema=P.PRICING_CONFIG_SCHEMA,
            max_tokens=2048,
        )
        try:
            out = validate_config(res.data, schema=schema, guardrails=guardrails)
            out["_meta"] = {
                "model": res.model, "latency_ms": res.latency_ms,
                "attempts": res.attempts, "hedged": res.hedged,
                "repaired": attempt > 0,
            }
            return out
        except ValidationReject as exc:
            last = exc
            log.info("config validation rejected (attempt %d): %s", attempt + 1, exc.reasons)

    raise last  # type: ignore[misc]


# ════════════════════════════════════════════════════════════════════════
#  B.  alert -> approval request
# ════════════════════════════════════════════════════════════════════════

_PARAM_REQUIRED = {
    "ROLLBACK_STRATEGY": "param_version",
    "DISABLE_RULE": "param_rule_id",
    "WIDEN_GUARDRAIL": "param_pct",
    "TIGHTEN_GUARDRAIL": "param_pct",
}

_PASSIVE_ACTIONS = {"KEEP_MONITORING", "ACKNOWLEDGE", "REJECT_PRICE_CHANGE"}


def validate_approval(
    raw: dict, *, available_versions: list[str], valid_rule_ids: set[str]
) -> dict:
    """Check the model's options are actually executable.

    An option whose action is unknown, or whose identifier doesn't exist, is
    dropped rather than shown — a button that cannot work is worse than no
    button, especially at 3am on a phone.
    """
    errors: list[str] = []
    options: list[dict] = []
    seen_ids: set[str] = set()

    for i, opt in enumerate(raw.get("options") or []):
        action = opt.get("action")
        if action not in P.APPROVAL_ACTIONS:
            errors.append(f"option {i + 1}: unknown action '{action}' — dropped")
            continue

        need = _PARAM_REQUIRED.get(action)
        if need and opt.get(need) is None:
            errors.append(f"option {i + 1}: {action} requires {need} — dropped")
            continue

        if action == "ROLLBACK_STRATEGY" and opt["param_version"] not in available_versions:
            errors.append(
                f"option {i + 1}: version '{opt['param_version']}' does not exist — dropped"
            )
            continue

        if action == "DISABLE_RULE" and opt["param_rule_id"] not in valid_rule_ids:
            errors.append(
                f"option {i + 1}: rule '{opt['param_rule_id']}' is not involved — dropped"
            )
            continue

        oid = (opt.get("option_id") or f"opt_{i + 1}").strip()
        if oid in seen_ids:
            oid = f"{oid}_{i + 1}"
        seen_ids.add(oid)
        opt["option_id"] = oid
        opt["label"] = (opt.get("label") or action.replace("_", " ").title())[:32]
        options.append(opt)

    if not options:
        raise ValidationReject(
            ["no executable options survived validation"] + errors, raw
        )

    # Guarantee a do-nothing escape hatch. If the model didn't offer one, add it
    # ourselves — the analyst must always be able to decline.
    if not any(o["action"] in _PASSIVE_ACTIONS for o in options):
        options.append({
            "option_id": "keep_monitoring",
            "label": "Keep monitoring",
            "action": "KEEP_MONITORING",
            "consequence": "Nothing changes. The alert is logged and stays open.",
            "recommended": False,
        })

    # Exactly one recommendation, and it must point at a surviving option.
    rec = raw.get("recommended_option_id")
    ids = {o["option_id"] for o in options}
    if rec not in ids:
        rec = next((o["option_id"] for o in options if o.get("recommended")), None)
    if rec not in ids:
        # Fall back to the most conservative surviving option.
        rec = next(
            (o["option_id"] for o in options if o["action"] in _PASSIVE_ACTIONS),
            options[0]["option_id"],
        )
    for o in options:
        o["recommended"] = o["option_id"] == rec

    raw["options"] = options
    raw["recommended_option_id"] = rec
    raw["notification_title"] = (raw.get("notification_title") or "Pricing alert")[:45]
    raw["notification_body"] = (raw.get("notification_body") or raw.get("question", ""))[:120]
    raw["dropped"] = errors
    return raw


def build_approval_request(
    *,
    trigger: str,
    project: dict,
    telemetry: dict,
    strategy: dict,
    available_versions: list[str],
    rules_involved: list[dict] | None = None,
    currency: str = "INR",
) -> dict:
    """Fired alert -> validated approval request. Synchronous: SQS workers call it.

    Runs on the WRITE path, before any notification is sent. By the time the
    analyst's phone buzzes, the question and its options are already stored, so
    opening the app is a single DynamoDB read with no model call in the way.
    """
    user = P.build_approval_request_user(
        trigger=trigger, project=project, telemetry=telemetry, strategy=strategy,
        available_versions=available_versions, rules_involved=rules_involved,
        currency=currency,
    )
    res = generate_sync(
        system=P.APPROVAL_REQUEST_SYSTEM,
        user=user,
        schema=P.APPROVAL_REQUEST_SCHEMA,
        max_tokens=1536,
    )
    out = validate_approval(
        res.data,
        available_versions=available_versions,
        valid_rule_ids={r.get("rule_id") for r in (rules_involved or []) if r.get("rule_id")},
    )
    out["_meta"] = {
        "model": res.model, "latency_ms": res.latency_ms,
        "attempts": res.attempts, "hedged": res.hedged,
    }
    return out
