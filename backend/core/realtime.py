"""Real-time publishing to connected dashboards.

    worker -> publish() -> API Gateway WebSocket -> browser

Design notes that matter:

**Workers publish directly, there is no broadcast queue.** Posting to a handful
of connections costs a few milliseconds and the workers are already
asynchronous, so an extra queue hop would add latency and another failure mode
for no benefit.

**Publishing can never fail a worker.** Every call is wrapped: a dead socket, a
throttled API or a missing WebSocket endpoint is logged and swallowed. The
dashboard is a view onto state that is already durably stored — losing a frame
is survivable, losing a priced decision is not.

**Batching happens at the call site, not here.** `feature_worker` already groups
events by item, so one SQS batch produces one publish carrying many items
rather than forty separate frames. That is what keeps a 20k events/sec storm
from melting the browser.

**Stale connections are pruned on GoneException.** A browser that closed without
a clean disconnect leaves a row behind; the first failed post removes it.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterable

import boto3

from core import db
from core.config import REGION, settings

log = logging.getLogger("devnexus.realtime")

# Channels a dashboard can subscribe to. A frame is only delivered to
# connections subscribed to its channel (or to all channels).
CHANNELS = ("events", "decisions", "kpis", "alerts", "health")

MAX_FRAME_BYTES = 120_000  # API Gateway caps a WebSocket frame at 128 KB

_mgmt = None


def _client():
    """ApiGatewayManagementApi, pointed at the WebSocket stage."""
    global _mgmt
    if _mgmt is None:
        endpoint = settings().ws_endpoint
        if not endpoint:
            return None
        _mgmt = boto3.client(
            "apigatewaymanagementapi", region_name=REGION, endpoint_url=endpoint
        )
    return _mgmt


# ── connection registry ─────────────────────────────────────────────────
#
# Stored in the context table beside the hot-path rows. Connections are
# short-lived and TTL'd, so they never accumulate.

def _conn_pk(project_id: str) -> str:
    return f"WSCONN#{project_id}"


def _conn_sk(connection_id: str) -> str:
    return f"CONN#{connection_id}"


def _idx_pk(connection_id: str) -> str:
    """Reverse lookup: connection -> project.

    Needed because API Gateway does NOT replay query-string parameters on
    $disconnect, so the project id is unavailable exactly when we need to
    delete the row. One extra tiny write on connect buys a direct GetItem on
    disconnect instead of a table scan.
    """
    return f"WSIDX#{connection_id}"


def register(
    *, project_id: str, connection_id: str, tenant_id: str, channels: list[str] | None = None
) -> None:
    # A socket cannot outlive API Gateway's 2h idle / 10h hard limit, so a 12h
    # TTL guarantees both rows are reaped even if $disconnect never fires.
    ttl = db.ttl_in(12 * 3600)
    db.put(db.context(), {
        "pk": _conn_pk(project_id),
        "sk": _conn_sk(connection_id),
        "connection_id": connection_id,
        "tenant_id": tenant_id,
        "project_id": project_id,
        "channels": channels or list(CHANNELS),
        "connected_at": db.now_ms(),
        "ttl": ttl,
    })
    db.put(db.context(), {
        "pk": _idx_pk(connection_id),
        "sk": "META",
        "project_id": project_id,
        "tenant_id": tenant_id,
        "ttl": ttl,
    })


def project_for_connection(connection_id: str) -> str | None:
    row = db.get(db.context(), _idx_pk(connection_id), "META")
    return row.get("project_id") if row else None


def registration_for_connection(connection_id: str) -> dict | None:
    """The whole reverse-index row: {project_id, tenant_id}. One GetItem.

    Callers that need the tenant (to file tenant-scoped data for the socket)
    use this instead of `project_for_connection` so there is no second read.
    """
    return db.get(db.context(), _idx_pk(connection_id), "META")


def unregister(*, project_id: str | None, connection_id: str) -> None:
    project_id = project_id or project_for_connection(connection_id)
    try:
        if project_id:
            db.delete(db.context(), _conn_pk(project_id), _conn_sk(connection_id))
        db.delete(db.context(), _idx_pk(connection_id), "META")
    except Exception:  # noqa: BLE001
        pass


def set_channels(*, project_id: str, connection_id: str, channels: list[str]) -> None:
    allowed = [c for c in channels if c in CHANNELS] or list(CHANNELS)
    db.update(db.context(), _conn_pk(project_id), _conn_sk(connection_id),
              {"channels": allowed})


def connections(project_id: str) -> list[dict]:
    rows, _ = db.query_prefix(
        db.context(), _conn_pk(project_id), "CONN#", limit=200
    )
    return rows


def connection_count(project_id: str) -> int:
    return len(connections(project_id))


# ── publishing ──────────────────────────────────────────────────────────

def publish(
    *,
    project_id: str,
    channel: str,
    payload: Any,
    tenant_id: str | None = None,
) -> int:
    """Send one frame to every subscriber of `channel`. Returns frames delivered.

    Never raises. See the module docstring for why.
    """
    if channel not in CHANNELS:
        log.warning("unknown realtime channel %r", channel)
        return 0

    client = _client()
    if client is None:
        return 0  # WebSocket not configured for this stage

    try:
        targets = [
            c for c in connections(project_id)
            if channel in (c.get("channels") or CHANNELS)
        ]
    except Exception as exc:  # noqa: BLE001
        log.warning("could not list realtime connections: %s", exc)
        return 0

    if not targets:
        return 0

    frame = json.dumps(
        {"channel": channel, "ts": db.now_ms(), "project_id": project_id,
         "data": payload},
        default=str, separators=(",", ":"),
    ).encode()

    if len(frame) > MAX_FRAME_BYTES:
        # Rather than drop the frame, tell the client to refetch. A truncated
        # payload would be worse than a nudge.
        frame = json.dumps({
            "channel": channel, "ts": db.now_ms(), "project_id": project_id,
            "truncated": True,
            "data": {"note": "payload exceeded the frame limit — refetch via REST"},
        }, separators=(",", ":")).encode()

    sent = 0
    for conn in targets:
        cid = conn.get("connection_id")
        if not cid:
            continue
        try:
            client.post_to_connection(ConnectionId=cid, Data=frame)
            sent += 1
        except client.exceptions.GoneException:
            # The browser went away without a clean disconnect.
            unregister(project_id=project_id, connection_id=cid)
        except Exception as exc:  # noqa: BLE001
            log.debug("realtime post failed for %s: %s", cid, exc)

    return sent


def publish_many(frames: Iterable[tuple[str, str, Any]]) -> int:
    """Publish several (project_id, channel, payload) frames. Never raises."""
    total = 0
    for project_id, channel, payload in frames:
        try:
            total += publish(project_id=project_id, channel=channel, payload=payload)
        except Exception:  # noqa: BLE001
            continue
    return total


# ── typed helpers, so frame shapes stay consistent across workers ───────

def publish_events(project_id: str, events: list[dict]) -> int:
    """Live event feed. One frame per SQS batch, not per event."""
    return publish(project_id=project_id, channel="events", payload={
        "events": [
            {
                "ts": e.get("ts"),
                "item_id": e.get("item_id"),
                "event_type": e.get("event_type"),
                "quantity": e.get("quantity"),
                "value": e.get("value"),
            }
            for e in events[:50]
        ],
        "count": len(events),
    })


def publish_signals(project_id: str, item_id: str, signals: dict) -> int:
    """Context update — demand, inventory, competitor gap and friends."""
    return publish(project_id=project_id, channel="kpis", payload={
        "type": "signals",
        "item_id": item_id,
        "signals": {k: v for k, v in signals.items() if not str(k).startswith("_")},
    })


def publish_decision(project_id: str, summary: dict) -> int:
    """Live pricing decision feed."""
    return publish(project_id=project_id, channel="decisions", payload={
        "decision_id": summary.get("decision_id"),
        "item_id": summary.get("item_id"),
        "previous_price": summary.get("previous_price"),
        "price": summary.get("final_price"),
        "changed": summary.get("changed"),
        "change_pct": summary.get("change_pct"),
        "rules_fired": summary.get("rules_fired", []),
        "guardrails_applied": summary.get("guardrail_names", []),
        "strategy_version": summary.get("strategy_version"),
        "degraded": summary.get("degraded"),
        "fallback": summary.get("fallback"),
        "latency_ms": summary.get("latency_ms"),
    })


def publish_alert(project_id: str, alert: dict, approval_id: str | None = None) -> int:
    return publish(project_id=project_id, channel="alerts", payload={
        "alert_id": alert.get("alert_id"),
        "severity": alert.get("severity"),
        "type": alert.get("type"),
        "title": alert.get("title"),
        "message": alert.get("message"),
        "item_id": alert.get("item_id"),
        "approval_id": approval_id,
        "needs_decision": bool(approval_id),
    })


def publish_health(project_id: str, health: dict) -> int:
    return publish(project_id=project_id, channel="health", payload=health)
