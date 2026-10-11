#!/usr/bin/env python3
"""Advanced pricing mechanisms, against a DEPLOYED stack.

    python3 scripts/test-advanced.py [--stage dev] [--region ap-south-1]
    python3 scripts/test-advanced.py --api https://xxxx.execute-api.../

The three pricing patterns a rule-of-fixed-adjustments cannot express on its
own, each now closed WITHOUT touching the deterministic core:

  * continuous formula pricing  — price as a safe arithmetic function of signals
                                  (percent, flat amount, or an exact price),
                                  with unsafe expressions refused at creation
  * basket / cart pricing       — the whole cart in one call, so rules can test
                                  cart value, line quantity and bundle size
  * calendar-window rules       — a rule that turns itself on and off between
                                  two dates, judged against the decision's clock
                                  so a replay still sees the window as it was

Everything is a GET; stdlib only; no PASS without an observation behind it.
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
         "--output", "text"], capture_output=True, text=True)
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
    print(f"{mark} {label:54} {detail}")
    if ok:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append(label)
    return ok


def section(t):
    print(f"\033[36m{t}\033[0m")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="dev")
    ap.add_argument("--region", default="ap-south-1")
    ap.add_argument("--api", default="")
    args = ap.parse_args()
    c = Client(resolve_api(args))
    call = c.call
    print("\033[36m── DevNexus advanced-mechanism tests ───────────\033[0m")
    print(f"    api: {c.base}\n")

    stamp = int(time.time())
    _, b = call("/auth/signup", auth=False,
                email=f"advanced-{stamp}@devnexus.test", password="advancedtest1234")
    c.token = b.get("token")
    call("/auth/complete-profile", company_name="Advanced",
         service_type="other", currency="INR", country="IN")

    def project(name, signals, items, rules, entity="Item"):
        _, b = call("/projects/create", name=name, domain_name=name,
                    entity_label=entity, currency="INR")
        pid, key = b["project_id"], b["api_key"]
        call("/domain/save", project_id=pid, schema=json.dumps({
            "domain_name": name, "entity_label": entity, "attributes": [],
            "context_signals": signals}))
        for it in items:
            call("/items/create", project_id=pid, item_id=it["id"], name=it["name"],
                 base_price=it["base_price"], cost=it.get("cost"),
                 signals=json.dumps(it.get("signals", {})), overwrite=True)
        rids = []
        for r in rules:
            s, b = call("/rules/create", project_id=pid, name=r["name"],
                        conditions=json.dumps(r["conditions"]),
                        adjustment=json.dumps(r["adjustment"]),
                        priority=r.get("priority", 50),
                        starts_at=r.get("starts_at"), ends_at=r.get("ends_at"))
            assert s == 200, b
            rids.append(b["rule_id"])
        _, b = call("/strategies/create", project_id=pid, name="v1", rule_ids=",".join(rids))
        sid = b["strategy_id"]
        call("/strategies/validate", project_id=pid, strategy_id=sid)
        call("/strategies/promote", project_id=pid, strategy_id=sid, mode="active")
        return pid, key

    def price(key, item, **req):
        time.sleep(1.1)
        _, b = call(f"/v1/p/{key}/price", auth=False, item_id=item, **req)
        return (b.get("price") or {})

    # ── 1. continuous formula pricing ───────────────────────────────────
    section("1. Continuous formula pricing")
    _, key = project("Formula",
        [{"id": "demand", "label": "Demand", "type": "number", "scope": "item"}],
        [{"id": "X", "name": "Item", "base_price": 100, "signals": {"demand": 73}}],
        [{"name": "Demand curve",
          "conditions": [{"field": "demand", "operator": ">=", "value": 0}],
          "adjustment": {"type": "formula", "expr": "demand*0.5", "formula_mode": "percent"}}])
    check(price(key, "X").get("price") == 136.5,
          "formula %: +0.5% per demand point (demand 73) → ₹136.50")

    _, key = project("CostPlus",
        [{"id": "x", "label": "X", "type": "number", "scope": "item"}],
        [{"id": "Y", "name": "Item", "base_price": 999, "cost": 50}],
        [{"name": "Cost plus 40%",
          "conditions": [{"field": "base_price", "operator": ">", "value": 0}],
          "adjustment": {"type": "formula", "expr": "cost*1.4", "formula_mode": "price"}}])
    check(price(key, "Y").get("price") == 70.0, "formula price: cost×1.4 → ₹70")

    _, b = call("/projects/create", name="Evil", domain_name="Evil",
                entity_label="Item", currency="INR")
    epid = b["project_id"]
    call("/domain/save", project_id=epid, schema=json.dumps({
        "domain_name": "Evil", "entity_label": "Item", "attributes": [],
        "context_signals": [{"id": "d", "label": "D", "type": "number", "scope": "item"}]}))
    s, b = call("/rules/create", project_id=epid, name="Hack",
                conditions=json.dumps([{"field": "d", "operator": ">=", "value": 0}]),
                adjustment=json.dumps({"type": "formula",
                                       "expr": "__import__('os').system('x')",
                                       "formula_mode": "percent"}))
    check(s == 400 and "formula" in json.dumps(b).lower(),
          "unsafe formula refused at creation")

    # ── 2. basket / cart pricing ────────────────────────────────────────
    section("2. Basket / cart pricing")
    _, key = project("Cart",
        [{"id": "category", "label": "Category", "type": "string", "scope": "item"}],
        [{"id": "A", "name": "A", "base_price": 1000},
         {"id": "B", "name": "B", "base_price": 500},
         {"id": "C", "name": "C", "base_price": 300}],
        [{"name": "Spend 2000+ save 10%",
          "conditions": [{"field": "cart_subtotal", "operator": ">=", "value": 2000}],
          "adjustment": {"type": "percentage", "value": 10, "direction": "decrease"}},
         {"name": "Buy 3+ save 15%",
          "conditions": [{"field": "line_quantity", "operator": ">=", "value": 3}],
          "adjustment": {"type": "percentage", "value": 15, "direction": "decrease"}}])
    time.sleep(1.2)
    cart = json.dumps([{"item_id": "A", "quantity": 1},
                       {"item_id": "B", "quantity": 1},
                       {"item_id": "C", "quantity": 4}])
    _, b = call(f"/v1/p/{key}/price/cart", auth=False, cart=cart)
    lines = {ln["item_id"]: ln for ln in b.get("lines", [])}
    check(b.get("cart", {}).get("cart_subtotal") == 2700.0,
          "cart subtotal computed from base×qty (₹2700)")
    check(lines.get("A", {}).get("price") == 900.0, "line A: cart-value -10% (₹900)")
    check(lines.get("C", {}).get("price") == 225.0,
          "line C: cart -10% + bulk -15% = -25% (₹225/unit)")
    check(lines.get("C", {}).get("line_total") == 900.0, "line C total: 225×4 (₹900)")
    check(b.get("cart", {}).get("cart_total") == 2250.0, "cart total (₹2250)")

    # ── 3. calendar-window effective dates ──────────────────────────────
    section("3. Calendar-window effective dates")
    now = int(time.time() * 1000)
    _, key = project("Calendar",
        [{"id": "demand", "label": "Demand", "type": "number", "scope": "item"}],
        [{"id": "P", "name": "Item", "base_price": 100, "signals": {"demand": 50}}],
        [{"name": "Future sale",
          "conditions": [{"field": "demand", "operator": ">=", "value": 0}],
          "adjustment": {"type": "percentage", "value": 30, "direction": "decrease"},
          "starts_at": now + 86400000, "ends_at": now + 2 * 86400000},
         {"name": "Live sale",
          "conditions": [{"field": "demand", "operator": ">=", "value": 0}],
          "adjustment": {"type": "percentage", "value": 5, "direction": "decrease"},
          "starts_at": now - 3600000, "ends_at": now + 3600000}])
    q = price(key, "P")
    check(q.get("price") == 95.0, "future rule dormant, live rule active (₹95)")
    drivers = [d["factor"] for d in q.get("drivers", [])]
    check("Live sale" in drivers and "Future sale" not in drivers,
          "only the in-window rule appears in the breakdown")
    _, zb = call("/projects/create", name="Z", domain_name="Z",
                 entity_label="Item", currency="INR")
    zpid = zb["project_id"]
    call("/domain/save", project_id=zpid, schema=json.dumps({
        "domain_name": "Z", "entity_label": "Item", "attributes": [],
        "context_signals": [{"id": "d", "label": "D", "type": "number", "scope": "item"}]}))
    s, _ = call("/rules/create", project_id=zpid, name="Bad",
                conditions=json.dumps([{"field": "d", "operator": ">=", "value": 0}]),
                adjustment=json.dumps({"type": "percentage", "value": 5}),
                starts_at=now + 1000, ends_at=now)
    check(s == 400, "ends_at before starts_at refused")

    print()
    total = PASS + FAIL
    if FAIL == 0:
        print(f"\033[32mpassed  {PASS}/{total}  — formulas, baskets and calendar rules, core unchanged\033[0m")
        return 0
    print(f"\033[31mfailed  {FAIL}/{total}\033[0m  →  {', '.join(FAILURES)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
