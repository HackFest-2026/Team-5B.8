"""Audit trail.

Who changed what, when, from what to what, under which strategy and rule
version, and which decision it produced. Rollback depends on this being
complete — you cannot revert what was never recorded.

Read-only by design. There is no endpoint to edit or delete an audit entry, and
that absence is the feature.
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import RegisteredDep
from app.responses import ApiError, ok
from core import audit as audit_core

router = APIRouter(tags=["audit"])


@router.get("/audit/list", summary="Audit trail")
async def list_audit(
    session: RegisteredDep,
    project_id: Annotated[str, Query()] = "",
    entity_type: Annotated[str, Query(description="strategy | rule | project | approval | …")] = "",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: Annotated[str, Query()] = "",
):
    start = None
    if cursor:
        try:
            start = json.loads(cursor)
        except json.JSONDecodeError:
            raise ApiError("invalid cursor")

    rows, nxt = audit_core.listing(
        session.tenant_id,  # type: ignore[arg-type]
        project_id=project_id or None,
        entity_type=entity_type or None,
        limit=limit,
        cursor=start,
    )

    return ok({
        "count": len(rows),
        "entries": [
            {
                "audit_id": r.get("audit_id"),
                "action": r.get("action"),
                "actor": r.get("actor"),
                "source": r.get("source", "web"),
                "project_id": r.get("project_id"),
                "entity_type": r.get("entity_type"),
                "entity_id": r.get("entity_id"),
                "old_value": r.get("old_value"),
                "new_value": r.get("new_value"),
                "strategy_version": r.get("strategy_version"),
                "rule_version": r.get("rule_version"),
                "decision_id": r.get("decision_id"),
                "note": r.get("note"),
                "ts": r.get("ts"),
            }
            for r in rows
        ],
        "cursor": json.dumps(nxt) if nxt else None,
        "known_actions": sorted(audit_core.ACTIONS),
    })
