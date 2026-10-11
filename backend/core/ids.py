"""Identifier generation.

All ids are URL-safe by construction, because every DevNexus API is a GET and
every id therefore travels in a query string or a path segment. No id may
contain a character that needs percent-encoding.
"""

from __future__ import annotations

import secrets
import time

_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def _b36(n: int) -> str:
    if n == 0:
        return "0"
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append(_ALPHABET[r])
    return "".join(reversed(out))


def _stamp() -> str:
    """Base36 milliseconds. Keeps generated ids roughly sortable by creation."""
    return _b36(int(time.time() * 1000))


def gen(prefix: str, *, entropy: int = 6) -> str:
    """A prefixed, time-sortable, URL-safe id: `rul_m4k2p9_x7f2q1`."""
    return f"{prefix}_{_stamp()}_{secrets.token_hex(entropy // 2 + 1)[:entropy]}"


# ── typed helpers, so prefixes stay consistent across the codebase ──────

def user_id() -> str:        return gen("usr")
def tenant_id() -> str:      return gen("ten")
def project_id() -> str:     return gen("prj")
def rule_id() -> str:        return gen("rul")
def strategy_id() -> str:    return gen("str")
def job_id() -> str:         return gen("job")
def alert_id() -> str:       return gen("alr")
def approval_id() -> str:    return gen("apr")
def audit_id() -> str:       return gen("aud")
def device_id() -> str:      return gen("dev")
def event_id() -> str:       return gen("evt")


def decision_id() -> str:
    """Pricing decisions get a human-quotable id: `DEC-7K2P9X4M`.

    Analysts read these aloud, paste them into chat and type them into the
    Decision Replay box, so they are upper-case and short rather than long and
    machine-pretty.
    """
    return "DEC-" + secrets.token_hex(5).upper()[:8]


def session_token() -> str:
    """Opaque 256-bit session token. Not a JWT: carries no claims at all.

    Everything about the session (user, tenant, expiry) lives server-side in
    DynamoDB, which is what makes instant revocation possible.
    """
    return "sess_" + secrets.token_urlsafe(32)


def api_key(stage: str = "live") -> str:
    """Per-project API key. Appears in the path of that project's dynamic API."""
    return f"pk_{stage}_{secrets.token_urlsafe(24).replace('-', '').replace('_', '')[:32]}"


def idempotency_key() -> str:
    return gen("idm", entropy=12)
