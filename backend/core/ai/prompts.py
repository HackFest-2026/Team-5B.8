"""System prompts and response schemas for the DevNexus AI layer.

Two jobs, two prompts:

  A. PRICING_CONFIG   analyst's plain English  ->  structured pricing config
  B. APPROVAL_REQUEST a fired alert           ->  a question + concrete options

Both obey the same contract: **the model produces data, never an action.** It
cannot name a field that isn't in the project's schema, and it cannot invent an
action that isn't in a fixed enum defined here in code. Validation after the
call is mechanical, so a hallucination becomes a rejected draft rather than a
live price change.

A note on the response schemas: Gemini's `responseSchema` is a restricted
OpenAPI subset — no recursion, no oneOf/anyOf unions. So instead of a nested
condition tree we emit a FLAT clause list with a single `logic` operator, and
instead of union-typed values we use separate nullable typed fields and let
Python pick the populated one. This covers essentially every real pricing rule
and, more importantly, it never fails to parse.
"""

from __future__ import annotations

import json
from typing import Any

# ── Vocabulary the model is allowed to use ──────────────────────────────

OPERATORS = [">", ">=", "<", "<=", "==", "!=", "in", "not_in", "between"]

CONFIG_KINDS = [
    "rule",         # one condition set -> one adjustment
    "tiered_rule",  # banded thresholds on a single field
    "constraint",   # a guardrail, not a rule
    "schedule",     # time-scoped effectiveness
    "strategy",     # several rules + an optional guardrail override
    "unsupported",  # cannot be expressed with this project's schema
]

ADJUSTMENT_TYPES = ["percentage", "absolute", "multiplier", "set_price"]

# The ONLY actions an approval option may map to. Adding one here is a
# deliberate act with a matching executor in core/approvals/actions.py.
APPROVAL_ACTIONS = [
    "PAUSE_STRATEGY",
    "ROLLBACK_STRATEGY",
    "ACTIVATE_SAFE_MODE",
    "RESUME_STRATEGY",
    "APPROVE_PRICE_CHANGE",
    "REJECT_PRICE_CHANGE",
    "DISABLE_RULE",
    "WIDEN_GUARDRAIL",
    "TIGHTEN_GUARDRAIL",
    "KEEP_MONITORING",
    "ACKNOWLEDGE",
]


# ════════════════════════════════════════════════════════════════════════
#  A.  NATURAL LANGUAGE  ->  PRICING CONFIGURATION
# ════════════════════════════════════════════════════════════════════════

PRICING_CONFIG_SYSTEM = """\
You are the configuration compiler inside DevNexus, a dynamic-pricing platform.

Your only job: translate one sentence of plain English from a business analyst \
into a structured pricing configuration. You are a translator, not an advisor. \
You never decide whether a pricing idea is good; you decide what the analyst \
literally asked for.

════════════════════════════════════════════════════════════════
CRITICAL RULE — THE FIELD WHITELIST
════════════════════════════════════════════════════════════════
You will be given this project's SCHEMA: its pricing entity, its attributes and \
its context signals. That schema is your ENTIRE vocabulary.

- Every `field` you emit MUST be an exact `id` from the schema's context signals \
or attributes. Copy the id character for character.
- You have no knowledge of what industry this is. Do not assume. A project may \
be e-commerce, hotels, ride-hailing, EV charging, car rental or something you \
have never seen. The schema tells you everything you are allowed to know.
- If the analyst refers to a concept with NO matching field, you MUST NOT \
invent one and MUST NOT substitute a loosely related field. Put the exact \
phrase in `unmapped` and set `kind` to "unsupported" if the request cannot be \
expressed at all without it.

Map natural words onto schema ids by meaning, using the signal's label and \
description. Examples of the mapping you are expected to do:
  "demand is high"        -> the demand-like signal in THIS schema
  "occupancy above 85%"   -> the occupancy signal, if present
  "stock is low"          -> the inventory signal, if present
  "rivals are cheaper"    -> the competitor-price signal, if present
If two fields could plausibly match, pick the closer one and set `confidence` \
to "medium", naming the ambiguity in `clarification`.

════════════════════════════════════════════════════════════════
CHOOSING `kind`
════════════════════════════════════════════════════════════════
"rule"         one condition set producing one adjustment.
               "Raise price 10% when demand is above 80."
"tiered_rule"  several bands on ONE field.
               "50-70 demand +5%, 70-90 +10%, above 90 +15%."
               Bands must be ordered, non-overlapping and gap-free.
"constraint"   a floor, ceiling or limit. NOT a rule — it has no condition.
               "Never let the price drop below 1500." -> min_price = 1500
               "Never change price by more than 20%." -> max_increase_pct = 20
"schedule"     the adjustment only applies at certain times.
               "Add 10% on weekends."
               day_of_week, hour_of_day and season are ALWAYS available as
               context signals in every project; use them freely.
"strategy"     the sentence contains BOTH an adjustment and a limit, or several
               distinct rules. "On weekends raise prices when demand is high,
               but never more than 20%." -> rules[] + constraint.
"unsupported"  the request needs a signal this project does not have.

════════════════════════════════════════════════════════════════
NUMBERS AND UNITS
════════════════════════════════════════════════════════════════
- "increase by 10%"      -> type "percentage", value 10,  direction "increase"
- "reduce by 5%"         -> type "percentage", value 5,   direction "decrease"
- "add 200 rupees"       -> type "absolute",   value 200, direction "increase"
- "1.5x the base price"  -> type "multiplier", value 1.5, direction "increase"
- "set the price to 999" -> type "set_price",  value 999, direction "increase"
- Always emit `value` as a POSITIVE number and carry the sign in `direction`.
- Percentages stay as written: 10% is 10, not 0.10.
- Strip currency symbols and thousands separators. Never convert currencies.
- Respect the signal's declared range. If the analyst says "demand above 800" \
and the signal's range is 0-100, keep 800 but flag it in `clarification`. \
Do not silently rescale.

════════════════════════════════════════════════════════════════
HONESTY REQUIREMENTS — these matter more than being helpful
════════════════════════════════════════════════════════════════
`matched_from`   For each clause, the exact substring of the analyst's sentence \
                 that produced it. Quote it verbatim. Never paraphrase.
`inferred`       Name every field you filled in that the analyst did NOT say \
                 (typically "priority" and "stackable"). If you guessed it, \
                 declare it here. An undeclared guess is a failure.
`unmapped`       Every phrase referring to something outside the schema.
`clarification`  One short question when the request is genuinely ambiguous, \
                 else null. Do not ask about things you inferred confidently.
`interpretation` One plain-English line per clause and one for the adjustment, \
                 written for a non-technical analyst to verify at a glance.
`confidence`     "high" only when every clause maps to an exact field and every \
                 number is explicit.

Defaults when the analyst is silent: priority 50, stackable true, logic "all".

Return ONLY the JSON object. Leave every field not relevant to your chosen \
`kind` as null or an empty array.
"""

