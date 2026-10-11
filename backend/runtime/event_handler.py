"""Event ingestion, and the unified update.

Does as close to nothing as possible: validate the shape, push to SQS, return.
No feature computation, no DynamoDB write, no aggregation. That is the entire
reason the API survives a 20,000 events/sec spike while the dashboard shows the
backlog draining instead of the API falling over.

    customer backend --GET--> this handler --> SQS --> feature-worker --> context

`/v1/u/{key}/update` is the one exception to "writes nothing". It is the single
call a customer's backend makes when something about a product changed — its
price, its cost, or a signal that moves its price — and it exists because those
are one event in the customer's world and asking them to make two calls to two
differently-authenticated endpoints was an integration seam with no upside.

Product fields are written straight through, because they are low-volume and
the caller needs to know the write landed. Signals still go through the queue,
because they are not: that split is what keeps a price change synchronous while
a traffic spike stays absorbable.

`event_id` is required, not optional. These are GETs, so proxies, browsers and
retrying clients will deliver the same event more than once. Without a dedup key
a retry storm would inflate demand and move real prices.
"""

from __future__ import annotations

import json
import os
import secrets
import time

import boto3

STAGE = os.environ.get("STAGE", "dev")
REGION = os.environ.get("AWS_REGION", "ap-south-1")
TABLE_CORE = os.environ.get("TABLE_CORE", f"devnexus-core-{STAGE}")
TABLE_CONTEXT = os.environ.get("TABLE_CONTEXT", f"devnexus-context-{STAGE}")
QUEUE_EVENTS = os.environ.get("QUEUE_EVENTS", "")
MAX_BATCH = 50
GLOBAL_ITEM_ID = "__GLOBAL__"

_ddb = boto3.client("dynamodb", region_name=REGION)
_sqs = boto3.client("sqs", region_name=REGION)

_key_cache: dict[str, tuple[dict, float]] = {}
# API-key lookups are cached per execution environment. 60s rather than 300s:
# a rotated key must stop working promptly, and TEN-03 showed a revoked key
# still pricing minutes later. The cost is one tiny projected GetItem per key
# per minute on a warm container, which is noise next to the 3.6ms p50.
_KEY_TTL = 60.0

KNOWN_EVENT_TYPES = {
    "view", "search", "click", "add_to_cart", "remove_from_cart",
    "purchase", "cancellation", "booking", "checkin", "checkout",
    "inventory_update", "availability_update", "competitor_price",
    "traffic_update", "supply_update", "signal_update", "custom",
}


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
    raw = resp.get("Item")
    if not raw:
        return None
    row = {
        "tenant_id": raw.get("tenant_id", {}).get("S"),
        "project_id": raw.get("project_id", {}).get("S"),
        "revoked": raw.get("revoked", {}).get("BOOL", False),
    }
    if row["revoked"]:
        return None
    _key_cache[api_key] = (row, now + _KEY_TTL)
    return row


