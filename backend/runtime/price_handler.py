"""The pricing hot path.

This is the most latency-sensitive code in DevNexus and the only Lambda with a
hard performance budget. It deliberately does NOT import FastAPI, Pydantic or
anything from app/ — those cost 300-600ms of cold start for features this
handler has no use for. It parses the API Gateway event itself.

Per request:

    1. resolve API key -> {tenant, project}     in-memory cache, else 1 GetItem
    2. ONE BatchGetItem fetching both:
         CTX#<project>#<item>     the precomputed context
         ACTIVE#<project>         the compiled active strategy
    3. pure in-memory evaluation                zero I/O
    4. guardrails
    5. respond
    6. fire the decision record at SQS          after the response is built

Step 2 is the important one. Both rows live in the same table, so one round
trip gets both. That is also why strategy activation takes effect immediately:
there is no cached ruleset to expire, because the ruleset is fetched alongside
the context every time.

Banned here, permanently: S3, historical scans, Query operations, ML inference,
model calls, analytics aggregation. If any of those appear in this file, the
latency KPI is gone.
"""

from __future__ import annotations

import json
import os
import time
from decimal import Decimal

import boto3

from core.engine import Guardrails, PricingContext, evaluate, rules_from_compiled, safe_fallback

STAGE = os.environ.get("STAGE", "dev")
REGION = os.environ.get("AWS_REGION", "ap-south-1")
TABLE_CORE = os.environ.get("TABLE_CORE", f"devnexus-core-{STAGE}")
TABLE_CONTEXT = os.environ.get("TABLE_CONTEXT", f"devnexus-context-{STAGE}")
QUEUE_DECISIONS = os.environ.get("QUEUE_DECISIONS", "")
# 6 hours, matching the ContextStaleSeconds template parameter. The old 120s
# fallback meant any gap in traffic longer than two minutes caused EVERY rule
# to be skipped and the price to silently revert to base.
STALE_AFTER_S = float(os.environ.get("CONTEXT_STALE_SECONDS", "21600"))
MAX_BULK = 100

# Module scope: created once per execution environment, reused by every warm
# invocation. Creating a boto3 client costs ~50-100ms, which would otherwise be
# paid on every request.
_ddb = boto3.client("dynamodb", region_name=REGION)
_sqs = boto3.client("sqs", region_name=REGION) if QUEUE_DECISIONS else None

# API keys never change for the life of a project, so caching the lookup for a
# few minutes removes one DynamoDB read from most requests.
_key_cache: dict[str, tuple[dict, float]] = {}
# API-key lookups are cached per execution environment. 60s rather than 300s:
# a rotated key must stop working promptly, and TEN-03 showed a revoked key
# still pricing minutes later. The cost is one tiny projected GetItem per key
# per minute on a warm container, which is noise next to the 3.6ms p50.
_KEY_TTL = 60.0

_DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]


# ── DynamoDB low-level helpers ──────────────────────────────────────────
# The resource API's serializer is convenient but adds measurable overhead per
# call. At this volume the low-level client is worth the extra code.

def _unwrap(av: dict):
    if av is None:
        return None
    if "S" in av:
        return av["S"]
    if "N" in av:
        n = Decimal(av["N"])
        return int(n) if n == n.to_integral_value() else float(n)
    if "BOOL" in av:
        return av["BOOL"]
    if "NULL" in av:
        return None
    if "M" in av:
        return {k: _unwrap(v) for k, v in av["M"].items()}
    if "L" in av:
        return [_unwrap(v) for v in av["L"]]
    if "SS" in av:
        return list(av["SS"])
    return None


def _item(raw: dict | None) -> dict | None:
    return {k: _unwrap(v) for k, v in raw.items()} if raw else None