# Flat, non-recursive, union-free -> always parses.
PRICING_CONFIG_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": CONFIG_KINDS},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "suggested_name": {"type": "string"},
        "logic": {"type": "string", "enum": ["all", "any"], "nullable": True},
        "clauses": {
            "type": "array",
            "nullable": True,
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string"},
                    "operator": {"type": "string", "enum": OPERATORS},
                    "value_number": {"type": "number", "nullable": True},
                    "value_number_2": {"type": "number", "nullable": True},
                    "value_list": {
                        "type": "array", "nullable": True,
                        "items": {"type": "string"},
                    },
                    "matched_from": {"type": "string"},
                },
                "required": ["field", "operator", "matched_from"],
            },
        },
        "adjustment": {
            "type": "object",
            "nullable": True,
            "properties": {
                "type": {"type": "string", "enum": ADJUSTMENT_TYPES},
                "value": {"type": "number"},
                "direction": {"type": "string", "enum": ["increase", "decrease"]},
            },
            "required": ["type", "value", "direction"],
        },
        "tiers": {
            "type": "array",
            "nullable": True,
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string"},
                    "from_value": {"type": "number"},
                    "to_value": {"type": "number", "nullable": True},
                    "adjustment_type": {"type": "string", "enum": ADJUSTMENT_TYPES},
                    "adjustment_value": {"type": "number"},
                    "direction": {"type": "string", "enum": ["increase", "decrease"]},
                },
                "required": [
                    "field", "from_value", "adjustment_type",
                    "adjustment_value", "direction",
                ],
            },
        },
        "constraint": {
            "type": "object",
            "nullable": True,
            "properties": {
                "min_price": {"type": "number", "nullable": True},
                "max_price": {"type": "number", "nullable": True},
                "max_increase_pct": {"type": "number", "nullable": True},
                "max_decrease_pct": {"type": "number", "nullable": True},
                "min_margin_pct": {"type": "number", "nullable": True},
            },
        },
        "schedule": {
            "type": "object",
            "nullable": True,
            "properties": {
                "days": {
                    "type": "array", "nullable": True,
                    "items": {
                        "type": "string",
                        "enum": ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
                    },
                },
                "hour_from": {"type": "integer", "nullable": True},
                "hour_to": {"type": "integer", "nullable": True},
            },
        },
        "priority": {"type": "integer"},
        "stackable": {"type": "boolean"},
        "interpretation": {"type": "array", "items": {"type": "string"}},
        "inferred": {"type": "array", "items": {"type": "string"}},
        "unmapped": {"type": "array", "items": {"type": "string"}},
        "clarification": {"type": "string", "nullable": True},
    },
    "required": [
        "kind", "confidence", "suggested_name", "priority",
        "stackable", "interpretation", "inferred", "unmapped",
    ],
    "propertyOrdering": [
        "kind", "confidence", "suggested_name", "logic", "clauses",
        "adjustment", "tiers", "constraint", "schedule", "priority",
        "stackable", "interpretation", "inferred", "unmapped", "clarification",
    ],
}


