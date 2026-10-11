"""Decision worker — persists what the pricing handler decided.

The hot path builds a full decision record and throws it at SQS, then returns.
This worker does the writes. That split is what keeps the pricing API fast:
persisting three DynamoDB items synchronously would add 10-15ms to every priced
request for data nobody is waiting on.

Three writes per decision, each serving a different read pattern:

    DEC#<project>#<id>          the replayable record, with the input snapshot
    DECIDX#<project>#<item>     per-item history, for the item drill-down
    DECFEED#<project>           project-wide feed, for the dashboard and analytics

It also updates `previous_price` on the context row, which is the reference the
movement guardrails measure against — "maximum increase" means from the price
the customer last saw, not from a catalogue number.
"""

from __future__ import annotations

import json
import logging
import os

from core import db, realtime, rollup
from core.config import settings

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("devnexus.decision_worker")

DECISION_TTL_DAYS = int(os.environ.get("DECISION_TTL_DAYS", "90"))
GUARDRAIL_SATURATION_PCT = 40  # sustained capping is worth an alert

_sqs = None


def sqs():
    global _sqs
    if _sqs is None:
        import boto3
        _sqs = boto3.client("sqs", region_name=settings().region)
    return _sqs


def _summary(rec: dict) -> dict:
    """The compact row the feed and per-item index store.

    Deliberately not the whole decision: the feed is queried in pages of 500 for
    analytics, and carrying the full rules array in every row would blow past
    DynamoDB's 1MB page limit after a handful of items.
    """
    d = rec["decision"]
    applied = [r for r in d.get("rules", []) if r.get("applied")]
    return {
        "decision_id": rec["decision_id"],
        "item_id": rec["item_id"],
        "final_price": d.get("final_price"),
        "previous_price": d.get("previous_price"),
        "base_price": d.get("base_price"),
        "changed": d.get("changed"),
        "change_pct": d.get("change_pct"),
        "strategy_version": d.get("strategy_version"),
        "ruleset_version": d.get("ruleset_version"),
        "rules_fired": [r.get("name") for r in applied],
        "rules_detail": [
            {
                "rule_id": r.get("rule_id"), "name": r.get("name"),
                "applied": r.get("applied"), "suppressed_by": r.get("suppressed_by"),
                "impact_amount": r.get("impact_amount"),
            }
            for r in d.get("rules", [])
        ],
        "guardrail_names": [g.get("rule") for g in d.get("guardrails_applied", [])],
        "signals": (rec.get("snapshot") or {}).get("signals", {}),
        "degraded": d.get("degraded"),
        "fallback": d.get("fallback"),
        "latency_ms": rec.get("latency_ms"),
        "ts": rec["ts"],
    }


def _realised(rec: dict) -> dict:
    """Revenue attribution.

    A pricing decision is not a sale. We record the priced amount so analytics
    has something to aggregate, and label it as such — reporting quoted prices
    as revenue would overstate the platform's impact, which is exactly the kind
    of number nobody should have to defend later.
    """
    d = rec["decision"]
    price = d.get("final_price") or 0
    cost = (rec.get("snapshot") or {}).get("cost")
    return {
        "realised_revenue": price,
        "realised_margin": round(price - cost, 2) if cost is not None else None,
        "revenue_basis": "quoted_price",
    }


