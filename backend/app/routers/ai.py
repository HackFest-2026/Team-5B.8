"""AI configuration — natural language to pricing rules.

    GET /ai/configure   "raise price 10% when demand is above 80"  ->  draft config
    GET /ai/forecast    advisory demand/elasticity hint
    GET /ai/health      key-pool and model status

The draft that comes back is **data, not an action**. It populates the visual
rule builder; the analyst edits it and saves through the normal `/rules/create`
or `/guardrails/save`. There is no "AI, activate this" path — not disabled,
not implemented.

`price-fn` has no IAM permission to reach Gemini, so the hot path physically
cannot call a model even if someone wired it up by mistake.
"""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import ProjectDep, RegisteredDep
from app.responses import ApiError, ok
from core import ai as ai_layer
from core import audit, db
from core.ai import ValidationReject, prompt_cache_key
from core.ai.gemini import GeminiError, generate

router = APIRouter(tags=["ai"])

CACHE_TTL_SECONDS = 24 * 3600


@router.get("/ai/configure", summary="Natural language → pricing configuration")
async def configure(
    ctx: ProjectDep,
    prompt: Annotated[str, Query(min_length=8, max_length=600,
                                 description="Plain English, e.g. 'raise price 10% when demand is above 80 and stock is below 20'")],
    use_cache: Annotated[bool, Query()] = True,
):
    """Translate one sentence into a structured draft.

    Domain-agnostic by construction: the model is handed this project's schema
    as its entire vocabulary and may only emit field ids that appear in it.
    Output is then validated mechanically — unknown field, impossible range or
    broken tier arithmetic all become a rejection with a readable reason rather
    than a bad rule.
    """
    schema = ctx.schema
    if not (schema.get("context_signals") or schema.get("attributes")):
        raise ApiError(
            "define this project's schema first — /domain/save. The AI uses your "
            "signals as its vocabulary and has nothing to work with yet.",
            code="schema_empty",
        )

    cache_key = prompt_cache_key(prompt, str(schema.get("version", 0)), "config")

    # A repeated prompt returns in ~15ms instead of ~1.2s and costs nothing.
    # The key includes the schema version, so editing the schema invalidates
    # every draft written against the old one automatically.
    if use_cache:
        cached = db.get(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_ai_cache(cache_key))
        if cached and cached.get("result"):
            return ok({**cached["result"], "cached": True})

    try:
        result = await ai_layer.nl_to_config(
            prompt=prompt,
            schema=schema,
            currency=ctx.currency,
            guardrails=ctx.guardrails,
        )
    except ValidationReject as exc:
        # The model answered, but its answer was not usable. Say why, and point
        # at the builder — never save a half-understood rule.
        return ok({
            "understood": False,
            "reasons": exc.reasons,
            "raw": exc.raw,
            "suggestion": "Rephrase using this project's signal names, or build "
                          "the rule manually.",
            "available_signals": [
                {"id": s["id"], "label": s.get("label")}
                for s in (schema.get("context_signals") or [])
            ],
        })
    except GeminiError as exc:
        raise ApiError(
            f"the AI service is unavailable right now: {exc}",
            code="ai_unavailable", status_code=503,
            fallback="Use the visual rule builder — it does everything this does.",
        ) from exc

    meta = result.pop("_meta", {})
    body = {
        "understood": True,
        "kind": result.get("kind"),
        "confidence": result.get("confidence"),
        "suggested_name": result.get("suggested_name"),
        "config": {
            k: v for k, v in result.items()
            if k in ("logic", "clauses", "adjustment", "tiers", "constraint",
                     "schedule", "priority", "stackable")
        },
        "interpretation": result.get("interpretation", []),
        "inferred": result.get("inferred", []),
        "unmapped": result.get("unmapped", []),
        "warnings": result.get("warnings", []),
        "clarification": result.get("clarification"),
        "status": "draft",
        "save_with": (
            "/guardrails/save" if result.get("kind") == "constraint" else "/rules/create"
        ),
        "next_steps": ["review", "edit", "validate", "simulate", "save"],
        "ai": meta,
        "cached": False,
    }

    db.put(db.core(), {
        "pk": db.pk_tenant(ctx.tenant_id),
        "sk": db.sk_ai_cache(cache_key),
        "result": body,
        "prompt": prompt,
        "project_id": ctx.project_id,
        "created_at": db.now_ms(),
        "ttl": db.ttl_in(CACHE_TTL_SECONDS),
    })

    audit.record(
        tenant_id=ctx.tenant_id, action="AI_CONFIG_GENERATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="ai_draft", entity_id=cache_key,
        new_value={"kind": result.get("kind"), "confidence": result.get("confidence")},
        note=prompt[:200],
    )
    return ok(body)


