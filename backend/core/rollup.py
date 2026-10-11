"""Pre-aggregated hourly counters.

Analytics was slow for one structural reason: every KPI recomputed itself by
scanning thousands of individual decision rows per request. Projection and
caching made that cheaper and hid it on repeat calls, but the cost still grew
linearly with traffic — a project doing 10x the volume paid 10x the latency.

So the aggregation moves to WRITE time. `decision_worker` already touches every
decision exactly once; while it is there it adds to an hourly bucket using
atomic DynamoDB ADD. Reading a 24-hour window then becomes ONE Query returning
at most ~24 tiny rows instead of a multi-thousand-row scan, and the cost is
flat regardless of how much traffic the project does.

    ROLLUP#<project_id>  H#<epoch_hour>              totals for that hour
    ROLLUP#<project_id>  H#<epoch_hour>#R#<rule_id>  per-rule triggers

Atomic ADD matters: several worker invocations process batches for the same
project in the same hour concurrently, and a read-modify-write would silently
lose counts. ADD is the only correct primitive here.

Buckets carry a TTL slightly beyond the decision retention window, so they
expire on their own rather than accumulating forever.
"""

from __future__ import annotations

import time
from decimal import Decimal

from core import db

HOUR_MS = 3_600_000
ROLLUP_TTL_DAYS = 100  # a little past the 90-day decision TTL

# Counters summed per hour. Averages are derived from a sum and a count rather
# than stored, because an average of averages is wrong once buckets have
# different weights.
COUNTERS = (
    "decisions", "changes", "fallbacks", "degraded", "guardrail_blocks",
    "orders", "revenue", "margin", "price_sum", "latency_sum", "latency_count",
)


def pk(project_id: str) -> str:
    return f"ROLLUP#{project_id}"


def hour_of(ts_ms: int) -> int:
    return int(ts_ms // HOUR_MS)


def sk(hour: int) -> str:
    return f"H#{hour:010d}"


def sk_rule(hour: int, rule_id: str) -> str:
    return f"H#{hour:010d}#R#{rule_id}"


def _add(project_id: str, sort_key: str, deltas: dict[str, float],
         labels: dict | None = None) -> None:
    """Atomically add to one bucket. Never raises."""
    deltas = {k: v for k, v in deltas.items() if v}
    if not deltas and not labels:
        return

    names: dict[str, str] = {}
    values: dict[str, Decimal | str | int] = {}
    adds: list[str] = []
    for i, (k, v) in enumerate(deltas.items()):
        names[f"#c{i}"] = k
        values[f":c{i}"] = Decimal(str(v))
        adds.append(f"#c{i} :c{i}")

    sets: list[str] = []
    for i, (k, v) in enumerate((labels or {}).items()):
        names[f"#s{i}"] = k
        values[f":s{i}"] = v
        sets.append(f"#s{i} = :s{i}")

    # TTL is set rather than added, so repeated writes keep extending it.
    names["#ttl"] = "ttl"
    values[":ttl"] = int(time.time()) + ROLLUP_TTL_DAYS * 86400
    sets.append("#ttl = :ttl")

    expr = ("SET " + ", ".join(sets) if sets else "") + \
           ((" ADD " + ", ".join(adds)) if adds else "")

    try:
        db.decisions().update_item(
            Key={"pk": pk(project_id), "sk": sort_key},
            UpdateExpression=expr.strip(),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except Exception:  # noqa: BLE001
        # A lost analytics counter is survivable; failing the decision write is
        # not. The raw decision rows remain the source of truth.
        pass


def record(project_id: str, summary: dict) -> None:
    """Fold one decision into its hourly bucket. Called by decision_worker."""
    hour = hour_of(summary.get("ts") or db.now_ms())
    price = summary.get("final_price") or 0
    lat = summary.get("latency_ms")

    _add(project_id, sk(hour), {
        "decisions": 1,
        "changes": 1 if summary.get("changed") else 0,
        "fallbacks": 1 if summary.get("fallback") else 0,
        "degraded": 1 if summary.get("degraded") else 0,
        "guardrail_blocks": 1 if summary.get("guardrail_names") else 0,
        "orders": summary.get("orders") or 0,
        "revenue": summary.get("realised_revenue") or 0,
        "margin": summary.get("realised_margin") or 0,
        "price_sum": price,
        "latency_sum": lat or 0,
        "latency_count": 1 if lat else 0,
    })

    # Per-rule triggers, so /analytics/rules does not need rules_detail either.
    for r in summary.get("rules_detail") or []:
        if r.get("applied") and r.get("rule_id"):
            _add(project_id, sk_rule(hour, r["rule_id"]),
                 {"triggered": 1, "impact": r.get("impact_amount") or 0},
                 labels={"rule_name": r.get("name") or r["rule_id"]})
        elif r.get("suppressed_by") and r.get("rule_id"):
            _add(project_id, sk_rule(hour, r["rule_id"]), {"suppressed": 1})


def read_window(project_id: str, since_ms: int, until_ms: int | None = None) -> dict:
    """Sum the buckets covering a window. ONE Query, at most ~720 tiny rows.

    Returns {"totals": {...}, "rules": {rule_id: {...}}, "buckets": {hour: {...}}}
    """
    until_ms = until_ms or db.now_ms()
    lo, hi = hour_of(since_ms), hour_of(until_ms)

    rows = db.query_between(
        db.decisions(), pk(project_id),
        sk(lo), sk(hi) + "#R#￿",
        limit=2000, ascending=True,
    )

    totals = {k: 0 for k in COUNTERS}
    buckets: dict[int, dict] = {}
    rules: dict[str, dict] = {}

    for row in rows:
        key = row.get("sk", "")
        if "#R#" in key:
            rule_id = key.split("#R#", 1)[1]
            agg = rules.setdefault(rule_id, {
                "triggered": 0, "suppressed": 0, "impact": 0.0, "rule_name": None,
            })
            agg["triggered"] += row.get("triggered", 0) or 0
            agg["suppressed"] += row.get("suppressed", 0) or 0
            agg["impact"] += row.get("impact", 0) or 0
            agg["rule_name"] = agg["rule_name"] or row.get("rule_name")
            continue

        try:
            hour = int(key.split("#", 1)[1])
        except (IndexError, ValueError):
            continue
        slot = {k: row.get(k, 0) or 0 for k in COUNTERS}
        buckets[hour] = slot
        for k in COUNTERS:
            totals[k] += slot[k]

    return {"totals": totals, "rules": rules, "buckets": buckets}


def summarise(totals: dict) -> dict:
    """Derive the presentable numbers from raw counters."""
    n = totals.get("decisions", 0) or 0
    lat_n = totals.get("latency_count", 0) or 0
    revenue = totals.get("revenue", 0) or 0
    return {
        "decisions": n,
        "price_changes": totals.get("changes", 0) or 0,
        "change_rate_pct": round((totals.get("changes", 0) or 0) / n * 100, 1) if n else 0.0,
        "avg_price": round((totals.get("price_sum", 0) or 0) / n, 2) if n else 0.0,
        "revenue": round(revenue, 2),
        "margin": round(totals.get("margin", 0) or 0, 2),
        "margin_pct": round((totals.get("margin", 0) or 0) / revenue * 100, 1) if revenue else 0.0,
        "orders": totals.get("orders", 0) or 0,
        "fallbacks": totals.get("fallbacks", 0) or 0,
        "degraded": totals.get("degraded", 0) or 0,
        "guardrail_blocks": totals.get("guardrail_blocks", 0) or 0,
        "avg_latency_ms": round((totals.get("latency_sum", 0) or 0) / lat_n, 2) if lat_n else None,
    }
