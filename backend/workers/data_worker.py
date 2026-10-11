"""Data worker — historical uploads become items and context.

    S3 event -> SQS -> this worker -> validate -> write items / seed context
                                              -> write a rejected-rows file

Validation is strict about what it rejects and generous about what it warns on.
A row with a negative price is wrong and gets rejected. A column that isn't in
the project's schema is probably just an extra column in the analyst's export,
so it is ignored with a warning rather than failing a 90,000-row file.

Rejections come back as a downloadable file, not a wall of error text. The
analyst fixes that file and re-uploads it.

Streaming matters: files are read line by line from the S3 body rather than
loaded whole. A 500MB CSV must not need 500MB of Lambda memory.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
from collections import defaultdict

import boto3

from core import audit, db
from core.config import REGION, settings

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("devnexus.data_worker")

_s3 = boto3.client("s3", region_name=REGION)
_sqs = boto3.client("sqs", region_name=REGION)

MAX_SAMPLE_ERRORS = 50
BATCH_SIZE = 25


class RowError(ValueError):
    pass


def _parse_number(value, field: str, *, allow_negative: bool = False) -> float | None:
    if value in (None, "", "NULL", "null", "NaN", "-"):
        return None
    try:
        # Tolerate "₹70,000" and "1 234.50" — real exports contain both.
        cleaned = str(value).replace(",", "").replace(" ", "")
        cleaned = "".join(c for c in cleaned if c.isdigit() or c in ".-")
        n = float(cleaned)
    except ValueError:
        raise RowError(f"{field}: '{value}' is not a number")
    if not allow_negative and n < 0:
        raise RowError(f"{field}: cannot be negative (got {n})")
    if n != n or n in (float("inf"), float("-inf")):
        raise RowError(f"{field}: not a finite number")
    return n


def _parse_timestamp(value, field: str = "timestamp") -> int | None:
    if not value:
        return None
    import datetime as dt

    text = str(value).strip()
    if text.isdigit():
        n = int(text)
        # Heuristic: 10 digits is seconds, 13 is milliseconds.
        return n * 1000 if n < 10_000_000_000 else n
    for fmt in (
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y",
    ):
        try:
            return int(dt.datetime.strptime(text, fmt)
                       .replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        except ValueError:
            continue
    raise RowError(f"{field}: '{value}' is not a recognised date/time")


def _rows_from(body, key: str):
    """Yield dict rows, streaming. Never loads the whole object."""
    ext = key.rsplit(".", 1)[-1].lower()

    if ext in ("csv", "tsv"):
        delimiter = "\t" if ext == "tsv" else ","
        stream = io.TextIOWrapper(body, encoding="utf-8-sig", errors="replace")
        yield from csv.DictReader(stream, delimiter=delimiter)

    elif ext == "jsonl":
        for line in io.TextIOWrapper(body, encoding="utf-8", errors="replace"):
            line = line.strip()
            if line:
                yield json.loads(line)

    elif ext == "json":
        data = json.loads(body.read().decode("utf-8", errors="replace"))
        rows = data if isinstance(data, list) else data.get("rows") or data.get("data") or []
        yield from rows

    elif ext in ("xlsx", "xls"):
        try:
            import openpyxl  # noqa: PLC0415
        except ImportError:
            raise RowError(
                "Excel support needs openpyxl in the deployment bundle. "
                "Export to CSV as a workaround."
            )
        wb = openpyxl.load_workbook(io.BytesIO(body.read()), read_only=True, data_only=True)
        sheet = wb.active
        rows = sheet.iter_rows(values_only=True)
        header = [str(h).strip() if h is not None else "" for h in next(rows)]
        for row in rows:
            yield {header[i]: v for i, v in enumerate(row) if i < len(header) and header[i]}
    else:
        raise RowError(f"unsupported file extension '.{ext}'")


def _process_items(rows, project_id: str, tenant_id: str, schema: dict) -> dict:
    """Catalogue import: item_id, name, base_price [, cost, attributes]."""
    known_attrs = {a["id"] for a in (schema.get("attributes") or [])}
    stats = {
        "total": 0, "valid": 0, "invalid": 0, "warned": 0,
        "errors_by_type": defaultdict(int), "sample_errors": [],
        "unknown_columns": set(), "items": set(),
    }
    batch: list[dict] = []

    for n, row in enumerate(rows, 1):
        stats["total"] = n
        try:
            item_id = str(row.get("item_id") or row.get("id") or "").strip()
            if not item_id:
                raise RowError("item_id is required")

            base_price = _parse_number(row.get("base_price") or row.get("price"), "base_price")
            if base_price is None or base_price <= 0:
                raise RowError("base_price must be a positive number")

            cost = _parse_number(row.get("cost"), "cost")
            if cost is not None and cost >= base_price:
                raise RowError(f"cost ({cost}) must be below base_price ({base_price})")

            attributes = {}
            for col, value in row.items():
                if col in ("item_id", "id", "name", "base_price", "price", "cost"):
                    continue
                if col in known_attrs:
                    attributes[col] = value
                elif col:
                    stats["unknown_columns"].add(col)

            now = db.now_ms()
            batch.append({
                "pk": db.pk_tenant(tenant_id),
                "sk": db.sk_item(project_id, item_id),
                "project_id": project_id, "item_id": item_id,
                "name": str(row.get("name") or item_id).strip(),
                "base_price": base_price, "cost": cost,
                "attributes": attributes,
                "created_at": now, "updated_at": now,
            })
            stats["items"].add(item_id)
            stats["valid"] += 1

            if len(batch) >= BATCH_SIZE:
                db.batch_put(db.core(), batch)
                _seed_contexts(project_id, batch)
                batch = []

        except (RowError, ValueError, TypeError) as exc:
            stats["invalid"] += 1
            stats["errors_by_type"][str(exc).split(":")[0]] += 1
            if len(stats["sample_errors"]) < MAX_SAMPLE_ERRORS:
                stats["sample_errors"].append({"row": n, "error": str(exc), "data": _trim(row)})

    if batch:
        db.batch_put(db.core(), batch)
        _seed_contexts(project_id, batch)

    return stats


def _seed_contexts(project_id: str, items: list[dict]) -> None:
    """Give each imported item a context row so it can be priced immediately."""
    db.batch_put(db.context(), [
        {
            "pk": db.ctx_pk(project_id, it["item_id"]),
            "sk": db.ctx_sk(),
            "project_id": project_id, "item_id": it["item_id"],
            "base_price": it["base_price"], "cost": it.get("cost"),
            "previous_price": None, "signals": {}, "signal_updated_at": {},
            "counters": {}, "updated_at": db.now_ms(),
        }
        for it in items
    ])


def _process_historical(rows, project_id: str, tenant_id: str, schema: dict) -> dict:
    """Historical context: item_id, timestamp, plus whatever signals exist.

    Aggregated per item into a seed context so a brand-new project can price
    sensibly before a single live event arrives. Individual historical rows are
    kept for backtesting.
    """
    signal_ids = {s["id"] for s in (schema.get("context_signals") or [])}
    stats = {
        "total": 0, "valid": 0, "invalid": 0, "warned": 0,
        "errors_by_type": defaultdict(int), "sample_errors": [],
        "unknown_columns": set(), "items": set(),
    }
    per_item: dict[str, dict] = defaultdict(lambda: {"n": 0, "sums": defaultdict(float),
                                                    "last_price": None, "last_ts": 0})
    history: list[dict] = []

    for n, row in enumerate(rows, 1):
        stats["total"] = n
        try:
            item_id = str(row.get("item_id") or row.get("id") or "").strip()
            if not item_id:
                raise RowError("item_id is required")

            ts = _parse_timestamp(row.get("timestamp") or row.get("date") or row.get("ts"))
            if ts is None:
                raise RowError("timestamp is required")

            agg = per_item[item_id]
            agg["n"] += 1
            captured = {}

            for col, value in row.items():
                if col in ("item_id", "id", "timestamp", "date", "ts"):
                    continue
                if col in signal_ids or col in (
                    "demand", "sales", "orders", "inventory", "availability",
                    "traffic", "searches", "competitor_price", "previous_price",
                ):
                    num = _parse_number(value, col, allow_negative=True)
                    if num is not None:
                        agg["sums"][col] += num
                        captured[col] = num
                elif col:
                    stats["unknown_columns"].add(col)

            price = _parse_number(row.get("previous_price") or row.get("price"), "price")
            if price and ts > agg["last_ts"]:
                agg["last_price"] = price
                agg["last_ts"] = ts

            history.append({
                "pk": db.ctx_pk(project_id, item_id),
                "sk": f"HIST#{ts:013d}",
                "ts": ts, "item_id": item_id, "signals": captured,
                "price": price,
                "ttl": db.ttl_in(400 * 86400),
            })
            stats["items"].add(item_id)
            stats["valid"] += 1

            if len(history) >= BATCH_SIZE * 4:
                db.batch_put(db.context(), history)
                history = []

        except (RowError, ValueError, TypeError) as exc:
            stats["invalid"] += 1
            stats["errors_by_type"][str(exc).split(":")[0]] += 1
            if len(stats["sample_errors"]) < MAX_SAMPLE_ERRORS:
                stats["sample_errors"].append({"row": n, "error": str(exc), "data": _trim(row)})

    if history:
        db.batch_put(db.context(), history)

    # Seed each item's live context with its historical averages, so rules have
    # something sane to evaluate before the first real event lands.
    for item_id, agg in per_item.items():
        if not agg["n"]:
            continue
        averages = {k: round(v / agg["n"], 3) for k, v in agg["sums"].items()}
        existing = db.get(db.context(), db.ctx_pk(project_id, item_id), db.ctx_sk()) or {}
        merged = {**averages, **(existing.get("signals") or {})}
        db.update(db.context(), db.ctx_pk(project_id, item_id), db.ctx_sk(), {
            "signals": merged,
            "signal_updated_at": {k: db.now_ms() for k in merged},
            "previous_price": existing.get("previous_price") or agg["last_price"],
            "historical_rows": agg["n"],
            "updated_at": db.now_ms(),
        })

    return stats


def _trim(row: dict) -> dict:
    return {k: (str(v)[:40] if v is not None else None) for k, v in list(row.items())[:8]}


def _write_rejects(bucket: str, key: str, errors: list[dict]) -> str | None:
    if not errors:
        return None
    reject_key = key.rsplit(".", 1)[0] + ".rejected.csv"
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["row_number", "error", "data"])
    for e in errors:
        writer.writerow([e["row"], e["error"], json.dumps(e.get("data", {}))])
    try:
        _s3.put_object(
            Bucket=bucket, Key=reject_key,
            Body=buf.getvalue().encode(), ContentType="text/csv",
        )
        return reject_key
    except Exception as exc:  # noqa: BLE001
        log.warning("could not write reject file: %s", exc)
        return None


def handler(event, _context):
    failures: list[dict] = []

    for record in event.get("Records", []):
        message_id = record.get("messageId")
        try:
            tenant_id = project_id = job_id = None
            body = json.loads(record["body"])
            # S3 notifications can arrive wrapped in an SQS envelope.
            s3_records = body.get("Records") or [body]

            for s3_rec in s3_records:
                bucket = s3_rec.get("s3", {}).get("bucket", {}).get("name") or body.get("bucket")
                key = s3_rec.get("s3", {}).get("object", {}).get("key") or body.get("key")
                if not bucket or not key:
                    continue

                head = _s3.head_object(Bucket=bucket, Key=key)

                # The job context comes from the KEY, not from object metadata.
                # Presigning with metadata would force the client to send
                # matching x-amz-meta-* headers or get a 403, so the presigned
                # URL covers only bucket and key. Metadata is still honoured if
                # present, for objects written by anything that does set it.
                tenant_id = project_id = job_id = None
                kind = "historical"
                parts = key.split("/")
                if len(parts) >= 5 and parts[0] == "uploads":
                    tenant_id, project_id, kind = parts[1], parts[2], parts[3]
                    job_id = parts[4].rsplit(".", 1)[0]

                meta = head.get("Metadata", {}) or {}
                tenant_id = meta.get("tenant-id") or tenant_id
                project_id = meta.get("project-id") or project_id
                job_id = meta.get("job-id") or job_id
                kind = meta.get("kind") or kind

                if not all((tenant_id, project_id, job_id)):
                    log.error(
                        "object %s carries no job context in its key or metadata", key
                    )
                    continue

                db.update(db.core(), db.pk_tenant(tenant_id), db.sk_job(project_id, job_id),
                          {"status": "processing", "started_at": db.now_ms(),
                           "size_bytes": head.get("ContentLength")})

                project = db.get(db.core(), db.pk_tenant(tenant_id),
                                 db.sk_project(project_id)) or {}
                schema = project.get("schema") or {}

                obj = _s3.get_object(Bucket=bucket, Key=key)
                rows = _rows_from(obj["Body"], key)

                if kind == "items":
                    stats = _process_items(rows, project_id, tenant_id, schema)
                else:
                    stats = _process_historical(rows, project_id, tenant_id, schema)

                reject_key = _write_rejects(bucket, key, stats["sample_errors"])

                db.update(db.core(), db.pk_tenant(tenant_id), db.sk_job(project_id, job_id), {
                    "status": "completed",
                    "rows_total": stats["total"],
                    "rows_valid": stats["valid"],
                    "rows_invalid": stats["invalid"],
                    "rows_warned": stats["warned"],
                    "errors_by_type": dict(stats["errors_by_type"]),
                    "sample_errors": stats["sample_errors"][:20],
                    "unknown_columns": sorted(stats["unknown_columns"]),
                    "items_affected": len(stats["items"]),
                    "reject_key": reject_key,
                    "completed_at": db.now_ms(),
                })

                if kind == "items" and stats["items"]:
                    db.update(db.core(), db.pk_tenant(tenant_id), db.sk_project(project_id),
                              {"item_count": len(stats["items"])})

                audit.record(
                    tenant_id=tenant_id, action="DATA_PROCESSED", actor="system",
                    project_id=project_id, entity_type="job", entity_id=job_id,
                    new_value={"valid": stats["valid"], "invalid": stats["invalid"],
                               "items": len(stats["items"])},
                    source="system",
                )

                if stats["invalid"] and settings().queue_alerts:
                    _sqs.send_message(
                        QueueUrl=settings().queue_alerts,
                        MessageBody=json.dumps({
                            "tenant_id": tenant_id, "project_id": project_id,
                            "type": "data_quality",
                            "severity": "warning" if stats["valid"] else "critical",
                            "rows_total": stats["total"],
                            "rows_invalid": stats["invalid"],
                            "job_id": job_id,
                        }),
                    )

                log.info(
                    "processed %s: %d valid, %d invalid, %d items",
                    key, stats["valid"], stats["invalid"], len(stats["items"]),
                )

        except Exception as exc:  # noqa: BLE001
            log.exception("data processing failed for %s: %s", message_id, exc)
            # Mark the job failed before giving up. Without this the row stays
            # at status="processing" forever and /data/job never resolves, so
            # the analyst sees a hang instead of the actual error.
            try:
                if all((tenant_id, project_id, job_id)):
                    db.update(db.core(), db.pk_tenant(tenant_id),
                              db.sk_job(project_id, job_id),
                              {"status": "failed", "error": str(exc)[:300],
                               "completed_at": db.now_ms()})
            except Exception:  # noqa: BLE001
                pass
            failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": failures}