def _resolve_key(api_key: str) -> dict | None:
    now = time.monotonic()
    hit = _key_cache.get(api_key)
    if hit and now < hit[1]:
        return hit[0]

    resp = _ddb.get_item(
        TableName=TABLE_CORE,
        Key={"pk": {"S": f"KEY#{api_key}"}, "sk": {"S": "META"}},
        ProjectionExpression="tenant_id, project_id, revoked",
    )
    row = _item(resp.get("Item"))
    if not row or row.get("revoked"):
        return None
    _key_cache[api_key] = (row, now + _KEY_TTL)
    return row


# DynamoDB caps BatchGetItem at 100 keys per request. The strategy row is one
# of those keys, so a 100-item bulk call needs 101 and must be split. Getting
# this wrong is a hard 500 at exactly the documented limit: 99 items worked,
# 100 did not.
BATCH_LIMIT = 100


def _fetch_state(project_id: str, item_ids: list[str]) -> tuple[dict, dict[str, dict], dict]:
    """Fetch the active strategy plus every requested context row.

    One BatchGetItem when it fits (the overwhelming majority of calls, since a
    single-item price needs only 2 keys), chunked when it does not. A 100-item
    bulk request is still 2 round trips rather than 100.
    """
    keys = [{"pk": {"S": f"ACTIVE#{project_id}"}, "sk": {"S": "STRATEGY"}}]
    # The global row rides along in the same BatchGetItem — one shared row for
    # every item in the request, so a 100-item bulk price still reads it once.
    keys.append({"pk": {"S": f"CTX#{project_id}#__GLOBAL__"}, "sk": {"S": "NOW"}})
    keys += [
        {"pk": {"S": f"CTX#{project_id}#{iid}"}, "sk": {"S": "NOW"}}
        for iid in item_ids
    ]

    strategy: dict = {}
    contexts: dict[str, dict] = {}
    global_row: dict = {}

    for start in range(0, len(keys), BATCH_LIMIT):
        remaining = keys[start:start + BATCH_LIMIT]
        # BatchGetItem can return UnprocessedKeys under throttling; retry them
        # rather than silently pricing on partial state.
        for _ in range(3):
            resp = _ddb.batch_get_item(
                RequestItems={TABLE_CONTEXT: {"Keys": remaining}}
            )
            for raw in resp.get("Responses", {}).get(TABLE_CONTEXT, []):
                row = _item(raw) or {}
                pk = row.get("pk", "")
                if pk.startswith("ACTIVE#"):
                    strategy = row
                elif pk.startswith("CTX#"):
                    iid = pk.rsplit("#", 1)[-1]
                    if iid == "__GLOBAL__":
                        global_row = row
                    else:
                        contexts[iid] = row
            unprocessed = (
                resp.get("UnprocessedKeys", {}).get(TABLE_CONTEXT, {}).get("Keys")
            )
            if not unprocessed:
                break
            remaining = unprocessed

    return strategy, contexts, global_row


# ── evaluation ──────────────────────────────────────────────────────────

def _ages_from(row: dict, now_ms: int) -> dict[str, float]:
    out: dict[str, float] = {}
    for key, stamp in (row.get("signal_updated_at") or {}).items():
        try:
            out[key] = max(0.0, (now_ms - float(stamp)) / 1000.0)
        except (TypeError, ValueError):
            continue
    return out