# ── Playground: AI-generated test cases ─────────────────────────────────

# Gemini response shape. Signals are an array of {field,value} pairs rather than
# a free-form object, because a fixed-key schema is what the model can reliably
# emit; the value is a string and the engine coerces it per the field's type.
_TESTCASE_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "description": {"type": "string"},
            "item_id": {"type": "string"},
            "signals": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "field": {"type": "string"},
                        "value": {"type": "string"},
                    },
                    "required": ["field", "value"],
                },
            },
            "expected_price": {"type": "number"},
            "reasoning": {"type": "string"},
        },
        "required": ["title", "signals", "expected_price"],
    },
}

_TESTCASE_SYSTEM = """\
You design test cases for a deterministic pricing engine. You are given a \
project's schema (signals with their scope and type), its products (with base \
prices and optional costs), its rules (conditions -> adjustment), and its \
guardrails.

Produce a diverse battery of test cases that exercise the configuration from \
every angle a careful QA engineer would: the quiet baseline where no rule \
fires; each rule firing on its own; conditions just below and exactly on each \
threshold; several rules stacking together; the guardrail caps and the margin \
floor; and, where present, formula and request-scope behaviour. Vary which \
product each case prices.

ACCURACY IS EVERYTHING — your expected_price is checked against the real engine, \
so it must match to the cent. Follow these rules exactly:
1. Use the EXACT numeric thresholds from the RULES you are given, never invented \
   ones. To MAKE a rule fire, set its signal just past its own threshold (rule \
   "x >= 5000" -> use 5000 or 5001; rule "x < 20" -> use 19). To keep it from \
   firing, stay clearly on the other side.
2. A rule changes the price ONLY when the signals in THIS case actually satisfy \
   its condition. If no rule's condition is met, expected_price = base_price. \
   Never apply a rule whose condition the case does not meet.
3. Use each rule's EXACT adjustment: its own percent, or its formula, or its \
   set_price — not a number you guessed. Percentages SUM (they do not compound), \
   apply to the base price; a set_price or price-mode formula overrides.
4. GUARDRAILS: max_increase_pct / max_decrease_pct only CLAMP a result that went \
   past them. min_margin (margin floor) is a MINIMUM that only RAISES a price \
   which would otherwise fall below the floor — it NEVER lowers a normal price. \
   If nothing hit a guardrail, it has no effect.
Keep `reasoning` to ONE short line naming the rule(s) that fired and the result \
(e.g. "High Traffic Surge +15% -> 575"); do not write long explanations.

Only use signal ids that exist in the schema. Give every case a short title and \
a one-line description of what it checks. Return ONLY the JSON array."""


def _render_rules(rules: list[dict]) -> str:
    out = []
    for r in rules:
        if not r.get("enabled", True):
            continue
        conds = "; ".join(
            f"{c.get('field')} {c.get('operator')} {c.get('value')}"
            + (f"..{c.get('value2')}" if c.get("value2") is not None else "")
            for c in (r.get("clauses") or [])
        )
        adj = r.get("adjustment") or {}
        if adj.get("type") == "formula":
            act = f"formula {adj.get('expr')} ({adj.get('formula_mode')})"
        else:
            act = f"{adj.get('direction','increase')} {adj.get('value')} ({adj.get('type')})"
        out.append(f"- {r.get('name')}: WHEN {conds} THEN {act} [priority {r.get('priority')}]")
    return "\n".join(out) or "(no rules)"


