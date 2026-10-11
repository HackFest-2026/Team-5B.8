"""WebSocket connection handler.

Three routes, one Lambda:

    $connect      authorize, register the connection
    $disconnect   deregister
    subscribe     narrow which channels this socket receives
    $default      anything else (ping, unknown action)

Authorization happens at $connect and NOWHERE ELSE. API Gateway only passes
query-string parameters on the connect frame, so the token arrives once, is
verified once, and the resulting connection is bound to a tenant and project
for its lifetime. Later frames carry no credentials and cannot change scope —
a socket authorized for project A can never be talked into receiving project B.

Like the pricing handler, this imports no FastAPI: it is a tiny event handler
and should stay that way.
"""

from __future__ import annotations

import json
import logging
import os

from core import db, realtime

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("devnexus.ws")


def _reply(status: int, body: str = "") -> dict:
    return {"statusCode": status, "body": body}


def _resolve_session(token: str) -> dict | None:
    """Same opaque-token lookup the REST API uses. One GetItem."""
    if not token:
        return None
    row = db.get(db.core(), db.pk_session(token), db.sk_meta())
    if not row or row.get("expires_at", 0) < db.now_s():
        return None
    return row


def _owns_project(tenant_id: str, project_id: str) -> bool:
    """A socket may only watch a project its tenant actually owns.

    Keyed by the session's tenant, so a project belonging to someone else
    simply does not resolve — the same structural isolation the REST API uses.
    """
    return bool(db.get(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id)))


def _push(connection_id: str, frame: dict) -> bool:
    """Send one JSON frame to a single connection. Never raises."""
    client = realtime._client()
    if not client:
        return False
    try:
        client.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(frame, separators=(",", ":")).encode(),
        )
        return True
    except Exception:  # noqa: BLE001 - a dead socket must not crash the stream
        return False


def _agent(connection_id: str, body: dict) -> dict:
    """Stream a schema-design reply token by token over the socket.

    The whole reply is relayed as it is generated, in small buffered frames so
    the UI types smoothly without a per-token API call. The client reads the
    deltas, shows the prose and applies the §directives live.
    """
    from core.ai.agent import (
        AGENT_SYSTEM, PROJECT_SYSTEM, build_contents, build_project_contents,
        stream_reply,
    )

    reg = _registration_for_connection(connection_id)
    project_id = reg.get("project_id") if reg else None
    tenant_id = reg.get("tenant_id") if reg else None
    if not project_id:
        return _reply(404, "connection not registered")

    history = body.get("history") or []
    if not isinstance(history, list):
        history = []
    project_name = str(body.get("project_name") or "")[:120]
    schema_summary = str(body.get("schema_summary") or "")[:2000]

    # Two assistants share this one streaming path: the wizard's schema designer
    # ("schema" mode) and the in-project assistant ("project" mode) that writes
    # rules, limits and test cases and can switch tabs. They differ only in the
    # system prompt and the context they are handed.
    mode = str(body.get("mode") or "schema")[:16]
    if mode == "project":
        surface = str(body.get("surface") or "overview")[:24]
        guardrails = str(body.get("guardrails") or "")[:400]
        analytics = str(body.get("analytics") or "")[:600]
        rules_summary = str(body.get("rules") or "")[:1600]
        contents = build_project_contents(
            history, project_name, surface, schema_summary, guardrails, analytics,
            rules_summary)
        system = PROJECT_SYSTEM
    else:
        stage = str(body.get("stage") or "schema")[:24]
        manual_changes = str(body.get("manual_changes") or "")[:800]
        items_summary = str(body.get("items_summary") or "")[:1600]
        contents = build_contents(
            history, project_name, stage, schema_summary, manual_changes, items_summary)
        system = AGENT_SYSTEM

    _push(connection_id, {"type": "agent_start"})
    buf = []
    buf_len = 0
    last_flush = db.now_ms()
    full = []  # the whole raw reply, for persistence (directives included)

    def flush():
        nonlocal buf, buf_len, last_flush
        if buf:
            _push(connection_id, {"type": "agent_delta", "text": "".join(buf)})
            buf = []
            buf_len = 0
            last_flush = db.now_ms()

    try:
        for delta in stream_reply(contents, system=system):
            buf.append(delta)
            full.append(delta)
            buf_len += len(delta)
            # Flush on a newline (so a completed §directive arrives whole), on a
            # size threshold, or every ~70ms — whichever comes first.
            if "\n" in delta or buf_len >= 24 or (db.now_ms() - last_flush) >= 70:
                flush()
        flush()
        _push(connection_id, {"type": "agent_done"})
        # Persist the turn: the client's history (user + prior turns) plus the
        # reply we just produced, so the whole exchange is there when the chat
        # is reopened. The raw reply is stored — the client strips §directives
        # for display exactly as it does while streaming.
        _persist_turn(tenant_id, project_id, history, "".join(full))
    except Exception as exc:  # noqa: BLE001
        flush()
        _push(connection_id, {"type": "agent_error",
                              "message": "The assistant is unavailable right now. "
                                         "You can keep building the schema by hand."})
        log.warning("agent stream failed: %s", exc)

    return _reply(200, "ok")


