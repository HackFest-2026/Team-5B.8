"""Backtest worker — replay a strategy version over historical context.

For every historical snapshot in the window, rebuild the context exactly as it
was and run the engine. The result is what this strategy WOULD have charged,
compared against what actually happened.

Two things make this trustworthy rather than decorative:

**It runs the production engine.** `core.pricing.price_with` — the same call the
live API makes. No separate backtest implementation that could drift.

**It verifies itself.** A sample of replayed decisions is re-run and checked for
an identical result. A backtest whose own numbers are not reproducible is not
evidence of anything, so the report says how many were checked and how many
reproduced.

Revenue comparison is modelled, and labelled as modelled. We know the historical
price and the historical demand; we do not know how customers would have reacted
to a different price. The elasticity assumption is stated in the output rather
than buried, because the honest version of this number is more useful than a
flattering one.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
from collections import defaultdict

from core import db, pricing
from core.engine import PricingContext

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("devnexus.backtest_worker")

MAX_ITEMS = 500
MAX_SNAPSHOTS_PER_ITEM = 500
CORRECTNESS_SAMPLE = 25

# How much demand is assumed to move per 1% price change. -0.8 is a mild,
# defensible default for retail-like goods. It is reported alongside every
# result so the reader can discount accordingly.
DEFAULT_ELASTICITY = -0.8


def _iso_to_ms(value: str, end_of_day: bool = False) -> int:
    d = dt.date.fromisoformat(value)
    t = dt.time(23, 59, 59) if end_of_day else dt.time(0, 0, 0)
    return int(dt.datetime.combine(d, t, dt.timezone.utc).timestamp() * 1000)


def _progress(tenant_id, project_id, job_id, **fields):
    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_job(project_id, job_id), fields)


def handler(event, _context):
    failures: list[dict] = []

    for record in event.get("Records", []):
        message_id = record.get("messageId")
        job = {}
        try:
            job = json.loads(record["body"])
            tenant_id = job["tenant_id"]
            project_id = job["project_id"]
            job_id = job["job_id"]

            _progress(tenant_id, project_id, job_id,
                      status="running", started_at=db.now_ms(), progress_pct=0)

            blob = db.get(db.core(), db.pk_tenant(tenant_id),
                          db.sk_version(project_id, job["strategy_id"], job["version"]))
            if not blob:
                raise RuntimeError(f"strategy version {job['version']} not found")
            strategy = {**blob, "mode": "active"}

            project = db.get(db.core(), db.pk_tenant(tenant_id),
                             db.sk_project(project_id)) or {}
            currency = project.get("currency", "INR")

            start_ms = _iso_to_ms(job["date_from"])
            end_ms = _iso_to_ms(job["date_to"], end_of_day=True)

            item_ids = job.get("item_ids") or []
            if not item_ids:
                rows, _ = db.query_prefix(
                    db.core(), db.pk_tenant(tenant_id),
                    db.sk_item_prefix(project_id), limit=MAX_ITEMS,
                )
                item_ids = [r["item_id"] for r in rows]
            if not item_ids:
                raise RuntimeError("no items to backtest")

            actual = {"revenue": 0.0, "margin": 0.0, "orders": 0, "price_sum": 0.0, "n": 0}
            simulated = dict(actual)
            rules_triggered: dict[str, int] = defaultdict(int)
            replayed = changes = guardrail_blocks = 0
            correctness_samples: list[dict] = []

            for idx, item_id in enumerate(item_ids):
                item = db.get(db.core(), db.pk_tenant(tenant_id),
                              db.sk_item(project_id, item_id))
                if not item:
                    continue
                cost = item.get("cost")
                base_price = item.get("base_price") or 0.0

                snapshots = db.query_between(
                    db.context(), db.ctx_pk(project_id, item_id),
                    f"HIST#{start_ms:013d}", f"HIST#{end_ms:013d}",
                    limit=MAX_SNAPSHOTS_PER_ITEM, ascending=True,
                )

                previous_sim_price = None
                for snap in snapshots:
                    ts = snap.get("ts") or 0
                    signals = dict(snap.get("signals") or {})
                    historical_price = snap.get("price") or base_price

                    # Demand proxy: whatever the data actually recorded.
                    units = (
                        signals.get("orders")
                        or signals.get("sales")
                        or signals.get("purchases")
                        or 0
                    )

                    ctx = PricingContext(
                        base_price=float(base_price),
                        signals={**signals, **pricing.time_signals(ts)},
                        signal_age_s={k: 0.0 for k in signals},
                        cost=float(cost) if cost is not None else None,
                        previous_price=previous_sim_price or float(historical_price),
                        now_ms=ts,
                        currency=currency,
                    )

                    decision = pricing.price_with(ctx=ctx, strategy_blob=strategy)
                    replayed += 1

                    if decision.changed:
                        changes += 1
                    if decision.guardrails_applied:
                        guardrail_blocks += 1
                    for r in decision.rules:
                        if r.applied:
                            rules_triggered[r.name] += 1

                    # Actual outcome, straight from the data.
                    actual["revenue"] += float(historical_price) * units
                    actual["orders"] += units
                    actual["price_sum"] += float(historical_price)
                    actual["n"] += 1
                    if cost is not None:
                        actual["margin"] += (float(historical_price) - float(cost)) * units

                    # Modelled outcome under the simulated price.
                    sim_price = decision.final_price
                    price_delta_pct = (
                        (sim_price - float(historical_price)) / float(historical_price) * 100
                        if historical_price else 0.0
                    )
                    demand_factor = max(
                        0.0, 1 + (DEFAULT_ELASTICITY * price_delta_pct / 100)
                    )
                    sim_units = units * demand_factor

                    simulated["revenue"] += sim_price * sim_units
                    simulated["orders"] += sim_units
                    simulated["price_sum"] += sim_price
                    simulated["n"] += 1
                    if cost is not None:
                        simulated["margin"] += (sim_price - float(cost)) * sim_units

                    previous_sim_price = sim_price

                    if len(correctness_samples) < CORRECTNESS_SAMPLE:
                        correctness_samples.append({
                            "snapshot": pricing.snapshot_for_replay(ctx, strategy),
                            "price": sim_price,
                        })

                if idx % 25 == 0:
                    _progress(tenant_id, project_id, job_id,
                              progress_pct=round(idx / len(item_ids) * 100),
                              items_processed=idx)

            # Self-check: re-run the sample and confirm identical results.
            reproduced = 0
            for sample in correctness_samples:
                again = pricing.replay(sample["snapshot"])
                if abs(again.final_price - sample["price"]) < 0.01:
                    reproduced += 1

            def finish(d: dict) -> dict:
                return {
                    "revenue": round(d["revenue"], 2),
                    "margin": round(d["margin"], 2),
                    "orders": round(d["orders"], 1),
                    "avg_price": round(d["price_sum"] / d["n"], 2) if d["n"] else 0.0,
                }

            _progress(
                tenant_id, project_id, job_id,
                status="completed",
                progress_pct=100,
                items_processed=len(item_ids),
                decisions_replayed=replayed,
                price_changes=changes,
                guardrail_blocks=guardrail_blocks,
                rules_triggered=dict(rules_triggered),
                actual=finish(actual),
                simulated=finish(simulated),
                correctness={
                    "checked": len(correctness_samples),
                    "reproduced": reproduced,
                    "deterministic": reproduced == len(correctness_samples),
                    "note": "Each sampled decision was re-run on its stored snapshot "
                            "and compared to the cent.",
                },
                assumptions={
                    "price_elasticity": DEFAULT_ELASTICITY,
                    "note": "Simulated revenue is MODELLED. Historical demand is known; "
                            "how customers would have responded to a different price is "
                            "not. Units are adjusted by the elasticity above. Treat the "
                            "uplift as directional, not as a forecast.",
                },
                completed_at=db.now_ms(),
            )

            log.info(
                "backtest %s complete: %d decisions over %d items, %d/%d reproduced",
                job_id, replayed, len(item_ids), reproduced, len(correctness_samples),
            )

        except Exception as exc:  # noqa: BLE001
            log.exception("backtest failed: %s", exc)
            try:
                _progress(job["tenant_id"], job["project_id"], job["job_id"],
                          status="failed", error=str(exc)[:300],
                          completed_at=db.now_ms())
            except Exception:  # noqa: BLE001
                pass
            failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": failures}
