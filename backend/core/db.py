"""DynamoDB access layer: clients, key builders, and type coercion.

Three tables, each with a different job (see ARCHITECTURE.md §2.7):

  core        configuration and state. Mixed access patterns, bursty.
  context     the hot path only. One GetItem per pricing call, nothing else.
  decisions   immutable decision snapshots, TTL'd.

`context` is deliberately separate from `core` so that an analyst running
analytics can never consume capacity the pricing API needs.

Key-building lives here and nowhere else. Scattering f-strings that assemble
`TENANT#...` across routers is how tenant-isolation bugs get written, so every
key in the system is produced by a function in this module.
"""

from __future__ import annotations

import time
from decimal import Decimal
from typing import Any, Iterable

import boto3
from boto3.dynamodb.conditions import Key

from core.config import REGION, settings

_resource = None
_tables: dict[str, Any] = {}


def _res():
    global _resource
    if _resource is None:
        _resource = boto3.resource("dynamodb", region_name=REGION)
    return _resource


def table(name: str):
    if name not in _tables:
        _tables[name] = _res().Table(name)
    return _tables[name]


def core():
    return table(settings().table_core)


def context():
    return table(settings().table_context)


def decisions():
    return table(settings().table_decisions)


# ════════════════════════════════════════════════════════════════════════
#  Key builders — the single source of truth for every partition/sort key
# ════════════════════════════════════════════════════════════════════════

def pk_user(email: str) -> str:
    """Email is the partition key, so login is a GetItem — no GSI, no scan."""
    return f"USER#{email}"


def pk_session(token: str) -> str:
    return f"SESSION#{token}"


def pk_tenant(tenant_id: str) -> str:
    return f"TENANT#{tenant_id}"


def pk_apikey(key: str) -> str:
    """Resolves a project API key to {tenant_id, project_id} in one read."""
    return f"KEY#{key}"


def sk_profile() -> str:
    return "PROFILE"


def sk_meta() -> str:
    return "META"


def sk_project(project_id: str) -> str:
    return f"PROJECT#{project_id}"


def sk_item(project_id: str, item_id: str) -> str:
    return f"ITEM#{project_id}#{item_id}"


def sk_item_prefix(project_id: str) -> str:
    return f"ITEM#{project_id}#"


def sk_rule(project_id: str, rule_id: str) -> str:
    return f"RULE#{project_id}#{rule_id}"


def sk_rule_prefix(project_id: str) -> str:
    return f"RULE#{project_id}#"


def sk_strategy(project_id: str, strategy_id: str) -> str:
    return f"STRAT#{project_id}#{strategy_id}"


def sk_strategy_prefix(project_id: str) -> str:
    return f"STRAT#{project_id}#"


def sk_version(project_id: str, strategy_id: str, version: str) -> str:
    """Immutable compiled snapshot. Never updated after write — that immutability
    is what makes rollback instant and Decision Replay exact."""
    return f"SVER#{project_id}#{strategy_id}#{version}"


def sk_version_prefix(project_id: str, strategy_id: str) -> str:
    return f"SVER#{project_id}#{strategy_id}#"


def sk_job(project_id: str, job_id: str) -> str:
    return f"JOB#{project_id}#{job_id}"


def sk_job_prefix(project_id: str) -> str:
    return f"JOB#{project_id}#"


def sk_alert(ts: int, alert_id: str) -> str:
    return f"ALERT#{ts:013d}#{alert_id}"


def sk_alert_prefix() -> str:
    return "ALERT#"


def sk_audit(ts: int, audit_id: str) -> str:
    return f"AUDIT#{ts:013d}#{audit_id}"


def sk_audit_prefix() -> str:
    return "AUDIT#"


def sk_device(device_id: str) -> str:
    return f"DEVICE#{device_id}"


def sk_device_prefix() -> str:
    return "DEVICE#"


def sk_approval(approval_id: str) -> str:
    """The durable record, whatever its status."""
    return f"APRV#{approval_id}"


def sk_approval_open(ts: int, approval_id: str) -> str:
    """Sparse 'still open' pointer carrying the full payload.

    Deleted the moment the approval is answered, so `GET /approvals/pending`
    is a Query over a handful of items instead of a filtered scan of history.
    The home screen is the most latency-sensitive read in the mobile app, and
    this keeps it at one short Query.
    """
    return f"APRVOPEN#{ts:013d}#{approval_id}"


def sk_approval_open_prefix() -> str:
    return "APRVOPEN#"


def sk_ai_cache(cache_key: str) -> str:
    return f"AICACHE#{cache_key}"


