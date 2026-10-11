"""Feature worker — raw events become pricing signals.

    SQS batch -> dedup -> decay -> accumulate -> write context -> detect anomalies

This is where "views, searches, cart adds" turn into "demand_score 0.87,
inventory_pressure 0.91, conversion_rate 0.082". The pricing hot path never does
any of this; it reads the result.

Two design points worth stating:

**Time-decayed counters, not windowed queries.** Each signal is an exponential
moving total with a half-life. Adding an event is `old * 0.5^(dt/half_life) + 1`,
which needs only the previous value and its timestamp. The alternative — storing
every event and aggregating over a window — would mean a Query per item per
update, and the whole point of the context table is that reads are O(1).

**Idempotency is mandatory.** Events arrive over GET, so proxies and retrying
clients deliver duplicates. A conditional write on `event_id` makes a repeat a
no-op. Without it, a retry storm would inflate demand and move real prices.
"""

from __future__ import annotations

import json
import logging
import math
import os
import time
from collections import defaultdict

import boto3

from core import db, realtime

STAGE = os.environ.get("STAGE", "dev")
REGION = os.environ.get("AWS_REGION", "ap-south-1")
TABLE_CONTEXT = os.environ.get("TABLE_CONTEXT", f"devnexus-context-{STAGE}")
QUEUE_ALERTS = os.environ.get("QUEUE_ALERTS", "")
DEDUP_TTL_SECONDS = 3600

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("devnexus.feature_worker")

_ddb = boto3.client("dynamodb", region_name=REGION)
_sqs = boto3.client("sqs", region_name=REGION) if QUEUE_ALERTS else None

# Half-life per counter, in seconds. Shorter means the signal reacts faster and
# is noisier; longer means it is smoother and lags. These are the knobs that
# decide how twitchy pricing feels.
HALF_LIFE = {
    "views": 1800,       # 30 min — traffic moves fast
    "searches": 1800,
    "cart_adds": 1800,
    "purchases": 3600,   # 1 hour — sales are sparser, need a longer memory
    "cancellations": 3600,
    "bookings": 3600,
}

EVENT_TO_COUNTER = {
    "view": "views",
    "search": "searches",
    "click": "views",
    "add_to_cart": "cart_adds",
    "purchase": "purchases",
    "booking": "purchases",
    "checkin": "purchases",
    "cancellation": "cancellations",
}

# Events that set a value outright rather than incrementing a counter.
DIRECT_SIGNALS = {
    "inventory_update": ("inventory", "inventory"),
    "availability_update": ("availability", "availability"),
    "competitor_price": ("competitor_price", "competitor_price"),
    "traffic_update": ("traffic", "traffic"),
    "supply_update": ("driver_supply", "supply"),
}

ANOMALY_FACTOR = 1.5   # a signal jumping >50% in one batch is worth a look
ANOMALY_FLOOR = 10.0   # ignore swings on tiny numbers, where noise dominates


def _decay(value: float, age_seconds: float, half_life: float) -> float:
    if value <= 0 or age_seconds <= 0:
        return max(0.0, value)
    return value * math.pow(0.5, age_seconds / half_life)


def _seen_before(project_id: str, event_id: str, ttl: int) -> bool:
    """Conditional write as a dedup gate. True means we've processed this one."""
    try:
        _ddb.put_item(
            TableName=TABLE_CONTEXT,
            Item={
                "pk": {"S": f"DEDUP#{project_id}"},
                "sk": {"S": f"EVT#{event_id}"},
                "ttl": {"N": str(ttl)},
            },
            ConditionExpression="attribute_not_exists(pk) AND attribute_not_exists(sk)",
        )
        return False
    except _ddb.exceptions.ConditionalCheckFailedException:
        return True
    except Exception as exc:  # noqa: BLE001
        # If the dedup gate itself is broken, process the event. Double-counting
        # one event is less harmful than silently dropping real demand.
        log.warning("dedup check failed for %s: %s", event_id, exc)
        return False


