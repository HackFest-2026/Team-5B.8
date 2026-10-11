"""Account APIs — the two-step registration flow.

    1. GET /auth/signup           email + password      -> partial account
    2. GET /auth/login            email + password      -> session token
    3. GET /auth/complete-profile company details       -> tenant created
    4. GET /auth/me               token                 -> bootstrap payload

Step 1 creates a user with NO tenant. The analyst is signed in but cannot do
anything except step 3. That is why `registered_session` exists as a separate
dependency from `current_session`.

Not built on purpose: logout (the session TTL handles it), password reset,
profile update, account deletion, email verification. None of them demonstrate
anything about dynamic pricing, and each one is a surface to get wrong.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import SessionDep, resolve_session
from app.responses import ApiError, Conflict, Unauthorized, ok
from core import audit, catalog, db, ids, security
from core.config import settings

router = APIRouter(tags=["auth"])

VALID_SERVICE_TYPES = {s["id"] for s in catalog.SERVICE_TYPES}
VALID_CURRENCIES = {c["id"] for c in catalog.CURRENCIES}


def _issue_session(user: dict) -> dict:
    """Mint an opaque session token and store it server-side.

    DynamoDB TTL reaps the row automatically; `expires_at` is also checked on
    read because TTL deletion can lag by several minutes.
    """
    token = ids.session_token()
    ttl = settings().session_ttl_seconds
    db.put(db.core(), {
        "pk": db.pk_session(token),
        "sk": db.sk_meta(),
        "user_id": user["user_id"],
        "tenant_id": user.get("tenant_id"),
        "email": user["email"],
        "name": user.get("name", ""),
        "created_at": db.now_ms(),
        "expires_at": db.ttl_in(ttl),
        "ttl": db.ttl_in(ttl),
    })
    return {"token": token, "expires_in": ttl}


@router.get("/auth/signup", summary="Step 1 — partial registration")
async def signup(
    email: Annotated[str, Query(description="Work email")],
    password: Annotated[str, Query(min_length=8, description="At least 8 characters")],
    name: Annotated[str, Query(description="Full name")] = "",
):
    """Create the login identity. Company details come later, in step 2."""
    email = security.normalize_email(email)
    if "@" not in email or "." not in email.split("@")[-1]:
        raise ApiError("that does not look like a valid email address")

    try:
        pw_hash = security.hash_password(password)
    except ValueError as exc:
        raise ApiError(str(exc)) from exc

    user_id = ids.user_id()
    created = db.put(db.core(), {
        "pk": db.pk_user(email),
        "sk": db.sk_profile(),
        "user_id": user_id,
        "email": email,
        "name": name.strip(),
        "password_hash": pw_hash,
        "tenant_id": None,
        "registration_complete": False,
        "created_at": db.now_ms(),
    }, unique=True)

    if not created:
        # Conditional write, so there is no read-then-write race here.
        raise Conflict("an account already exists for this email — try logging in")

    user = {"user_id": user_id, "email": email, "name": name.strip(), "tenant_id": None}
    sess = _issue_session(user)

    return ok({
        "user_id": user_id,
        "email": email,
        "registration_complete": False,
        "next_step": "complete-profile",
        **sess,
        # Bundled so the company form can render immediately without a second
        # round trip for its dropdown options.
        "service_types": catalog.SERVICE_TYPES,
        "currencies": catalog.CURRENCIES,
    })


@router.get("/auth/login", summary="Log in")
async def login(
    email: Annotated[str, Query()],
    password: Annotated[str, Query()],
):
    email = security.normalize_email(email)
    user = db.get(db.core(), db.pk_user(email), db.sk_profile())

    # Identical error whether the email is unknown or the password is wrong,
    # so this endpoint cannot be used to enumerate registered accounts.
    if not user or not security.verify_password(password, user.get("password_hash", "")):
        raise Unauthorized("incorrect email or password")

    sess = _issue_session(user)
    complete = bool(user.get("tenant_id"))

    body = {
        "user_id": user["user_id"],
        "email": email,
        "name": user.get("name", ""),
        "registration_complete": complete,
        "next_step": "dashboard" if complete else "complete-profile",
        **sess,
    }
    if not complete:
        body["service_types"] = catalog.SERVICE_TYPES
        body["currencies"] = catalog.CURRENCIES
    return ok(body)


@router.get("/auth/complete-profile", summary="Step 2 — company details")
async def complete_profile(
    session: SessionDep,
    company_name: Annotated[str, Query(description="Company name, not a username")],
    service_type: Annotated[str, Query(description="One of catalog.service_types")],
    currency: Annotated[str, Query()] = "INR",
    country: Annotated[str, Query()] = "IN",
    company_size: Annotated[str, Query()] = "",
):
    """Create the tenant. This is the isolation boundary for everything after."""
    if session.tenant_id:
        raise Conflict("this account already has a company profile")

    service_type = service_type.strip().lower()
    if service_type not in VALID_SERVICE_TYPES:
        raise ApiError(
            f"unknown service_type '{service_type}'",
            valid=sorted(VALID_SERVICE_TYPES),
        )
    currency = currency.strip().upper()
    if currency not in VALID_CURRENCIES:
        raise ApiError(f"unsupported currency '{currency}'", valid=sorted(VALID_CURRENCIES))
    if not company_name.strip():
        raise ApiError("company_name is required")

    tenant_id = ids.tenant_id()
    now = db.now_ms()

    db.put(db.core(), {
        "pk": db.pk_tenant(tenant_id),
        "sk": db.sk_profile(),
        "tenant_id": tenant_id,
        "company_name": company_name.strip(),
        "service_type": service_type,
        "country": country.strip().upper(),
        "currency": currency,
        "company_size": company_size.strip(),
        "owner_user_id": session.user_id,
        "created_at": now,
    })

    # Attach the tenant to both the user and the live session, so the caller
    # does not have to log in again to pick it up.
    db.update(db.core(), db.pk_user(session.email), db.sk_profile(), {
        "tenant_id": tenant_id, "registration_complete": True, "updated_at": now,
    })
    db.update(db.core(), db.pk_session(session.token), db.sk_meta(), {
        "tenant_id": tenant_id,
    })

    audit.record(
        tenant_id=tenant_id, action="TENANT_CREATED", actor=session.user_id,
        entity_type="tenant", entity_id=tenant_id,
        new_value={"company_name": company_name.strip(), "service_type": service_type},
    )

    # Suggest the matching domain template so project creation is one click.
    suggested = catalog.template(service_type)

    return ok({
        "tenant_id": tenant_id,
        "company_name": company_name.strip(),
        "service_type": service_type,
        "currency": currency,
        "registration_complete": True,
        "next_step": "create-project",
        "suggested_template": suggested,
        "domain_templates": catalog.DOMAIN_TEMPLATES,
    })


@router.get("/auth/me", summary="Bootstrap the app in one call")
async def me(session: SessionDep):
    """Everything the SPA needs on load: user, tenant, projects, catalog.

    Deliberately one call rather than four. The web app and the Android home
    screen both start here, and on a weak mobile connection four sequential
    round trips is the difference between instant and sluggish.
    """
    user = db.get(db.core(), db.pk_user(session.email), db.sk_profile()) or {}
    body: dict = {
        "user": {
            "user_id": session.user_id,
            "email": session.email,
            "name": user.get("name", ""),
        },
        "registration_complete": bool(session.tenant_id),
        "catalog": catalog.catalog(),
    }

    if not session.tenant_id:
        body["next_step"] = "complete-profile"
        return ok(body)

    tenant = db.get(db.core(), db.pk_tenant(session.tenant_id), db.sk_profile()) or {}
    projects, _ = db.query_prefix(
        db.core(), db.pk_tenant(session.tenant_id), "PROJECT#", limit=100
    )

    body["tenant"] = {
        "tenant_id": session.tenant_id,
        "company_name": tenant.get("company_name"),
        "service_type": tenant.get("service_type"),
        "country": tenant.get("country"),
        "currency": tenant.get("currency"),
    }
    body["projects"] = [
        {
            "project_id": p["project_id"],
            "name": p.get("name"),
            "domain_name": p.get("domain_name"),
            "entity_label": p.get("entity_label"),
            "currency": p.get("currency"),
            "active_strategy_id": p.get("active_strategy_id"),
            "active_strategy_version": p.get("active_strategy_version"),
            "mode": p.get("mode", "draft"),
            "item_count": p.get("item_count", 0),
            "created_at": p.get("created_at"),
        }
        for p in projects
    ]
    body["next_step"] = "dashboard" if projects else "create-project"
    return ok(body)


@router.get("/meta/catalog", summary="Dropdown options and domain templates")
async def meta_catalog():
    """Public, token-free. Powers every dropdown in the UI from one source, so
    the frontend and the engine cannot drift apart on legal operators or
    adjustment types."""
    return ok({"catalog": catalog.catalog()})
