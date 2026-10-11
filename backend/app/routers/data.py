"""Historical data onboarding.

The only place in DevNexus where traffic is not a GET — and even then, our API
only *hands out* a presigned URL (via GET). The browser then PUTs the file
straight to S3.

That matters for more than purity. A 200MB CSV streamed through API Gateway and
Lambda would hit the 10MB payload limit, burn Lambda duration on I/O, and block
the API while it uploaded. Going direct to S3 means the file never touches our
compute, and an S3 event hands it to a worker through SQS.

    browser --(presigned PUT)--> S3 --event--> SQS --> data-worker
                                                          |
                                               validate, build features,
                                               write context, write reject file
"""

from __future__ import annotations

from typing import Annotated

import boto3
from fastapi import APIRouter, Query

from app.deps import ProjectDep
from app.responses import ApiError, NotFound, ok
from core import audit, db, ids
from core.config import REGION, settings

router = APIRouter(tags=["data"])

ALLOWED_EXTENSIONS = {".csv", ".tsv", ".json", ".jsonl", ".xlsx", ".xls"}
MAX_UPLOAD_BYTES = 500 * 1024 * 1024

_s3 = None


def s3():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3", region_name=REGION,
                           config=boto3.session.Config(signature_version="s3v4"))
    return _s3


@router.get("/data/upload-url", summary="Get a presigned S3 upload URL")
async def upload_url(
    ctx: ProjectDep,
    filename: Annotated[str, Query(description="Original filename, used for the extension")],
    kind: Annotated[str, Query(description="historical | items | competitor")] = "historical",
):
    """Create an upload job and return a presigned PUT URL.

    The URL is single-use in practice (15 minute TTL) and scoped to one exact
    object key, so it cannot be reused to overwrite another tenant's data. The
    key is prefixed with the tenant id, which is also how the bucket policy
    enforces isolation.
    """
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise ApiError(
            f"unsupported file type '{ext}'",
            allowed=sorted(ALLOWED_EXTENSIONS),
        )
    if kind not in ("historical", "items", "competitor"):
        raise ApiError("kind must be historical, items or competitor")

    job_id = ids.job_id()
    key = f"uploads/{ctx.tenant_id}/{ctx.project_id}/{kind}/{job_id}{ext}"
    now = db.now_ms()

    try:
        # Sign the Bucket and Key ONLY.
        #
        # Anything else included here (Metadata, ContentType) becomes part of
        # the signature, which means the client must send byte-identical
        # x-amz-meta-* / Content-Type headers or S3 rejects the PUT with a bare
        # 403. The caller has no way to know that from the URL, so signing
        # metadata made every upload fail — a browser hits it just as hard as a
        # script does.
        #
        # The job context lives in the object key instead:
        #   uploads/<tenant>/<project>/<kind>/<job_id><ext>
        # which the worker parses. Same information, nothing for the client to
        # get wrong.
        url = s3().generate_presigned_url(
            "put_object",
            Params={"Bucket": settings().bucket_data, "Key": key},
            ExpiresIn=settings().presign_ttl_seconds,
        )
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"could not create upload URL: {exc}",
                       code="storage_error", status_code=503) from exc

    db.put(db.core(), {
        "pk": db.pk_tenant(ctx.tenant_id),
        "sk": db.sk_job(ctx.project_id, job_id),
        "job_id": job_id,
        "project_id": ctx.project_id,
        "type": "upload",
        "kind": kind,
        "filename": filename,
        "s3_key": key,
        "status": "awaiting_upload",
        "created_at": now,
        "created_by": ctx.session.user_id,
    })

    audit.record(
        tenant_id=ctx.tenant_id, action="DATA_UPLOADED", actor=ctx.session.user_id,
        project_id=ctx.project_id, entity_type="job", entity_id=job_id,
        new_value={"filename": filename, "kind": kind},
    )

    return ok({
        "job_id": job_id,
        "upload_url": url,
        "method": "PUT",
        "expires_in": settings().presign_ttl_seconds,
        "max_bytes": MAX_UPLOAD_BYTES,
        "instructions": (
            "PUT the raw file to upload_url with "
            "Content-Type: application/octet-stream. Processing starts "
            "automatically; poll /data/job for progress."
        ),
        "required_columns": _expected_columns(kind, ctx.schema),
    })


