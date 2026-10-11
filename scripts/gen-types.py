#!/usr/bin/env python3
"""Generate frontend/src/api/types.ts from the captured live responses.

The shapes come from /tmp/devnexus-api-capture.json — real responses from the
deployed API, not hand-written guesses. That matters: a type that disagrees
with the server is worse than no type, because it makes the compiler confirm a
wrong assumption.

Nullability is inferred from what was actually observed. Where a capture was
truncated for the reference document, the type is marked as partial so nobody
mistakes it for exhaustive.
"""

from __future__ import annotations

import json
import keyword
import re
from collections import OrderedDict

CAP = "/tmp/devnexus-api-capture.json"
# The documentation capture truncates long bodies at 2600 chars, which leaves
# invalid JSON — so the biggest and most important responses (/auth/me,
# /live/pulse, /meta/catalog, /projects/get) produced no type at all. This
# second file holds untruncated captures of exactly those endpoints.
CAP_FULL = "/tmp/devnexus-capture-full.json"
OUT = "/Users/mohammadsadiq/Desktop/DevNexus/frontend/src/api/types.ts"

# path -> TypeScript interface name, for the 200 responses worth typing.
NAMES = {
    "/": "ServiceInfo",
    "/health": "HealthResponse",
    "/meta/catalog": "CatalogResponse",
    "/auth/signup": "SignupResponse",
    "/auth/login": "LoginResponse",
    "/auth/complete-profile": "CompleteProfileResponse",
    "/auth/me": "MeResponse",
    "/projects/create": "CreateProjectResponse",
    "/projects/list": "ProjectListResponse",
    "/projects/get": "ProjectDetailResponse",
    "/domain/save": "SaveDomainResponse",
    "/guardrails/save": "SaveGuardrailsResponse",
    "/items/create": "CreateItemResponse",
    "/items/list": "ItemListResponse",
    "/items/get": "ItemDetailResponse",
    "/rules/create": "CreateRuleResponse",
    "/rules/update": "UpdateRuleResponse",
    "/rules/list": "RuleListResponse",
    "/rules/conflicts": "RuleConflictsResponse",
    "/strategies/create": "CreateStrategyResponse",
    "/strategies/list": "StrategyListResponse",
    "/strategies/get": "StrategyDetailResponse",
    "/strategies/validate": "ValidateStrategyResponse",
    "/strategies/promote": "PromoteStrategyResponse",
    "/strategies/rollback": "RollbackResponse",
    "/simulate/whatif": "WhatIfResponse",
    "/simulate/compare": "CompareResponse",
    "/backtest/result": "BacktestResultResponse",
    "/backtest/list": "BacktestListResponse",
    "/data/jobs": "DataJobListResponse",
    "/data/job": "DataJobResponse",
    "/data/upload-url": "UploadUrlResponse",
    "/shadow/comparison": "ShadowComparisonResponse",
    "/decisions/list": "DecisionListResponse",
    "/decisions/replay": "DecisionReplayResponse",
    "/decisions/verify": "DecisionVerifyResponse",
    "/analytics/overview": "OverviewResponse",
    "/analytics/timeseries": "TimeseriesResponse",
    "/analytics/rules": "RuleAnalyticsResponse",
    "/analytics/system": "SystemHealthResponse",
    "/analytics/domains": "DomainsResponse",
    "/analytics/pipeline": "PipelineResponse",
    "/live/pulse": "PulseResponse",
    "/live/events": "LiveEventsResponse",
    "/live/decisions": "LiveDecisionsResponse",
    "/live/connections": "ConnectionsResponse",
    "/audit/list": "AuditListResponse",
    "/alerts/list": "AlertListResponse",
    "/approvals/pending": "PendingApprovalsResponse",
    "/approvals/history": "ApprovalHistoryResponse",
    "/notify/send": "NotifyResponse",
    "/devices/register": "RegisterDeviceResponse",
    "/mobile/home": "MobileHomeResponse",
    "/ai/configure": "AiConfigureResponse",
    "/ai/health": "AiHealthResponse",
    "/ai/forecast": "ForecastResponse",
    "/demo/traffic": "DemoTrafficResponse",
    "/demo/chaos": "ChaosResponse",
}
RUNTIME = {
    "price": "PriceResponse",
    "price/bulk": "BulkPriceResponse",
    "event": "EventAckResponse",
    "event/batch": "EventAckResponse",
    "explain": "ExplainResponse",
}

