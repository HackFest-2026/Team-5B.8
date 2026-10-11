#!/usr/bin/env python3
"""Generate the API reference section of CURRENT.txt from captured calls.

Every example is a real request and its real response, captured from the
deployed stack by capture-api.py. Nothing here is written by hand, so the
document cannot drift from what the API actually does.
"""

from __future__ import annotations

import json
import re
import textwrap

CAP = "/tmp/devnexus-api-capture.json"
OUT = "/tmp/devnexus-api-reference.txt"

state = json.load(open(CAP))
API = state["api"]
WS = state["ws"]
caps = state["captures"]

GROUPS = [
    ("system", "SYSTEM", "No authentication. Use these to confirm the service "
                         "is up and to populate every dropdown in your UI."),
    ("auth", "ACCOUNTS & SESSIONS",
     "Two-step registration. Step 1 creates the login identity; step 2 creates "
     "the company. Between them the account can do nothing else."),
    ("projects", "PROJECTS & DOMAIN SCHEMA",
     "A project is one pricing setup with its own schema, rules, analytics and "
     "API key. One company can create as many as it likes."),
    ("items", "PRICING ITEMS",
     "The things being priced. Generic by design — a Product, Room, Ride or "
     "Charging Session depending only on the project's schema."),
    ("rules", "RULES",
     "conditions -> adjustment, plus a priority and a stacking policy. "
     "Versioned, never deleted."),
    ("strategies", "STRATEGIES & LIFECYCLE",
     "draft -> validated -> shadow -> active -> paused, with instant rollback. "
     "Every version is an immutable compiled snapshot."),
    ("runtime", "RUNTIME PRICING  (your customer's backend calls these)",
     "Authenticated by the project API key in the PATH, never a session token. "
     "This is the latency-critical surface: 4ms server-side."),
    ("events", "EVENT INGESTION  (your customer's backend calls these)",
     "Validate and queue, nothing more. That is why the API survives a spike."),
    ("simulate", "SIMULATION & BACKTESTING",
     "Both run the production engine, not an approximation of it."),
    ("decisions", "DECISIONS, REPLAY & THE DETERMINISM PROOF",
     "Every price is reconstructable and machine-verifiable."),
    ("analytics", "ANALYTICS & AUDIT",
     "KPIs come from pre-aggregated hourly counters, so cost is flat "
     "regardless of traffic."),
    ("live", "LIVE OPERATIONS",
     "The REST half of the realtime surface. Paint with these, then keep the "
     "screen moving over the WebSocket."),
    ("approvals", "APPROVALS, NOTIFICATIONS & MOBILE",
     "The human-in-the-loop decision loop."),
    ("ai", "AI CONFIGURATION",
     "Natural language to a validated draft. Output is data, never an action."),
    ("demo", "DEMO & CHAOS",
     "Generate load, or break something on purpose and watch it degrade safely."),
]

STATUS_MEANING = {
    200: "OK",
    400: "Bad request — a parameter is wrong; the body explains which",
    401: "Unauthorized — bad/expired session token, or invalid API key",
    403: "Forbidden — registration incomplete, or not your tenant",
    404: "Not found — or it belongs to another tenant, which is the same thing",
    409: "Conflict — already exists, or the lifecycle forbids it",
    422: "Invalid parameters — missing or wrong type (FastAPI validation)",
    503: "Service unavailable — upstream dependency down, or Lambda throttled",
}


def wrap(text, width=74, indent="      "):
    out = []
    for para in text.split("\n"):
        if not para.strip():
            out.append("")
            continue
        out.extend(textwrap.wrap(para, width=width,
                                 initial_indent=indent,
                                 subsequent_indent=indent) or [indent])
    return "\n".join(out)


def fmt_query(q: str) -> list[str]:
    """Break a query string into one parameter per line, readable."""
    if not q:
        return ["      (no parameters)"]
    parts = q.split("&")
    lines = []
    for i, p in enumerate(parts):
        prefix = "      ?" if i == 0 else "      &"
        if len(p) > 86:
            k, _, v = p.partition("=")
            lines.append(f"{prefix}{k}=")
            for chunk in textwrap.wrap(v, 80):
                lines.append(f"          {chunk}")
        else:
            lines.append(f"{prefix}{p}")
    return lines


L: list[str] = []
A = L.append

A("=" * 80)
A("  COMPLETE API REFERENCE  —  EVERY ENDPOINT, EVERY RESPONSE")
A("=" * 80)
A("")
A(wrap(
    "Every request and response below was CAPTURED FROM THE LIVE SYSTEM, "
    "including the failure cases, which were provoked deliberately. Nothing is "
    "illustrative. If a field appears here, the API returns it.", indent="  "))
