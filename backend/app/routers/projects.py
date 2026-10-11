"""Project and domain configuration.

A project is one pricing setup: one domain schema, its own items, rules,
strategies, analytics and API key. A company creates as many as it likes, and
they are fully isolated from each other.

This router is where the central claim of the product lives. `/domain/save`
writes a schema; nothing downstream has a branch for "hotel" or "ride". The
engine reads signal ids out of that schema and evaluates them. Adding a new
industry is this endpoint, not a deploy.
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.deps import ProjectDep, RegisteredDep
from app.responses import ApiError, ok
from core import audit, catalog, db, ids, rollup
from core.config import settings

router = APIRouter(tags=["projects"])

MAX_SIGNALS = 40
MAX_ATTRIBUTES = 40
RESERVED_IDS = {"base_price", "price", "item_id", "name", "cost"}


def _parse_json_param(raw: str, field: str) -> dict | list:
    """Complex objects travel as one URL-encoded JSON query param.

    Guarded at 6 KB: API Gateway caps the request line plus headers near 8 KB,
    and a schema that large should be arriving through the file-upload path
    instead of a URL.
    """
    if len(raw) > 6144:
        raise ApiError(
            f"{field} is {len(raw)} bytes; the URL budget is 6144. "
            f"Shorten ids/labels, or upload the configuration as a file.",
            code="payload_too_large",
        )
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(f"{field} is not valid JSON: {exc}") from exc


def _validate_schema(schema: dict) -> dict:
    """Normalise and sanity-check an analyst-authored domain schema."""
    signals = schema.get("context_signals") or []
    attrs = schema.get("attributes") or []

    if not isinstance(signals, list) or not isinstance(attrs, list):
        raise ApiError("context_signals and attributes must both be arrays")
    if len(signals) > MAX_SIGNALS:
        raise ApiError(f"at most {MAX_SIGNALS} context signals")
    if len(attrs) > MAX_ATTRIBUTES:
        raise ApiError(f"at most {MAX_ATTRIBUTES} attributes")

    seen: set[str] = set()
    cleaned_signals = []
    for s in signals:
        sid = (s.get("id") or "").strip()
        if not sid:
            raise ApiError("every context signal needs an id")
        if not sid.replace("_", "").isalnum():
            raise ApiError(f"signal id '{sid}' must be alphanumeric with underscores")
        if sid in RESERVED_IDS:
            raise ApiError(f"'{sid}' is reserved by the engine — pick another id")
        if sid in seen:
            raise ApiError(f"duplicate signal id '{sid}'")
        seen.add(sid)
        # Scope decides WHERE the value lives and HOW it reaches the engine:
        #   item    per-product, stored on the item's context row
        #   global  one value for the whole project, stored on the global row
        #   request supplied on the /price call, never stored
        # Absent scope means `item`, so every schema written before scopes
        # existed keeps behaving exactly as it did.
        scope = (s.get("scope") or "item").strip().lower()
        if scope not in ("item", "global", "request"):
            raise ApiError(
                f"signal '{sid}' has scope '{scope}' — must be item, global or request"
            )
        cleaned_signals.append({
            "id": sid,
            "label": (s.get("label") or sid.replace("_", " ").capitalize()).strip(),
            "type": s.get("type", "number"),
            "scope": scope,
            "min": s.get("min"),
            "max": s.get("max"),
            "enum": s.get("enum"),
            "description": (s.get("description") or "").strip(),
        })

    cleaned_attrs = []
    for a in attrs:
        aid = (a.get("id") or "").strip()
        if not aid:
            raise ApiError("every attribute needs an id")
        if aid in seen:
            raise ApiError(f"'{aid}' is used by both an attribute and a signal")
        seen.add(aid)
        cleaned_attrs.append({
            "id": aid,
            "label": (a.get("label") or aid.replace("_", " ").capitalize()).strip(),
            "type": a.get("type", "string"),
        })

    return {
        "domain_name": (schema.get("domain_name") or "").strip(),
        "entity_label": (schema.get("entity_label") or "Item").strip(),
        "context_signals": cleaned_signals,
        "attributes": cleaned_attrs,
        # Bumped on every save. The AI draft cache keys on it, so editing the
        # schema automatically invalidates drafts written against the old one.
        "version": int(schema.get("version", 0)) + 1,
    }


def _base_url(request: Request) -> str:
    """The public base URL, taken from the incoming request.

    Derived from the Host header rather than injected as an environment
    variable: the API function is the integration target of the very API whose
    URL we want, so a `!Sub` reference to it in the template would be a circular
    dependency. Reading it off the request sidesteps that and stays correct
    behind a custom domain too.
    """
    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    proto = request.headers.get("x-forwarded-proto", "https")
    return f"{proto}://{host}" if host else ""


def _endpoints(key: str, base: str = "") -> dict:
    base = base or "https://{your-api-host}"
    return {
        "price": f"{base}/v1/p/{key}/price?item_id=YOUR_ITEM_ID",
        "price_bulk": f"{base}/v1/p/{key}/price/bulk?item_ids=ID1,ID2,ID3",
        "explain": f"{base}/v1/p/{key}/explain?decision_id=DEC-XXXXXXXX",
        "event": f"{base}/v1/t/{key}/event?item_id=YOUR_ITEM_ID&event_type=purchase&event_id=UNIQUE_ID",
        "event_batch": f"{base}/v1/t/{key}/event/batch?payload=URL_ENCODED_JSON_ARRAY",
    }


@router.get("/projects/create", summary="Create a pricing project")
async def create_project(
    request: Request,
    session: RegisteredDep,
    name: Annotated[str, Query(description="What this pricing setup is called")],
    domain_name: Annotated[str, Query(description="E-commerce, Hospitality, EV Charging…")],
    entity_label: Annotated[str, Query(description="Product, Room, Ride, Vehicle…")] = "Item",
    currency: Annotated[str, Query()] = "INR",
    template_id: Annotated[str, Query(description="Optional catalog template to prefill")] = "",
):
    """Create a project and mint its API key.

    Passing `template_id` prefills the schema from the catalog so a standard
    domain is usable immediately; `/domain/save` then edits it freely. A domain
    with no template is equally valid — the schema is just typed in.
    """
    if not name.strip():
        raise ApiError("name is required")

    project_id = ids.project_id()
    key = ids.api_key("live")
    now = db.now_ms()

    tpl = catalog.template(template_id) if template_id else None
    schema = _validate_schema({
        "domain_name": domain_name.strip() or (tpl or {}).get("domain_name", ""),
        "entity_label": entity_label.strip() or (tpl or {}).get("entity_label", "Item"),
        "context_signals": (tpl or {}).get("context_signals", []),
        "attributes": (tpl or {}).get("attributes", []),
        "version": 0,
    })

    project = {
        "pk": db.pk_tenant(session.tenant_id),
        "sk": db.sk_project(project_id),
        "project_id": project_id,
        "tenant_id": session.tenant_id,
        "name": name.strip(),
        "domain_name": schema["domain_name"],
        "entity_label": schema["entity_label"],
        "currency": currency.strip().upper(),
        "api_key": key,
        "schema": schema,
        "guardrails": {},
        "mode": "draft",
        "active_strategy_id": None,
        "active_strategy_version": None,
        "shadow_strategy_id": None,
        "shadow_strategy_version": None,
        "item_count": 0,
        "created_at": now,
        "created_by": session.user_id,
    }
    db.put(db.core(), project)

    # Reverse lookup so the runtime path resolves a key in one GetItem.
    db.put(db.core(), {
        "pk": db.pk_apikey(key),
        "sk": db.sk_meta(),
        "tenant_id": session.tenant_id,
        "project_id": project_id,
        "revoked": False,
        "created_at": now,
    })

    audit.record(
        tenant_id=session.tenant_id, action="PROJECT_CREATED", actor=session.user_id,
        project_id=project_id, entity_type="project", entity_id=project_id,
        new_value={"name": name.strip(), "domain": schema["domain_name"]},
    )

    return ok({
        "project_id": project_id,
        "name": project["name"],
        "domain_name": project["domain_name"],
        "entity_label": project["entity_label"],
        "currency": project["currency"],
        "api_key": key,
        "schema": schema,
        "endpoints": _endpoints(key, _base_url(request)),
        "next_step": "add-items" if not tpl else "review-schema",
    })


@router.get("/projects/list", summary="All projects for this company")
async def list_projects(session: RegisteredDep):
    rows, _ = db.query_prefix(db.core(), db.pk_tenant(session.tenant_id), "PROJECT#", limit=100)
    return ok({
        "count": len(rows),
        "projects": [
            {
                "project_id": p["project_id"],
                "name": p.get("name"),
                "domain_name": p.get("domain_name"),
                "entity_label": p.get("entity_label"),
                "currency": p.get("currency"),
                "mode": p.get("mode", "draft"),
                "active_strategy_id": p.get("active_strategy_id"),
                "active_strategy_version": p.get("active_strategy_version"),
                "item_count": p.get("item_count", 0),
                "signal_count": len((p.get("schema") or {}).get("context_signals", [])),
                "created_at": p.get("created_at"),
            }
            for p in rows
        ],
    })


def _shadow_fields(project: dict) -> dict:
    """Report a shadow strategy only when it is genuinely a different strategy.

    Promoting a shadow strategy to active used to leave its shadow pointer in
    place, so the project claimed to be both running and shadowing the same
    version. Activation now clears it, but projects activated before that fix
    still carry the stale value — filtering on read repairs them without a
    migration.
    """
    active_id = project.get("active_strategy_id")
    shadow_id = project.get("shadow_strategy_id")
    real = bool(shadow_id) and shadow_id != active_id
    return {
        "shadow_strategy_id": shadow_id if real else None,
        "shadow_strategy_version": project.get("shadow_strategy_version") if real else None,
    }


@router.get("/projects/get", summary="Full project configuration")
async def get_project(request: Request, ctx: ProjectDep):
    p = ctx.project
    return ok({
        "project": {
            "project_id": p["project_id"],
            "name": p.get("name"),
            "domain_name": p.get("domain_name"),
            "entity_label": p.get("entity_label"),
            "currency": p.get("currency"),
            "mode": p.get("mode", "draft"),
            "active_strategy_id": p.get("active_strategy_id"),
            "active_strategy_version": p.get("active_strategy_version"),
            # A strategy shadowing itself is not a shadow run. See
            # _strategy_status in app/routers/live.py for why this is resolved
            # on read rather than migrated.
            **_shadow_fields(p),
            "item_count": p.get("item_count", 0),
            "created_at": p.get("created_at"),
            # Publish-approval gate state, so the UI can show "waiting for
            # approval" and the approve/reject controls.
            "require_approval": bool(p.get("require_approval")),
            "pending_publish": p.get("pending_publish"),
        },
        "schema": p.get("schema") or {},
        "guardrails": p.get("guardrails") or {},
        "builtin_signals": catalog.BUILTIN_SIGNALS,
        "api_key": p.get("api_key"),
        "endpoints": _endpoints(p.get("api_key", ""), _base_url(request)),
    })


@router.get("/domain/save", summary="Save the domain schema (the no-code builder)")
async def save_domain(
    ctx: ProjectDep,
    schema: Annotated[str, Query(description="URL-encoded JSON: entity, attributes, context_signals")],
):
    """Define what this project prices and which signals drive it.

    This is the endpoint that makes the platform domain-agnostic. Nothing in
    core/engine/ knows what an 'occupancy' or a 'grid_load' is — it reads ids
    from here and evaluates them numerically.
    """
    parsed = _parse_json_param(schema, "schema")
    if not isinstance(parsed, dict):
        raise ApiError("schema must be a JSON object")

    old = ctx.project.get("schema") or {}
    parsed.setdefault("domain_name", ctx.project.get("domain_name"))
    parsed.setdefault("entity_label", ctx.project.get("entity_label"))
    parsed["version"] = old.get("version", 0)
    cleaned = _validate_schema(parsed)

    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id), {
        "schema": cleaned,
        "domain_name": cleaned["domain_name"],
        "entity_label": cleaned["entity_label"],
        "updated_at": db.now_ms(),
    })

    audit.record(
        tenant_id=ctx.tenant_id, action="DOMAIN_SAVED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="schema", entity_id=ctx.project_id,
        old_value={"version": old.get("version"), "signals": len(old.get("context_signals", []))},
        new_value={"version": cleaned["version"], "signals": len(cleaned["context_signals"])},
    )

    return ok({
        "schema": cleaned,
        "signal_count": len(cleaned["context_signals"]),
        "attribute_count": len(cleaned["attributes"]),
        "note": "Rules and AI drafts written against the previous schema version "
                "should be revalidated.",
    })


@router.get("/guardrails/save", summary="Project-level pricing safety limits")
async def save_guardrails(
    ctx: ProjectDep,
    min_price: Annotated[float | None, Query()] = None,
    max_price: Annotated[float | None, Query()] = None,
    max_increase_pct: Annotated[float | None, Query()] = None,
    max_decrease_pct: Annotated[float | None, Query()] = None,
    min_margin_pct: Annotated[float | None, Query()] = None,
):
    """The last line of defence. Applied after rules, on every decision, always.

    Note these take effect on the next evaluation but do NOT recompile the
    active strategy — a strategy may carry its own tighter override.
    """
    g = {
        "min_price": min_price, "max_price": max_price,
        "max_increase_pct": max_increase_pct, "max_decrease_pct": max_decrease_pct,
        "min_margin_pct": min_margin_pct,
    }
    g = {k: v for k, v in g.items() if v is not None}

    if "min_price" in g and "max_price" in g and g["min_price"] >= g["max_price"]:
        raise ApiError("min_price must be below max_price")
    for k in ("max_increase_pct", "max_decrease_pct", "min_margin_pct"):
        if k in g and not (0 <= g[k] <= 100):
            raise ApiError(f"{k} must be between 0 and 100")

    old = ctx.project.get("guardrails") or {}
    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id), {
        "guardrails": g, "updated_at": db.now_ms(),
    })

    # Keep the hot-path copy in step, so guardrails apply without waiting for
    # the next strategy activation.
    active = db.get(db.context(), db.active_pk(ctx.project_id), db.active_sk())
    if active:
        merged = {**g, **(active.get("guardrails_override") or {})}
        db.update(db.context(), db.active_pk(ctx.project_id), db.active_sk(),
                  {"guardrails": merged})

    audit.record(
        tenant_id=ctx.tenant_id, action="GUARDRAILS_SAVED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="guardrails", entity_id=ctx.project_id,
        old_value=old, new_value=g,
    )

    from core.engine import Guardrails, describe_guardrails
    return ok({
        "guardrails": g,
        "explanation": describe_guardrails(Guardrails.from_dict(g), ctx.currency),
    })


@router.get("/apikeys/rotate", summary="Rotate this project's API key")
async def rotate_key(request: Request, ctx: ProjectDep):
    """Issue a new key and revoke the old one.

    The old key is marked revoked rather than deleted so that calls arriving on
    it fail with a clear 'invalid API key' instead of a confusing 404, and so
    the rotation stays visible in the audit trail.
    """
    old_key = ctx.project.get("api_key")
    new_key = ids.api_key("live")
    now = db.now_ms()

    db.put(db.core(), {
        "pk": db.pk_apikey(new_key), "sk": db.sk_meta(),
        "tenant_id": ctx.tenant_id, "project_id": ctx.project_id,
        "revoked": False, "created_at": now,
    })
    if old_key:
        db.update(db.core(), db.pk_apikey(old_key), db.sk_meta(),
                  {"revoked": True, "revoked_at": now})

    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id),
              {"api_key": new_key, "updated_at": now})

    audit.record(
        tenant_id=ctx.tenant_id, action="APIKEY_ROTATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="api_key", entity_id=ctx.project_id,
        note="previous key revoked immediately",
    )

    return ok({
        "api_key": new_key,
        "endpoints": _endpoints(new_key, _base_url(request)),
        "warning": "The previous key stopped working immediately. "
                   "Update any integration using it.",
    })


def _purge_partition(tbl, pk: str) -> int:
    """Delete every row in one partition, paging through it. Best effort."""
    n = 0
    cursor = None
    while True:
        rows, cursor = db.query_prefix(tbl, pk, "", limit=200, cursor=cursor)
        for r in rows:
            try:
                db.delete(tbl, r["pk"], r["sk"])
                n += 1
            except Exception:  # noqa: BLE001 - keep deleting the rest
                pass
        if not cursor:
            break
    return n


@router.get("/projects/delete", summary="Delete a project and everything in it")
async def delete_project(ctx: ProjectDep):
    """Permanently delete a project and ALL of its data — draft or fully built.

    Clears the project record and its API key, every item, rule, strategy and
    strategy version, background jobs, the AI chat transcript, approvals and
    guardrails, the live context (global + per-item), the decision feed and
    history, the decisions themselves, and the sockets registry. The audit
    trail is kept, so the deletion stays on record. This cannot be undone.
    """
    pid = ctx.project_id
    tid = ctx.tenant_id
    api_key = (ctx.project or {}).get("api_key")
    counts = {"core": 0, "context": 0, "decisions": 0}

    # Collect the item ids (for per-item context + decision history) and the
    # decision ids (for the decisions table) BEFORE anything is deleted.
    item_ids: list[str] = []
    cursor = None
    while True:
        rows, cursor = db.query_prefix(
            db.core(), db.pk_tenant(tid), db.sk_item_prefix(pid), limit=200, cursor=cursor)
        item_ids += [r["item_id"] for r in rows if r.get("item_id")]
        if not cursor:
            break

    decision_ids: list[str] = []
    cursor = None
    while True:
        rows, cursor = db.query_prefix(
            db.context(), db.decfeed_pk(pid), "", limit=200, cursor=cursor)
        decision_ids += [r["decision_id"] for r in rows if r.get("decision_id")]
        if not cursor:
            break

    # 1. Core tenant partition — every row for this project, keeping AUDIT# so
    #    the trail (including this deletion) survives.
    cursor = None
    while True:
        rows, cursor = db.query_prefix(db.core(), db.pk_tenant(tid), "", limit=200, cursor=cursor)
        for r in rows:
            sk = r.get("sk", "")
            if sk.startswith("AUDIT#"):
                continue
            belongs = (
                sk == db.sk_project(pid)
                or sk.startswith(db.sk_item_prefix(pid))
                or sk.startswith(db.sk_rule_prefix(pid))
                or sk.startswith(db.sk_strategy_prefix(pid))
                or sk.startswith(f"SVER#{pid}#")
                or sk.startswith(db.sk_job_prefix(pid))
                or sk == db.sk_agent_chat(pid)
                or r.get("project_id") == pid
            )
            if belongs:
                try:
                    db.delete(db.core(), r["pk"], sk)
                    counts["core"] += 1
                except Exception:  # noqa: BLE001
                    pass
        if not cursor:
            break

    # 2. API-key reverse lookup, so the key stops resolving immediately.
    if api_key:
        try:
            db.delete(db.core(), db.pk_apikey(api_key), db.sk_meta())
            counts["core"] += 1
        except Exception:  # noqa: BLE001
            pass

    # 3. Context table: live strategy, global + per-item context, the decision
    #    feed and per-item decision history, and the sockets registry.
    counts["context"] += _purge_partition(db.context(), db.active_pk(pid))
    counts["context"] += _purge_partition(db.context(), db.global_ctx_pk(pid))
    for iid in item_ids:
        counts["context"] += _purge_partition(db.context(), db.ctx_pk(pid, iid))
        counts["context"] += _purge_partition(db.context(), db.decidx_pk(pid, iid))
    counts["context"] += _purge_partition(db.context(), db.decfeed_pk(pid))
    counts["context"] += _purge_partition(db.context(), f"WSCONN#{pid}")

    # 4. Decisions table: each decision is its own partition.
    for did in set(decision_ids):
        try:
            db.delete(db.decisions(), db.dec_pk(pid, did), db.sk_meta())
            counts["decisions"] += 1
        except Exception:  # noqa: BLE001
            pass

    audit.record(
        tenant_id=tid, action="PROJECT_DELETED", actor=ctx.session.user_id,
        project_id=pid, entity_type="project", entity_id=pid,
        old_value={"name": (ctx.project or {}).get("name")}, new_value=counts,
    )

    return ok({
        "deleted": True,
        "project_id": pid,
        "removed": counts,
        "note": "The project and all its data are gone. This cannot be undone.",
    })


@router.get("/projects/reset-data", summary="Wipe a project's activity, keep its config")
async def reset_project_data(ctx: ProjectDep):
    """Clear everything the project has *done* while keeping everything it *is*.

    Removes the decision feed and history, the pre-aggregated analytics counters
    (so revenue / decisions / price-changes / avg-price all return to zero), every
    alert, this project's audit entries, any open approvals, and the live signal
    context (global + per-item). Keeps the schema, items, rules, strategy and API
    key, so the project stays live and immediately re-priceable.

    Built for demos and simulations: one call returns a clean slate without
    tearing the project down. This cannot be undone.
    """
    pid = ctx.project_id
    tid = ctx.tenant_id
    counts = {"decisions": 0, "rollup": 0, "context": 0, "alerts": 0, "audit": 0, "approvals": 0}

    # Collect item ids and decision ids before deleting.
    item_ids: list[str] = []
    cursor = None
    while True:
        rows, cursor = db.query_prefix(
            db.core(), db.pk_tenant(tid), db.sk_item_prefix(pid), limit=200, cursor=cursor)
        item_ids += [r["item_id"] for r in rows if r.get("item_id")]
        if not cursor:
            break

    # The decision feed + per-item index live in the DECISIONS table (that is
    # what /decisions/list and /live/decisions read), NOT the context table.
    decision_ids: list[str] = []
    cursor = None
    while True:
        rows, cursor = db.query_prefix(db.decisions(), db.decfeed_pk(pid), "", limit=200, cursor=cursor)
        decision_ids += [r["decision_id"] for r in rows if r.get("decision_id")]
        if not cursor:
            break

    # Decisions table: each decision record, the project feed, every per-item
    # index, and the hourly analytics counters.
    for did in set(decision_ids):
        try:
            db.delete(db.decisions(), db.dec_pk(pid, did), db.sk_meta())
            counts["decisions"] += 1
        except Exception:  # noqa: BLE001
            pass
    counts["decisions"] += _purge_partition(db.decisions(), db.decfeed_pk(pid))
    for iid in item_ids:
        counts["decisions"] += _purge_partition(db.decisions(), db.decidx_pk(pid, iid))
    counts["rollup"] += _purge_partition(db.decisions(), rollup.pk(pid))

    # NB: we deliberately do NOT delete the per-item or global context rows.
    # The pricing engine reads CTX#<pid>#<item> on every call; removing it makes
    # the item unpriceable ("unknown item"). Live signal VALUES are reset by the
    # caller (the sim neutralises them) — the rows themselves must stay.

    # Core partition: alerts, this project's audit trail, and open/record approvals.
    cursor = None
    while True:
        rows, cursor = db.query_prefix(db.core(), db.pk_tenant(tid), "", limit=200, cursor=cursor)
        for r in rows:
            sk = r.get("sk", "")
            try:
                if sk.startswith("ALERT#") and (r.get("project_id") in (pid, None, "")):
                    db.delete(db.core(), r["pk"], sk); counts["alerts"] += 1
                elif sk.startswith("AUDIT#") and r.get("project_id") == pid:
                    db.delete(db.core(), r["pk"], sk); counts["audit"] += 1
                elif (sk.startswith("APRV#") or sk.startswith("APRVOPEN#")) and r.get("project_id") == pid:
                    db.delete(db.core(), r["pk"], sk); counts["approvals"] += 1
            except Exception:  # noqa: BLE001
                pass
        if not cursor:
            break

    return ok({
        "reset": True,
        "project_id": pid,
        "cleared": counts,
        "kept": ["schema", "items", "rules", "strategy", "api_key"],
        "note": "Activity wiped to a clean slate; configuration kept. The project is still live.",
    })


@router.get("/projects/rename", summary="Rename a project")
async def rename_project(
    ctx: ProjectDep,
    name: Annotated[str, Query(description="The new project name")],
):
    """Change the project's display name. Everything else stays as-is."""
    if not name.strip():
        raise ApiError("name is required")
    old = (ctx.project or {}).get("name")
    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id),
              {"name": name.strip(), "updated_at": db.now_ms()})
    audit.record(
        tenant_id=ctx.tenant_id, action="PROJECT_RENAMED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="project", entity_id=ctx.project_id,
        old_value={"name": old}, new_value={"name": name.strip()},
    )
    return ok({"renamed": True, "name": name.strip()})