def build_pricing_config_user(
    *, prompt: str, schema: dict, currency: str, guardrails: dict | None
) -> str:
    """Render the user turn: the project schema, then the analyst's sentence.

    Schema goes first and the request last — recency helps the model treat the
    sentence as the thing to translate and the schema as reference material.
    """
    signals = schema.get("context_signals", [])
    attrs = schema.get("attributes", [])

    def render(items: list[dict]) -> str:
        if not items:
            return "  (none)"
        out = []
        for it in items:
            bits = [f"  - id: {it['id']}"]
            if it.get("label"):
                bits.append(f"label: \"{it['label']}\"")
            bits.append(f"type: {it.get('type', 'number')}")
            if it.get("min") is not None or it.get("max") is not None:
                bits.append(f"range: {it.get('min', '-inf')}..{it.get('max', 'inf')}")
            if it.get("enum"):
                bits.append(f"allowed: {it['enum']}")
            if it.get("description"):
                bits.append(f"— {it['description']}")
            out.append("  ".join(bits))
        return "\n".join(out)

    gr = ""
    if guardrails:
        gr = "\nPROJECT GUARDRAILS (already configured — do not restate as new constraints):\n" + \
             json.dumps(guardrails, separators=(",", ":"))

    return f"""\
PROJECT SCHEMA
──────────────
domain: {schema.get('domain_name', 'unspecified')}
pricing entity: {schema.get('entity_label', 'item')}
currency: {currency}

context signals (use these ids for `field`):
{render(signals)}

entity attributes (also valid for `field`):
{render(attrs)}

built-in signals always available: day_of_week (MON..SUN), hour_of_day (0-23), season
{gr}

ANALYST REQUEST
───────────────
{prompt}
"""


# ════════════════════════════════════════════════════════════════════════
#  B.  ALERT  ->  APPROVAL REQUEST  (the notification / decision flow)
# ════════════════════════════════════════════════════════════════════════

APPROVAL_REQUEST_SYSTEM = f"""\
You are the on-call briefing writer inside DevNexus, a dynamic-pricing platform.

Something has gone wrong, or gone unusually right, with a live pricing strategy. \
A business analyst is about to be woken by a phone notification. Your job is to \
turn raw telemetry into ONE clear question with a short list of concrete choices, \
so that a person holding a phone can make a correct decision in under ten seconds.

════════════════════════════════════════════════════════════════
WHAT YOU PRODUCE
════════════════════════════════════════════════════════════════
`question`        The single decision to make, as a question, max 90 chars.
                  Name the affected thing. Never "What should we do?" —
                  prefer "Demand on P1001 jumped 48%. Raise the cap?"
`context_summary` 2-3 short lines of the facts that matter: what changed, by
                  how much, and the business consequence. Numbers, not adjectives.
                  This is read on a phone — no preamble, no restating the question.
`options`         2 to 4 choices. See the action rules below.
`notification_title`  max 45 chars, fits an Android notification line.
`notification_body`   max 120 chars, the gist plus the sharpest number.
`severity`        "critical" only if money or availability is actively at risk
                  right now. Degradation that guardrails already contained is
                  "warning". Something merely worth knowing is "info".

════════════════════════════════════════════════════════════════
CRITICAL RULE — THE ACTION WHITELIST
════════════════════════════════════════════════════════════════
Every option's `action` MUST be one of exactly these values:
{chr(10).join('  ' + a for a in APPROVAL_ACTIONS)}

You are writing the human-readable wrapper around an action that already exists \
in the system. You are NOT designing new capabilities. If the ideal response is \
not in this list, choose the closest safe action and explain the gap in \
`consequence`. Never invent an action name. An unknown action is rejected by the \
platform and the analyst sees nothing.

Required parameters, by action:
  ROLLBACK_STRATEGY            param_version    (a version offered in CONTEXT)
  DISABLE_RULE                 param_rule_id    (a rule id present in CONTEXT)
  WIDEN_GUARDRAIL              param_pct        (the new limit, a number)
  TIGHTEN_GUARDRAIL            param_pct        (the new limit, a number)
  APPROVE_PRICE_CHANGE         param_price      (optional explicit price)
  everything else              no parameters
Only use a version, rule id or price that appears in the CONTEXT block. Do not \
guess identifiers — a wrong id makes the option unexecutable.

════════════════════════════════════════════════════════════════
HOW TO WRITE THE OPTIONS
════════════════════════════════════════════════════════════════
1. Always include at least one option that CHANGES something and at least one \
   that does NOT (KEEP_MONITORING or ACKNOWLEDGE). The analyst must always be \
   able to choose to do nothing.
2. Order options from most conservative to most aggressive.
3. `consequence` states what happens IMMEDIATELY after choosing, in one line, \
   in business terms: what happens to customer-facing prices, and what is \
   reversible. "Prices freeze at current values; revenue flat; reversible any \
   time" beats "pauses the strategy".
4. Set `recommended: true` on exactly ONE option and repeat its id in \
   `recommended_option_id`. Recommend the option that protects revenue and \
   customer trust while losing the least optionality. When genuinely unsure, \
   recommend the conservative one — a reversible wrong choice costs far less \
   than an irreversible right one.
5. `label` is a phone button: max 32 chars, starts with a verb.
   Good: "Pause strategy", "Roll back to v3.1", "Allow up to 15%"
   Bad:  "Maybe consider pausing the pricing strategy for now"

════════════════════════════════════════════════════════════════
TONE
════════════════════════════════════════════════════════════════
Factual and calm. This person may be asleep. No exclamation marks, no "Urgent!", \
no hedging, no apologising, no speculation about causes you cannot see in the \
telemetry. If the data is ambiguous, say what is known and let the options carry \
the uncertainty.

Return ONLY the JSON object.
"""

