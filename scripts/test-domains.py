#!/usr/bin/env python3
"""Domain-agnostic proof: the five industries from the problem statement,
each built through CONFIGURATION ONLY, against a DEPLOYED stack.

    python3 scripts/test-domains.py --api https://xxxx.execute-api.../

The 5B brief names five industries the one engine must price without hardcoding
domain logic: hotel occupancy/seasonality, airline fare classes, banking
risk-based rates, e-commerce inventory/demand, and ride-hailing surge. This
builds a real project for each — its own three-scope schema, its own rules —
and verifies the deterministic price. Nothing in core/engine changes between
domains; only the schema and rules differ, which is the KPI ("new domain added
live with no engine rewrite").

Each case also proves the scopes carry their natural meaning per industry:
  item    = the thing priced (this room / fare class / product / ride type)
  global  = conditions shared across the project (route demand, site traffic,
            area surge, the central-bank rate)
  request = facts about this one booking/call (loyalty tier, days-to-departure,
            credit score, rider tier)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PASS = 0
FAIL = 0
FAILURES: list[str] = []


def resolve_api(args) -> str:
    if args.api:
        return args.api.rstrip("/")
    out = subprocess.run(
        ["aws", "cloudformation", "describe-stacks",
         "--stack-name", f"devnexus-{args.stage}", "--region", args.region,
         "--query", "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue",
         "--output", "text"],
        capture_output=True, text=True)
    api = (out.stdout or "").strip()
    if not api or api == "None":
        sys.exit(f"could not read ApiBaseUrl from devnexus-{args.stage}")
    return api.rstrip("/")


class Client:
    def __init__(self, base):
        self.base = base
        self.token = None

    def call(self, path, auth=True, **params):
        q = {k: v for k, v in params.items() if v is not None}
        if auth and self.token:
            q["token"] = self.token
        url = f"{self.base}{path}" + (("?" + urllib.parse.urlencode(q)) if q else "")
        try:
            with urllib.request.urlopen(urllib.request.Request(url), timeout=25) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")


def check(ok, label, detail=""):
    global PASS, FAIL
    mark = "\033[32m  PASS\033[0m" if ok else "\033[31m  FAIL\033[0m"
    print(f"{mark} {label:52} {detail}")
    if ok:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append(label)
    return ok


def section(t):
    print(f"\033[36m{t}\033[0m")


def build_domain(c, *, name, entity, signals, items, rules, guardrails=None):
    """Create a fully-configured project for one industry. Returns its key."""
    _, b = c.call("/projects/create", name=name, domain_name=name,
                  entity_label=entity, currency="INR")
    pid, key = b["project_id"], b["api_key"]

    c.call("/domain/save", project_id=pid, schema=json.dumps({
        "domain_name": name, "entity_label": entity, "attributes": [],
        "context_signals": signals,
    }))

    for it in items:
        c.call("/items/create", project_id=pid, item_id=it["id"], name=it["name"],
               base_price=it["base_price"], cost=it.get("cost"),
               signals=json.dumps(it.get("signals", {})), overwrite=True)

    rule_ids = []
    for r in rules:
        s, b = c.call("/rules/create", project_id=pid, name=r["name"],
                      conditions=json.dumps(r["conditions"]),
                      adjustment=json.dumps(r["adjustment"]),
                      priority=r.get("priority", 50))
        assert s == 200, b
        rule_ids.append(b["rule_id"])

    if guardrails:
        c.call("/guardrails/save", project_id=pid, **guardrails)

    _, b = c.call("/strategies/create", project_id=pid, name=f"{name} v1",
                  rule_ids=",".join(rule_ids))
    sid = b["strategy_id"]
    c.call("/strategies/validate", project_id=pid, strategy_id=sid)
    c.call("/strategies/promote", project_id=pid, strategy_id=sid, mode="active")
    return pid, key


def pct(value, direction="increase"):
    return {"type": "percentage", "value": value, "direction": direction}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="dev")
    ap.add_argument("--region", default="ap-south-1")
    ap.add_argument("--api", default="")
    args = ap.parse_args()
    c = Client(resolve_api(args))
    print("\033[36m── DevNexus domain-agnostic proof ──────────────\033[0m")
    print(f"    api: {c.base}\n")

    stamp = int(time.time())
    _, b = c.call("/auth/signup", auth=False,
                  email=f"domains-{stamp}@devnexus.test", password="domaintest1234")
    c.token = b.get("token")
    c.call("/auth/complete-profile", company_name="Universal Pricing",
           service_type="other", currency="INR", country="IN")

    def price(key, item, **req):
        time.sleep(1.2)  # batch reads are eventually consistent
        s, b = c.call(f"/v1/p/{key}/price", auth=False, item_id=item, **req)
        return (b.get("price") or {})

    # ════════════════════════════════════════════════════════════════════
    # 1. HOTEL — occupancy + seasonality
    # ════════════════════════════════════════════════════════════════════
    section("1. Hotel — occupancy and seasonality")
    _, key = build_domain(
        c, name="Hotel", entity="Room",
        signals=[
            {"id": "occupancy", "label": "Occupancy %", "type": "number", "scope": "item"},
            {"id": "city_event_demand", "label": "City event demand", "type": "number", "scope": "global"},
            {"id": "loyalty_tier", "label": "Loyalty tier", "type": "string", "scope": "request"},
        ],
        items=[{"id": "DELUXE", "name": "Deluxe room", "base_price": 5000,
                "signals": {"occupancy": 85}}],
        rules=[
            {"name": "High occupancy", "conditions": [{"field": "occupancy", "operator": ">=", "value": 80}], "adjustment": pct(15)},
            {"name": "City event", "conditions": [{"field": "city_event_demand", "operator": ">=", "value": 70}], "adjustment": pct(20)},
            {"name": "Loyalty discount", "conditions": [{"field": "loyalty_tier", "operator": "==", "value": "gold"}], "adjustment": pct(10, "decrease")},
        ],
    )
    c.call(f"/v1/g/{key}/context", auth=False, signal_city_event_demand=80)
    q = price(key, "DELUXE", loyalty_tier="gold")
    # +15 (occupancy) +20 (event) -10 (loyalty) = +25% → 6250
    check(q.get("price") == 6250.0, "room price: occupancy+event+loyalty = +25%",
          f"₹{q.get('price')} drivers={[d['factor'] for d in q.get('drivers', [])]}")

    # ════════════════════════════════════════════════════════════════════
    # 2. AIRLINE — fare classes, seats remaining
    # ════════════════════════════════════════════════════════════════════
    section("2. Airline — fare classes and scarcity")
    _, key = build_domain(
        c, name="Airline", entity="Fare",
        signals=[
            {"id": "seats_remaining", "label": "Seats remaining", "type": "number", "scope": "item"},
            {"id": "route_demand", "label": "Route demand", "type": "number", "scope": "global"},
            {"id": "days_to_departure", "label": "Days to departure", "type": "number", "scope": "request"},
        ],
        items=[{"id": "ECON-BLR-DEL", "name": "Economy BLR→DEL", "base_price": 8000,
                "signals": {"seats_remaining": 5}}],
        rules=[
            {"name": "Low seats", "conditions": [{"field": "seats_remaining", "operator": "<", "value": 10}], "adjustment": pct(25)},
            {"name": "Last minute", "conditions": [{"field": "days_to_departure", "operator": "<=", "value": 7}], "adjustment": pct(30)},
            {"name": "Hot route", "conditions": [{"field": "route_demand", "operator": ">=", "value": 80}], "adjustment": pct(10)},
        ],
    )
    c.call(f"/v1/g/{key}/context", auth=False, signal_route_demand=85)
    q = price(key, "ECON-BLR-DEL", days_to_departure="3")
    # +25 +30 +10 = +65% → 13200
    check(q.get("price") == 13200.0, "fare price: scarcity+urgency+demand = +65%",
          f"₹{q.get('price')}")

    # ════════════════════════════════════════════════════════════════════
    # 3. BANKING — risk-based rate (the "price" IS the interest rate)
    # ════════════════════════════════════════════════════════════════════
    section("3. Banking — risk-based rates")
    _, key = build_domain(
        c, name="Banking", entity="Loan",
        signals=[
            {"id": "central_bank_rate", "label": "Central bank rate", "type": "number", "scope": "global"},
            {"id": "credit_score", "label": "Credit score", "type": "number", "scope": "request"},
            {"id": "loan_amount", "label": "Loan amount", "type": "number", "scope": "request"},
        ],
        items=[{"id": "PERSONAL", "name": "Personal loan", "base_price": 10}],  # base APR 10%
        rules=[
            {"name": "Subprime risk", "conditions": [{"field": "credit_score", "operator": "<", "value": 600}], "adjustment": pct(50)},
            {"name": "Tight money", "conditions": [{"field": "central_bank_rate", "operator": ">=", "value": 7}], "adjustment": pct(20)},
            {"name": "Large loan discount", "conditions": [{"field": "loan_amount", "operator": ">=", "value": 1000000}], "adjustment": pct(5, "decrease")},
        ],
    )
    c.call(f"/v1/g/{key}/context", auth=False, signal_central_bank_rate=8)
    q = price(key, "PERSONAL", credit_score="550", loan_amount="1500000")
    # 10% APR: +50 +20 -5 = +65% → 16.5% APR
    check(q.get("price") == 16.5, "loan APR: risk+policy+size = 16.5%", f"{q.get('price')}%")

    # ════════════════════════════════════════════════════════════════════
    # 4. E-COMMERCE — inventory + demand
    # ════════════════════════════════════════════════════════════════════
    section("4. E-commerce — inventory and demand")
    _, key = build_domain(
        c, name="Ecommerce", entity="Product",
        signals=[
            {"id": "inventory", "label": "Inventory", "type": "number", "scope": "item"},
            {"id": "demand_score", "label": "Demand score", "type": "number", "scope": "item"},
            {"id": "site_traffic", "label": "Site traffic", "type": "number", "scope": "global"},
            {"id": "customer_tier", "label": "Customer tier", "type": "string", "scope": "request"},
        ],
        items=[{"id": "P1001", "name": "Wireless mouse", "base_price": 200, "cost": 80,
                "signals": {"inventory": 10, "demand_score": 90}}],
        rules=[
            {"name": "Low stock", "conditions": [{"field": "inventory", "operator": "<", "value": 20}], "adjustment": pct(10)},
            {"name": "High demand", "conditions": [{"field": "demand_score", "operator": ">", "value": 80}], "adjustment": pct(5)},
            {"name": "Peak traffic", "conditions": [{"field": "site_traffic", "operator": ">", "value": 100000}], "adjustment": pct(5)},
            {"name": "VIP discount", "conditions": [{"field": "customer_tier", "operator": "==", "value": "vip"}], "adjustment": pct(8, "decrease")},
        ],
    )
    c.call(f"/v1/g/{key}/context", auth=False, signal_site_traffic=150000)
    q = price(key, "P1001", customer_tier="vip")
    # +10 +5 +5 -8 = +12% → 224
    check(q.get("price") == 224.0, "product price: stock+demand+traffic+vip = +12%",
          f"₹{q.get('price')}")

    # ════════════════════════════════════════════════════════════════════
    # 5. RIDE-HAILING — surge, bounded by a guardrail
    # ════════════════════════════════════════════════════════════════════
    section("5. Ride-hailing — surge, capped deterministically")
    _, key = build_domain(
        c, name="RideHailing", entity="Ride",
        signals=[
            {"id": "area_demand", "label": "Area demand", "type": "number", "scope": "global"},
            {"id": "active_drivers", "label": "Active drivers", "type": "number", "scope": "global"},
            {"id": "rider_tier", "label": "Rider tier", "type": "string", "scope": "request"},
        ],
        items=[{"id": "ECONOMY", "name": "Economy ride", "base_price": 150}],
        rules=[
            {"name": "High demand surge", "conditions": [{"field": "area_demand", "operator": ">=", "value": 80}], "adjustment": pct(40)},
            {"name": "Few drivers surge", "conditions": [{"field": "active_drivers", "operator": "<", "value": 20}], "adjustment": pct(20)},
            {"name": "Premium rider", "conditions": [{"field": "rider_tier", "operator": "==", "value": "premium"}], "adjustment": pct(10)},
        ],
        guardrails={"max_increase_pct": 60},  # surge must never exceed +60%
    )
    c.call(f"/v1/g/{key}/context", auth=False, signal_area_demand=90, signal_active_drivers=15)
    q = price(key, "ECONOMY", rider_tier="premium")
    # rules want +40+20+10 = +70%, but the guardrail caps at +60% → 240
    check(q.get("price") == 240.0, "ride fare: +70% surge CAPPED to +60% = ₹240",
          f"₹{q.get('price')}")

    # ════════════════════════════════════════════════════════════════════
    # 6. A NEW domain added live, no engine change (the headline KPI)
    # ════════════════════════════════════════════════════════════════════
    section("6. A brand-new domain, added live with zero engine changes")
    _, key = build_domain(
        c, name="EVCharging", entity="Session",
        signals=[
            {"id": "connector_load", "label": "Connector load %", "type": "number", "scope": "item"},
            {"id": "grid_price", "label": "Grid price", "type": "number", "scope": "global"},
            {"id": "membership", "label": "Membership", "type": "string", "scope": "request"},
        ],
        items=[{"id": "DC-FAST", "name": "DC fast charge", "base_price": 18,
                "signals": {"connector_load": 95}}],
        rules=[
            {"name": "Busy connector", "conditions": [{"field": "connector_load", "operator": ">=", "value": 90}], "adjustment": pct(15)},
            {"name": "Expensive grid", "conditions": [{"field": "grid_price", "operator": ">=", "value": 8}], "adjustment": pct(25)},
            {"name": "Member discount", "conditions": [{"field": "membership", "operator": "==", "value": "plus"}], "adjustment": pct(20, "decrease")},
        ],
    )
    c.call(f"/v1/g/{key}/context", auth=False, signal_grid_price=9)
    q = price(key, "DC-FAST", membership="plus")
    # +15 +25 -20 = +20% → 21.6
    check(q.get("price") == 21.6, "EV session: load+grid+member = +20% → ₹21.6",
          f"₹{q.get('price')}")
    check(len(q.get("drivers", [])) >= 3, "price-driver breakdown present (explainability)",
          f"{len(q.get('drivers', []))} drivers")

    print()
    total = PASS + FAIL
    if FAIL == 0:
        print(f"\033[32mpassed  {PASS}/{total}  — one engine, six industries, configuration only\033[0m")
        return 0
    print(f"\033[31mfailed  {FAIL}/{total}\033[0m  →  {', '.join(FAILURES)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
