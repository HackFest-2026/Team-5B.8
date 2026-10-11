"""Request dependencies: session resolution and tenant scoping.

The isolation rule this module exists to enforce:

    tenant_id is ALWAYS derived from the authenticated session.
    It is NEVER read from a query parameter, even if the client sends one.

Every handler that touches tenant data takes `Session` (or `ProjectCtx`) as a
dependency, so there is no code path that can reach DynamoDB with a tenant id
the caller supplied. `project_id` IS a query parameter, so `project_ctx` always
re-checks that the project belongs to the session's tenant before returning it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Query

from app.responses import Forbidden, NotFound, Unauthorized
from core import db
from core.config import settings


@dataclass(frozen=True, slots=True)
class Session:
    token: str
    user_id: str
    tenant_id: str | None
    email: str
    name: str
    registration_complete: bool


@dataclass(frozen=True, slots=True)
class ProjectCtx:
    session: Session
    project_id: str
    project: dict

    @property
    def tenant_id(self) -> str:
        return self.session.tenant_id  # type: ignore[return-value]

    @property
    def schema(self) -> dict:
        return self.project.get("schema") or {}

    @property
    def guardrails(self) -> dict:
        return self.project.get("guardrails") or {}

    @property
    def currency(self) -> str:
        return self.project.get("currency", "INR")


def resolve_session(token: str) -> Session:
    """One GetItem. No signature verification, no clock skew, no key rotation.

    Expiry is enforced here as well as by DynamoDB TTL, because TTL deletion is
    best-effort and can lag by minutes — long enough for a logged-out token to
    still resolve if we trusted TTL alone.
    """
    row = db.get(db.core(), db.pk_session(token), db.sk_meta())
    if not row:
        raise Unauthorized()
    if row.get("expires_at", 0) < db.now_s():
        raise Unauthorized("session expired")
    return Session(
        token=token,
        user_id=row["user_id"],
        tenant_id=row.get("tenant_id"),
        email=row.get("email", ""),
        name=row.get("name", ""),
        registration_complete=bool(row.get("tenant_id")),
    )


async def current_session(
    token: Annotated[str, Query(description="Session token from /auth/login")],
) -> Session:
    return resolve_session(token)


async def registered_session(
    session: Annotated[Session, Depends(current_session)],
) -> Session:
    """A session that has completed step 2 and therefore has a tenant.

    Signup is deliberately two-step, so a token can legitimately exist with no
    tenant attached. Everything except /auth/complete-profile requires one.
    """
    if not session.tenant_id:
        raise Forbidden(
            "registration incomplete — call /auth/complete-profile with your "
            "company details first"
        )
    return session


async def project_ctx(
    project_id: Annotated[str, Query(description="Project id")],
    session: Annotated[Session, Depends(registered_session)],
) -> ProjectCtx:
    """Load a project, proving it belongs to the caller's tenant.

    The read is keyed by the session's tenant, so a project id belonging to
    another tenant simply does not exist from this caller's perspective. There
    is no ownership check to forget, because a wrong tenant cannot address the
    row at all.
    """
    row = db.get(
        db.core(), db.pk_tenant(session.tenant_id), db.sk_project(project_id)  # type: ignore[arg-type]
    )
    if not row:
        raise NotFound("project")
    return ProjectCtx(session=session, project_id=project_id, project=row)


def resolve_api_key(key: str) -> dict:
    """Customer-facing runtime auth: project API key -> {tenant_id, project_id}.

    Used by the dynamic per-project endpoints. Separate from session auth
    because external systems must never hold an analyst's session token.
    """
    row = db.get(db.core(), db.pk_apikey(key), db.sk_meta())
    if not row or row.get("revoked"):
        raise Unauthorized("invalid API key")
    return row


SessionDep = Annotated[Session, Depends(current_session)]
RegisteredDep = Annotated[Session, Depends(registered_session)]
ProjectDep = Annotated[ProjectCtx, Depends(project_ctx)]