def _build_context(
    ctx_row: dict,
    global_row: dict,
    request_signals: dict,
    now_ms: int,
    currency: str,
) -> PricingContext:
    """Merge the three scopes into the flat view the engine reads.

    Precedence, lowest to highest: GLOBAL (shared) < ITEM (this product) <
    REQUEST (this call). A request value is the most specific thing anyone knows
    about the price being asked for, so it wins; a global value is the least
    specific, so it is the floor. The engine itself stays scope-blind — it reads
    one `signals` dict and one `signal_age_s` dict, so determinism and replay
    are untouched.
    """
    signals: dict = {}
    ages: dict[str, float] = {}

    # Global first (the shared floor).
    signals.update(global_row.get("signals") or {})
    ages.update(_ages_from(global_row, now_ms))

    # Item next (this product's own values override a shared default).
    signals.update(ctx_row.get("signals") or {})
    ages.update(_ages_from(ctx_row, now_ms))

    # Request last (supplied for this call; by definition fresh).
    for name, value in (request_signals or {}).items():
        signals[name] = value
        ages[name] = 0.0

    # Time signals are derived from now_ms, not the clock, so a replay of this
    # decision evaluates the same day and hour.
    stamp = time.gmtime((now_ms / 1000) + 19800)  # +05:30
    signals["day_of_week"] = _DAYS[(stamp.tm_wday)]
    signals["hour_of_day"] = stamp.tm_hour

    return PricingContext(
        base_price=float(ctx_row.get("base_price") or 0.0),
        signals=signals,
        signal_age_s=ages,
        cost=float(ctx_row["cost"]) if ctx_row.get("cost") is not None else None,
        previous_price=(
            float(ctx_row["previous_price"])
            if ctx_row.get("previous_price") is not None else None
        ),
        now_ms=now_ms,
        currency=currency,
    )


def _context_health(ctx: PricingContext, signal_meta: dict) -> dict:
    """Which declared signals are present, missing or stale, by scope.

    This is the reliability signal the spec asks for: a missing value is never
    treated as zero — the engine already skips a clause whose signal is absent —
    and here that absence is reported so the caller can see WHY a rule that
    should have fired did not. Stale is reported the same way.
    """
    present, missing, stale = [], [], []
    for field, meta in (signal_meta or {}).items():
        scope = meta.get("scope", "item")
        if scope == "request":
            # Request fields are expected to be absent unless this call sent
            # one, so their absence is not a fault worth reporting as missing.
            if field in ctx.signals:
                present.append({"field": field, "scope": scope})
            continue
        if field in ("day_of_week", "hour_of_day", "season"):
            continue
        if field not in ctx.signals or ctx.signals.get(field) is None:
            missing.append({"field": field, "scope": scope})
        else:
            age = ctx.signal_age_s.get(field)
            if age is not None and age > STALE_AFTER_S:
                stale.append({"field": field, "scope": scope, "age_seconds": round(age, 1)})
            else:
                present.append({"field": field, "scope": scope})
    return {"present": present, "missing": missing, "stale": stale}


def _price_one(
    item_id: str,
    ctx_row: dict | None,
    global_row: dict,
    request_signals: dict,
    strategy: dict,
    now_ms: int,
) -> dict:
    """Evaluate one item. Always returns a price — never raises."""
    currency = strategy.get("currency") or "INR"
    guardrails = Guardrails.from_dict(strategy.get("guardrails") or {})

    if not ctx_row:
        return {
            "item_id": item_id,
            "error": "unknown item",
            "price": None,
        }

    ctx = _build_context(ctx_row, global_row, request_signals, now_ms, currency)
    mode = strategy.get("mode")

    # Dynamic pricing switched OFF.
    #
    # The caller gets a refusal rather than a quiet base price. Returning a
    # price that looks normal but ignores every rule is the worse failure: an
    # integration cannot tell the difference, so a switch left off by accident
    # would go unnoticed for as long as it took someone to read a chart.
    #
    # `base_price` is still included so a caller that WANTS to carry on can fall
    # back deliberately, in its own code, having seen that pricing is off.
    if mode == "paused":
        return {
            "item_id": item_id,
            "price": None,
            "error": "pricing is switched off for this project",
            "pricing_enabled": False,
            "base_price": ctx.base_price,
            "currency": currency,
        }

    if not strategy or mode == "safe":
        reason = "no active strategy" if not strategy else f"strategy is {mode}"
        d = safe_fallback(ctx=ctx, guardrails=guardrails, reason=reason)
    else:
        try:
            d = evaluate(
                ctx=ctx,
                rules=rules_from_compiled(strategy),
                guardrails=guardrails,
                strategy_id=strategy.get("strategy_id"),
                strategy_version=strategy.get("version"),
                ruleset_version=strategy.get("ruleset_version"),
                stale_after_s=STALE_AFTER_S,
            )
        except Exception as exc:  # noqa: BLE001
            # A bad ruleset must never become a failed checkout.
            d = safe_fallback(ctx=ctx, guardrails=guardrails, reason=f"engine error: {exc}")

    health = _context_health(ctx, strategy.get("signal_meta") or {})
    return {"decision": d, "ctx": ctx, "item_id": item_id, "context_health": health}