def _validate(raw: dict, now_ms: int) -> tuple[dict | None, str | None]:
    """Shape check only. Semantic validation belongs in the worker, where it
    can take its time without holding the caller open."""
    item_id = (raw.get("item_id") or "").strip()
    if not item_id:
        return None, "item_id is required"

    event_type = (raw.get("event_type") or "").strip().lower()
    if not event_type:
        return None, "event_type is required"

    event_id = (raw.get("event_id") or "").strip()
    if not event_id:
        return None, (
            "event_id is required for idempotency — these are GET requests and "
            "will be retried by proxies and clients"
        )

    out = {
        "item_id": item_id,
        "event_type": event_type,
        "event_id": event_id,
        "ts": now_ms,
    }

    if raw.get("ts"):
        try:
            ts = int(raw["ts"])
            # Reject absurd timestamps rather than letting them poison the
            # feature windows; accept modest clock skew.
            if abs(ts - now_ms) < 7 * 86400 * 1000:
                out["ts"] = ts
        except (TypeError, ValueError):
            pass

    for field in ("quantity", "value", "price", "competitor_price", "inventory",
                  "availability", "traffic", "supply", "occupancy", "demand"):
        if raw.get(field) is not None:
            try:
                out[field] = float(raw[field])
            except (TypeError, ValueError):
                return None, f"{field} must be numeric"

    # ── arbitrary signals: signal_<id>=<value> ──────────────────────────
    #
    # Without this, ingestion only accepts a hardcoded list of signal names,
    # which breaks the whole domain-agnostic claim at the boundary: a project
    # can DEFINE `desk_occupancy` in its schema and a rule can REFERENCE it,
    # but nothing could ever SET it.
    #
    # Names are not validated here — that would need a schema read on the
    # latency-critical ingest path. The feature worker validates instead, and
    # an unknown signal is harmless because /rules/create already refuses to
    # build a rule against a field that is not in the schema.
    signals: dict[str, float] = {}
    for key, value in raw.items():
        if not key.startswith("signal_") or value is None:
            continue
        name = key[7:]
        if not name or not name.replace("_", "").isalnum():
            return None, f"invalid signal name '{name}'"
        try:
            signals[name] = float(value)
        except (TypeError, ValueError):
            return None, f"signal_{name} must be numeric"

    if raw.get("signals"):
        # Batch events may carry a nested object instead of flat params.
        nested = raw["signals"]
        if isinstance(nested, dict):
            for name, value in nested.items():
                try:
                    signals[str(name)] = float(value)
                except (TypeError, ValueError):
                    return None, f"signals.{name} must be numeric"

    if signals:
        if len(signals) > 40:
            return None, "at most 40 signals per event"
        out["signals"] = signals

    for field in ("location", "segment", "season", "zone", "currency"):
        if raw.get(field):
            out[field] = str(raw[field])[:64]

    if event_type not in KNOWN_EVENT_TYPES:
        # Unknown types are accepted and flagged rather than rejected: a new
        # domain may legitimately emit an event type we have not seen.
        out["unknown_type"] = True

    return out, None


# ── unified update ──────────────────────────────────────────────────────

# Everything a caller may change about a product in one go. `item_id` is not
# here on purpose: it is what every decision, context row and snapshot is filed
# under, so changing it would silently detach a product from its own history.
UPDATABLE_FIELDS = {"name": str, "base_price": float, "cost": float}

# How many times to retry when a concurrent writer moves the context row out
# from under us. Three is enough for contention; more would mask a real problem.
MAX_TXN_ATTEMPTS = 3


def _audit_id() -> str:
    """Same shape as core.ids.audit_id, without importing core into the hot path."""
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

    def b36(n: int) -> str:
        if n == 0:
            return "0"
        out = []
        while n:
            n, r = divmod(n, 36)
            out.append(alphabet[r])
        return "".join(reversed(out))

    return f"aud_{b36(int(time.time() * 1000))}_{secrets.token_hex(4)[:6]}"


def _wrap(value):
    """Python value -> DynamoDB attribute value."""
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if value is None:
        return {"NULL": True}
    if isinstance(value, dict):
        return {"M": {k: _wrap(v) for k, v in value.items()}}
    if isinstance(value, (list, tuple)):
        return {"L": [_wrap(v) for v in value]}
    return {"S": str(value)}


def _unwrap(av):
    """DynamoDB attribute value -> Python value."""
    if av is None:
        return None
    if "S" in av:
        return av["S"]
    if "N" in av:
        return float(av["N"])
    if "BOOL" in av:
        return av["BOOL"]
    if "NULL" in av:
        return None
    if "M" in av:
        return {k: _unwrap(v) for k, v in av["M"].items()}
    if "L" in av:
        return [_unwrap(v) for v in av["L"]]
    return None


