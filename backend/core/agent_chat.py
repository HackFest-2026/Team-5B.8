"""Durable storage for the schema-design agent's conversation.

The wizard's assistant is not a throwaway chat: the user builds a pricing
schema with it over several steps and expects the whole exchange to still be
there when they come back to the project. So every turn is persisted, and the
transcript is loaded when the chat is reopened.

One DynamoDB item per project holds the entire transcript. A wizard
conversation is a few dozen short messages — comfortably inside the 400 KB
item limit — and keeping it as one item makes "load the whole history" a single
GetItem with no pagination. A hard cap trims the oldest turns if a conversation
ever runs long, so the item can never grow unbounded.
"""

from __future__ import annotations

import logging

from core import db

log = logging.getLogger("devnexus.agent_chat")

# Keep the transcript bounded. Far more than any real wizard session needs, but
# it guarantees the item stays well under the DynamoDB size limit.
MAX_MESSAGES = 200
MAX_CONTENT = 8000  # one pathological message cannot blow the item up


def _clean(messages: list) -> list[dict]:
    """Normalise to the shape the client sends: role + content (+ applied)."""
    out: list[dict] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").strip().lower()
        if role not in ("user", "assistant"):
            continue
        content = str(m.get("content") or "")[:MAX_CONTENT]
        msg: dict = {"role": role, "content": content}
        applied = m.get("applied")
        if isinstance(applied, list) and applied:
            msg["applied"] = [str(x)[:60] for x in applied][:20]
        out.append(msg)
    return out[-MAX_MESSAGES:]


def load(tenant_id: str, project_id: str) -> list[dict]:
    """The full transcript for a project, oldest first. Empty if none yet."""
    if not tenant_id or not project_id:
        return []
    row = db.get(db.core(), db.pk_tenant(tenant_id), db.sk_agent_chat(project_id))
    if not row:
        return []
    messages = row.get("messages")
    return messages if isinstance(messages, list) else []


def save(tenant_id: str, project_id: str, messages: list) -> None:
    """Replace the stored transcript with `messages`. Never raises.

    The client always holds the authoritative, ordered conversation, so each
    turn sends the whole thing and we overwrite — no merge, no race between the
    REST read and the socket write beyond last-writer-wins, which is exactly
    what a single-user wizard wants.
    """
    if not tenant_id or not project_id:
        return
    try:
        db.put(db.core(), {
            "pk": db.pk_tenant(tenant_id),
            "sk": db.sk_agent_chat(project_id),
            "messages": _clean(messages),
            "updated_at": db.now_ms(),
        })
    except Exception as exc:  # noqa: BLE001 - persistence must not break the stream
        log.warning("could not persist agent chat for %s/%s: %s",
                    tenant_id, project_id, exc)