def _public(result: dict, decision_id: str) -> dict:
    """The customer-facing response. Deliberately small.

    Rule names and internal ids stay out of it — a customer's backend should
    not learn our pricing logic from an API response. The full breakdown is
    available to the analyst through /decisions/replay.
    """
    d = result["decision"]
    return {
        "item_id": result["item_id"],
        "price": d.final_price,
        "currency": d.currency,
        "decision_id": decision_id,
        "strategy_version": d.strategy_version,
        "previous_price": d.previous_price,
        "changed": d.changed,
        "drivers": [
            {"factor": dr["factor"], "impact": dr["impact"]} for dr in d.drivers
        ],
        "degraded": d.degraded,
        "fallback": d.fallback,
        # Only when something is actually wrong, so a healthy response stays
        # small. Missing values are reported, never silently read as zero.
        **({"context": _health_summary(result["context_health"])}
           if result.get("context_health")
           and (result["context_health"]["missing"] or result["context_health"]["stale"])
           else {}),
    }


def _health_summary(health: dict) -> dict:
    """The caller-facing slice of context health: what is missing or stale, so
    a rule that did not fire can be explained without exposing the rule."""
    out: dict = {}
    if health.get("missing"):
        out["missing_signals"] = health["missing"]
    if health.get("stale"):
        out["stale_signals"] = health["stale"]
    return out


def _emit(records: list[dict]) -> None:
    """Hand decision records to SQS for a worker to persist.

    Fire and forget, after the response payload is already built. Writing the
    decision synchronously to DynamoDB would add 10-15ms to every priced
    request for data nobody is waiting on.
    """
    if not _sqs or not records:
        return
    try:
        for i in range(0, len(records), 10):
            _sqs.send_message_batch(
                QueueUrl=QUEUE_DECISIONS,
                Entries=[
                    {"Id": str(n), "MessageBody": json.dumps(r, default=str)}
                    for n, r in enumerate(records[i:i + 10])
                ],
            )
    except Exception:  # noqa: BLE001
        # Losing an analytics record is survivable. Failing the price is not.
        pass


def _response(status: int, body: dict, elapsed_ms: float) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            # Mandatory: these are GETs that produce priced, per-tenant results.
            "cache-control": "no-store",
            "x-response-time": f"{elapsed_ms:.1f}ms",
        },
        "body": json.dumps(body, default=str, separators=(",", ":")),
    }


# ── entry point ─────────────────────────────────────────────────────────