def _parse_update(params: dict) -> tuple[dict, dict, dict | None, str | None]:
    """Pull fields, signals and attributes out of the query string.

    Returns (fields, signals, attributes, error). `attributes` is None when the
    caller did not send the parameter at all, which is different from sending an
    empty object — one leaves the existing set alone, the other clears it.
    """
    fields: dict = {}
    for field, caster in UPDATABLE_FIELDS.items():
        raw = params.get(field)
        if raw is None or raw == "":
            continue
        try:
            value = caster(raw)
        except (TypeError, ValueError):
            return {}, {}, None, f"{field} is not a valid {caster.__name__}"
        if field in ("base_price", "cost") and value < 0:
            return {}, {}, None, f"{field} cannot be negative"
        if field == "base_price" and value == 0:
            return {}, {}, None, "base_price must be above zero"
        # An explicit 0 is how a cost is cleared; anything else is the value.
        fields[field] = None if (field == "cost" and value == 0) else value

    signals: dict = {}
    for key, raw in params.items():
        if not key.startswith("signal_") or raw in (None, ""):
            continue
        name = key[len("signal_"):]
        if not name or not name.replace("_", "").isalnum():
            return {}, {}, None, f"invalid signal name '{name}'"
        try:
            signals[name] = float(raw)
        except (TypeError, ValueError):
            return {}, {}, None, f"signal_{name} must be numeric"
    if len(signals) > 40:
        return {}, {}, None, "at most 40 signals per call"

    attributes = None
    raw_attrs = params.get("attributes")
    if raw_attrs not in (None, ""):
        if len(raw_attrs) > 4096:
            return {}, {}, None, "attributes exceed the 4 KB URL budget"
        try:
            parsed = json.loads(raw_attrs)
        except json.JSONDecodeError as exc:
            return {}, {}, None, f"attributes is not valid JSON: {exc}"
        if not isinstance(parsed, dict):
            return {}, {}, None, "attributes must be a JSON object"
        attributes = parsed

    return fields, signals, attributes, None


