#!/usr/bin/env python3
"""Capture real request/response pairs from the deployed API.

Writes /tmp/devnexus-api-capture.json for the reference-doc generator.

Every example in the documentation comes from an actual call against the live
stack rather than being written by hand, so the shapes cannot drift from
reality. Error cases are provoked deliberately — a reference that only shows
the happy path is the half nobody needs when something breaks.

Runs strictly sequentially with a small delay: the account's Lambda
concurrency limit is low, and hammering it would produce 503s that are an
artefact of the capture rather than real behaviour.
"""

from __future__ import annotations

import json
import os
import random
import string
import subprocess
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testlib import call  # noqa: E402

OUT = "/tmp/devnexus-api-capture.json"
PACE = 0.35          # seconds between calls, to stay under the concurrency cap
MAX_BODY = 2600      # truncate very long bodies in the doc

captures: list[dict] = []
ctx: dict = {}


def rid(n=5):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def grab(label: str, path: str, params: dict, *, note: str = "",
         group: str = "", expect: str = "") -> dict:
    """Make the call, record request and response verbatim."""
    time.sleep(PACE)
    r = call(API, path, **params)
    qs = urllib.parse.urlencode(
        {k: (json.dumps(v, separators=(",", ":")) if isinstance(v, (dict, list)) else v)
         for k, v in params.items() if v is not None},
        quote_via=urllib.parse.quote)
    body = r.raw
    truncated = False
    if len(body) > MAX_BODY:
        body = body[:MAX_BODY]
        truncated = True
    try:
        pretty = json.dumps(json.loads(r.raw), indent=2)
        if len(pretty) > MAX_BODY:
            pretty = pretty[:MAX_BODY]
            truncated = True
    except Exception:
        pretty = body
    rec = {
        "label": label, "group": group, "path": path,
        "query": qs, "url": f"{path}?{qs}" if qs else path,
        "status": r.status, "ms": round(r.ms, 1),
        "body": pretty, "truncated": truncated,
        "note": note, "expect": expect,
    }
    captures.append(rec)
    mark = "ok " if r.status == 200 else f"{r.status}"
    print(f"  [{mark}] {label}", flush=True)
    # Return the response object: rec["body"] is a TRUNCATED display copy and
    # must never be parsed by callers.
    return r


# ════════════════════════════════════════════════════════════════════════

API = subprocess.run(
    ["aws", "cloudformation", "describe-stacks", "--stack-name", "devnexus-dev",
     "--region", "ap-south-1", "--query",
     "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue", "--output", "text"],
    capture_output=True, text=True).stdout.strip()
WS = subprocess.run(
    ["aws", "cloudformation", "describe-stacks", "--stack-name", "devnexus-dev",
     "--region", "ap-south-1", "--query",
     "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue", "--output", "text"],
    capture_output=True, text=True).stdout.strip()
print(f"api {API}\nws  {WS}\n")

# ── 0. system ───────────────────────────────────────────────────────────
print("system")
grab("Service root", "/", {}, group="system",
     note="No auth. Confirms the service is up and states the GET-only convention.")
grab("Health check", "/health", {}, group="system",
     note="Deliberately shallow — no database round trip. Wired to the API "
          "Gateway health check, which must not fail because DynamoDB is slow.")
grab("Dropdown catalog", "/meta/catalog", {}, group="system",
     note="Public. Every dropdown option in the product from one source, so the "
          "UI and the engine cannot disagree on legal operators or types.")

# ── 1. auth ─────────────────────────────────────────────────────────────
print("\nauth")
email = f"doc-{int(time.time())}-{rid(4)}@devnexus.example"
grab("Signup — step 1 (partial registration)", "/auth/signup",
     {"email": email, "password": "docspassword1", "name": "Doc Example"},
     group="auth",
     note="Creates the login identity ONLY. tenant_id is null: this account can "
          "do nothing but step 2 until a company exists.")
r = call(API, "/auth/login", email=email, password="docspassword1")
TOKEN = r.get("token")
ctx["token"] = TOKEN

grab("Signup — duplicate email", "/auth/signup",
     {"email": email, "password": "docspassword1"}, group="auth",
     expect="409", note="Conditional write, so there is no read-then-write race.")
grab("Signup — password too short", "/auth/signup",
     {"email": f"short-{rid()}@devnexus.example", "password": "abc"},
     group="auth", expect="400")