def _price_cart(project, cart_lines, params, now_ms):
    """Price a whole basket, so rules can see the cart, not just one item.

    Each line is still priced by the SAME deterministic engine — basket facts
    are injected as reserved signals (cart_lines, cart_units, cart_subtotal,
    line_quantity) that a rule or formula can test. That is what lets "spend
    5000, get 10% off", "buy 3+, save per unit" and bundle-by-value rules work
    without the engine gaining any basket-specific logic.

    cart_subtotal is computed from each item's base price x quantity, so a
    threshold rule sees the real basket value before any discount.
    """
    project_id = project["project_id"]
    item_ids = [ln["item_id"] for ln in cart_lines]
    strategy, contexts, global_row = _fetch_state(project_id, item_ids)
    request_signals = _request_signals(params, strategy.get("signal_meta") or {})

    # Aggregates over the whole basket, computed once.
    units = sum(ln["quantity"] for ln in cart_lines)
    subtotal = 0.0
    for ln in cart_lines:
        row = contexts.get(ln["item_id"]) or {}
        subtotal += float(row.get("base_price") or 0.0) * ln["quantity"]
    basket = {
        "cart_lines": len(cart_lines),
        "cart_units": units,
        "cart_subtotal": round(subtotal, 2),
    }

    out_lines = []
    records = []
    for ln in cart_lines:
        iid, qty = ln["item_id"], ln["quantity"]
        # Request signals plus this basket's facts plus this line's quantity.
        line_req = {**request_signals, **basket, "line_quantity": qty}
        r = _price_one(iid, contexts.get(iid), global_row, line_req, strategy, now_ms)
        if "decision" not in r:
            out_lines.append({**{k: r.get(k) for k in ("item_id", "error", "price")},
                              "quantity": qty})
            continue
        decision_id = "DEC-" + format(now_ms, "x").upper()[-6:] + format(
            abs(hash(iid)) % 0xFFFF, "04X")
        pub = _public(r, decision_id)
        unit = pub["price"]
        pub["quantity"] = qty
        pub["line_total"] = round(unit * qty, 2) if unit is not None else None
        out_lines.append(pub)
        d = r["decision"]
        records.append({
            "decision_id": decision_id, "tenant_id": project["tenant_id"],
            "project_id": project_id, "item_id": iid, "decision": d.to_dict(),
            "snapshot": {
                "base_price": r["ctx"].base_price, "cost": r["ctx"].cost,
                "previous_price": r["ctx"].previous_price,
                "signals": r["ctx"].signals, "signal_age_s": r["ctx"].signal_age_s,
                "now_ms": r["ctx"].now_ms, "currency": r["ctx"].currency,
                "strategy_id": strategy.get("strategy_id"),
                "strategy_version": strategy.get("version"),
                "ruleset_version": strategy.get("ruleset_version"),
                "rules": strategy.get("rules", []), "guardrails": strategy.get("guardrails", {}),
                "cart": basket,
            },
            "ts": now_ms,
        })

    cart_total = round(
        sum(ln["line_total"] for ln in out_lines if ln.get("line_total") is not None), 2)
    return out_lines, records, {**basket, "cart_total": cart_total,
                                "currency": strategy.get("currency") or "INR"}


# Params that are never a request signal, whatever the schema says.
_RESERVED_PARAMS = {"item_id", "item_ids"}


def _request_signals(params: dict, signal_meta: dict) -> dict:
    """Pull request-scope values off the query string, typed per the schema.

    A value whose declared type it fails to parse is DROPPED, not defaulted:
    the engine then treats that field as missing (no match), which is the safe
    outcome — far better than coercing "gold" to 0 and firing the wrong rule.
    """
    out: dict = {}
    request_fields = {
        f: m for f, m in signal_meta.items() if m.get("scope") == "request"
    }
    for name, meta in request_fields.items():
        if name in _RESERVED_PARAMS or name not in params:
            continue
        raw = params[name]
        if meta.get("type") in ("number", "integer", "float"):
            try:
                out[name] = float(raw)
            except (TypeError, ValueError):
                continue  # invalid → leave missing, never silently zero
        else:
            out[name] = str(raw)
    return out