@router.get("/ai/testcases", summary="Generate pricing test cases for the Playground")
async def generate_testcases(
    ctx: ProjectDep,
    count: Annotated[int, Query(ge=1, le=40)] = 20,
    focus: Annotated[str, Query(description="Describe a specific scenario to test")] = "",
):
    """Draft test cases from the project's own configuration.

    The cases are a HYPOTHESIS: the AI proposes inputs and an expected price, and
    the Playground then runs the real deterministic engine (via simulation, which
    writes nothing) and shows expected-vs-actual. A disagreement is surfaced for
    the human — it may be the engine, or it may be the AI's arithmetic.
    """
    schema = ctx.schema or {}
    sigs = schema.get("context_signals") or []
    items, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id),
        db.sk_item_prefix(ctx.project_id), limit=12)
    rules, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id),
        db.sk_rule_prefix(ctx.project_id), limit=200)

    if not items:
        raise ApiError("add at least one product before generating test cases")

    sig_lines = "\n".join(
        f"- {s['id']} ({s.get('scope','item')}, {s.get('type','number')})"
        + (f" range {s.get('min')}..{s.get('max')}" if s.get("min") is not None else "")
        for s in sigs
    ) or "(no signals)"
    item_lines = "\n".join(
        f"- {it['item_id']} \"{it.get('name')}\" base {it.get('base_price')}"
        + (f" cost {it.get('cost')}" if it.get("cost") is not None else "")
        for it in items[:12]
    )
    g = ctx.guardrails or {}
    guard_line = ", ".join(f"{k}={v}" for k, v in g.items() if v is not None) or "none"

    user = (
        f"Entity: {schema.get('entity_label','item')}\n"
        f"Currency: {ctx.currency}\n\n"
        f"SIGNALS:\n{sig_lines}\n\n"
        f"PRODUCTS:\n{item_lines}\n\n"
        f"RULES:\n{_render_rules(rules)}\n\n"
        f"GUARDRAILS: {guard_line}\n\n"
        f"Produce {count} diverse test cases."
    )
    if focus.strip():
        user += f"\n\nFocus specifically on this scenario: {focus.strip()}"

    try:
        result = await generate(
            system=_TESTCASE_SYSTEM, user=user, schema=_TESTCASE_SCHEMA,
            max_tokens=4096, temperature=0.4, hedge=1,
        )
    except GeminiError as exc:
        raise ApiError(
            f"the AI service is unavailable right now: {exc}",
            code="ai_unavailable", status_code=503,
            fallback="Add test cases manually in the Playground.",
        ) from exc

    raw = result.data if isinstance(result.data, list) else []
    known = {s["id"] for s in sigs} | {"day_of_week", "hour_of_day", "season",
                                       "base_price", "cost", "price"}
    item_ids = {it["item_id"] for it in items}
    cases = []
    for i, c in enumerate(raw):
        if not isinstance(c, dict):
            continue
        signals = {}
        for pair in (c.get("signals") or []):
            f = (pair.get("field") or "").strip()
            if f and f in known:
                signals[f] = pair.get("value")
        iid = c.get("item_id") if c.get("item_id") in item_ids else items[0]["item_id"]
        cases.append({
            "id": f"ai-{i}",
            "title": (c.get("title") or f"Case {i + 1}").strip(),
            "description": (c.get("description") or "").strip(),
            "item_id": iid,
            "signals": signals,
            "expected_price": c.get("expected_price"),
            "reasoning": (c.get("reasoning") or "").strip(),
            "source": "ai",
        })

    audit.record(
        tenant_id=ctx.tenant_id, action="AI_CONFIG_GENERATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="testcases", entity_id=ctx.project_id,
        new_value={"count": len(cases)}, note=(focus or "")[:160],
    )
    return ok({
        "cases": cases,
        "count": len(cases),
        "model": result.model,
        "note": "Expected prices are the AI's estimate — the Playground runs the "
                "real engine and shows any difference.",
    })


_BESTRULES_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "rules": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "field": {"type": "string"},
                    "operator": {"type": "string"},
                    "value": {"type": "number"},
                    "action": {"type": "string"},
                    "percent": {"type": "number"},
                    "formula": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["name", "field", "operator", "value", "action", "reason"],
            },
        },
    },
    "required": ["summary", "rules"],
}

_BESTRULES_SYSTEM = """\
You design the BEST SET of pricing rules for a deterministic engine, from the \
project's schema (signals with scope and type), its products (base prices and \
optional costs) and its guardrails.

Think in BOTH directions at once: lift profit AND stay fair and logical, and \
NEVER propose a move the guardrails would reject. Raise when demand is high, \
stock is scarce or a competitor is pricing high; protect margin with a floor at \
cost when a cost exists; give sensible discounts (bulk, loyalty, slow movers). \
No blunt or arbitrary hikes — every rule needs a reason a customer would accept.

Produce a SMALL, high-value set — the few rules that matter, typically 3 to 6, \
NEVER more than 8. Quality over quantity; prefer several targeted rules over one \
crude one, but do not pad the list.

STACKING DISCIPLINE — the rules stack, so a careless set compounds into a wild \
swing. This matters even when NO guardrails are set yet (rules are often created \
before limits), so keep the combined effect sane on your own, not by relying on \
a cap:
- NEVER two rules with the same name, or the same condition+direction. Each rule \
  fires on a DISTINCT condition.
- Keep each percentage SMALL (a few %). The SUM of all your UP rules should stay \
  modest — about 10-20% total, NEVER 40%+ — and likewise for DOWN rules. If \
  guardrails ARE given, stay within roughly the max_increase / max_decrease. If \
  several rules could realistically fire together, shrink their percentages so \
  the combined move is still sensible.

Each rule has ONE condition (field, operator in > >= < <= == !=, numeric value) \
and an action:
- "increase" or "decrease" with a `percent`, OR
- "formula": set `formula` to an expression over the signal ids, base_price and \
  cost (e.g. base_price * (1 + occupancy/200)); use a formula only where it makes \
  pricing genuinely smarter.
Only use field ids that exist in the schema (plus base_price, cost, price, \
day_of_week, hour_of_day, season). Give each rule a short name and a one-line \
`reason`. Also write a `summary`: 1-2 sentences describing the set as a whole. \
Return ONLY the JSON object."""


