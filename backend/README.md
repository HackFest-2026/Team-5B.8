# DevNexus Backend

Universal Dynamic Pricing Platform. FastAPI control plane + dependency-free
hot-path Lambdas + SQS workers, on AWS.

Design rationale lives in [../ARCHITECTURE.md](../ARCHITECTURE.md). This file is
how to deploy and operate it.

---

## The one rule

**Every endpoint is a `GET`.** No request bodies anywhere. Complex objects travel
as one URL-encoded JSON query parameter. Auth is `?token=<session_token>`.

The only non-GET traffic in the entire system is the browser PUTting a file
straight to S3 using a presigned URL — and our API only *hands out* that URL,
via a GET.

Two consequences this codebase handles explicitly:

- **`Cache-Control: no-store` on every response** ([app/responses.py](app/responses.py)).
  Since writes are GETs, a cached one would silently replay a mutation.
- **6 KB URL budget.** API Gateway caps the request line plus headers near 8 KB.
  Oversized configs are rejected with a readable error pointing at the file-upload path.

---

## Layout

```
backend/
├── app/                    FastAPI control plane — one Lambda via Mangum
│   ├── main.py             app assembly, error envelopes, Lambda handler
│   ├── deps.py             session resolution + tenant scoping
│   ├── responses.py        no-store JSON envelope
│   └── routers/            16 routers, ~56 endpoints
│
├── core/                   shared, no FastAPI import
│   ├── engine/             ⭐ THE DETERMINISTIC PRICING ENGINE — pure, no I/O
│   │   ├── models.py       frozen value types
│   │   ├── evaluate.py     match → order → resolve conflicts → apply → clamp
│   │   ├── compile.py      stored config → executable ruleset; tier expansion
│   │   └── describe.py     config → English (template renderer, NOT a model)
│   ├── ai/                 Gemini: key pool, client, system prompts, validation
│   ├── approvals/          human-in-the-loop decision flow + action executors
│   ├── notify/fcm.py       FCM HTTP v1
│   ├── pricing.py          orchestration shared by live/simulate/replay/backtest
│   ├── db.py               DynamoDB access + every key builder in the system
│   ├── catalog.py          service types, domain templates, builder vocabulary
│   ├── config.py           env + SSM, cached per execution environment
│   ├── security.py         scrypt password hashing (stdlib, no dependency)
│   ├── audit.py            audit trail
│   └── ids.py              URL-safe identifier generation
│
├── runtime/                🔥 HOT PATH — imports only boto3 + core.engine
│   ├── price_handler.py    /v1/p/{key}/price  — 1 BatchGetItem, then pure eval
│   └── event_handler.py    /v1/t/{key}/event  — validate + enqueue, nothing else
│
└── workers/                SQS consumers
    ├── feature_worker.py   events → time-decayed signals → context + anomalies
    ├── decision_worker.py  persists decisions (3 rows per decision)
    ├── alert_worker.py     alert → Gemini question → approval → FCM push
    ├── data_worker.py      S3 upload → validate → items/context + reject file
    └── backtest_worker.py  historical replay + self-verification
```

### Why the hot path is separate

[runtime/price_handler.py](runtime/price_handler.py) deliberately imports no
FastAPI, no Pydantic and nothing from `app/`. Those cost 300–600 ms of cold
start for features a pricing call has no use for, so it parses the API Gateway
event itself. It also has **no IAM permission to reach SSM or Gemini** — the hot
path physically cannot call a model.

---

## Deploy

Needs only the AWS CLI. SAM CLI is not required, because SAM is a
CloudFormation transform and `aws cloudformation package` uploads the artifacts.

```bash
# 1. deploy infrastructure + code
./scripts/deploy.sh dev ap-south-1

# 2. push secrets to SSM (Gemini keys, Firebase service account)
./scripts/load-secrets.sh dev ap-south-1

# 3. exercise the whole flow end to end
./scripts/smoke-test.sh dev ap-south-1
```