def handler(event, _context):
    t0 = time.perf_counter()
    now_ms = int(time.time() * 1000)

    path = event.get("rawPath") or event.get("requestContext", {}).get("http", {}).get("path", "")
    params = event.get("queryStringParameters") or {}
    api_key = (event.get("pathParameters") or {}).get("project_key", "")

    project = _resolve_key(api_key)
    if not project:
        return _response(401, {
            "ok": False,
            "error": {"code": "unauthorized", "message": "invalid or revoked API key"},
        }, (time.perf_counter() - t0) * 1000)

    project_id = project["project_id"]

    # Basket pricing: the whole cart in one call, so rules can see it.
    if path.endswith("/cart"):
        raw = params.get("cart", "")
        try:
            parsed = json.loads(raw) if raw else []
        except json.JSONDecodeError:
            return _response(400, {"ok": False, "error": {
                "code": "bad_request",
                "message": "cart must be URL-encoded JSON: [{\"item_id\":..,\"quantity\":..}]"}},
                (time.perf_counter() - t0) * 1000)
        lines = []
        for entry in parsed[:MAX_BULK] if isinstance(parsed, list) else []:
            iid = str((entry or {}).get("item_id", "")).strip()
            if not iid:
                continue
            try:
                qty = max(1, int(entry.get("quantity", 1)))
            except (TypeError, ValueError):
                qty = 1
            lines.append({"item_id": iid, "quantity": qty})
        if not lines:
            return _response(400, {"ok": False, "error": {
                "code": "bad_request", "message": "cart is empty"}},
                (time.perf_counter() - t0) * 1000)

        out_lines, records, summary = _price_cart(project, lines, params, now_ms)
        elapsed = (time.perf_counter() - t0) * 1000
        for rec in records:
            rec["latency_ms"] = round(elapsed, 2)
        _emit(records)
        return _response(200, {"ok": True, "lines": out_lines, "cart": summary}, elapsed)

    bulk = path.endswith("/bulk")

    if bulk:
        raw = params.get("item_ids", "")
        item_ids = [i.strip() for i in raw.split(",") if i.strip()][:MAX_BULK]
        if not item_ids:
            return _response(400, {
                "ok": False,
                "error": {"code": "bad_request", "message": "item_ids is required"},
            }, (time.perf_counter() - t0) * 1000)
    else:
        item_id = (params.get("item_id") or "").strip()
        if not item_id:
            return _response(400, {
                "ok": False,
                "error": {"code": "bad_request", "message": "item_id is required"},
            }, (time.perf_counter() - t0) * 1000)
        item_ids = [item_id]

    strategy, contexts, global_row = _fetch_state(project_id, item_ids)

    # Request-scope signals: supplied on this call, never stored. Accepted as
    # bare params that match a field the schema declared `scope: request`, so a
    # typo or a stray query param cannot smuggle a value into the engine. The
    # scope map was frozen into the ACTIVE row at promote time, so this needs no
    # schema read on the hot path.
    request_signals = _request_signals(params, strategy.get("signal_meta") or {})

    results = [
        _price_one(iid, contexts.get(iid), global_row, request_signals, strategy, now_ms)
        for iid in item_ids
    ]

    payload = []
    records = []
    for r in results:
        if "decision" not in r:
            payload.append(r)
            continue
        decision_id = "DEC-" + format(now_ms, "x").upper()[-6:] + format(
            abs(hash(r["item_id"])) % 0xFFFF, "04X"
        )
        payload.append(_public(r, decision_id))
        d = r["decision"]
        records.append({
            "decision_id": decision_id,
            "tenant_id": project["tenant_id"],
            "project_id": project_id,
            "item_id": r["item_id"],
            "decision": d.to_dict(),
            # The full input snapshot: this is what /decisions/verify replays.
            "snapshot": {
                "base_price": r["ctx"].base_price,
                "cost": r["ctx"].cost,
                "previous_price": r["ctx"].previous_price,
                "signals": r["ctx"].signals,
                "signal_age_s": r["ctx"].signal_age_s,
                "now_ms": r["ctx"].now_ms,
                "currency": r["ctx"].currency,
                "strategy_id": strategy.get("strategy_id"),
                "strategy_version": strategy.get("version"),
                "ruleset_version": strategy.get("ruleset_version"),
                "rules": strategy.get("rules", []),
                "guardrails": strategy.get("guardrails", {}),
            },
            "ts": now_ms,
        })

    elapsed = (time.perf_counter() - t0) * 1000
    for rec in records:
        rec["latency_ms"] = round(elapsed, 2)
    _emit(records)

    body = {"ok": True, "prices" if bulk else "price": payload if bulk else payload[0]}
    if bulk:
        body["count"] = len(payload)
    return _response(200, body, elapsed)