@router.get("/ai/rules/best", summary="Generate the best set of pricing rules")
async def best_rules(
    ctx: ProjectDep,
    focus: Annotated[str, Query(description="Optional emphasis, e.g. 'maximize profit'")] = "",
):
    """Draft a small, profit-aware, guardrail-respecting SET of rules.

    This is the multi-rule counterpart to `/ai/configure` (which drafts one rule
    from one sentence). Every rule is a DRAFT: it populates the builder and the
    user reviews, edits and saves through the ordinary rule endpoints. Nothing is
    activated here.
    """
    schema = ctx.schema or {}
    sigs = schema.get("context_signals") or []
    if not sigs:
        raise ApiError(
            "define this project's schema first — the AI designs rules from your "
            "signals and has nothing to work with yet.",
            code="schema_empty",
        )

    items, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id),
        db.sk_item_prefix(ctx.project_id), limit=8)

    sig_lines = "\n".join(
        f"- {s['id']} ({s.get('scope','item')}, {s.get('type','number')})"
        + (f" range {s.get('min')}..{s.get('max')}" if s.get("min") is not None else "")
        for s in sigs
    ) or "(no signals)"
    item_lines = "\n".join(
        f"- {it['item_id']} \"{it.get('name')}\" base {it.get('base_price')}"
        + (f" cost {it.get('cost')}" if it.get("cost") is not None else "")
        for it in items[:8]
    ) or "(no products yet)"
    g = ctx.guardrails or {}
    guard_line = ", ".join(f"{k}={v}" for k, v in g.items() if v is not None) or "none"
    has_cost = any(it.get("cost") is not None for it in items)

    user = (
        f"Entity: {schema.get('entity_label','item')}\n"
        f"Currency: {ctx.currency}\n\n"
        f"SIGNALS:\n{sig_lines}\n\n"
        f"PRODUCTS (sample):\n{item_lines}\n\n"
        f"GUARDRAILS: {guard_line}\n"
        f"Cost is {'available' if has_cost else 'NOT set'} on products.\n\n"
        "Design the best set of rules."
    )
    if focus.strip():
        user += f"\n\nEmphasis: {focus.strip()}"

    try:
        result = await generate(
            system=_BESTRULES_SYSTEM, user=user, schema=_BESTRULES_SCHEMA,
            max_tokens=4096, temperature=0.4, hedge=1,
        )
    except GeminiError as exc:
        raise ApiError(
            f"the AI service is unavailable right now: {exc}",
            code="ai_unavailable", status_code=503,
            fallback="Add rules manually below.",
        ) from exc

    data = result.data if isinstance(result.data, dict) else {}
    raw = data.get("rules") if isinstance(data.get("rules"), list) else []
    known = {s["id"] for s in sigs} | {"day_of_week", "hour_of_day", "season",
                                       "base_price", "cost", "price"}
    ops = {">", ">=", "<", "<=", "==", "!="}
    rules = []
    for r in raw[:8]:
        if not isinstance(r, dict):
            continue
        field = (r.get("field") or "").strip()
        op = (r.get("operator") or "").strip()
        if field not in known or op not in ops or r.get("value") is None:
            continue
        action = (r.get("action") or "increase").strip().lower()
        out = {
            "name": (r.get("name") or "Rule").strip()[:60],
            "field": field,
            "operator": op,
            "value": r.get("value"),
            "reason": (r.get("reason") or "").strip()[:160],
        }
        if action == "formula" and (r.get("formula") or "").strip():
            out["action"] = "formula"
            out["formula"] = r["formula"].strip()[:400]
        else:
            out["action"] = "decrease" if action == "decrease" else "increase"
            out["percent"] = abs(float(r.get("percent") or 0)) or 5.0
        rules.append(out)

    audit.record(
        tenant_id=ctx.tenant_id, action="AI_CONFIG_GENERATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="bestrules", entity_id=ctx.project_id,
        new_value={"count": len(rules)}, note=(focus or "")[:160],
    )
    return ok({
        "rules": rules,
        "count": len(rules),
        "summary": (data.get("summary") or "").strip(),
        "model": result.model,
        "note": "These are drafts — review, edit and they save when you continue. "
                "The engine, not the AI, prices for real.",
    })