def _chaos_active(project_id: str) -> str | None:
    """Honour an injected fault from /demo/chaos."""
    try:
        resp = _ddb.get_item(
            TableName=TABLE_CONTEXT,
            Key={"pk": {"S": f"CHAOS#{project_id}"}, "sk": {"S": "META"}},
        )
        item = resp.get("Item")
        if not item:
            return None
        expires = float(item.get("expires_at", {}).get("N", 0))
        if expires and expires < time.time() * 1000:
            return None
        return item.get("scenario", {}).get("S")
    except Exception:  # noqa: BLE001
        return None


def _load_context(project_id: str, item_id: str) -> dict:
    resp = _ddb.get_item(
        TableName=TABLE_CONTEXT,
        Key={"pk": {"S": f"CTX#{project_id}#{item_id}"}, "sk": {"S": "NOW"}},
    )
    raw = resp.get("Item") or {}

    def unwrap(av):
        if "S" in av:
            return av["S"]
        if "N" in av:
            n = float(av["N"])
            return int(n) if n.is_integer() else n
        if "BOOL" in av:
            return av["BOOL"]
        if "M" in av:
            return {k: unwrap(v) for k, v in av["M"].items()}
        if "L" in av:
            return [unwrap(v) for v in av["L"]]
        if "NULL" in av:
            return None
        return None

    return {k: unwrap(v) for k, v in raw.items()}


def _compute(signals: dict, counters: dict, explicit: set[str] | None = None) -> dict:
    """Derive the pricing signals analysts actually write rules against.

    `explicit` names signals that arrived directly on an event (signal_<id>=).
    Those are never overwritten by a derived value: the caller stated the
    number, and our counter-based estimate is a guess by comparison. Without
    this, sending signal_demand_score=85 would be silently replaced by
    whatever the view/purchase counters happened to imply.

    The set is loaded from the stored context, not just the current batch, so a
    stated value keeps winning after later unrelated events arrive for the same
    item. Scoped to one batch, the protection lasted only until the next event.
    """
    explicit = explicit or set()

    def put(name: str, value):
        if name not in explicit:
            out[name] = value

    views = counters.get("views", 0.0)
    searches = counters.get("searches", 0.0)
    cart_adds = counters.get("cart_adds", 0.0)
    purchases = counters.get("purchases", 0.0)
    cancellations = counters.get("cancellations", 0.0)

    out = dict(signals)

    interest = views + searches * 1.2 + cart_adds * 3.0
    intent = purchases * 8.0
    raw_demand = interest + intent

    # Log compression: demand should respond strongly at low volume and flatten
    # at high volume, otherwise one viral item pins the scale at 100 and every
    # other item looks dead.
    put("demand_score", round(min(100.0, 100.0 * math.log1p(raw_demand) / math.log1p(500)), 2))

    if views > 0:
        put("conversion_rate", round(min(100.0, purchases / views * 100), 3))
    put("sales_velocity", round(purchases, 2))
    put("traffic", round(views + searches, 2))
    put("cart_additions", round(cart_adds, 2))

    if purchases + cancellations > 0:
        put("cancellation_rate",
            round(cancellations / (purchases + cancellations) * 100, 2))

    inventory = signals.get("inventory")
    if inventory is not None:
        # Pressure rises as stock falls AND demand climbs. Either alone is not
        # a reason to move a price; together they are.
        scarcity = max(0.0, 100.0 - float(inventory))
        put("inventory_pressure", round(
            min(100.0, scarcity * (0.5 + out.get("demand_score", 0) / 200.0)), 2
        ))

    competitor = signals.get("competitor_price")
    base = signals.get("_base_price")
    if competitor and base:
        put("competitor_gap",
            round((float(base) - float(competitor)) / float(base) * 100, 2))

    availability = signals.get("availability")
    if availability is not None:
        put("occupancy", round(max(0.0, 100.0 - float(availability)), 2))

    return out


def _detect_anomalies(item_id: str, before: dict, after: dict) -> list[dict]:
    found = []
    for key, new in after.items():
        if not isinstance(new, (int, float)) or key.startswith("_"):
            continue
        old = before.get(key)
        if not isinstance(old, (int, float)) or old < ANOMALY_FLOOR:
            continue
        if new > old * ANOMALY_FACTOR:
            found.append({
                "item_id": item_id, "signal": key,
                "from": round(old, 2), "to": round(new, 2),
                "change_pct": round((new - old) / old * 100, 1),
                "direction": "spike",
            })
        elif new < old / ANOMALY_FACTOR:
            found.append({
                "item_id": item_id, "signal": key,
                "from": round(old, 2), "to": round(new, 2),
                "change_pct": round((new - old) / old * 100, 1),
                "direction": "drop",
            })
    return found