A("")
A(f"  BASE URL    {API}")
A(f"  WEBSOCKET   {WS}")
A(f"  DOCS        {API}/docs")
A("")
A("  THE CONVENTIONS, IN ONE PLACE")
A("  " + "-" * 76)
A("    * EVERY endpoint is a GET. There are no request bodies anywhere.")
A("    * Simple values are plain query parameters.")
A("    * Complex objects travel as ONE url-encoded JSON parameter.")
A("    * Lists are comma-separated.")
A("    * Analyst auth:  ?token=sess_...        (from /auth/login)")
A("    * Customer auth: the API key in the PATH, e.g. /v1/p/pk_live_.../price")
A("    * Every response carries Cache-Control: no-store. Because writes are")
A("      GETs, a cached one would silently replay a mutation.")
A("    * Success is {\"ok\": true, ...}. Failure is")
A("      {\"ok\": false, \"error\": {\"code\": \"...\", \"message\": \"...\"}}")
A("    * The URL budget is 6KB; anything larger belongs on the upload path.")
A("")
A("  STATUS CODES YOU WILL SEE")
A("  " + "-" * 76)
for code, meaning in STATUS_MEANING.items():
    A(f"    {code}   {meaning}")
A("")

by_group: dict[str, list[dict]] = {}
for c in caps:
    by_group.setdefault(c.get("group", "other"), []).append(c)

n_total = 0
for key, title, blurb in GROUPS:
    items = by_group.get(key, [])
    if not items:
        continue
    A("")
    A("=" * 80)
    A(f"  {title}   ({len(items)} examples)")
    A("=" * 80)
    A("")
    A(wrap(blurb, indent="  "))
    A("")
    for c in items:
        n_total += 1
        ok = c["status"] == 200
        badge = "OK" if ok else f"ERROR {c['status']}"
        A("  " + "-" * 76)
        A(f"  {c['label']}")
        A(f"  [{badge}]   {c['ms']}ms")
        A("  " + "-" * 76)
        if c.get("note"):
            A("")
            A(wrap("WHY: " + c["note"]))
        A("")
        A("    REQUEST")
        A(f"      GET {c['path']}")
        for line in fmt_query(c["query"]):
            A(line)
        A("")
        A(f"    RESPONSE  ({c['status']} {STATUS_MEANING.get(c['status'], '')})")
        body = c["body"]
        for line in body.split("\n"):
            A("      " + line if line else "")
        if c.get("truncated"):
            A("      ...  [truncated for the document; the API returns the full object]")
        A("")

# ── WebSocket ───────────────────────────────────────────────────────────
A("")
A("=" * 80)
A("  WEBSOCKET  —  REALTIME STREAMING")
A("=" * 80)
A("")
A(wrap(
    "The dashboard receives pushes rather than polling. Authorization happens "
    "ONCE, at $connect: API Gateway passes query parameters on the connect "
    "frame and on no frame after it, so the socket is bound to a tenant and "
    "project for its lifetime and later frames cannot change its scope.",
    indent="  "))
A("")
A("  CONNECT")
A("  " + "-" * 76)
A(f"    {WS}")
A("      ?token=sess_...")
A("      &project_id=prj_...")
A("      &channels=events,decisions          (optional; default is all)")
A("")
A("    Refused at connect with a close code if the token is invalid, the")
A("    registration is incomplete, or the project is not yours.")
A("")
A("  CLIENT FRAMES")
A("  " + "-" * 76)
A('    {"action": "subscribe", "channels": ["events", "decisions"]}')
A('    {"action": "ping"}')
A("")
A("  SERVER FRAMES")
A("  " + "-" * 76)
A("    Every frame is {channel, ts, project_id, data}.")
A("")
A("    events     one frame PER SQS BATCH carrying many events, not one per")
A("               event — that is what stops a storm flooding the browser")
A('               data: {"events": [{ts, item_id, event_type, quantity}], "count": N}')
A("")
A("    kpis       a context/signal update for one item")
A('               data: {"type": "signals", "item_id": "...", "signals": {...}}')
A("")
A("    decisions  a priced decision with its drivers and guardrail outcome")
A('               data: {decision_id, item_id, previous_price, price, changed,')
A('                      change_pct, rules_fired, guardrails_applied,')
A('                      strategy_version, degraded, fallback, latency_ms}')
A("")
A("    alerts     published TWICE — once when the alert is raised, again once")
A("               it carries a decision, so the dashboard can show the question")
A("               without a refetch")
A('               data: {alert_id, severity, type, title, message, item_id,')
A('                      approval_id, needs_decision}')
A("")
A("    health     pipeline and engine status, published per decision batch")
A('               data: {decisions_in_batch, price_changes, fallbacks, degraded,')
A('                      guardrail_block_pct, avg_latency_ms, engine}')
A("")
A(wrap(
    "A socket alone is not enough: a client that connects, or reconnects after "
    "a drop, would stare at an empty page until the next event happened to "
    "arrive. So call /live/pulse to paint the screen, then rely on the socket "
    "to keep it moving, and call /live/pulse again on reconnect.", indent="  "))
A("")

open(OUT, "w").write("\n".join(L) + "\n")
print(f"{n_total} endpoint examples -> {OUT}")
print(f"{len(L)} lines")