@router.get("/ai/forecast", summary="Advisory demand forecast (optional ML)")
async def forecast(
    ctx: ProjectDep,
    item_id: Annotated[str, Query()],
    horizon: Annotated[int, Query(ge=1, le=72, description="Hours ahead")] = 24,
):
    """A hint for the analyst, never an input to the engine.

    Deliberately advisory: deterministic rules plus guardrails remain the only
    thing that sets a price. A forecast that feeds pricing directly would make
    prices unreproducible, which breaks replay, backtesting and the audit trail
    in one move.

    The estimate is a simple trend extrapolation over recent decisions rather
    than a trained model — honest about what it is, and it needs no training
    pipeline to be useful.
    """
    rows, _ = db.query_prefix(
        db.decisions(), db.decidx_pk(ctx.project_id, item_id), "",
        limit=200, ascending=False,
    )
    if len(rows) < 5:
        return ok({
            "item_id": item_id,
            "available": False,
            "reason": f"only {len(rows)} decisions recorded; at least 5 are needed",
        })

    series = [
        (r.get("ts"), (r.get("signals") or {}).get("demand_score"))
        for r in rows if (r.get("signals") or {}).get("demand_score") is not None
    ]
    if len(series) < 5:
        return ok({
            "item_id": item_id, "available": False,
            "reason": "no demand_score history on these decisions",
        })

    series.sort()
    values = [v for _, v in series]
    n = len(values)
    recent = values[-min(12, n):]
    older = values[:min(12, n)]
    avg_recent = sum(recent) / len(recent)
    avg_older = sum(older) / len(older)
    trend = (avg_recent - avg_older) / max(avg_older, 1e-6)

    projected = max(0.0, min(100.0, avg_recent * (1 + trend * horizon / 24)))

    prices = [r.get("final_price") for r in rows if r.get("final_price")]
    elasticity = None
    if len(prices) >= 10:
        p_avg = sum(prices) / len(prices)
        p_var = sum((p - p_avg) ** 2 for p in prices) / len(prices)
        if p_var > 0:
            elasticity = round(-trend / (p_var ** 0.5 / max(p_avg, 1e-6) + 1e-6), 3)

    return ok({
        "item_id": item_id,
        "available": True,
        "horizon_hours": horizon,
        "current_demand": round(avg_recent, 2),
        "projected_demand": round(projected, 2),
        "trend_pct": round(trend * 100, 2),
        "elasticity_hint": elasticity,
        "sample_size": n,
        "method": "trend extrapolation over recent decisions",
        "disclaimer": "Advisory only. This never feeds the pricing engine — "
                      "deterministic rules and guardrails set every price.",
    })


@router.get("/ai/chat/history", summary="The schema-design conversation for a project")
async def chat_history(ctx: ProjectDep):
    """The whole agent transcript, oldest first.

    The wizard loads this when the chat is reopened so the user sees every
    earlier message — the conversation is tied to the project, not the browser
    tab. Messages are the same {role, content} the socket streamed; the client
    strips the §directives for display exactly as it does while streaming.
    """
    from core import agent_chat

    messages = agent_chat.load(ctx.tenant_id, ctx.project_id)
    return ok({"messages": messages, "count": len(messages)})


@router.get("/ai/health", summary="Gemini key pool and model status")
async def ai_health(session: RegisteredDep):
    """Operational view of the key pool.

    Surfaces the four failure modes separately, because they need different
    responses: a dead key needs replacing, a cooling key needs patience, an
    unavailable model needs the fallback chain re-pointed.
    """
    try:
        health = ai_layer.health()
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"key pool unavailable: {exc}", code="ai_unavailable",
                       status_code=503) from exc

    keys = health["keys"]
    models_up = [m for m in health["models"] if m["available"]]
    return ok({
        "healthy": keys["usable"] > 0 and bool(models_up),
        "keys": keys,
        "models": health["models"],
        "capacity_rpm_estimate": health["capacity_rpm_estimate"],
        "detail": health["detail"],
        "guidance": {
            "dead": "403/401 — the project is denied access. Replace the key.",
            "cooling": "429 — rate limited. It recovers on its own.",
            "model_unavailable": "503/404 — re-point the fallback chain in SSM "
                                 "at /devnexus/<stage>/gemini/models.",
        },
    })