def _persist(project_id: str, item_id: str, signals: dict, counters: dict, now_ms: int,
             explicit: set[str] | None = None) -> None:
    def wrap(v):
        if isinstance(v, bool):
            return {"BOOL": v}
        if isinstance(v, (int, float)):
            return {"N": str(v)}
        if v is None:
            return {"NULL": True}
        if isinstance(v, dict):
            return {"M": {k: wrap(x) for k, x in v.items()}}
        return {"S": str(v)}

    ages = {k: now_ms for k in signals if not k.startswith("_")}

    _ddb.update_item(
        TableName=TABLE_CONTEXT,
        Key={"pk": {"S": f"CTX#{project_id}#{item_id}"}, "sk": {"S": "NOW"}},
        UpdateExpression=(
            "SET signals = :s, counters = :c, signal_updated_at = :a, "
            "updated_at = :u, project_id = :p, item_id = :i, "
            "explicit_signals = :e"
        ),
        ExpressionAttributeValues={
            ":s": wrap({k: v for k, v in signals.items() if not k.startswith("_")}),
            ":c": wrap(counters),
            ":a": wrap(ages),
            ":u": {"N": str(now_ms)},
            ":p": {"S": project_id},
            ":i": {"S": item_id},
            # Which signals the caller set by hand, remembered ACROSS batches.
            # `explicit` used to be rebuilt per batch, so a value stated once was
            # protected only until the next unrelated event arrived for the same
            # item — sending signal_inventory a minute later silently recomputed
            # signal_demand_score from the counters and threw the stated value
            # away. That is how a demand_score of 92 became 11 on its own.
            ":e": {"L": [{"S": n} for n in sorted(explicit or set())]},
        },
    )


EVENT_FEED_TTL_SECONDS = 3600


def _append_event_feed(project_id: str, events: list[dict]) -> None:
    """Keep a short, TTL'd tail of raw events for the live feed.

    Raw events are otherwise consumed and discarded — they exist only as the
    counters they contributed to. The dashboard's event stream needs the
    individual lines, so a one-hour window is retained. Deliberately TTL'd
    rather than kept: this is a display buffer, not a data store, and the
    durable record of what happened is the decision log.
    """
    try:
        db.batch_put(db.context(), [
            {
                "pk": f"EVTFEED#{project_id}",
                "sk": f"{int(e.get('ts', 0)):013d}#{e.get('event_id', '')}",
                "ts": e.get("ts"),
                "item_id": e.get("item_id"),
                "event_type": e.get("event_type"),
                "quantity": e.get("quantity"),
                "value": e.get("value"),
                "synthetic": e.get("synthetic", False),
                "ttl": db.ttl_in(EVENT_FEED_TTL_SECONDS),
            }
            for e in events[:50]
        ])
    except Exception as exc:  # noqa: BLE001
        log.debug("event feed write skipped: %s", exc)