grab("Signup — malformed email", "/auth/signup",
     {"email": "not-an-email", "password": "docspassword1"},
     group="auth", expect="400")
grab("Login", "/auth/login", {"email": email, "password": "docspassword1"},
     group="auth",
     note="next_step routes the client: 'complete-profile' or 'dashboard'.")
grab("Login — wrong password", "/auth/login",
     {"email": email, "password": "wrongpassword"}, group="auth", expect="401",
     note="IDENTICAL error for an unknown email, so this cannot be used to "
          "enumerate which addresses are registered.")
grab("Login — unknown email", "/auth/login",
     {"email": f"nobody-{rid()}@devnexus.example", "password": "whatever123"},
     group="auth", expect="401")
grab("Any endpoint before completing registration", "/projects/list",
     {"token": TOKEN}, group="auth", expect="403",
     note="Every endpoint except complete-profile requires a tenant.")
grab("Complete profile — step 2 (the company)", "/auth/complete-profile",
     {"token": TOKEN, "company_name": "Doc Example Ltd",
      "service_type": "hospitality", "currency": "INR", "country": "IN",
      "company_size": "11-50"}, group="auth",
     note="Creates the TENANT — the isolation boundary for everything after. "
          "Attached to both the user row and the live session, so no re-login.")
# A second throwaway account, so the negative profile cases are tested while
# the account genuinely still has no tenant.
_e2 = f"doc-neg-{int(time.time())}-{rid(4)}@devnexus.example"
_t2 = call(API, "/auth/signup", email=_e2, password="docspassword1").get("token")
grab("Complete profile — invalid service_type", "/auth/complete-profile",
     {"token": _t2, "company_name": "X", "service_type": "not_a_real_industry"},
     group="auth", expect="400",
     note="The response lists every valid value.")
grab("Complete profile — unsupported currency", "/auth/complete-profile",
     {"token": _t2, "company_name": "X", "service_type": "ecommerce",
      "currency": "XYZ"}, group="auth", expect="400")
grab("Complete profile — blank company name", "/auth/complete-profile",
     {"token": _t2, "company_name": "   ", "service_type": "ecommerce"},
     group="auth", expect="400")
grab("Complete profile — already done", "/auth/complete-profile",
     {"token": TOKEN, "company_name": "Again", "service_type": "ecommerce"},
     group="auth", expect="409")
grab("Bootstrap the app", "/auth/me", {"token": TOKEN}, group="auth",
     note="ONE call on app load: user, tenant, projects and the full catalog. "
          "Deliberately not four round trips.")
grab("Invalid session token", "/auth/me", {"token": "sess_not_a_real_token"},
     group="auth", expect="401")
grab("Missing required parameter", "/auth/login", {"email": email},
     group="auth", expect="422",
     note="FastAPI validation, flattened into the same error envelope.")

# ── 2. projects & schema ────────────────────────────────────────────────
print("\nprojects")
r = grab("Create project (from a catalog template)", "/projects/create",
         {"token": TOKEN, "name": "Doc Hotel", "domain_name": "Hospitality",
          "entity_label": "Room", "currency": "INR", "template_id": "hospitality"},
         group="projects",
         note="Mints the API key and returns paste-ready endpoint URLs. "
              "template_id only PREFILLS the schema; /domain/save edits it freely.")
PID = r.get("project_id")
KEY = r.get("api_key")
ctx["project_id"], ctx["api_key"] = PID, KEY

r2 = grab("Create project (NO template — fully custom domain)", "/projects/create",
          {"token": TOKEN, "name": "Doc Parking", "domain_name": "Parking",
           "entity_label": "Bay", "currency": "INR"},
          group="projects",
          note="This is the domain-agnostic claim: a brand-new industry needs "
               "no template and no code change.")
PID2 = r2.get("project_id")
KEY2 = r2.get("api_key")
ctx["project_id2"], ctx["api_key2"] = PID2, KEY2

grab("Create project — missing name", "/projects/create",
     {"token": TOKEN, "domain_name": "X"}, group="projects", expect="422")
grab("List projects", "/projects/list", {"token": TOKEN}, group="projects")
grab("Get one project", "/projects/get", {"token": TOKEN, "project_id": PID},
     group="projects", note="Includes the schema, guardrails, API key and endpoints.")
grab("Get project — unknown id", "/projects/get",
     {"token": TOKEN, "project_id": "prj_does_not_exist"},
     group="projects", expect="404",
     note="A project belonging to ANOTHER tenant returns the same 404: the row "
          "is unaddressable, so there is no ownership check to forget.")

