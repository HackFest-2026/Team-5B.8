#!/usr/bin/env python3
"""Scope-based pricing test suite, against a DEPLOYED DevNexus stack.

    python3 scripts/test-scopes.py [--stage dev] [--region ap-south-1]
    python3 scripts/test-scopes.py --api https://xxxx.execute-api.../

Covers the three pricing scopes end to end — the behaviour the deterministic
engine must guarantee once a field can live on the item, across the project, or
only on the request:

  * manual schema fields in all three scopes persist with their scope
  * item-scope values travel with the product; global/request are refused there
  * a global signal is written ONCE and seen by every item
  * a request value is passed on the price call and never stored
  * rules combining scopes stack correctly on one decision
  * a MISSING value is reported, never silently read as zero
  * an INVALID request value is dropped, never coerced to zero
  * deleting a field a rule uses blocks strategy validation and names it
  * a scope-less schema still defaults every field to `item` (back-compat)

Every call is a GET, so the whole thing runs with nothing but the standard
library. Nothing is marked PASS without an observation behind it.
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
        capture_output=True, text=True,
    )
    api = (out.stdout or "").strip()
    if not api or api == "None":
        sys.exit(f"could not read ApiBaseUrl from devnexus-{args.stage}")
    return api.rstrip("/")


class Client:
    def __init__(self, base: str):
        self.base = base
        self.token: str | None = None

    def call(self, path: str, auth: bool = True, **params):
        q = {k: v for k, v in params.items() if v is not None}
        if auth and self.token:
            q["token"] = self.token
        url = f"{self.base}{path}"
        if q:
            url += "?" + urllib.parse.urlencode(q)
        try:
            with urllib.request.urlopen(urllib.request.Request(url), timeout=25) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")


def check(ok: bool, label: str, detail: str = "") -> bool:
    global PASS, FAIL
    mark = "\033[32m  PASS\033[0m" if ok else "\033[31m  FAIL\033[0m"
    print(f"{mark} {label:54} {detail}")
    if ok:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append(label)
    return ok


def section(title: str):
    print(f"\033[36m{title}\033[0m")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="dev")
    ap.add_argument("--region", default="ap-south-1")
    ap.add_argument("--api", default="")
    args = ap.parse_args()

    api = resolve_api(args)
    c = Client(api)
    call = c.call
    print(f"\033[36m── DevNexus scope tests ────────────────────────\033[0m")
    print(f"    api: {api}\n")

    # ── account + project ───────────────────────────────────────────────
    stamp = int(time.time())
    _, b = call("/auth/signup", auth=False,
                email=f"scopes-{stamp}@devnexus.test", password="scopetest1234")
    c.token = b.get("token")
    call("/auth/complete-profile", company_name="Scope Tests",
         service_type="ecommerce", currency="INR", country="IN")
    _, b = call("/projects/create", name="Scopes", domain_name="E-commerce",
                entity_label="Product", currency="INR")
    pid, key = b["project_id"], b["api_key"]

    # ── 1. schema with all three scopes ─────────────────────────────────
    section("1. manual schema across three scopes")
    schema = {
        "domain_name": "E-commerce", "entity_label": "Product", "attributes": [],
        "context_signals": [
            {"id": "inventory", "label": "Inventory", "type": "number",
             "scope": "item", "min": 0, "max": 1000},
            {"id": "website_traffic", "label": "Website traffic", "type": "number",
             "scope": "global", "min": 0, "max": 1000000},
            {"id": "customer_tier", "label": "Customer tier", "type": "string",
             "scope": "request"},
        ],
    }
    s, b = call("/domain/save", project_id=pid, schema=json.dumps(schema))
    check(s == 200, "schema with item/global/request saved", str(s))
    _, b = call("/projects/get", project_id=pid)
    scopes = {sg["id"]: sg.get("scope") for sg in b["schema"]["context_signals"]}
    check(scopes == {"inventory": "item", "website_traffic": "global",
                     "customer_tier": "request"},
          "each field persists with its scope", str(scopes))

    # ── 2. item-scope values on the product; others refused ─────────────
    section("2. item-scope values live on the product")
    s, b = call("/items/create", project_id=pid, item_id="P1", name="Widget",
                base_price=200, cost=80, signals=json.dumps({"inventory": 15}))
    check(s == 200, "product created with an item-scope value", str(s))
    s, b = call("/items/create", project_id=pid, item_id="P2", name="Gadget",
                base_price=300, signals=json.dumps({"website_traffic": 5000}))
    check(s != 200 and "global" in json.dumps(b),
          "a global value is refused on a product",
          b.get("error", {}).get("message", "")[:48])
    call("/items/create", project_id=pid, item_id="P2", name="Gadget",
         base_price=300, cost=100)

    # ── 3. rules across scopes ──────────────────────────────────────────
    section("3. rules spanning scopes")

    def mkrule(name, conds, pct, prio=50):
        s, b = call("/rules/create", project_id=pid, name=name,
                    conditions=json.dumps(conds),
                    adjustment=json.dumps({"type": "percentage", "value": pct,
                                           "direction": "increase"}),
                    priority=prio)
        assert s == 200, b
        return b["rule_id"]

    r_item = mkrule("Low stock", [{"field": "inventory", "operator": "<", "value": 20}], 10)
    r_global = mkrule("High traffic", [{"field": "website_traffic", "operator": ">", "value": 100000}], 5)
    r_req = mkrule("VIP", [{"field": "customer_tier", "operator": "==", "value": "gold"}], 8)
    r_combo = mkrule("Stock+traffic", [
        {"field": "inventory", "operator": "<", "value": 20},
        {"field": "website_traffic", "operator": ">", "value": 100000}], 12, prio=90)
    check(True, "rules on item, global, request and a combination built")

    _, b = call("/strategies/create", project_id=pid, name="Launch",
                rule_ids=",".join([r_item, r_global, r_req, r_combo]))
    sid = b["strategy_id"]
    v = call("/strategies/validate", project_id=pid, strategy_id=sid)[1]
    check(v.get("passed") is True, "strategy with multi-scope rules validates", str(v.get("passed")))
    call("/strategies/promote", project_id=pid, strategy_id=sid, mode="active")

    P = f"/v1/p/{key}/price"

    # ── 4. item scope + missing global ──────────────────────────────────
    section("4. item fires; missing global is reported, not zeroed")
    s, b = call(P, auth=False, item_id="P1")
    q = b.get("price") or {}
    check(q.get("price") == 220.0, "item signal fires (+10%)", f"price={q.get('price')}")
    miss = [m["field"] for m in (q.get("context") or {}).get("missing_signals", [])]
    check("website_traffic" in miss, "missing global reported, never read as zero", str(miss))

    # ── 5. global set once, seen by every item ──────────────────────────
    section("5. one global write reaches every item")
    s, b = call(f"/v1/g/{key}/context", auth=False, signal_website_traffic=150000)
    check(s == 200 and b.get("updated") == ["website_traffic"],
          "global context set with one call", str(b.get("updated")))
    time.sleep(1)
    s, b = call(P, auth=False, item_id="P1")
    q = b.get("price") or {}
    # combo +12, low stock +10, high traffic +5 → 200 * 1.27 = 254
    check(q.get("price") == 254.0, "item + global stack on one decision (+27%)",
          f"price={q.get('price')}")
    s, b = call(P, auth=False, item_id="P2")
    q = b.get("price") or {}
    check(q.get("price") == 315.0, "same global applies to a different item (+5%)",
          f"price={q.get('price')}")

    # ── 6. request scope pass-through ───────────────────────────────────
    section("6. request value passes through, never stored")
    s, b = call(P, auth=False, item_id="P2", customer_tier="gold")
    q = b.get("price") or {}
    check(q.get("price") == 339.0, "request signal applies (global +5, gold +8)",
          f"price={q.get('price')}")
    s, b = call(P, auth=False, item_id="P2", customer_tier="silver")
    q = b.get("price") or {}
    check(q.get("price") == 315.0, "a different request value is respected (not gold)",
          f"price={q.get('price')}")
    s, b = call(P, auth=False, item_id="P2", customer_tier="abc123")
    # strings pass as-is; still only global fires
    check((b.get("price") or {}).get("price") == 315.0,
          "unmatched request value leaves only the global rule", "")

    # ── 7. invalid + missing handling ───────────────────────────────────
    section("7. invalid values are dropped, not coerced")
    # Add a numeric request field and a rule on it.
    schema["context_signals"].append(
        {"id": "quantity", "label": "Quantity", "type": "number", "scope": "request"})
    call("/domain/save", project_id=pid, schema=json.dumps(schema))
    r_qty = mkrule("Bulk order", [{"field": "quantity", "operator": ">=", "value": 5}], 4)
    _, b = call("/strategies/create", project_id=pid, name="Launch2",
                rule_ids=",".join([r_item, r_global, r_req, r_combo, r_qty]))
    sid2 = b["strategy_id"]
    call("/strategies/validate", project_id=pid, strategy_id=sid2)
    call("/strategies/promote", project_id=pid, strategy_id=sid2, mode="active")
    s, b = call(P, auth=False, item_id="P2", quantity="abc")
    q = b.get("price") or {}
    check(q.get("price") == 315.0, "invalid request number dropped, not zeroed (+5 only)",
          f"price={q.get('price')}")
    s, b = call(P, auth=False, item_id="P2", quantity="5")
    q = b.get("price") or {}
    check(q.get("price") == 327.0, "valid request number applies (global +5, bulk +4)",
          f"price={q.get('price')}")

    # ── 8. rule dependency after a schema change ────────────────────────
    section("8. deleting a used field blocks validation")
    reduced = {
        "domain_name": "E-commerce", "entity_label": "Product", "attributes": [],
        "context_signals": [
            {"id": "inventory", "label": "Inventory", "type": "number", "scope": "item"},
            {"id": "website_traffic", "label": "Traffic", "type": "number", "scope": "global"},
        ],
    }  # removes customer_tier + quantity, both used by rules
    call("/domain/save", project_id=pid, schema=json.dumps(reduced))
    v = call("/strategies/validate", project_id=pid, strategy_id=sid2)[1]
    check(v.get("passed") is False, "strategy with a deleted-field rule fails validation",
          str(v.get("passed")))
    errs = json.dumps(v.get("errors", []))
    check(("customer_tier" in errs or "quantity" in errs),
          "validation names the broken field", errs[:60])

    # ── 9. backward compatibility ───────────────────────────────────────
    section("9. a scope-less schema defaults to item")
    _, b = call("/projects/create", name="Legacy", domain_name="E-commerce",
                entity_label="Product", currency="INR")
    pid2 = b["project_id"]
    legacy = {
        "domain_name": "E-commerce", "entity_label": "Product", "attributes": [],
        "context_signals": [{"id": "demand", "label": "Demand", "type": "number",
                             "min": 0, "max": 100}],  # NO scope key
    }
    call("/domain/save", project_id=pid2, schema=json.dumps(legacy))
    _, b = call("/projects/get", project_id=pid2)
    check(b["schema"]["context_signals"][0].get("scope") == "item",
          "field with no scope defaults to item",
          b["schema"]["context_signals"][0].get("scope"))

    # ── summary ─────────────────────────────────────────────────────────
    print()
    total = PASS + FAIL
    if FAIL == 0:
        print(f"\033[32mpassed  {PASS}/{total}\033[0m")
        return 0
    print(f"\033[31mfailed  {FAIL}/{total}\033[0m  →  {', '.join(FAILURES)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