def _persist_turn(tenant_id, project_id, history: list, reply: str) -> None:
    """Store the conversation so far, with the assistant reply appended."""
    if not tenant_id or not project_id:
        return
    from core import agent_chat

    transcript = [
        {"role": m.get("role"), "content": m.get("content")}
        for m in history
        if isinstance(m, dict)
    ]
    transcript.append({"role": "assistant", "content": reply})
    agent_chat.save(tenant_id, project_id, transcript)


def handler(event, _context):
    ctx = event.get("requestContext") or {}
    route = ctx.get("routeKey")
    connection_id = ctx.get("connectionId")

    # ── $connect ────────────────────────────────────────────────────────
    if route == "$connect":
        params = event.get("queryStringParameters") or {}
        token = params.get("token", "")
        project_id = (params.get("project_id") or "").strip()

        session = _resolve_session(token)
        if not session:
            # Refusing here means the socket never opens, which is the only
            # place we get to say no — there is no 401 frame after connect.
            return _reply(401, "invalid or expired token")

        tenant_id = session.get("tenant_id")
        if not tenant_id:
            return _reply(403, "registration incomplete")

        if not project_id:
            return _reply(400, "project_id is required")

        if not _owns_project(tenant_id, project_id):
            return _reply(403, "unknown project for this tenant")

        channels = [
            c.strip() for c in (params.get("channels") or "").split(",") if c.strip()
        ]

        try:
            realtime.register(
                project_id=project_id,
                connection_id=connection_id,
                tenant_id=tenant_id,
                channels=channels or None,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("could not register connection: %s", exc)
            return _reply(500, "could not register connection")

        log.info("ws connect %s project=%s channels=%s",
                 connection_id, project_id, channels or "all")
        return _reply(200, "connected")

    # ── $disconnect ─────────────────────────────────────────────────────
    if route == "$disconnect":
        # API Gateway does NOT replay query-string params on disconnect, so the
        # project is recovered from the registry. A scan would be wasteful, so
        # we rely on the TTL as a backstop if this lookup misses.
        project_id = _find_project_for_connection(connection_id)
        if project_id:
            realtime.unregister(project_id=project_id, connection_id=connection_id)
        log.info("ws disconnect %s", connection_id)
        return _reply(200, "disconnected")

    # ── subscribe / default ─────────────────────────────────────────────
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        body = {}

    action = body.get("action", "")

    if action == "subscribe":
        project_id = _find_project_for_connection(connection_id)
        if not project_id:
            return _reply(404, "connection not registered")
        channels = body.get("channels") or []
        if not isinstance(channels, list):
            return _reply(400, "channels must be an array")
        realtime.set_channels(
            project_id=project_id, connection_id=connection_id, channels=channels
        )
        return _reply(200, json.dumps({
            "subscribed": [c for c in channels if c in realtime.CHANNELS]
                          or list(realtime.CHANNELS),
            "available": list(realtime.CHANNELS),
        }))

    if action == "agent":
        return _agent(connection_id, body)

    if action == "ping":
        return _reply(200, json.dumps({"pong": db.now_ms()}))

    return _reply(200, json.dumps({
        "note": "unknown action",
        "actions": ["subscribe", "ping"],
        "channels": list(realtime.CHANNELS),
    }))


def _find_project_for_connection(connection_id: str) -> str | None:
    """Recover which project a connection belongs to.

    API Gateway does not replay query-string parameters on $disconnect, so the
    project id is looked up from the reverse-index row written at connect time.
    One GetItem — no scan, no cache to go stale.
    """
    try:
        return realtime.project_for_connection(connection_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("connection lookup failed for %s: %s", connection_id, exc)
        return None


def _registration_for_connection(connection_id: str) -> dict | None:
    """Recover {project_id, tenant_id} for a connection in one read."""
    try:
        return realtime.registration_for_connection(connection_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("registration lookup failed for %s: %s", connection_id, exc)
        return None