def handler(event, _context):
    failures: list[dict] = []
    saturation: dict[tuple[str, str], list[int]] = {}
    # Per-project rollup for the health frame published at the end of the batch.
    health_stats: dict[str, dict] = {}

    for record in event.get("Records", []):
        message_id = record.get("messageId")
        try:
            rec = json.loads(record["body"])
            tenant_id = rec["tenant_id"]
            project_id = rec["project_id"]
            item_id = rec["item_id"]
            decision_id = rec["decision_id"]
            ts = rec["ts"]
            d = rec["decision"]

            summary = {**_summary(rec), **_realised(rec)}
            ttl = db.ttl_in(DECISION_TTL_DAYS * 86400)

            # 1. the replayable record — snapshot included, this is what
            #    /decisions/verify re-runs
            db.put(db.decisions(), {
                "pk": db.dec_pk(project_id, decision_id),
                "sk": db.sk_meta(),
                "decision_id": decision_id,
                "tenant_id": tenant_id,
                "project_id": project_id,
                "item_id": item_id,
                "decision": d,
                "snapshot": rec.get("snapshot", {}),
                "latency_ms": rec.get("latency_ms"),
                "ts": ts,
                "ttl": ttl,
            })

            # 2. per-item history
            db.put(db.decisions(), {
                "pk": db.decidx_pk(project_id, item_id),
                "sk": db.decidx_sk(ts, decision_id),
                **summary, "ttl": ttl,
            })

            # 3. project-wide feed
            db.put(db.decisions(), {
                "pk": db.decfeed_pk(project_id),
                "sk": db.decidx_sk(ts, decision_id),
                **summary, "ttl": ttl,
            })

            # The price the customer was just quoted becomes the reference for
            # the next evaluation's movement guardrails.
            if d.get("final_price") and not d.get("fallback"):
                db.update(db.context(), db.ctx_pk(project_id, item_id), db.ctx_sk(), {
                    "previous_price": d["final_price"],
                    "last_decision_id": decision_id,
                    "last_priced_at": ts,
                })

            # Count rule triggers for the rule-health panel.
            for r in d.get("rules", []):
                if r.get("applied") and r.get("rule_id"):
                    try:
                        db.counter(
                            db.core(), db.pk_tenant(tenant_id),
                            db.sk_rule(project_id, r["rule_id"]), "trigger_count", 1,
                        )
                    except Exception:  # noqa: BLE001
                        pass  # a lost counter must not fail the decision write

            # Fold into the hourly rollup. This is what makes analytics flat
            # instead of linear in traffic: the aggregation happens once here,
            # on the write we were already doing, rather than being recomputed
            # from thousands of rows on every dashboard request.
            rollup.record(project_id, summary)

            # Live pricing decision feed.
            try:
                realtime.publish_decision(project_id, summary)
            except Exception as exc:  # noqa: BLE001
                log.debug("realtime publish skipped: %s", exc)

            key = (tenant_id, project_id)
            saturation.setdefault(key, []).append(
                1 if d.get("guardrails_applied") else 0
            )

            hs = health_stats.setdefault(project_id, {
                "count": 0, "changed": 0, "fallbacks": 0, "degraded": 0,
                "latencies": [],
            })
            hs["count"] += 1
            hs["changed"] += 1 if d.get("changed") else 0
            hs["fallbacks"] += 1 if d.get("fallback") else 0
            hs["degraded"] += 1 if d.get("degraded") else 0
            if rec.get("latency_ms"):
                hs["latencies"].append(rec["latency_ms"])

            # A fallback means the engine could not run. That is always worth
            # waking someone for.
            if d.get("fallback"):
                _alert(tenant_id, project_id, {
                    "type": "fallback_engaged",
                    "severity": "critical",
                    "reason": "; ".join(d.get("notes") or ["engine unavailable"]),
                    "decision_id": decision_id,
                    "item_id": item_id,
                })

        except Exception as exc:  # noqa: BLE001
            log.exception("failed persisting decision %s: %s", message_id, exc)
            failures.append({"itemIdentifier": message_id})

    # Sustained guardrail capping means the strategy is fighting its own limits.
    for (tenant_id, project_id), hits in saturation.items():
        if len(hits) >= 10:
            pct = round(sum(hits) / len(hits) * 100)
            if pct >= GUARDRAIL_SATURATION_PCT:
                _alert(tenant_id, project_id, {
                    "type": "guardrail_saturation",
                    "severity": "warning",
                    "blocked_pct": pct,
                    "sample_size": len(hits),
                })

    # Publish a health frame per project touched by this batch.
    #
    # The `health` channel was subscribable but nothing ever published to it, so
    # a dashboard could subscribe and receive silence indefinitely. This runs on
    # every decision batch and reports only what the worker already computed —
    # no extra reads, no extra IAM permissions.
    for (tenant_id, project_id), hits in saturation.items():
        stats = health_stats.get(project_id) or {}
        lat = stats.get("latencies") or []
        try:
            realtime.publish_health(project_id, {
                "decisions_in_batch": stats.get("count", 0),
                "price_changes": stats.get("changed", 0),
                "fallbacks": stats.get("fallbacks", 0),
                "degraded": stats.get("degraded", 0),
                "guardrail_block_pct": (
                    round(sum(hits) / len(hits) * 100) if hits else 0
                ),
                "avg_latency_ms": (
                    round(sum(lat) / len(lat), 2) if lat else None
                ),
                "engine": "degraded" if stats.get("fallbacks") else "healthy",
            })
        except Exception as exc:  # noqa: BLE001
            log.debug("health publish skipped: %s", exc)

    return {"batchItemFailures": failures}


def _alert(tenant_id: str, project_id: str, payload: dict) -> None:
    queue = settings().queue_alerts
    if not queue:
        return
    try:
        sqs().send_message(
            QueueUrl=queue,
            MessageBody=json.dumps({
                "tenant_id": tenant_id, "project_id": project_id, **payload,
            }),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("could not queue alert: %s", exc)