def _expected_columns(kind: str, schema: dict) -> dict:
    """Tell the analyst what the file should contain, derived from THEIR schema.

    Not a fixed list: the expected columns for a hotel and for an EV charging
    network differ, and both come from the same code path.
    """
    signals = [s["id"] for s in (schema.get("context_signals") or [])]
    attrs = [a["id"] for a in (schema.get("attributes") or [])]

    if kind == "items":
        return {
            "required": ["item_id", "name", "base_price"],
            "optional": ["cost", *attrs],
        }
    if kind == "competitor":
        return {"required": ["item_id", "timestamp", "competitor_price"], "optional": []}
    return {
        "required": ["item_id", "timestamp"],
        "optional": ["previous_price", "demand", "sales", "orders", *signals],
        "note": "Optional columns map onto this project's context signals. "
                "Unknown columns are ignored with a warning, not rejected.",
    }


@router.get("/data/jobs", summary="Upload history and validation summaries")
async def list_jobs(
    ctx: ProjectDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
):
    rows, _ = db.query_prefix(
        db.core(), db.pk_tenant(ctx.tenant_id), db.sk_job_prefix(ctx.project_id),
        limit=limit, ascending=False,
    )
    rows = [r for r in rows if r.get("type") == "upload"]

    return ok({
        "count": len(rows),
        "jobs": [
            {
                "job_id": r["job_id"],
                "filename": r.get("filename"),
                "kind": r.get("kind"),
                "status": r.get("status"),
                "rows_total": r.get("rows_total"),
                "rows_valid": r.get("rows_valid"),
                "rows_invalid": r.get("rows_invalid"),
                "rows_warned": r.get("rows_warned"),
                "created_at": r.get("created_at"),
                "completed_at": r.get("completed_at"),
                "error": r.get("error"),
            }
            for r in rows
        ],
    })


@router.get("/data/job", summary="Validation detail and rejected-row download")
async def get_job(
    ctx: ProjectDep,
    job_id: Annotated[str, Query()],
):
    """Row-level errors plus a presigned download for the rejected rows.

    Rejections come back as a file the analyst can fix and re-upload, rather
    than a wall of error text they have to transcribe.
    """
    row = db.get(db.core(), db.pk_tenant(ctx.tenant_id), db.sk_job(ctx.project_id, job_id))
    if not row:
        raise NotFound("job")

    reject_url = None
    if row.get("reject_key"):
        try:
            reject_url = s3().generate_presigned_url(
                "get_object",
                Params={"Bucket": settings().bucket_data, "Key": row["reject_key"]},
                ExpiresIn=settings().presign_ttl_seconds,
            )
        except Exception:  # noqa: BLE001
            reject_url = None

    total = row.get("rows_total") or 0
    valid = row.get("rows_valid") or 0

    return ok({
        "job_id": job_id,
        "filename": row.get("filename"),
        "kind": row.get("kind"),
        "status": row.get("status"),
        "summary": {
            "rows_total": total,
            "rows_valid": valid,
            "rows_invalid": row.get("rows_invalid", 0),
            "rows_warned": row.get("rows_warned", 0),
            "quality_pct": round(valid / total * 100, 1) if total else None,
        },
        "errors_by_type": row.get("errors_by_type", {}),
        "sample_errors": row.get("sample_errors", [])[:20],
        "unknown_columns": row.get("unknown_columns", []),
        "items_affected": row.get("items_affected", 0),
        "rejected_rows_url": reject_url,
        "created_at": row.get("created_at"),
        "completed_at": row.get("completed_at"),
        "error": row.get("error"),
    })