`deploy.sh` installs dependencies into `.build/` (gitignored) with
`--platform manylinux2014_aarch64`, because the Lambdas run on ARM64 Amazon
Linux. Building for the host platform is the classic way to ship a bundle that
imports fine on a Mac and fails in Lambda with `invalid ELF header`.

### Secrets

Drop these into `.secrets/` (gitignored, never committed):

| File | Purpose |
|---|---|
| `gemini-keys.txt` | one Gemini `AQ.…` key per line |
| `firebase-service-account.json` | Firebase service account, for FCM |

`load-secrets.sh` writes them to SSM as SecureStrings. Nothing lands in the
CloudFormation template or a Lambda environment variable.

Validate the key pool before deploying:

```bash
node ../scripts/validate-gemini-keys.mjs --model gemini-3.6-flash
```

---

## Operating the Gemini key pool

Model availability is volatile, so the fallback chain lives in SSM rather than
in code:

```bash
aws ssm put-parameter --name /devnexus/dev/gemini/models --type String --overwrite \
  --value "gemini-3.6-flash,gemini-3.5-flash,gemini-flash-latest,gemini-2.5-flash"
```

Check pool health through the API:

```bash
curl "$API/ai/health?token=$TOKEN"
```

The response separates the four failure modes, because they need different
responses:

| Shown as | Cause | What to do |
|---|---|---|
| `dead` | `403`/`401` project denied | replace the key |
| `cooling` | `429` rate limited | nothing — it recovers itself |
| model `available: false` | `503` saturated / `404` retired | re-point the chain above |

---

## Tables

| Table | Holds | Accessed by |
|---|---|---|
| `devnexus-core` | users, sessions, tenants, projects, items, rules, strategy versions, alerts, audit, approvals, devices | control plane |
| `devnexus-context` | **hot path only** — `CTX#<project>#<item>` and `ACTIVE#<project>` | `price-fn`, workers |
| `devnexus-decisions` | replayable decision snapshots (90-day TTL) | replay, analytics |

`context` is separate from `core` so an analyst running analytics can never
consume capacity the pricing API needs. Both of the hot path's reads live in
`context`, which is what lets `price-fn` fetch the item context *and* the active
strategy in a single `BatchGetItem` — and why strategy activation takes effect
on the very next request rather than after a cache TTL.

---

## Things worth knowing before changing code

- **The engine must stay pure.** `core/engine/` performs no I/O, reads no clock
  and holds no database handle. `now_ms` arrives inside `PricingContext`. Break
  that and simulation, backtesting, Decision Replay and `/decisions/verify` all
  stop being honest at the same moment, with no error to notice it by.
- **Rule ordering is a total order** — priority DESC, then `rule_id` ASC. Sorting
  on priority alone would let the same ruleset stored in a different sequence
  produce a different price.
- **Percentages sum, they don't compound.** Two +10% rules give +20%, not +21%.
  Compounding would make the result depend on evaluation order, which an analyst
  cannot predict from reading the rules.
- **Strategy versions are immutable.** That is what makes rollback instant and
  replay exact. Never mutate `SVER#…`.
- **`event_id` is mandatory on ingest.** Events arrive over GET, so proxies and
  retrying clients deliver duplicates. Without dedup, a retry storm inflates
  demand and moves real prices.
- **AI output is data, never an action.** Field names are checked against the
  project schema; approval actions against a fixed enum. A hallucination becomes
  a rejected draft with a readable reason.
- **Config → English is a template renderer, never a model.** That text narrates
  live rules in the audit trail, and the audit trail is the one artefact here
  that has to be exactly right.

---

## Determinism check

The claim that pricing is reproducible is machine-checkable:

```bash
curl "$API/decisions/verify?token=$TOKEN&project_id=$PID&decision_id=DEC-XXXXXXXX"
```

It re-runs the engine on the decision's stored input snapshot and asserts the
price matches to the cent. A failure is a real finding — either the snapshot is
incomplete or engine behaviour changed — so it reports the mismatch in detail
rather than smoothing it over.