def _unified_update(project: dict, params: dict, api_key: str, now_ms: int):
    """Apply product fields AND signals in ONE DynamoDB transaction.

    Everything lands or nothing does. That is the whole point of this endpoint:
    the previous version wrote the fields, then queued the signals, and a queue
    failure left a product whose price had moved but whose demand had not —
    a half-applied state the caller could not reason about.

    Signals are written straight to the context row rather than queued, which is
    also what makes the timing honest: one call, one guarantee, both effective
    on the very next pricing request. Queueing is right for the high-volume
    event endpoints; it is wrong here, where the caller is changing one product
    and needs to know the change took.

    Returns (body, error_message, status_code).
    """
    item_id = (params.get("item_id") or "").strip()
    if not item_id:
        return None, "item_id is required", 400

    fields, signals, attributes, err = _parse_update(params)
    if err:
        return None, err, 400
    if not fields and not signals and attributes is None:
        return None, (
            "nothing to update — send at least one of name, base_price, cost, "
            "attributes, or a signal_<id> parameter"
        ), 400

    tenant_pk = f"TENANT#{project['tenant_id']}"
    item_sk = f"ITEM#{project['project_id']}#{item_id}"
    ctx_pk = f"CTX#{project['project_id']}#{item_id}"

    # The schema, so a typo'd signal name is refused instead of silently stored.
    # The event endpoints cannot afford this read on the hot path; this endpoint
    # is one product at a time and can.
    if signals:
        proj_row = _ddb.get_item(
            TableName=TABLE_CORE,
            Key={"pk": {"S": tenant_pk}, "sk": {"S": f"PROJECT#{project['project_id']}"}},
            ProjectionExpression="#s",
            ExpressionAttributeNames={"#s": "schema"},
        ).get("Item")
        schema = _unwrap((proj_row or {}).get("schema")) or {}
        sigs = schema.get("context_signals") or []
        item_fields = {sg["id"] for sg in sigs
                       if sg.get("id") and (sg.get("scope") or "item") == "item"}
        other_scope = {sg["id"]: (sg.get("scope") or "item") for sg in sigs
                       if sg.get("id") and (sg.get("scope") or "item") != "item"}
        if item_fields or other_scope:
            # A global or request field sent here would land on the item row,
            # where no rule reads it — so name the right endpoint instead of
            # silently storing a dead value.
            misscoped = sorted(set(signals) & set(other_scope))
            if misscoped:
                scope = other_scope[misscoped[0]]
                where = ("/v1/g/<key>/context" if scope == "global"
                         else "the price request")
                return None, (
                    f"{misscoped} is a {scope} signal — set it with {where}, "
                    f"not on a product"
                ), 400
            unknown = sorted(set(signals) - item_fields)
            if unknown:
                return None, (
                    f"unknown signal(s) {unknown} — this project's item signals "
                    f"are {sorted(item_fields)}. Add them to the schema first."
                ), 400

    for attempt in range(MAX_TXN_ATTEMPTS):
        existing = _ddb.get_item(
            TableName=TABLE_CORE,
            Key={"pk": {"S": tenant_pk}, "sk": {"S": item_sk}},
            ProjectionExpression="base_price, cost, #n, attributes",
            ExpressionAttributeNames={"#n": "name"},
        ).get("Item")
        if not existing:
            return None, f"no product with id '{item_id}' in this project", 404

        ctx_row = _ddb.get_item(
            TableName=TABLE_CONTEXT,
            Key={"pk": {"S": ctx_pk}, "sk": {"S": "NOW"}},
        ).get("Item")

        # Validate the COMBINED state, not just what was sent: lowering
        # base_price alone can put it under a cost that was set earlier, which
        # would make every sale lose money and the margin guardrail impossible.
        final_price = fields.get("base_price", _unwrap(existing.get("base_price")))
        final_cost = fields["cost"] if "cost" in fields else _unwrap(existing.get("cost"))
        if final_cost is not None and final_price is not None and final_cost >= final_price:
            return None, (
                f"cost ({final_cost}) must be below base_price ({final_price}) — "
                f"otherwise every sale loses money"
            ), 400

        txn: list[dict] = []

        # ── 1. the product row ──────────────────────────────────────────
        sets, removes, names, values = [], [], {}, {}
        for i, (field, value) in enumerate(fields.items()):
            names[f"#f{i}"] = field
            if value is None:
                removes.append(f"#f{i}")
            else:
                values[f":f{i}"] = _wrap(value)
                sets.append(f"#f{i} = :f{i}")
        if attributes is not None:
            names["#at"] = "attributes"
            values[":at"] = _wrap(attributes)
            sets.append("#at = :at")
        names["#u"] = "updated_at"
        values[":u"] = {"N": str(now_ms)}
        sets.append("#u = :u")

        txn.append({"Update": {
            "TableName": TABLE_CORE,
            "Key": {"pk": {"S": tenant_pk}, "sk": {"S": item_sk}},
            "UpdateExpression": "SET " + ", ".join(sets)
            + (" REMOVE " + ", ".join(removes) if removes else ""),
            "ExpressionAttributeNames": names,
            "ExpressionAttributeValues": values,
            # Proves the product still exists at commit time, not just at read.
            "ConditionExpression": "attribute_exists(sk)",
        }})

        # ── 2. the context row the engine actually reads ────────────────
        c_sets, c_removes, c_names, c_values = [], [], {}, {}
        for i, (field, value) in enumerate(
            {k: v for k, v in fields.items() if k in ("base_price", "cost")}.items()
        ):
            c_names[f"#c{i}"] = field
            if value is None:
                c_removes.append(f"#c{i}")
            else:
                c_values[f":c{i}"] = _wrap(value)
                c_sets.append(f"#c{i} = :c{i}")

        has_signal_map = "signals" in (ctx_row or {})
        condition = None
        if signals:
            ages = {name: now_ms for name in signals}
            if has_signal_map:
                # Nested SET touches only the keys being written, so a signal
                # the worker is maintaining in parallel is never clobbered.
                for i, (name, value) in enumerate(signals.items()):
                    c_names[f"#s{i}"] = name
                    c_values[f":s{i}"] = {"N": str(value)}
                    c_sets.append(f"signals.#s{i} = :s{i}")
                    c_values[f":t{i}"] = {"N": str(ages[name])}
                    c_sets.append(f"signal_updated_at.#s{i} = :t{i}")
            else:
                # No map yet, so write it whole. Guarded, because the worker
                # could create one between this read and the commit.
                c_values[":sig"] = _wrap(signals)
                c_values[":age"] = _wrap(ages)
                c_sets.append("signals = :sig")
                c_sets.append("signal_updated_at = :age")
                condition = "attribute_not_exists(signals)"

            # Remember which signals were set by hand so the feature worker's
            # counter-derived values never overwrite them. Only names that are
            # not already present are appended; a duplicate from a concurrent
            # writer is harmless (the worker reads this as a set) and is tidied
            # up the next time the worker rewrites the row.
            already = set(_unwrap((ctx_row or {}).get("explicit_signals")) or [])
            fresh = [n for n in sorted(signals) if n not in already]
            if fresh:
                c_values[":new"] = _wrap(fresh)
                c_values[":empty"] = {"L": []}
                c_sets.append(
                    "explicit_signals = list_append("
                    "if_not_exists(explicit_signals, :empty), :new)"
                )

        c_names["#u"] = "updated_at"
        c_values[":u"] = {"N": str(now_ms)}
        c_sets.append("#u = :u")
        c_values[":pid"] = {"S": project["project_id"]}
        c_values[":iid"] = {"S": item_id}
        c_sets.append("project_id = :pid")
        c_sets.append("item_id = :iid")

        ctx_update = {
            "TableName": TABLE_CONTEXT,
            "Key": {"pk": {"S": ctx_pk}, "sk": {"S": "NOW"}},
            "UpdateExpression": "SET " + ", ".join(c_sets)
            + (" REMOVE " + ", ".join(c_removes) if c_removes else ""),
            "ExpressionAttributeNames": c_names,
            "ExpressionAttributeValues": c_values,
        }
        if condition:
            ctx_update["ConditionExpression"] = condition
        txn.append({"Update": ctx_update})

        # ── 3. the audit record, in the SAME transaction ────────────────
        # Not after it. An audit log that can be missing the last entry because
        # a second write failed is not an audit log.
        old_value = {
            k: _unwrap(existing.get(k))
            for k in ("name", "base_price", "cost")
            if k in fields
        }
        if attributes is not None:
            old_value["attributes"] = _unwrap(existing.get("attributes")) or {}
        new_value = {k: v for k, v in fields.items()}
        if attributes is not None:
            new_value["attributes"] = attributes
        if signals:
            new_value["signals"] = signals

        audit_ts = now_ms
        audit = {
            "pk": {"S": tenant_pk},
            "sk": {"S": f"AUDIT#{audit_ts:013d}#{_audit_id()}"},
            "audit_id": {"S": _audit_id()},
            "action": {"S": "ITEM_UPDATED"},
            # The caller is a key, not a person. Only the last six characters,
            # so the trail identifies the key without storing it.
            "actor": {"S": f"apikey:…{api_key[-6:]}"},
            "source": {"S": "api"},
            "project_id": {"S": project["project_id"]},
            "entity_type": {"S": "item"},
            "entity_id": {"S": item_id},
            "old_value": _wrap(old_value),
            "new_value": _wrap(new_value),
            "note": {"S": "unified update"},
            "ts": {"N": str(audit_ts)},
        }
        txn.append({"Put": {"TableName": TABLE_CORE, "Item": audit}})

        try:
            _ddb.transact_write_items(TransactItems=txn)
        except _ddb.exceptions.TransactionCanceledException as exc:
            reasons = [r.get("Code") for r in (exc.response.get("CancellationReasons") or [])]
            # The product row's condition failing means it was deleted between
            # the read and the commit — retrying cannot help.
            if reasons and reasons[0] == "ConditionalCheckFailed":
                return None, f"no product with id '{item_id}' in this project", 404
            # Anything else is contention on the context row: re-read and retry.
            if attempt == MAX_TXN_ATTEMPTS - 1:
                return None, (
                    "this product is being updated concurrently; nothing was "
                    "changed — retry the call"
                ), 409
            continue

        return {
            "item_id": item_id,
            "fields_updated": sorted([*fields] + (["attributes"] if attributes is not None else [])),
            "signals_updated": sorted(signals),
            # One call, one guarantee. Both parts are committed together and
            # both are read by the very next pricing request.
            "effective": "immediately — the next price request uses all of it",
            "atomic": True,
        }, None, 200

    return None, "could not complete the update; nothing was changed", 409


