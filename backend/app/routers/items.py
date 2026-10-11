"""Pricing items — the things being priced.

Generic by design. A row here is a Product, a Room, a Ride or a Charging
Session depending only on the project's schema. The engine sees `base_price`
plus a bag of attributes either way.

Creating an item also seeds its context row, so the pricing API can serve it
immediately at base price instead of 404ing until the first event arrives.
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import ProjectDep
from app.responses import ApiError, NotFound, ok
from core import audit, db

router = APIRouter(tags=["items"])


def _seed_context(
    project_id: str,
    item_id: str,
    base_price: float,
    cost: float | None,
    signals: dict | None = None,
) -> None:
    """Write the hot-path context row for a new item.

    `signals` are the initial values of this item's ITEM-SCOPE fields, given
    when the product is added (its inventory, capacity, and so on). They are
    marked explicit so the feature worker's counter-derived values never quietly
    overwrite a number the owner typed. A field left empty stays absent, and the
    engine treats a missing signal as 'does not match' — never as zero.
    """
    now = db.now_ms()
    signals = {k: v for k, v in (signals or {}).items() if v is not None}
    db.put(db.context(), {
        "pk": db.ctx_pk(project_id, item_id),
        "sk": db.ctx_sk(),
        "item_id": item_id,
        "project_id": project_id,
        "base_price": base_price,
        "cost": cost,
        "previous_price": None,
        "signals": signals,
        "signal_updated_at": {k: now for k in signals},
        "explicit_signals": sorted(signals),
        "updated_at": now,
    })


def _parse_item_signals(raw: str, schema: dict) -> dict:
    """Validate a JSON object of item-scope signal values against the schema.

    Only fields the schema declares with scope `item` are allowed. A value for
    a global or request field is rejected rather than stored silently, because
    storing it on the item row is a value no rule would ever read.
    """
    if not raw:
        return {}
    if len(raw) > 4096:
        raise ApiError("signals exceed the 4 KB URL budget", code="payload_too_large")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(f"signals is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ApiError("signals must be a JSON object")

    by_id = {s["id"]: s for s in (schema.get("context_signals") or [])}
    out: dict = {}
    for name, value in parsed.items():
        if value is None or value == "":
            continue
        meta = by_id.get(name)
        if not meta:
            raise ApiError(f"'{name}' is not a signal in this project's schema")
        scope = meta.get("scope", "item")
        if scope != "item":
            raise ApiError(
                f"'{name}' is a {scope} signal, not an item signal — set it with "
                f"{'/v1/g/<key>/context' if scope == 'global' else 'the price request'}"
            )
        if meta.get("type", "number") in ("number", "integer", "float"):
            try:
                out[name] = float(value)
            except (TypeError, ValueError):
                raise ApiError(f"signal '{name}' must be numeric")
        else:
            out[name] = str(value)
    return out


@router.get("/items/create", summary="Create a pricing item")
async def create_item(
    ctx: ProjectDep,
    item_id: Annotated[str, Query(description="Your own identifier, e.g. P1001 or R204")],
    name: Annotated[str, Query()],
    base_price: Annotated[float, Query(gt=0, description="List price before any adjustment")],
    cost: Annotated[float | None, Query(description="Unit cost; required for min-margin guardrails")] = None,
    attributes: Annotated[str, Query(description="URL-encoded JSON of schema attributes")] = "",
    signals: Annotated[str, Query(description="URL-encoded JSON of this item's item-scope signal values")] = "",
    overwrite: Annotated[bool, Query(description="Allow replacing an item that already exists")] = False,
):
    """Add one item to the pricing catalogue.

    `item_id` is YOUR identifier — the one your own systems already use — and it
    is the integration key the pricing API is called with. It can never be
    changed afterwards; renaming it would orphan every decision, context row and
    historical snapshot that references it. Use /items/delete and create a new
    one if an id is genuinely wrong.

    Creating over an existing id is refused unless `overwrite=true`. It used to
    replace silently, which meant a re-run of an import quietly rewrote prices a
    user had since edited by hand, with nothing to notice it by.
    """
    item_id = item_id.strip()
    if not item_id:
        raise ApiError("item_id is required")
    if cost is not None and cost >= base_price:
        raise ApiError("cost must be below base_price")

    attrs: dict = {}
    if attributes:
        if len(attributes) > 4096:
            raise ApiError("attributes exceed the 4 KB URL budget", code="payload_too_large")
        try:
            attrs = json.loads(attributes)
        except json.JSONDecodeError as exc:
            raise ApiError(f"attributes is not valid JSON: {exc}") from exc
        if not isinstance(attrs, dict):
            raise ApiError("attributes must be a JSON object")

    # Unknown attribute keys are kept but reported, rather than rejected: an
    # analyst importing a catalogue should not have a load fail because one
    # column isn't in the schema yet.
    existing_check = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                            db.sk_item(ctx.project_id, item_id))
    if existing_check and not overwrite:
        raise ApiError(
            f"'{item_id}' already exists in this project. Use /items/update to "
            f"change it, or pass overwrite=true to replace it outright.",
            code="already_exists",
            status_code=409,
            item_id=item_id,
            existing={"name": existing_check.get("name"),
                      "base_price": existing_check.get("base_price")},
        )

    known = {a["id"] for a in (ctx.schema.get("attributes") or [])}
    unknown = sorted(set(attrs) - known) if known else []

    # Item-scope signal values travel with the product (its inventory, etc.).
    # Only item-scope fields are accepted here: a global or request field given
    # on a product would be stored where no rule looks for it.
    sig_values = _parse_item_signals(signals, ctx.schema)

    existing = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_item(ctx.project_id, item_id))
    now = db.now_ms()

    db.put(db.core(), {
        "pk": db.pk_tenant(ctx.tenant_id),
        "sk": db.sk_item(ctx.project_id, item_id),
        "project_id": ctx.project_id,
        "item_id": item_id,
        "name": name.strip(),
        "base_price": base_price,
        "cost": cost,
        "attributes": attrs,
        "created_at": existing.get("created_at", now) if existing else now,
        "updated_at": now,
    })

    _seed_context(ctx.project_id, item_id, base_price, cost, sig_values)

    if not existing:
        db.counter(db.core(), db.pk_tenant(ctx.tenant_id),
                   db.sk_project(ctx.project_id), "item_count", 1)

    audit.record(
        tenant_id=ctx.tenant_id,
        action="ITEM_UPDATED" if existing else "ITEM_CREATED",
        actor=ctx.session.user_id, project_id=ctx.project_id,
        entity_type="item", entity_id=item_id,
        old_value={"base_price": existing.get("base_price")} if existing else None,
        new_value={"base_price": base_price},
    )

    body = {
        "item_id": item_id, "name": name.strip(), "base_price": base_price,
        "cost": cost, "attributes": attrs, "created": not existing,
    }
    if unknown:
        body["warning"] = (
            f"attributes not in this project's schema: {', '.join(unknown)} — "
            f"stored, but no rule can reference them until you add them in /domain/save"
        )
    return ok(body)


@router.get("/items/update", summary="Update a pricing item")
async def update_item(
    ctx: ProjectDep,
    item_id: Annotated[str, Query(description="Which item to change. Cannot itself be changed.")],
    name: Annotated[str, Query()] = "",
    base_price: Annotated[float | None, Query(gt=0)] = None,
    cost: Annotated[float | None, Query()] = None,
    attributes: Annotated[str, Query(description="URL-encoded JSON; replaces the whole set")] = "",
    signals: Annotated[str, Query(description="URL-encoded JSON of item-scope signal values to set")] = "",
):
    """Change an existing item. Only the fields you send are touched.

    `item_id` is deliberately NOT updatable. It is the key every decision,
    context row and historical snapshot is filed under, and the identifier the
    customer's own backend calls the pricing API with — changing it would
    silently detach an item from its entire history.

    Price changes take effect on the next pricing request. There is nothing to
    redeploy and no cache to wait for.
    """
    item_id = item_id.strip()
    existing = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_item(ctx.project_id, item_id))
    if not existing:
        raise NotFound(f"item '{item_id}'")

    changes: dict = {}
    if name.strip():
        changes["name"] = name.strip()
    if base_price is not None:
        changes["base_price"] = base_price
    if cost is not None:
        # A negative cost is meaningless; an explicit 0 is how you clear it.
        changes["cost"] = cost if cost > 0 else None

    # Validate the COMBINED state, not just what was sent: updating base_price
    # alone can put it below a cost that was set earlier.
    final_price = changes.get("base_price", existing.get("base_price"))
    final_cost = changes.get("cost", existing.get("cost"))
    if final_cost is not None and final_price is not None and final_cost >= final_price:
        raise ApiError(
            f"cost ({final_cost}) must be below base_price ({final_price}) — "
            f"otherwise every sale loses money and the margin guardrail can never pass"
        )

    if attributes:
        if len(attributes) > 4096:
            raise ApiError("attributes exceed the 4 KB URL budget", code="payload_too_large")
        try:
            attrs = json.loads(attributes)
        except json.JSONDecodeError as exc:
            raise ApiError(f"attributes is not valid JSON: {exc}") from exc
        if not isinstance(attrs, dict):
            raise ApiError("attributes must be a JSON object")
        changes["attributes"] = attrs

    if not changes and not signals:
        raise ApiError(
            "nothing to update — send at least one of name, base_price, cost, "
            "attributes or signals"
        )

    changes["updated_at"] = db.now_ms()
    db.update(db.core(), db.pk_tenant(ctx.tenant_id),
              db.sk_item(ctx.project_id, item_id), changes)

    # The hot path reads base_price and cost from the context row, so it has to
    # move too or the engine keeps pricing off the old number.
    ctx_changes = {k: v for k, v in changes.items() if k in ("base_price", "cost")}

    # Item-scope signal values are edited straight on the context row, and
    # remembered as explicit so the feature worker will not recompute over them.
    sig_values = _parse_item_signals(signals, ctx.schema)
    now = db.now_ms()
    if ctx_changes or sig_values:
        ctx_row = db.get(db.context(), db.ctx_pk(ctx.project_id, item_id), db.ctx_sk()) or {}
        merged_signals = {**(ctx_row.get("signals") or {}), **sig_values}
        merged_ages = {**(ctx_row.get("signal_updated_at") or {}),
                       **{k: now for k in sig_values}}
        explicit = sorted(set(ctx_row.get("explicit_signals") or []) | set(sig_values))
        db.update(
            db.context(), db.ctx_pk(ctx.project_id, item_id), db.ctx_sk(),
            {
                **ctx_changes,
                **({"signals": merged_signals,
                    "signal_updated_at": merged_ages,
                    "explicit_signals": explicit} if sig_values else {}),
                "updated_at": now,
            },
        )

    audit.record(
        tenant_id=ctx.tenant_id, action="ITEM_UPDATED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="item", entity_id=item_id,
        old_value={k: existing.get(k) for k in changes if k != "updated_at"},
        new_value={k: v for k, v in changes.items() if k != "updated_at"},
    )

    return ok({
        "item_id": item_id,
        "updated": [k for k in changes if k != "updated_at"],
        "item": {
            "item_id": item_id,
            "name": changes.get("name", existing.get("name")),
            "base_price": final_price,
            "cost": final_cost,
            "attributes": changes.get("attributes", existing.get("attributes") or {}),
        },
        "effective": "immediately — the next pricing request uses it",
    })


@router.get("/items/delete", summary="Remove a pricing item")
async def delete_item(
    ctx: ProjectDep,
    item_id: Annotated[str, Query()],
):
    """Remove an item and the live context the engine prices it from.

    Past decisions are deliberately KEPT. They are an audit record of prices
    real customers were quoted, and deleting an item must not rewrite history —
    a decision you can no longer explain is worse than one for an item you no
    longer sell. /decisions/replay keeps working for them.

    The pricing API answers 404 for the item from the next request onwards.
    """
    item_id = item_id.strip()
    existing = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                      db.sk_item(ctx.project_id, item_id))
    if not existing:
        raise NotFound(f"item '{item_id}'")

    db.delete(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_item(ctx.project_id, item_id))
    db.delete(db.context(), db.ctx_pk(ctx.project_id, item_id), db.ctx_sk())

    count = max(0, (ctx.project.get("item_count") or 1) - 1)
    db.update(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_project(ctx.project_id),
              {"item_count": count, "updated_at": db.now_ms()})

    audit.record(
        tenant_id=ctx.tenant_id, action="ITEM_DELETED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="item", entity_id=item_id,
        old_value={"name": existing.get("name"), "base_price": existing.get("base_price")},
    )

    return ok({
        "item_id": item_id,
        "deleted": True,
        "items_remaining": count,
        "note": "Past pricing decisions for this item are kept and remain explainable.",
    })


@router.get("/items/list", summary="List and search pricing items")
async def list_items(
    ctx: ProjectDep,
    search: Annotated[str, Query(description="Substring match on id or name")] = "",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: Annotated[str, Query(description="Opaque cursor from a previous page")] = "",
):
    start = None
    if cursor:
        try:
            start = json.loads(cursor)
        except json.JSONDecodeError:
            raise ApiError("invalid cursor")

    # Over-fetch when searching, since filtering happens after the Query.
    rows, nxt = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id), db.sk_item_prefix(ctx.project_id),
        limit=limit * 4 if search else limit, cursor=start,
    )

    if search:
        needle = search.lower()
        rows = [
            r for r in rows
            if needle in r.get("item_id", "").lower()
            or needle in r.get("name", "").lower()
        ]

    page = rows[:limit]

    # Attach each item's current item-scope signal values, so the products
    # table can show and edit them. One BatchGetItem for the page — fine on an
    # admin list, never on the pricing hot path. Only item-scope fields are
    # surfaced: global and request values do not belong to a product.
    item_scope_ids = {
        sg["id"] for sg in (ctx.schema.get("context_signals") or [])
        if (sg.get("scope") or "item") == "item"
    }
    signals_by_item: dict[str, dict] = {}
    if item_scope_ids and page:
        ctx_rows = db.batch_get(
            db.context(),
            [(db.ctx_pk(ctx.project_id, r["item_id"]), db.ctx_sk()) for r in page],
        )
        for cr in ctx_rows:
            iid = cr.get("item_id")
            vals = cr.get("signals") or {}
            signals_by_item[iid] = {
                k: vals[k] for k in item_scope_ids if k in vals
            }

    return ok({
        "count": len(page),
        "items": [
            {
                "item_id": r["item_id"], "name": r.get("name"),
                "base_price": r.get("base_price"), "cost": r.get("cost"),
                "attributes": r.get("attributes", {}),
                "signals": signals_by_item.get(r["item_id"], {}),
                "updated_at": r.get("updated_at"),
            }
            for r in page
        ],
        "cursor": json.dumps(nxt) if nxt else None,
        "currency": ctx.currency,
        # So the client knows which columns to render and in what order.
        "item_fields": [
            {"id": sg["id"], "label": sg.get("label", sg["id"]), "type": sg.get("type", "number")}
            for sg in (ctx.schema.get("context_signals") or [])
            if (sg.get("scope") or "item") == "item"
        ],
    })


@router.get("/items/get", summary="Item detail with live context and last decision")
async def get_item(
    ctx: ProjectDep,
    item_id: Annotated[str, Query()],
):
    """One call returning the item, its current signals and its latest price.

    Used by the web drill-down and the Android app. Bundled because the mobile
    client should not have to make three sequential requests to show one screen.
    """
    item = db.get(db.core(), db.pk_tenant(ctx.tenant_id),
                  db.sk_item(ctx.project_id, item_id))
    if not item:
        raise NotFound("item")

    context = db.get(db.context(), db.ctx_pk(ctx.project_id, item_id), db.ctx_sk()) or {}

    # Freshness per signal, so the UI can grey out stale inputs.
    now = db.now_ms()
    ages = {
        k: round((now - v) / 1000.0, 1)
        for k, v in (context.get("signal_updated_at") or {}).items()
    }

    last_decisions = db.query_prefix(
        db.decisions(), db.decidx_pk(ctx.project_id, item_id), "",
        limit=1, ascending=False,
    )[0]

    return ok({
        "item": {
            "item_id": item["item_id"], "name": item.get("name"),
            "base_price": item.get("base_price"), "cost": item.get("cost"),
            "attributes": item.get("attributes", {}),
        },
        "context": {
            "signals": context.get("signals", {}),
            "signal_age_seconds": ages,
            "previous_price": context.get("previous_price"),
            "updated_at": context.get("updated_at"),
        },
        "last_decision": last_decisions[0] if last_decisions else None,
        "currency": ctx.currency,
    })