def sk_agent_chat(project_id: str) -> str:
    """The schema-design conversation for a project.

    One item holds the whole transcript, filed under the tenant partition like
    everything else the tenant owns, so it is reachable by both the REST history
    endpoint and the WebSocket agent and is isolated by tenant for free.
    """
    return f"AGENTCHAT#{project_id}"


# ── context table ──────────────────────────────────────────────────────

def ctx_pk(project_id: str, item_id: str) -> str:
    return f"CTX#{project_id}#{item_id}"


def ctx_sk() -> str:
    return "NOW"


# The reserved item id under which a project's GLOBAL signals live. Global
# values are shared across every item, so they are stored once here rather than
# duplicated onto every product's context row — one write, not one-per-item.
# The double underscores keep it from colliding with any real item id, which is
# `alnum + _` but never starts/ends bare like this by convention.
GLOBAL_ITEM_ID = "__GLOBAL__"


def global_ctx_pk(project_id: str) -> str:
    return ctx_pk(project_id, GLOBAL_ITEM_ID)


def active_pk(project_id: str) -> str:
    return f"ACTIVE#{project_id}"


def active_sk() -> str:
    return "STRATEGY"


# ── decisions table ────────────────────────────────────────────────────

def dec_pk(project_id: str, decision_id: str) -> str:
    return f"DEC#{project_id}#{decision_id}"


def decidx_pk(project_id: str, item_id: str) -> str:
    return f"DECIDX#{project_id}#{item_id}"


def decidx_sk(ts: int, decision_id: str) -> str:
    return f"{ts:013d}#{decision_id}"


def decfeed_pk(project_id: str) -> str:
    """Project-wide decision feed, for the dashboard's recent-decisions panel."""
    return f"DECFEED#{project_id}"


# ════════════════════════════════════════════════════════════════════════
#  Type coercion
# ════════════════════════════════════════════════════════════════════════
#
# DynamoDB has no float type: boto3 demands Decimal on the way in and returns
# Decimal on the way out. Converting at the boundary — here — means the rest of
# the codebase and the pricing engine deal in plain floats and never has to
# think about it.

def to_dynamo(value: Any) -> Any:
    """Python -> DynamoDB. Floats become Decimal; empty strings become None."""
    if isinstance(value, float):
        # str() round-trip avoids Decimal(0.1) == 0.1000000000000000055511151231
        return Decimal(str(value))
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, dict):
        return {k: to_dynamo(v) for k, v in value.items() if v != ""}
    if isinstance(value, (list, tuple)):
        return [to_dynamo(v) for v in value]
    return value