IDENT = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")

# Fields that happened to be null in every capture. Their real types come from
# the backend dataclasses, so pin them rather than emit `unknown | null` — an
# honest narrow type beats a useless wide one, and these are not guesses.
NULL_OVERRIDES = {
    "previous_price": "number", "change_pct": "number", "cost": "number",
    "min_price": "number", "max_price": "number", "min_margin_pct": "number",
    "max_increase_pct": "number", "max_decrease_pct": "number",
    "avg_latency_ms": "number", "latency_ms": "number", "p50_ms": "number",
    "p95_ms": "number", "p99_ms": "number", "items_covered": "number",
    "change_pct_value": "number", "elasticity_hint": "number",
    "shadow_strategy_id": "string", "shadow_strategy_version": "string",
    "shadow_version": "string", "active_strategy_id": "string",
    "active_strategy_version": "string", "approval_id": "string",
    "decision_id": "string", "item_id": "string", "cursor": "string",
    "clarification": "string", "suppressed_by": "string",
    "skipped_reason": "string", "conflict_group": "string",
    "recommended_option_id": "string", "rejected_rows_url": "string",
    "tenant_id": "string", "currency": "string", "note": "string",
    "error": "string", "spread": "Record<string, number>",
    "most_urgent": "Record<string, unknown>",
    "pending_decision": "Record<string, unknown>",
    "last_decision": "Record<string, unknown>",
    "summary": "Record<string, unknown>",
    # Backtest / shadow uplift is null until a run has both arms to compare.
    "revenue_uplift_pct": "number", "uplift_pct": "number",
    # An approval row carries these only once somebody has answered it.
    "chosen_option_id": "string", "chosen_label": "string",
    "chosen_action": "string", "outcome": "string",
    "answered_at": "number", "answered_by": "string", "answered_from": "string",
    "response_seconds": "number", "followed_recommendation": "boolean",
    "recommendation_follow_rate": "number", "median_response_seconds": "number",
    # Rule clauses: only the operator in use populates its value slot.
    "value_list": "(string | number)[]", "value_number_2": "number",
    "value2": "number",
    # Audit rows record the prior value only for updates, not creates.
    "old_value": "Record<string, unknown>", "rule_version": "number",
    "previous": "Record<string, unknown>",
}


# Fields that were an empty list in every capture, so their element type could
# not be inferred. These come from the backend dataclasses (core/engine/models.py
# and workers/decision_worker.py), not from guesswork: `rules_fired` is a list
# of rule NAMES, and `guardrails_applied` is GuardrailHit.to_dict().
EMPTY_ARRAY_OVERRIDES = {
    "rules_fired": "string[]",
    "shadow_rules_fired": "string[]",
    "notes": "string[]",
    "warnings": "string[]",
    "errors": "string[]",
    "guardrails_applied": (
        "{ rule: string; limit: number | string; before: number; after: number }[]"
    ),
    "drivers": "{ factor: string; impact: string }[]",
    # Rule NAMES that started or stopped firing between two scenarios.
    "newly_triggered": "string[]",
    "no_longer_triggered": "string[]",
    "rule_names": "string[]",
    "unmapped": "string[]",
}


