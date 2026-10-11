"""Firebase Cloud Messaging (HTTP v1).

Sends the critical subset of alerts to the analyst's phone. The rule from the
spec, enforced here and in the alert worker:

    info      dashboard only — never pushed
    warning   pushed to devices that opted in
    critical  pushed to every registered device, high priority

Notification spam is the fastest way to make an on-call app useless, so the
severity gate is not a preference setting the analyst can accidentally widen.

Two implementation notes:

  * The OAuth access token is minted from the service account and cached in
    module scope for its full hour. Re-signing a JWT on every send would add
    ~200ms to each notification and hammer Google's token endpoint.
  * HTTP v1 has no multicast, so one request per device token, fanned out
    across a small thread pool. Dead tokens (404/403 UNREGISTERED) are pruned
    automatically — which is why there is no /devices/unregister endpoint.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

from core import db
from core.config import fcm_service_account, settings

log = logging.getLogger("devnexus.fcm")

_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_TOKEN_URL = "https://oauth2.googleapis.com/token"

_token: str | None = None
_token_expires_at: float = 0.0
_token_lock = threading.Lock()


def _access_token() -> str:
    """Mint (and cache) a short-lived OAuth token from the service account."""
    global _token, _token_expires_at

    with _token_lock:
        # 60s safety margin so a token never expires mid-flight.
        if _token and time.time() < _token_expires_at - 60:
            return _token

        sa = fcm_service_account()

        # google-auth handles RS256 signing and the JWT-bearer exchange. It is
        # worth the dependency: hand-rolling this means owning key parsing,
        # clock skew and refresh logic.
        from google.auth.transport.requests import Request  # noqa: PLC0415
        from google.oauth2 import service_account  # noqa: PLC0415

        creds = service_account.Credentials.from_service_account_info(sa, scopes=[_SCOPE])
        creds.refresh(Request())

        _token = creds.token
        _token_expires_at = creds.expiry.timestamp() if creds.expiry else time.time() + 3300
        return _token  # type: ignore[return-value]


def _project_id() -> str:
    pid = settings().fcm_project_id
    if pid:
        return pid
    return fcm_service_account().get("project_id", "")


def _build_message(
    *, token: str, title: str, body: str, severity: str, data: dict
) -> dict:
    critical = severity == "critical"
    return {
        "message": {
            "token": token,
            "notification": {"title": title[:45], "body": body[:160]},
            # All data values must be strings in FCM v1; a non-string silently
            # fails the whole send.
            "data": {k: str(v) for k, v in data.items() if v not in (None, "")}
                    | {"severity": severity},
            "android": {
                "priority": "HIGH" if critical else "NORMAL",
                "notification": {
                    # Critical alerts target the app's custom-sound channel
                    # (created in push.dart as Env.alertsChannelId) so the 4s tone
                    # + strong vibration play even when the app is fully closed —
                    # on Android 8+ the CHANNEL's sound wins, so the message must
                    # name the right channel, not just set default_sound.
                    "channel_id": "devnexus_alerts_v3" if critical else "devnexus_alerts",
                    "notification_priority": "PRIORITY_MAX" if critical else "PRIORITY_DEFAULT",
                    "default_sound": True,
                    "default_vibrate_timings": critical,
                    # Critical alerts must survive Doze. Normal ones must not.
                    "visibility": "PUBLIC" if critical else "PRIVATE",
                },
                # Collapse repeated alerts about the same thing into one.
                "collapse_key": data.get("approval_id") or data.get("project_id") or "devnexus",
                "ttl": "3600s" if critical else "86400s",
            },
        }
    }


def _send_one(client: httpx.Client, url: str, headers: dict, msg: dict) -> tuple[bool, str]:
    try:
        r = client.post(url, headers=headers, json=msg, timeout=8.0)
        if r.status_code == 200:
            return True, "ok"
        err = r.json().get("error", {}) if r.headers.get("content-type", "").startswith("application/json") else {}
        detail = err.get("status") or err.get("message") or r.text[:120]
        return False, f"{r.status_code}:{detail}"
    except Exception as exc:  # noqa: BLE001
        return False, f"transport:{exc}"


_DEAD_TOKEN_MARKERS = ("UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND", "404:", "403:")


def send_to_devices(
    *,
    devices: list[dict],
    title: str,
    body: str,
    severity: str,
    data: dict | None = None,
    tenant_id: str | None = None,
) -> dict:
    """Fan out to every registered device. Never raises.

    A notification failure must not fail the alert that triggered it — the
    dashboard copy of the alert is the source of truth, push is best-effort.
    """
    if severity == "info":
        return {"sent": 0, "skipped": True, "reason": "info alerts are not pushed"}

    targets = [
        d for d in devices
        if d.get("fcm_token") and (severity == "critical" or d.get("warnings_enabled", True))
    ]
    if not targets:
        return {"sent": 0, "reason": "no eligible devices"}

    try:
        token = _access_token()
        project = _project_id()
    except Exception as exc:  # noqa: BLE001
        log.error("FCM auth failed: %s", exc)
        return {"sent": 0, "failed": len(targets), "error": f"fcm auth failed: {exc}"}

    url = f"https://fcm.googleapis.com/v1/projects/{project}/messages:send"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = data or {}

    sent, failures, dead = 0, [], []
    with httpx.Client() as client:
        with ThreadPoolExecutor(max_workers=min(8, len(targets))) as pool:
            jobs = {
                pool.submit(
                    _send_one, client, url, headers,
                    _build_message(
                        token=d["fcm_token"], title=title, body=body,
                        severity=severity, data=payload,
                    ),
                ): d
                for d in targets
            }
            for fut, device in jobs.items():
                okay, detail = fut.result()
                if okay:
                    sent += 1
                else:
                    failures.append({"device_id": device.get("device_id"), "detail": detail})
                    if any(m in detail for m in _DEAD_TOKEN_MARKERS):
                        dead.append(device)

    # Prune tokens FCM has told us are gone. This is why the API surface has no
    # unregister endpoint: the uninstall signal comes from FCM itself.
    if dead and tenant_id:
        for d in dead:
            try:
                db.delete(db.core(), db.pk_tenant(tenant_id), db.sk_device(d["device_id"]))
            except Exception:  # noqa: BLE001
                pass

    if failures:
        log.warning("FCM: %d sent, %d failed: %s", sent, len(failures), failures[:3])

    return {
        "sent": sent,
        "failed": len(failures),
        "pruned_dead_tokens": len(dead),
        "severity": severity,
        "failures": failures[:5],
    }


def send_approval(*, tenant_id: str, approval: dict) -> dict:
    """Push an approval request. Called by the alert worker after the question
    and its options are already stored — so tapping the notification opens a
    screen that is ready, not one that waits on a model."""
    devices, _ = db.query_prefix(
        db.core(), db.pk_tenant(tenant_id), db.sk_device_prefix(), limit=50
    )
    return send_to_devices(
        devices=devices,
        title=approval.get("notification_title") or "Pricing decision needed",
        body=approval.get("notification_body") or approval.get("question", ""),
        severity=approval.get("severity", "warning"),
        data={
            "type": "approval",
            "approval_id": approval.get("approval_id"),
            "project_id": approval.get("project_id"),
            "item_id": approval.get("item_id"),
            "options": len(approval.get("options", [])),
        },
        tenant_id=tenant_id,
    )