def _project_schema(project: dict) -> dict:
    """Read a project's schema. Only for low-volume endpoints (global context,
    unified update) — never the per-request price path, which uses the scope
    map embedded in the ACTIVE strategy instead."""
    row = _ddb.get_item(
        TableName=TABLE_CORE,
        Key={
            "pk": {"S": f"TENANT#{project['tenant_id']}"},
            "sk": {"S": f"PROJECT#{project['project_id']}"},
        },
        ProjectionExpression="#s",
        ExpressionAttributeNames={"#s": "schema"},
    ).get("Item")
    return _unwrap((row or {}).get("schema")) or {}


def _global_update(project: dict, params: dict, now_ms: int):
    """Write project-wide signal values to the single global context row.

    Global signals are shared across every item, so they are stored ONCE here.
    The old model would have forced the caller to write the same traffic number
    onto every product's row; this is one write regardless of catalogue size.

    Synchronous, not queued: global updates are low-volume (one per project, not
    one per item per event) and the caller needs to know the value took. That is
    the same reasoning as the unified item update.

    Only fields the schema declares as `scope: global` are accepted. A value for
    an item- or request-scope field here is a mistake, and silently storing it
    on the global row would make it invisible to the engine.
    """
    schema = _project_schema(project)
    sigs = schema.get("context_signals") or []
    global_fields = {
        s["id"]: (s.get("type") or "number")
        for s in sigs if (s.get("scope") or "item") == "global"
    }
    if not global_fields:
        return None, (
            "this project declares no global signals — add one with scope "
            "'global' in the schema first"
        ), 400

    accepted: dict = {}
    rejected: list[str] = []
    for key, raw in params.items():
        if not key.startswith("signal_"):
            continue
        name = key[len("signal_"):]
        if name not in global_fields:
            rejected.append(name)
            continue
        if global_fields[name] in ("number", "integer", "float"):
            try:
                accepted[name] = float(raw)
            except (TypeError, ValueError):
                return None, f"signal_{name} must be numeric", 400
        else:
            accepted[name] = str(raw)[:128]

    if not accepted:
        hint = f" (unknown global signal(s): {sorted(set(rejected))})" if rejected else ""
        return None, (
            "no global signals in this call — send signal_<id> for a declared "
            f"global field{hint}"
        ), 400

    # Nested SET so a concurrent writer touching a different global signal is
    # never clobbered, mirroring the item-signal write path.
    pk = f"CTX#{project['project_id']}#{GLOBAL_ITEM_ID}"
    names, values, sets = {"#u": "updated_at"}, {":u": {"N": str(now_ms)}}, ["#u = :u"]
    has_map = "signals" in (_ddb.get_item(
        TableName=TABLE_CONTEXT, Key={"pk": {"S": pk}, "sk": {"S": "NOW"}},
        ProjectionExpression="signals",
    ).get("Item") or {})
    if has_map:
        for i, (name, value) in enumerate(accepted.items()):
            names[f"#s{i}"] = name
            values[f":s{i}"] = _wrap(value)
            sets.append(f"signals.#s{i} = :s{i}")
            values[f":t{i}"] = {"N": str(now_ms)}
            sets.append(f"signal_updated_at.#s{i} = :t{i}")
        condition = None
    else:
        values[":sig"] = _wrap(accepted)
        values[":age"] = _wrap({k: now_ms for k in accepted})
        sets.append("signals = :sig")
        sets.append("signal_updated_at = :age")
        condition = "attribute_not_exists(signals)"
    values[":p"] = {"S": project["project_id"]}
    values[":i"] = {"S": GLOBAL_ITEM_ID}
    sets.append("project_id = :p")
    sets.append("item_id = :i")

    update = {
        "TableName": TABLE_CONTEXT,
        "Key": {"pk": {"S": pk}, "sk": {"S": "NOW"}},
        "UpdateExpression": "SET " + ", ".join(sets),
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": values,
    }
    if condition:
        update["ConditionExpression"] = condition
    try:
        _ddb.update_item(**update)
    except _ddb.exceptions.ConditionalCheckFailedException:
        # The row gained a signals map between our read and write. Re-running
        # takes the nested-SET branch, which has no such race.
        return _global_update(project, params, now_ms)

    body = {
        "scope": "global",
        "updated": sorted(accepted),
        "effective": "immediately — the next price request for any item uses it",
    }
    if rejected:
        body["ignored"] = sorted(set(rejected))
        body["ignored_reason"] = "not declared as global signals in this project's schema"
    return body, None, 200