# Fields that are OPEN MAPS keyed by whatever the project's schema declares,
# not fixed structures. Inferring their keys from a capture is actively wrong:
# it would type `signals` as the hotel fixture's occupancy/availability and make
# the compiler reject a co-working project's desk_occupancy — contradicting the
# one thing the platform claims, that domains are configuration.
MAP_FIELDS = {
    "signals": "Record<string, number | string | boolean>",
    "signal_age_seconds": "Record<string, number>",
    "signal_updated_at": "Record<string, number>",
    "attributes": "Record<string, unknown>",
    "overrides": "Record<string, number | string | boolean>",
    "by_signal": "Record<string, number>",
    "rules_triggered": "Record<string, number>",
    "spread": "Record<string, number>",
    # The what-if / compare scenario is whatever signals the caller overrode.
    "overrides_applied": "Record<string, number | string | boolean>",
    "scenario": "Record<string, number | string | boolean>",
    # Audit rows record whatever changed, which differs per action. The capture
    # happened to be an approval row; typing those three keys as the shape would
    # make every other action's row a type error.
    "new_value": "Record<string, unknown>",
    "errors_by_type": "Record<string, number>",
}


def key(k: str) -> str:
    return k if IDENT.match(k) and not keyword.iskeyword(k) else json.dumps(k)


def ts_type(v, depth=0, name_hint="") -> str:
    pad = "  " * (depth + 1)
    close = "  " * depth
    if isinstance(v, tuple) and len(v) == 2 and v[0] == "nullable":
        inner = ts_type(v[1], depth, name_hint=name_hint)
        return inner if inner.endswith("| null") else f"{inner} | null"
    if v is None:
        # Only ever observed as null. Pinned from the backend types where we
        # know them, because claiming a field is ONLY ever null is wrong.
        return f"{NULL_OVERRIDES[name_hint]} | null" if name_hint in NULL_OVERRIDES \
            else "unknown"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        if not v:
            return EMPTY_ARRAY_OVERRIDES.get(name_hint, "unknown[]")
        # Merge object members so the element type covers every key observed.
        if all(isinstance(x, dict) for x in v):
            merged: OrderedDict = OrderedDict()
            nullable: set[str] = set()
            for x in v:
                for k2, v2 in x.items():
                    if k2 not in merged or merged[k2] == "null":
                        merged[k2] = ts_type(v2, depth + 1, name_hint=k2)
                    elif v2 is None:
                        nullable.add(k2)
            for x in v:
                for k2 in merged:
                    if k2 not in x:
                        nullable.add(k2)
            lines = [
                f"{pad}{key(k2)}{'?' if k2 in nullable else ''}: "
                f"{t}{' | null' if k2 in nullable and t != 'null' else ''};"
                for k2, t in merged.items()
            ]
            return "{\n" + "\n".join(lines) + f"\n{close}}}[]"
        return f"{ts_type(v[0], depth)}[]"
    if isinstance(v, dict):
        if name_hint in MAP_FIELDS:
            return MAP_FIELDS[name_hint]
        if not v:
            return "Record<string, unknown>"
        lines = []
        for k2, v2 in v.items():
            t = ts_type(v2, depth + 1, name_hint=k2)
            lines.append(f"{pad}{key(k2)}: {t};")
        return "{\n" + "\n".join(lines) + f"\n{close}}}"
    return "unknown"


state = json.load(open(CAP))
caps = state["captures"]
try:
    caps = caps + json.load(open(CAP_FULL))["captures"]
except FileNotFoundError:
    print(f"note: {CAP_FULL} absent — large responses will be typed as partial")

def merge(a, b):
    """Union two observed JSON values into one that describes both."""
    if a is None:
        return ("nullable", b)
    if b is None:
        return ("nullable", a)
    if isinstance(a, tuple) and a[0] == "nullable":
        inner = merge(a[1], b)
        return ("nullable", inner[1] if isinstance(inner, tuple) else inner)
    if isinstance(a, dict) and isinstance(b, dict):
        out = dict(a)
        for k, v in b.items():
            out[k] = merge(a[k], v) if k in a else v
        # A key present in one response and absent in the other is optional.
        for k in list(out):
            if (k in a) != (k in b):
                cur = out[k]
                out[k] = cur if (isinstance(cur, tuple) and cur[0] == "nullable") \
                    else ("nullable", cur)
        return out
    if isinstance(a, list) and isinstance(b, list):
        merged = None
        for x in a + b:
            merged = x if merged is None else merge(merged, x)
        return [merged] if merged is not None else []
    return a


