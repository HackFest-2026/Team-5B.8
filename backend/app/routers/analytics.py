"""Analytics — the live operations dashboard.

Five endpoints behind the whole dashboard:

    /analytics/overview    KPI cards
    /analytics/timeseries  every chart, driven by a `metric` parameter
    /analytics/rules       rule health and conflicts
    /analytics/system      latency, pipeline, freshness, safety
    /analytics/domains     cross-project rollup — the "one engine, many
                           industries" proof panel

`/analytics/system` reports latency from two independent sources and labels
both. CloudWatch is the honest number but lags a minute or two; our own
in-request timing is instant but is us grading our own homework. Showing one
without the other would be either useless live or quietly self-serving.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from typing import Annotated

import boto3
from fastapi import APIRouter, Query

from app.deps import ProjectDep, RegisteredDep
from app.responses import ApiError, ok
from core import db, fanout, rollup
from core.config import REGION, settings

router = APIRouter(tags=["analytics"])

RANGES = {"1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}
METRICS = {
    "price", "demand", "revenue", "margin", "orders", "inventory",
    "conversion", "traffic", "price_changes", "api_requests", "latency",
}

_cw = None


def cloudwatch():
    global _cw
    if _cw is None:
        _cw = boto3.client("cloudwatch", region_name=REGION)
    return _cw


def _window(range_key: str) -> tuple[int, int]:
    if range_key not in RANGES:
        raise ApiError(f"range must be one of {sorted(RANGES)}")
    now = db.now_ms()
    return now - RANGES[range_key] * 1000, now


# The scalar fields every KPI and chart actually reads. Deliberately excludes
# `rules_detail` and `signals`, which are the two fat blobs on a feed row and
# are only needed by /analytics/rules and /analytics/timeseries respectively.
SLIM_FIELDS = (
    "ts,decision_id,item_id,final_price,previous_price,base_price,"
    "changed,change_pct,realised_revenue,realised_margin,orders,"
    "guardrail_names,degraded,fallback,latency_ms,strategy_version"
)
RULE_FIELDS = SLIM_FIELDS + ",rules_detail,rules_fired"
SIGNAL_FIELDS = SLIM_FIELDS + ",signals"


def _decisions_in(project_id: str, since_ms: int, cap: int = 2000,
                  fields: str | None = SLIM_FIELDS) -> list[dict]:
    """Recent decisions, newest first, stopping at the window edge.

    The feed partition is time-ordered, so this stops reading as soon as it
    passes `since_ms` rather than scanning the whole project history.

    `fields` projects away the wide attributes. Without it a 24-hour window
    fetched `rules_detail` and `signals` for every row — enough to fill the
    1MB page budget repeatedly and leave Python deserializing nested Decimals
    it never looked at. Callers that need those blobs ask for them explicitly.
    """
    out: list[dict] = []
    cursor = None
    while len(out) < cap:
        rows, cursor = db.query_prefix(
            db.decisions(), db.decfeed_pk(project_id), "",
            limit=500, cursor=cursor, ascending=False, projection=fields,
        )
        if not rows:
            break
        for r in rows:
            if (r.get("ts") or 0) < since_ms:
                return out
            out.append(r)
        if not cursor:
            break
    return out


@router.get("/analytics/overview", summary="Dashboard KPI cards")
async def overview(
    ctx: ProjectDep,
    range: Annotated[str, Query(description="1h | 6h | 24h | 7d | 30d")] = "24h",
):
    since, now = _window(range)

    # Read PRE-AGGREGATED hourly buckets, not individual decisions.
    #
    # This endpoint used to scan up to 2000 decision rows per window, twice
    # (current plus the preceding window for trend arrows), and got slower as a
    # project did more business — 410ms server-side at this project's volume.
    # decision_worker now folds each decision into an hourly counter as it
    # persists it, so a 24-hour window is ONE Query over ~24 tiny rows and the
    # cost no longer depends on traffic at all.
    span = now - since
    agg = fanout.cached(
        f"ovw:{ctx.project_id}:{range}", 10.0,
        lambda: {
            "cur": rollup.read_window(ctx.project_id, since, now),
            "prev": rollup.read_window(ctx.project_id, since - span, since),
        },
    )
    current = rollup.summarise(agg["cur"]["totals"])
    previous = rollup.summarise(agg["prev"]["totals"])

    def delta(key: str) -> float | None:
        a, b = previous.get(key), current.get(key)
        if not a:
            return None
        return round((b - a) / a * 100, 1)

    degraded = current["degraded"]
    fallbacks = current["fallbacks"]
    blocked = current["guardrail_blocks"]

    return ok({
        "range": range,
        "currency": ctx.currency,
        "strategy": {
            "active_strategy_id": ctx.project.get("active_strategy_id"),
            "version": ctx.project.get("active_strategy_version"),
            "mode": ctx.project.get("mode", "draft"),
        },
        "kpis": {
            # NOT money taken. This is the sum of the prices DevNexus quoted,
            # which is why it can be non-zero while orders is zero. The basis is
            # reported alongside it so a client cannot label it "revenue"
            # without having seen this.
            "revenue": {"value": current["revenue"], "change_pct": delta("revenue"),
                        "basis": "quoted_price",
                        "meaning": "Sum of prices quoted by the pricing API, "
                                   "not confirmed sales."},
            "margin": {"value": current["margin"], "change_pct": delta("margin"),
                       "percent": current["margin_pct"],
                       # Derived from quoted prices, so it carries the same caveat.
                       "basis": "quoted_price"},
            "orders": {"value": current["orders"], "change_pct": delta("orders")},
            "avg_price": {"value": current["avg_price"], "change_pct": delta("avg_price")},
            "decisions": {"value": current["decisions"], "change_pct": delta("decisions")},
            "price_changes": {"value": current["price_changes"],
                              "rate_pct": current["change_rate_pct"]},
        },
        "safety": {
            "guardrail_blocks": blocked,
            "fallback_decisions": fallbacks,
            "degraded_decisions": degraded,
            # A degraded decision is one priced on stale or partial context. It
            # is not as serious as a fallback — the engine DID run — but it is
            # not "all clear" either, and claiming it was produced a dashboard
            # that said "every decision ran on fresh context" directly above a
            # count of 8 that had not.
            "healthy": fallbacks == 0 and degraded == 0,
            "degraded_rate_pct": round(degraded / current["decisions"] * 100, 1)
            if current["decisions"] else 0.0,
        },
        # Hourly buckets are counters, not row sets, so a distinct-item count
        # is not derivable from them. Reported as null rather than guessed.
        "items_covered": None,
        "note": "KPIs come from pre-aggregated hourly counters, so this is "
                "flat-cost regardless of traffic volume.",
    })


@router.get("/analytics/timeseries", summary="Chart data for any metric")
async def timeseries(
    ctx: ProjectDep,
    metric: Annotated[str, Query(description=f"one of: {', '.join(sorted(METRICS))}")],
    range: Annotated[str, Query()] = "24h",
    interval: Annotated[str, Query(description="1m | 5m | 1h | 1d")] = "1h",
):
    if metric not in METRICS:
        raise ApiError(f"unknown metric '{metric}'", available=sorted(METRICS))

    buckets_ms = {"1m": 60_000, "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000}
    if interval not in buckets_ms:
        raise ApiError(f"interval must be one of {sorted(buckets_ms)}")

    since, now = _window(range)
    size = buckets_ms[interval]
    # Only the signal-derived metrics need the signals blob; the rest are scalars.
    needs_signals = metric in ("demand", "inventory", "conversion", "traffic")

    # Hourly buckets already hold everything the scalar metrics need, so an
    # hour- or day-grained chart is a single Query over a handful of counter
    # rows rather than a scan of every decision in the range.
    if interval in ("1h", "1d") and not needs_signals:
        agg = fanout.cached(
            f"tsagg:{ctx.project_id}:{range}", 10.0,
            lambda: rollup.read_window(ctx.project_id, since, now),
        )
        points = []
        step = 1 if interval == "1h" else 24
        lo, hi = rollup.hour_of(since), rollup.hour_of(now)
        h = lo
        while h <= hi:
            # NOTE: the `range` query parameter shadows the builtin range() in
            # this function, so bucket spans are walked with an explicit loop.
            # Calling range() here raised "'str' object is not callable".
            group = []
            x = h
            end = min(h + step, hi + 1)
            while x < end:
                group.append(agg["buckets"].get(x, {}))
                x += 1
            n = sum(g.get("decisions", 0) or 0 for g in group)
            if metric == "price":
                v = round(sum(g.get("price_sum", 0) or 0 for g in group) / n, 2) if n else 0.0
            elif metric == "revenue":
                v = round(sum(g.get("revenue", 0) or 0 for g in group), 2)
            elif metric == "margin":
                v = round(sum(g.get("margin", 0) or 0 for g in group), 2)
            elif metric == "orders":
                v = sum(g.get("orders", 0) or 0 for g in group)
            elif metric == "price_changes":
                v = sum(g.get("changes", 0) or 0 for g in group)
            elif metric == "api_requests":
                v = n
            elif metric == "latency":
                c = sum(g.get("latency_count", 0) or 0 for g in group)
                v = round(sum(g.get("latency_sum", 0) or 0 for g in group) / c, 1) if c else 0.0
            else:
                v = 0.0
            points.append({"t": h * rollup.HOUR_MS, "value": v})
            h += step

        # Whether an empty bucket counts as a zero depends on what the metric
        # MEANS, and getting this wrong produced a chart sitting at zero for 23
        # hours under the caption "avg 1.02K, min 1.02K, max 1.02K".
        #
        #   summed metrics  (priced value, orders, changes, requests, margin):
        #     an hour with no activity genuinely IS zero, so it must be counted
        #     or the average silently describes only the busy hours.
        #
        #   averaged metrics (price, latency):
        #     an hour with no decisions has no price at all. Counting it as zero
        #     would drag the average toward a number nothing ever cost.
        AVERAGED = {"price", "latency", "conversion"}
        if metric in AVERAGED:
            vals = [pt["value"] for pt in points if pt["value"]]
            basis = "buckets with activity"
        else:
            vals = [pt["value"] for pt in points]
            basis = "all buckets in range"

        return ok({
            "metric": metric, "range": range, "interval": interval,
            "points": points,
            "stats": {
                "min": min(vals) if vals else 0, "max": max(vals) if vals else 0,
                "avg": round(sum(vals) / len(vals), 2) if vals else 0,
                "latest": points[-1]["value"] if points else 0,
                # Stated so the figures cannot be read as covering something
                # other than what they were computed over.
                "basis": basis,
                "buckets": len(points),
            },
            "currency": ctx.currency if metric in ("price", "revenue", "margin") else None,
            "source": "pre-aggregated hourly counters",
        })

    rows = fanout.cached(
        f"ts:{ctx.project_id}:{range}:{'sig' if needs_signals else 'slim'}", 12.0,
        lambda: _decisions_in(ctx.project_id, since,
                              fields=SIGNAL_FIELDS if needs_signals else SLIM_FIELDS),
    )

    buckets: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        buckets[(r.get("ts", 0) // size) * size].append(r)

    def value(data: list[dict]) -> float:
        if metric == "price":
            p = [d.get("final_price") for d in data if d.get("final_price")]
            return round(sum(p) / len(p), 2) if p else 0.0
        if metric == "demand":
            v = [(d.get("signals") or {}).get("demand_score") for d in data]
            v = [x for x in v if x is not None]
            return round(sum(v) / len(v), 2) if v else 0.0
        if metric == "inventory":
            v = [(d.get("signals") or {}).get("inventory") for d in data]
            v = [x for x in v if x is not None]
            return round(sum(v) / len(v), 2) if v else 0.0
        if metric == "revenue":
            return round(sum(d.get("realised_revenue", 0) or 0 for d in data), 2)
        if metric == "margin":
            return round(sum(d.get("realised_margin", 0) or 0 for d in data), 2)
        if metric == "orders":
            return sum(d.get("orders", 0) or 0 for d in data)
        if metric == "conversion":
            v = [(d.get("signals") or {}).get("conversion_rate") for d in data]
            v = [x for x in v if x is not None]
            return round(sum(v) / len(v), 2) if v else 0.0
        if metric == "traffic":
            v = [(d.get("signals") or {}).get("traffic") for d in data]
            v = [x for x in v if x is not None]
            return round(sum(v), 2) if v else 0.0
        if metric == "price_changes":
            return sum(1 for d in data if d.get("changed"))
        if metric == "api_requests":
            return len(data)
        if metric == "latency":
            v = [d.get("latency_ms") for d in data if d.get("latency_ms")]
            return round(sum(v) / len(v), 1) if v else 0.0
        return 0.0

    points = []
    t = (since // size) * size
    while t <= now:
        points.append({"t": t, "value": value(buckets.get(t, []))})
        t += size

    values = [p["value"] for p in points if p["value"]]
    return ok({
        "metric": metric,
        "range": range,
        "interval": interval,
        "points": points,
        "stats": {
            "min": min(values) if values else 0,
            "max": max(values) if values else 0,
            "avg": round(sum(values) / len(values), 2) if values else 0,
            "latest": points[-1]["value"] if points else 0,
        },
        "currency": ctx.currency if metric in ("price", "revenue", "margin") else None,
    })


@router.get("/analytics/rules", summary="Rule health")
async def rule_analytics(
    ctx: ProjectDep,
    range: Annotated[str, Query()] = "24h",
):
    since, now = _window(range)

    # Per-rule triggers come from the same hourly rollup the KPIs use.
    # Previously this was the one endpoint that still had to pull rules_detail
    # off every decision row in the window, which left it at ~195ms however
    # much it was cached. decision_worker now also counts per-rule triggers and
    # suppressions into H#<hour>#R#<rule_id> buckets, so this is the same
    # single Query as the overview.
    agg = fanout.cached(
        f"rules:{ctx.project_id}:{range}", 10.0,
        lambda: rollup.read_window(ctx.project_id, since, now),
    )
    rule_stats = agg["rules"]
    fired = {rid: v.get("triggered", 0) for rid, v in rule_stats.items()}
    suppressed = {rid: v.get("suppressed", 0) for rid, v in rule_stats.items()}
    impact = {rid: v.get("impact", 0.0) for rid, v in rule_stats.items()}

    all_rules, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id), db.sk_rule_prefix(ctx.project_id), limit=500
    )
    enabled = [r for r in all_rules if r.get("enabled", True)]

    from core.engine import compile_rules, detect_conflicts
    conflicts = detect_conflicts(compile_rules(enabled))

    stats = []
    for r in enabled:
        rid = r["rule_id"]
        stats.append({
            "rule_id": rid,
            "name": r.get("name"),
            "priority": r.get("priority", 50),
            "triggered": fired.get(rid, 0),
            "suppressed": suppressed.get(rid, 0),
            "total_impact": round(impact.get(rid, 0), 2),
            "never_fired": fired.get(rid, 0) == 0,
        })
    stats.sort(key=lambda s: -s["triggered"])

    return ok({
        "range": range,
        "active_rules": len(enabled),
        "disabled_rules": len(all_rules) - len(enabled),
        "total_triggers": sum(fired.values()),
        "source": "pre-aggregated hourly rule counters",
        "conflicts": conflicts,
        "conflict_count": len(conflicts),
        "blocked_rules": sum(1 for c in conflicts if c["severity"] == "error"),
        "dead_rules": [s for s in stats if s["never_fired"]],
        "rules": stats,
    })


def _cloudwatch_latency() -> dict | None:
    """Independent latency percentiles from CloudWatch.

    Pulled out so it can run concurrently with the DynamoDB reads: it is the
    slowest dependency in /analytics/system by an order of magnitude, and
    nothing else in the response depends on it. Returns None rather than
    raising — CloudWatch being unavailable is not an outage of this endpoint.
    """
    try:
        resp = cloudwatch().get_metric_statistics(
            Namespace="AWS/ApiGateway",
            MetricName="Latency",
            Dimensions=[{"Name": "ApiId", "Value": settings().stage}],
            StartTime=dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=15),
            EndTime=dt.datetime.now(dt.timezone.utc),
            Period=300,
            Statistics=["Average"],
            ExtendedStatistics=["p50", "p95", "p99"],
        )
        pts = sorted(resp.get("Datapoints", []), key=lambda d: d["Timestamp"])
        if not pts:
            return None
        ext = pts[-1].get("ExtendedStatistics", {})
        return {
            "p50": round(ext.get("p50", 0), 1),
            "p95": round(ext.get("p95", 0), 1),
            "p99": round(ext.get("p99", 0), 1),
            "as_of": pts[-1]["Timestamp"].isoformat(),
        }
    except Exception:  # noqa: BLE001
        return None


@router.get("/analytics/system", summary="Latency, pipeline health and data freshness")
async def system_health(ctx: ProjectDep):
    """Operational truth, from two sources, both labelled.

    Self-measured numbers come from decision records written by the pricing
    handler — instant, but ours. CloudWatch is independent but lags. Showing
    both is the honest version.
    """
    since = db.now_ms() - 3600 * 1000

    # CloudWatch is the slowest dependency here (hundreds of ms) and is
    # completely independent of the DynamoDB reads, so it must not be serial.
    parts = fanout.gather({
        "rows": lambda: fanout.cached(
            f"sys:{ctx.project_id}", 10.0,
            # 250 recent samples is ample for p50/p95/p99 and a quarter of
            # the scan 1000 required.
            lambda: _decisions_in(ctx.project_id, since, cap=250)),
        "items": lambda: db.query_prefix(
            db.core(), db.pk_tenant(ctx.tenant_id),
            db.sk_item_prefix(ctx.project_id), limit=25)[0],
        # 60s cache: these figures already lag real time by 1-2 minutes, so
        # re-fetching them per request buys no freshness and costs the most of
        # anything in this endpoint.
        "cw": lambda: fanout.cached("cw:latency", 60.0, _cloudwatch_latency),
    })
    rows = fanout.ok(parts["rows"], []) or []

    lat = sorted(r["latency_ms"] for r in rows if r.get("latency_ms"))

    def pct(q: float) -> float | None:
        if not lat:
            return None
        return round(lat[min(len(lat) - 1, int(len(lat) * q))], 1)

    cw_latency = fanout.ok(parts["cw"])

    # Freshness: ONE BatchGetItem rather than one GetItem per sampled item.
    items = fanout.ok(parts["items"], []) or []
    now = db.now_ms()
    freshness_rows = db.batch_get(
        db.context(),
        [(db.ctx_pk(ctx.project_id, it["item_id"]), db.ctx_sk()) for it in items],
    ) if items else []
    freshness_raw: dict[str, list[float]] = {}
    for row in freshness_rows:
        for sig, stamp in ((row or {}).get("signal_updated_at") or {}).items():
            freshness_raw.setdefault(sig, []).append((now - float(stamp)) / 1000.0)

    stale_after = settings().context_stale_seconds
    signal_freshness = [
        {
            "signal": sig,
            "median_age_seconds": round(sorted(ages)[len(ages) // 2], 1),
            "stale": sorted(ages)[len(ages) // 2] > stale_after,
        }
        for sig, ages in freshness_raw.items() if ages
    ]

    fallbacks = sum(1 for r in rows if r.get("fallback"))
    degraded = sum(1 for r in rows if r.get("degraded"))

    return ok({
        "pricing_api": {
            "self_measured": {
                "p50_ms": pct(0.5), "p95_ms": pct(0.95), "p99_ms": pct(0.99),
                "sample_size": len(lat),
                "source": "timing recorded inside the pricing handler",
                "caveat": "measured by us; use the CloudWatch figures for an "
                          "independent number",
            },
            "cloudwatch": cw_latency or {
                "available": False,
                "note": "no datapoints yet — CloudWatch lags by 1-2 minutes",
            },
            "requests_last_hour": len(rows),
        },
        "pricing_safety": {
            "fallback_decisions": fallbacks,
            "degraded_decisions": degraded,
            "primary_engine": "degraded" if fallbacks else "healthy",
            "fallback_strategy": "ready",
        },
        "data_freshness": {
            "stale_after_seconds": stale_after,
            "signals": signal_freshness,
            "any_stale": any(s["stale"] for s in signal_freshness),
        },
        "strategy": {
            "mode": ctx.project.get("mode", "draft"),
            "active_version": ctx.project.get("active_strategy_version"),
            "shadow_version": ctx.project.get("shadow_strategy_version"),
        },
    })


@router.get("/analytics/portfolio", summary="Analytics across every project")
async def portfolio(
    session: RegisteredDep,
    range: Annotated[str, Query(description="1h | 6h | 24h | 7d | 30d")] = "24h",
):
    """Everything the account is doing, in one call.

    This is the home screen's data and it is deliberately NOT scoped to a
    project: the question it answers is "how is my pricing doing overall",
    which no per-project endpoint can answer without the client fanning out and
    summing on its own.

    Hourly rollups make this cheap — one Query per project over a handful of
    counter rows — so the cost tracks the number of PROJECTS, not the number of
    decisions they have made.
    """
    since, now = _window(range)
    span = now - since

    projects, _ = db.query_prefix(
        db.core(), db.pk_tenant(session.tenant_id), "PROJECT#", limit=100  # type: ignore[arg-type]
    )

    if not projects:
        return ok({
            "range": range,
            "projects": {"total": 0, "live": 0, "draft": 0, "paused": 0},
            "totals": {"decisions": 0, "price_changes": 0, "priced_value": 0.0,
                       "items": 0, "change_rate_pct": 0.0},
            "trend": {"decisions": None, "priced_value": None},
            "series": [],
            "health": {"degraded": 0, "fallbacks": 0, "guardrail_blocks": 0, "healthy": True},
            "busiest": [],
            "domains": [],
            "currency": None,
            "note": "No projects yet.",
        })

    cached = fanout.cached(
        f"pf:{session.tenant_id}:{range}", 15.0,
        lambda: {
            "cur": fanout.pmap(projects, lambda p: rollup.read_window(p["project_id"], since, now)),
            "prev": fanout.pmap(
                projects, lambda p: rollup.read_window(p["project_id"], since - span, since)),
        },
    )

    totals = {"decisions": 0, "changes": 0, "revenue": 0.0, "margin": 0.0,
              "degraded": 0, "fallbacks": 0, "guardrail_blocks": 0}
    prev_totals = {"decisions": 0, "revenue": 0.0}

    # Hour -> combined counters, so the chart is the whole account rather than
    # one project's line repeated.
    merged: dict[int, dict] = {}
    per_project = []

    for p, cur, prv in zip(projects, cached["cur"], cached["prev"]):
        agg = fanout.ok(cur, {}) or {}
        t = agg.get("totals", {})
        s = rollup.summarise(t)

        totals["decisions"] += s["decisions"]
        totals["changes"] += s["price_changes"]
        totals["revenue"] += s["revenue"]
        totals["margin"] += s["margin"]
        totals["degraded"] += s["degraded"]
        totals["fallbacks"] += s["fallbacks"]
        totals["guardrail_blocks"] += s["guardrail_blocks"]

        pt = (fanout.ok(prv, {}) or {}).get("totals", {})
        ps = rollup.summarise(pt)
        prev_totals["decisions"] += ps["decisions"]
        prev_totals["revenue"] += ps["revenue"]

        for hour, slot in (agg.get("buckets") or {}).items():
            bucket = merged.setdefault(hour, {k: 0 for k in rollup.COUNTERS})
            for k in rollup.COUNTERS:
                bucket[k] += slot.get(k, 0) or 0

        per_project.append({
            "project_id": p["project_id"],
            "name": p.get("name"),
            "domain_name": p.get("domain_name"),
            "mode": p.get("mode", "draft"),
            "currency": p.get("currency"),
            "decisions": s["decisions"],
            "price_changes": s["price_changes"],
            "priced_value": round(s["revenue"], 2),
            # Carried per project so the account screen can NAME what is wrong.
            # The account-wide totals below can only say "something is failing",
            # which is the least useful possible version of an alert.
            "fallbacks": s["fallbacks"],
            "degraded": s["degraded"],
        })

    # The series spans the WHOLE window, including hours with no activity, so a
    # quiet night reads as a flat line rather than being silently dropped.
    #
    # Long windows are bucketed by DAY. An hourly 30-day series is 721 points,
    # which is more marks than a dashboard chart has pixels — it reads as noise
    # and costs bandwidth to say nothing.
    step = 24 if range in ("7d", "30d") else 1
    interval = "1d" if step == 24 else "1h"

    lo, hi = rollup.hour_of(since), rollup.hour_of(now)
    series = []
    h = lo
    while h <= hi:
        end = min(h + step, hi + 1)
        decisions = changes = 0
        value = 0.0
        x = h
        while x < end:
            slot = merged.get(x)
            if slot:
                decisions += slot.get("decisions", 0) or 0
                changes += slot.get("changes", 0) or 0
                value += slot.get("revenue", 0) or 0
            x += 1
        series.append({
            "t": h * rollup.HOUR_MS,
            "decisions": decisions,
            "price_changes": changes,
            "priced_value": round(value, 2),
        })
        h += step

    def trend(cur_v: float, prev_v: float) -> float | None:
        # No previous activity means there is no percentage to report. Saying
        # "+100%" against zero would be a number nobody could defend.
        if not prev_v:
            return None
        return round((cur_v - prev_v) / prev_v * 100, 1)

    modes = [p.get("mode", "draft") for p in projects]
    currencies = {p.get("currency") for p in projects if p.get("currency")}

    return ok({
        "range": range,
        "interval": interval,
        "projects": {
            "total": len(projects),
            "live": modes.count("active"),
            "draft": modes.count("draft"),
            "paused": modes.count("paused"),
        },
        "totals": {
            "decisions": totals["decisions"],
            "price_changes": totals["changes"],
            "priced_value": round(totals["revenue"], 2),
            "priced_margin": round(totals["margin"], 2),
            "items": sum(p.get("item_count", 0) for p in projects),
            "change_rate_pct": round(totals["changes"] / totals["decisions"] * 100, 1)
            if totals["decisions"] else 0.0,
        },
        "trend": {
            "decisions": trend(totals["decisions"], prev_totals["decisions"]),
            "priced_value": trend(totals["revenue"], prev_totals["revenue"]),
        },
        "series": series,
        "health": {
            "degraded": totals["degraded"],
            "fallbacks": totals["fallbacks"],
            "guardrail_blocks": totals["guardrail_blocks"],
            "healthy": totals["fallbacks"] == 0 and totals["degraded"] == 0,
        },
        # Most active first, so the home screen leads with where things are
        # actually happening.
        "busiest": sorted(per_project, key=lambda x: -x["decisions"])[:5],
        # Projects whose engine could not run. This is the only thing an account
        # screen genuinely owes the user: a project failing quietly is invisible
        # everywhere else, because nobody opens a project they think is fine.
        #
        # DEGRADED is deliberately excluded. A project that has never been sent
        # signals reports every decision as degraded, which would make "needs
        # attention" the permanent state of every new project — an alarm that is
        # always on is an alarm nobody reads.
        "attention": sorted(
            [x for x in per_project if x["fallbacks"] > 0],
            key=lambda x: -x["fallbacks"],
        ),
        "domains": sorted({p.get("domain_name") for p in projects if p.get("domain_name")}),
        # Only meaningful when every project agrees; mixed currencies cannot be
        # summed into one figure and the client must not pretend otherwise.
        "currency": next(iter(currencies)) if len(currencies) == 1 else None,
        "priced_value_basis": "quoted_price",
    })


@router.get("/analytics/domains", summary="Cross-project rollup")
async def domains(session: RegisteredDep):
    """One engine, many industries — in numbers.

    Every project here is priced by the same deterministic engine with no
    domain-specific code. The spread of domain names in this response is the
    evidence for the core claim.
    """
    projects, _ = db.query_prefix(
        db.core(), db.pk_tenant(session.tenant_id), "PROJECT#", limit=100  # type: ignore[arg-type]
    )
    since = db.now_ms() - 86400 * 1000

    # One walk per project, fanned out. Serially this was the whole cost of the
    # endpoint and it grew linearly with every project a tenant added.
    # One rollup Query per project instead of a full decision scan per project.
    # Cheap enough that the fan-out still earns its keep here, because each
    # project is a separate partition.
    now_ms = db.now_ms()
    per_project = fanout.cached(
        f"dom:{session.tenant_id}", 15.0,
        lambda: fanout.pmap(
            projects,
            lambda pr: rollup.read_window(pr["project_id"], since, now_ms)),
    )

    rows = []
    totals = {"items": 0, "decisions": 0, "changes": 0, "revenue": 0.0}
    for p, agg in zip(projects, per_project):
        t = (fanout.ok(agg, {}) or {}).get("totals", {})
        summary = rollup.summarise(t)
        changes = summary["price_changes"]
        revenue = summary["revenue"]

        totals["items"] += p.get("item_count", 0)
        totals["decisions"] += summary["decisions"]
        totals["changes"] += changes
        totals["revenue"] += revenue

        rows.append({
            "project_id": p["project_id"],
            "name": p.get("name"),
            "domain_name": p.get("domain_name"),
            "entity_label": p.get("entity_label"),
            "currency": p.get("currency"),
            "mode": p.get("mode", "draft"),
            "items": p.get("item_count", 0),
            "signals": len((p.get("schema") or {}).get("context_signals", [])),
            "decisions_24h": summary["decisions"],
            "price_changes_24h": changes,
            "revenue_24h": round(revenue, 2),
        })

    distinct = sorted({r["domain_name"] for r in rows if r["domain_name"]})
    return ok({
        "project_count": len(rows),
        "distinct_domains": distinct,
        "distinct_domain_count": len(distinct),
        "totals": {**totals, "revenue": round(totals["revenue"], 2)},
        "projects": rows,
        "claim": (
            f"{len(distinct)} distinct domain(s) priced by one engine. "
            f"No domain-specific code exists — each project differs only by its "
            f"configured schema and rules."
        ),
    })