def _response(status: int, body: dict, elapsed_ms: float) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-response-time": f"{elapsed_ms:.1f}ms",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }


def handler(event, _context):
    t0 = time.perf_counter()
    now_ms = int(time.time() * 1000)

    path = event.get("rawPath") or ""
    params = event.get("queryStringParameters") or {}
    api_key = (event.get("pathParameters") or {}).get("project_key", "")

    project = _resolve_key(api_key)
    if not project:
        return _response(401, {
            "ok": False,
            "error": {"code": "unauthorized", "message": "invalid or revoked API key"},
        }, (time.perf_counter() - t0) * 1000)

    # ── global context ──────────────────────────────────────────────────
    # Project-wide signals: one value shared by every item, written once.
    if path.endswith("/context"):
        body, err, status = _global_update(project, params, now_ms)
        if err:
            return _response(status, {
                "ok": False,
                "error": {"code": "bad_request", "message": err},
                "changed": False,
            }, (time.perf_counter() - t0) * 1000)
        return _response(200, {"ok": True, **body}, (time.perf_counter() - t0) * 1000)

    # ── unified update ──────────────────────────────────────────────────
    # One call for "this product changed": its fields, its signals, or both.
    # Everything commits together or not at all — see _unified_update.
    if path.endswith("/update"):
        body, err, status = _unified_update(project, params, api_key, now_ms)
        if err:
            return _response(status, {
                "ok": False,
                "error": {
                    "code": "not_found" if status == 404
                    else "conflict" if status == 409
                    else "bad_request",
                    "message": err,
                },
                # Stated explicitly so a failed call is never ambiguous: the
                # transaction means a failure changed nothing at all.
                "changed": False,
            }, (time.perf_counter() - t0) * 1000)

        # No event is queued for this call, deliberately. The feature worker
        # would treat it as ordinary traffic and recompute the context row it
        # has just been written transactionally — risking undoing the very
        # write that succeeded. The change is recorded in the AUDIT TRAIL,
        # which is the authoritative history; it simply does not appear as a
        # row in the live activity feed.
        return _response(200, {
            "ok": True,
            **body,
            "audited": True,
        }, (time.perf_counter() - t0) * 1000)

    # ── batch ingest ────────────────────────────────────────────────────
    if path.endswith("/batch"):
        raw = params.get("payload", "")
        if not raw:
            return _response(400, {
                "ok": False,
                "error": {"code": "bad_request",
                          "message": "payload is required (URL-encoded JSON array)"},
            }, (time.perf_counter() - t0) * 1000)
        try:
            items = json.loads(raw)
        except json.JSONDecodeError as exc:
            return _response(400, {
                "ok": False,
                "error": {"code": "bad_request", "message": f"payload is not valid JSON: {exc}"},
            }, (time.perf_counter() - t0) * 1000)
        if not isinstance(items, list):
            return _response(400, {
                "ok": False,
                "error": {"code": "bad_request", "message": "payload must be a JSON array"},
            }, (time.perf_counter() - t0) * 1000)
        items = items[:MAX_BATCH]
    else:
        items = [params]

    accepted, rejected = [], []
    for raw in items:
        clean, err = _validate(raw, now_ms)
        if err:
            rejected.append({"item_id": raw.get("item_id"), "reason": err})
        else:
            accepted.append({
                **clean,
                "tenant_id": project["tenant_id"],
                "project_id": project["project_id"],
            })

    # A partially valid batch still queues its good events. Dropping the whole
    # batch would make one malformed row cost a customer all the others.
    if accepted and QUEUE_EVENTS:
        try:
            for i in range(0, len(accepted), 10):
                _sqs.send_message_batch(
                    QueueUrl=QUEUE_EVENTS,
                    Entries=[
                        {
                            "Id": str(n),
                            "MessageBody": json.dumps(e, separators=(",", ":")),
                            # Group by item so one item's events stay ordered
                            # relative to each other on a FIFO queue.
                            "MessageAttributes": {
                                "item_id": {"DataType": "String", "StringValue": e["item_id"]}
                            },
                        }
                        for n, e in enumerate(accepted[i:i + 10])
                    ],
                )
        except Exception as exc:  # noqa: BLE001
            return _response(503, {
                "ok": False,
                "error": {"code": "queue_unavailable",
                          "message": "could not queue events; retry shortly"},
                "detail": str(exc)[:120],
            }, (time.perf_counter() - t0) * 1000)

    elapsed = (time.perf_counter() - t0) * 1000
    status = 200 if accepted else 400
    return _response(status, {
        "ok": bool(accepted),
        "accepted": len(accepted),
        "rejected": len(rejected),
        "errors": rejected[:10] or None,
        # Measured, not guessed: the event is queued, batched by the feature
        # worker's event-source mapping, and only then written to the context
        # store. End-to-end that was 4-20s in testing. The old wording here
        # promised "a second or two", which led to three separate bug reports
        # from people polling the price API before the signal had landed.
        "note": "Events are queued and processed asynchronously. Signals "
                "usually appear in the pricing context within 5 seconds, and "
                "can take up to 20. Poll until the value changes rather than "
                "waiting a fixed time.",
        "context_update_eta_seconds": {"typical": 5, "max": 20},
    }, elapsed)