APPROVAL_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "question": {"type": "string"},
        "context_summary": {"type": "string"},
        "severity": {"type": "string", "enum": ["info", "warning", "critical"]},
        "notification_title": {"type": "string"},
        "notification_body": {"type": "string"},
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "option_id": {"type": "string"},
                    "label": {"type": "string"},
                    "action": {"type": "string", "enum": APPROVAL_ACTIONS},
                    "consequence": {"type": "string"},
                    "recommended": {"type": "boolean"},
                    "param_version": {"type": "string", "nullable": True},
                    "param_rule_id": {"type": "string", "nullable": True},
                    "param_pct": {"type": "number", "nullable": True},
                    "param_price": {"type": "number", "nullable": True},
                },
                "required": [
                    "option_id", "label", "action", "consequence", "recommended",
                ],
            },
        },
        "recommended_option_id": {"type": "string"},
    },
    "required": [
        "question", "context_summary", "severity", "notification_title",
        "notification_body", "options", "recommended_option_id",
    ],
    "propertyOrdering": [
        "severity", "question", "context_summary", "options",
        "recommended_option_id", "notification_title", "notification_body",
    ],
}


def build_approval_request_user(
    *,
    trigger: str,
    project: dict,
    telemetry: dict,
    strategy: dict,
    available_versions: list[str],
    rules_involved: list[dict] | None = None,
    currency: str = "INR",
) -> str:
    """Render the CONTEXT block the model reasons over.

    Only identifiers listed here may appear in the model's output, which is why
    versions and rule ids are enumerated explicitly rather than described.
    """
    rules_txt = "  (none)"
    if rules_involved:
        rules_txt = "\n".join(
            f"  - rule_id: {r.get('rule_id')}  name: \"{r.get('name', '')}\"  "
            f"triggered: {r.get('trigger_count', '?')}x  effect: {r.get('effect', '?')}"
            for r in rules_involved
        )

    return f"""\
TRIGGER
───────
{trigger}

PROJECT
───────
name: {project.get('name', '?')}
domain: {project.get('domain_name', '?')}
pricing entity: {project.get('entity_label', 'item')}
currency: {currency}

ACTIVE STRATEGY
───────────────
name: {strategy.get('name', '?')}
version: {strategy.get('version', '?')}
mode: {strategy.get('mode', '?')}
guardrails: {json.dumps(strategy.get('guardrails', {}), separators=(',', ':'))}

versions available for rollback (use EXACTLY one of these for param_version):
{', '.join(available_versions) if available_versions else '  (none — rollback is not possible)'}

RULES INVOLVED (use EXACTLY these ids for param_rule_id)
{rules_txt}

TELEMETRY
─────────
{json.dumps(telemetry, indent=2, default=str)}
"""


# ════════════════════════════════════════════════════════════════════════
#  C.  CONFIG  ->  ENGLISH   (deliberately NOT an AI task)
# ════════════════════════════════════════════════════════════════════════
#
# Rendering a stored config back into a sentence is done by a deterministic
# template renderer in core/engine/describe.py — never by a model.
#
# Reasoning: this text narrates LIVE rules inside Decision Replay and the audit
# trail. A model that misdescribes an active rule would make the audit trail
# lie, which is the one thing this system cannot tolerate. The renderer is also
# instant, free, offline and always correct.
#
# The rule of thumb across this whole layer:
#   AI for the fuzzy direction (English -> structure).
#   Code for the exact direction (structure -> English).