custom_schema = {
    "domain_name": "Parking", "entity_label": "Bay",
    "attributes": [{"id": "zone", "label": "Zone", "type": "string"},
                   {"id": "bay_type", "label": "Bay type", "type": "string"}],
    "context_signals": [
        {"id": "bay_occupancy", "label": "Bay occupancy", "type": "number",
         "min": 0, "max": 100, "description": "Bays in use, %"},
        {"id": "dwell_minutes", "label": "Average dwell", "type": "number",
         "min": 0, "max": 1440},
        {"id": "nearby_events", "label": "Nearby events", "type": "number",
         "min": 0, "max": 50},
    ],
}
grab("Save a fully custom domain schema", "/domain/save",
     {"token": TOKEN, "project_id": PID2, "schema": custom_schema},
     group="projects",
     note="THE endpoint that makes the platform domain-agnostic. Nothing in "
          "core/engine/ knows what 'bay_occupancy' means — it reads ids from "
          "here and evaluates them numerically.")
grab("Save schema — reserved signal id", "/domain/save",
     {"token": TOKEN, "project_id": PID2,
      "schema": {"context_signals": [{"id": "base_price", "label": "Nope"}]}},
     group="projects", expect="400",
     note="base_price, price, item_id and cost belong to the engine.")
grab("Save schema — duplicate id", "/domain/save",
     {"token": TOKEN, "project_id": PID2,
      "schema": {"context_signals": [{"id": "dup"}, {"id": "dup"}]}},
     group="projects", expect="400")
grab("Save schema — not valid JSON", "/domain/save",
     {"token": TOKEN, "project_id": PID2, "schema": "{broken"},
     group="projects", expect="400")
grab("Set guardrails", "/guardrails/save",
     {"token": TOKEN, "project_id": PID, "min_price": 4000, "max_price": 9000,
      "max_increase_pct": 15, "max_decrease_pct": 15, "min_margin_pct": 10},
     group="projects",
     note="Returns a plain-English explanation from a deterministic template "
          "renderer, never a model.")
grab("Guardrails — min above max", "/guardrails/save",
     {"token": TOKEN, "project_id": PID, "min_price": 9000, "max_price": 1000},
     group="projects", expect="400")
grab("Guardrails — percentage out of range", "/guardrails/save",
     {"token": TOKEN, "project_id": PID, "max_increase_pct": 500},
     group="projects", expect="400")

# ── 3. items ────────────────────────────────────────────────────────────
print("\nitems")
grab("Create a pricing item", "/items/create",
     {"token": TOKEN, "project_id": PID, "item_id": "DOC-R101",
      "name": "Doc Deluxe Room", "base_price": 6000, "cost": 2400,
      "attributes": {"room_type": "deluxe", "location": "Mumbai"}},
     group="items",
     note="Also seeds the hot-path context row, so the item is priceable "
          "immediately at base rather than 404ing until the first event.")
grab("Create item — cost above base price", "/items/create",
     {"token": TOKEN, "project_id": PID, "item_id": "DOC-BAD",
      "name": "Bad economics", "base_price": 100, "cost": 500},
     group="items", expect="400")
grab("Create item — attribute not in schema", "/items/create",
     {"token": TOKEN, "project_id": PID, "item_id": "DOC-WARN",
      "name": "Unknown attribute", "base_price": 1000,
      "attributes": {"not_in_schema": "x"}},
     group="items",
     note="Stored with a WARNING rather than rejected: an analyst importing a "
          "catalogue should not have a load fail over one extra column.")
grab("List items", "/items/list",
     {"token": TOKEN, "project_id": PID, "limit": 5}, group="items")
grab("Search items", "/items/list",
     {"token": TOKEN, "project_id": PID, "search": "Deluxe", "limit": 5},
     group="items")
grab("Get item with live context", "/items/get",
     {"token": TOKEN, "project_id": PID, "item_id": "DOC-R101"},
     group="items",
     note="Item + current signals + per-signal age + last decision in one call. "
          "Used by the web drill-down AND the Android app.")
grab("Get item — unknown id", "/items/get",
     {"token": TOKEN, "project_id": PID, "item_id": "NOPE"},
     group="items", expect="404")

json.dump({"api": API, "ws": WS, "ctx": ctx, "captures": captures},
          open(OUT, "w"), indent=1)
print(f"\n{len(captures)} captures -> {OUT}")