def from_dynamo(value: Any) -> Any:
    """DynamoDB -> Python. Decimal becomes int when integral, else float."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: from_dynamo(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [from_dynamo(v) for v in value]
    if isinstance(value, set):
        return [from_dynamo(v) for v in value]
    return value


def now_ms() -> int:
    return int(time.time() * 1000)


def now_s() -> int:
    return int(time.time())


def ttl_in(seconds: int) -> int:
    """DynamoDB TTL expects epoch SECONDS, not milliseconds. Getting this wrong
    silently schedules deletion ~50,000 years out, so it lives in one place."""
    return now_s() + seconds


# ════════════════════════════════════════════════════════════════════════
#  Generic operations
# ════════════════════════════════════════════════════════════════════════

def get(tbl, pk: str, sk: str, *, consistent: bool = False) -> dict | None:
    resp = tbl.get_item(Key={"pk": pk, "sk": sk}, ConsistentRead=consistent)
    item = resp.get("Item")
    return from_dynamo(item) if item else None


def put(tbl, item: dict, *, unique: bool = False) -> bool:
    """Write an item. `unique=True` fails instead of overwriting.

    Returns False when `unique` was requested and the item already existed —
    that's how signup detects a duplicate email without a read-then-write race.
    """
    kwargs: dict[str, Any] = {"Item": to_dynamo(item)}
    if unique:
        kwargs["ConditionExpression"] = "attribute_not_exists(pk) AND attribute_not_exists(sk)"
    try:
        tbl.put_item(**kwargs)
        return True
    except tbl.meta.client.exceptions.ConditionalCheckFailedException:
        return False


def update(tbl, pk: str, sk: str, changes: dict, *, condition: str | None = None) -> dict | None:
    """SET-only update. Returns the updated item, or None if the condition failed."""
    if not changes:
        return get(tbl, pk, sk)
    names, values, sets = {}, {}, []
    for i, (k, v) in enumerate(changes.items()):
        names[f"#k{i}"] = k
        values[f":v{i}"] = to_dynamo(v)
        sets.append(f"#k{i} = :v{i}")
    kwargs: dict[str, Any] = {
        "Key": {"pk": pk, "sk": sk},
        "UpdateExpression": "SET " + ", ".join(sets),
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": values,
        "ReturnValues": "ALL_NEW",
    }
    if condition:
        kwargs["ConditionExpression"] = condition
    try:
        return from_dynamo(tbl.update_item(**kwargs).get("Attributes"))
    except tbl.meta.client.exceptions.ConditionalCheckFailedException:
        return None


def delete(tbl, pk: str, sk: str) -> None:
    tbl.delete_item(Key={"pk": pk, "sk": sk})


def query_prefix(
    tbl,
    pk: str,
    sk_prefix: str,
    *,
    limit: int = 100,
    cursor: dict | None = None,
    ascending: bool = True,
    consistent: bool = False,
    projection: str | None = None,
) -> tuple[list[dict], dict | None]:
    """Query one partition by sort-key prefix. Returns (items, next_cursor).

    An empty `sk_prefix` means "the whole partition". DynamoDB rejects
    begins_with with an empty string ("The AttributeValue for a key attribute
    cannot contain an empty string value"), so the condition is dropped rather
    than passed through — several partitions (the decision feed, per-item
    decision history) are single-purpose and queried in full.

    `projection` restricts which attributes come back, and on wide rows it is
    the single biggest lever available. A decision-feed row carries
    `rules_detail` and `signals`; at a few hundred rows those blobs fill
    DynamoDB's 1MB page before the row Limit is reached, so a scan that should
    be one query becomes several, and Python then deserializes every nested
    Decimal it will immediately discard. Asking for six scalar fields instead
    turned the analytics scans from hundreds of milliseconds into tens.
    """
    condition = Key("pk").eq(pk)
    if sk_prefix:
        condition = condition & Key("sk").begins_with(sk_prefix)

    kwargs: dict[str, Any] = {
        "KeyConditionExpression": condition,
        "Limit": limit,
        "ScanIndexForward": ascending,
        "ConsistentRead": consistent,
    }
    if cursor:
        kwargs["ExclusiveStartKey"] = cursor
    if projection:
        # Reserved words (ts, status, type...) are common in these rows, so
        # every projected name is aliased rather than risking a Query failure.
        names = [n.strip() for n in projection.split(",") if n.strip()]
        kwargs["ProjectionExpression"] = ", ".join(f"#p{i}" for i in range(len(names)))
        kwargs["ExpressionAttributeNames"] = {f"#p{i}": n for i, n in enumerate(names)}

    resp = tbl.query(**kwargs)
    return [from_dynamo(i) for i in resp.get("Items", [])], resp.get("LastEvaluatedKey")


def query_between(
    tbl, pk: str, sk_lo: str, sk_hi: str, *, limit: int = 500, ascending: bool = False
) -> list[dict]:
    """Range query, used by analytics and audit for time windows."""
    resp = tbl.query(
        KeyConditionExpression=Key("pk").eq(pk) & Key("sk").between(sk_lo, sk_hi),
        Limit=limit,
        ScanIndexForward=ascending,
    )
    return [from_dynamo(i) for i in resp.get("Items", [])]


def batch_put(tbl, items: Iterable[dict]) -> int:
    n = 0
    with tbl.batch_writer() as batch:
        for item in items:
            batch.put_item(Item=to_dynamo(item))
            n += 1
    return n


def batch_get(tbl, keys: list[tuple[str, str]]) -> list[dict]:
    """BatchGetItem, chunked at DynamoDB's 100-key limit."""
    out: list[dict] = []
    client = _res().meta.client
    name = tbl.name
    for i in range(0, len(keys), 100):
        chunk = [{"pk": pk, "sk": sk} for pk, sk in keys[i:i + 100]]
        resp = client.batch_get_item(RequestItems={name: {"Keys": chunk}})
        out.extend(from_dynamo(x) for x in resp.get("Responses", {}).get(name, []))
    return out


def counter(tbl, pk: str, sk: str, field: str, by: int = 1) -> int:
    """Atomic increment. Used for rule trigger counts and live metrics, where
    a read-modify-write would lose updates under concurrency."""
    resp = tbl.update_item(
        Key={"pk": pk, "sk": sk},
        UpdateExpression=f"ADD #f :by",
        ExpressionAttributeNames={"#f": field},
        ExpressionAttributeValues={":by": Decimal(by)},
        ReturnValues="UPDATED_NEW",
    )
    return from_dynamo(resp.get("Attributes", {})).get(field, 0)