observed: dict[str, object] = {}
labels: dict[str, dict] = {}
counts: dict[str, int] = {}
for c in caps:
    if c["status"] != 200 or c.get("truncated"):
        continue
    path = c["path"]
    name = NAMES.get(path)
    if not name:
        for suffix, n in RUNTIME.items():
            if path.endswith("/" + suffix):
                name = n
                break
    if not name:
        continue
    try:
        body = __import__("json").loads(c["body"])
    except Exception:
        continue
    observed[name] = body if name not in observed else merge(observed[name], body)
    counts[name] = counts.get(name, 0) + 1
    # Prefer a complete capture for the doc comment. A truncated body can be
    # LONGER than a full one (it is padded to the 2600-char cap), so comparing
    # lengths alone would label a fully-typed interface "partial".
    prev = labels.get(name)
    better = (
        prev is None
        or (prev.get("truncated") and not c.get("truncated"))
        or (bool(prev.get("truncated")) == bool(c.get("truncated"))
            and len(c["body"]) > len(prev["body"]))
    )
    if better:
        labels[name] = c

# Truncated captures still give us a type when nothing else did.
for c in caps:
    if c["status"] != 200 or not c.get("truncated"):
        continue
    name = NAMES.get(c["path"])
    if name and name not in observed:
        try:
            observed[name] = __import__("json").loads(c["body"])
            labels[name] = c
            counts[name] = 1
        except Exception:
            pass

best = labels

L: list[str] = []
A = L.append
A("// GENERATED — do not edit by hand.")
A("//")
A("// Produced by scripts/gen-types.py from real responses captured off the")
A("// deployed API (scripts/capture-api.py). Shapes and nullability reflect what")
A("// the server actually returned, not an assumption about what it should.")
A("//")
A("// Regenerate:  python3 scripts/capture-api.py && python3 scripts/capture-api2.py")
A("//              python3 scripts/gen-types.py")
A("")
A("/** Every response is wrapped: success sets ok=true, failure sets ok=false. */")
A("export interface ApiError {")
A("  code: string;")
A("  message: string;")
A("  /** Some errors attach extra context, e.g. the list of valid values. */")
A("  [key: string]: unknown;")
A("}")
A("")
A("export interface ApiFailure {")
A("  ok: false;")
A("  error: ApiError;")
A("}")
A("")
A("/** Thrown by the client for any non-2xx or ok:false response. */")
A("export class DevNexusError extends Error {")
A("  constructor(")
A("    readonly status: number,")
A("    readonly code: string,")
A("    message: string,")
A("    readonly detail?: Record<string, unknown>,")
A("  ) {")
A("    super(message);")
A("    this.name = 'DevNexusError';")
A("  }")
A("}")
A("")

for name in sorted(observed):
    c = best[name]
    body = observed[name]
    A(f"/**")
    A(f" * {c['label']}")
    A(f" *")
    A(f" * GET {c['path']}")
    A(f" *")
    A(f" * Shape merged from {counts.get(name, 1)} live response(s).")
    if c.get("truncated"):
        A(" *")
        A(" * NOTE: the capture was truncated for the reference document, so this")
        A(" * interface may omit trailing fields. Treat it as partial.")
    A(f" */")
    A(f"export interface {name} {ts_type(body)}")
    A("")

open(OUT, "w").write("\n".join(L) + "\n")
print(f"{len(best)} interfaces -> {OUT}")
print(f"{len(L)} lines")