def _raise_alerts(tenant_id: str, project_id: str, anomalies: list[dict]) -> None:
    if not _sqs or not anomalies:
        return
    try:
        for i in range(0, len(anomalies), 10):
            _sqs.send_message_batch(
                QueueUrl=QUEUE_ALERTS,
                Entries=[
                    {
                        "Id": str(n),
                        "MessageBody": json.dumps({
                            "tenant_id": tenant_id,
                            "project_id": project_id,
                            "type": "signal_anomaly",
                            "severity": "warning" if abs(a["change_pct"]) < 100 else "critical",
                            "anomaly": a,
                        }),
                    }
                    for n, a in enumerate(anomalies[i:i + 10])
                ],
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("could not queue alerts: %s", exc)


def handler(event, _context):
    """SQS handler. Reports partial batch failures so one bad message does not
    force redelivery of the nine good ones beside it."""
    now_ms = int(time.time() * 1000)
    failures: list[dict] = []

    # Group by item so an item touched by 40 events in one batch is written once
    # rather than 40 times.
    grouped: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for record in event.get("Records", []):
        try:
            body = json.loads(record["body"])
            key = (body["tenant_id"], body["project_id"], body["item_id"])
            grouped[key].append({**body, "_message_id": record["messageId"]})
        except Exception as exc:  # noqa: BLE001
            log.error("malformed message %s: %s", record.get("messageId"), exc)
            # Malformed JSON will never parse, so retrying wastes attempts.
            # Drop it rather than letting it cycle to the DLQ three times.

    dedup_ttl = int(time.time()) + DEDUP_TTL_SECONDS

    for (tenant_id, project_id, item_id), events in grouped.items():
        try:
            chaos = _chaos_active(project_id)
            if chaos == "sqs_delay":
                # Deliberately fail so SQS redelivers: the backlog grows and the
                # dashboard's pipeline panel shows it, which is the demo.
                for e in events:
                    failures.append({"itemIdentifier": e["_message_id"]})
                continue

            ctx = _load_context(project_id, item_id)
            signals = dict(ctx.get("signals") or {})
            counters = dict(ctx.get("counters") or {})
            before = dict(signals)
            # Start from the signals previously stated by hand, so they survive
            # events that have nothing to do with them.
            explicit: set[str] = set(ctx.get("explicit_signals") or [])

            last_update = float(ctx.get("updated_at") or now_ms)
            age_s = max(0.0, (now_ms - last_update) / 1000.0)

            # Decay existing counters to now, then add this batch.
            for name, half_life in HALF_LIFE.items():
                if name in counters:
                    counters[name] = _decay(float(counters[name]), age_s, half_life)

            if ctx.get("base_price") is not None:
                signals["_base_price"] = ctx["base_price"]

            for e in events:
                if _seen_before(project_id, e.get("event_id", ""), dedup_ttl):
                    continue

                etype = e.get("event_type", "")
                counter = EVENT_TO_COUNTER.get(etype)
                if counter:
                    counters[counter] = counters.get(counter, 0.0) + float(e.get("quantity", 1) or 1)

                direct = DIRECT_SIGNALS.get(etype)
                if direct:
                    signal_name, param = direct
                    value = e.get(param, e.get("value"))
                    if value is not None:
                        signals[signal_name] = float(value)

                # Arbitrary signals from signal_<id>= params. This is what lets
                # a domain nobody anticipated feed its own signals: the schema
                # defines them, rules reference them, and these set them.
                # Applied last so an explicit signal always wins over a value
                # inferred from the event type.
                for name, value in (e.get("signals") or {}).items():
                    try:
                        signals[name] = float(value)
                        explicit.add(name)
                    except (TypeError, ValueError):
                        continue

                for passthrough in ("season", "location", "segment", "zone"):
                    if e.get(passthrough):
                        signals[passthrough] = e[passthrough]

            if chaos == "stale_data":
                # Write the signals but backdate their timestamps, so the engine
                # sees them as stale and skips the rules that depend on them.
                signals = _compute(signals, counters, explicit)
                stale_ms = now_ms - 86_400_000
                _persist(project_id, item_id, signals, counters, stale_ms, explicit)
                continue

            signals = _compute(signals, counters, explicit)
            _persist(project_id, item_id, signals, counters, now_ms, explicit)

            # Live event feed + context push to any connected dashboard.
            # ONE frame per SQS batch, not one per event — that is what keeps a
            # 20k events/sec storm from melting the browser.
            _append_event_feed(project_id, events)
            try:
                realtime.publish_events(project_id, events)
                realtime.publish_signals(project_id, item_id, signals)
            except Exception as exc:  # noqa: BLE001
                # A dashboard frame is never worth failing a processed batch.
                log.debug("realtime publish skipped: %s", exc)

            anomalies = _detect_anomalies(item_id, before, signals)
            if anomalies:
                _raise_alerts(tenant_id, project_id, anomalies)

        except Exception as exc:  # noqa: BLE001
            log.exception("failed processing %s/%s: %s", project_id, item_id, exc)
            for e in events:
                failures.append({"itemIdentifier": e["_message_id"]})

    return {"batchItemFailures": failures}
