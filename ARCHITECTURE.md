# DevNexus — Universal Dynamic Pricing Platform
## System Architecture + Complete API Specification

---

# PART 0 — What changed from the original spec

| Topic | Original | DevNexus (final) |
|---|---|---|
| Name | Monetize360 | **DevNexus** |
| Auth | JWT tokens | **Opaque session token** stored in DynamoDB, passed as URL param |
| Registration | One-shot signup | **Two-step**: partial signup (email+password) → profile completion (company) |
| Scope per account | One business | **Multiple Pricing Projects** per account, each with own domain/rules/API/analytics |
| HTTP methods | REST (POST/PUT/DELETE) | **GET only**, all data in URL query params. Exception: browser→S3 file PUT |

---

# PART 1 — THE CORE RULE: GET-ONLY API

Every API in this system is a `GET`. No request bodies. No POST/PUT/PATCH/DELETE.

### Conventions

- **Simple values** → plain query params
  `?item_id=P1001&base_price=70000`
- **Complex objects** → one param holding compact URL-encoded JSON
  `?schema=%7B%22attributes%22%3A%5B...%5D%7D`
- **Lists** → comma-separated
  `?item_ids=P1001,P1002,P1003`
- **Analyst auth** → `?token=<session_token>`
- **Customer runtime auth** → API key in the **path**, not the query
  `/v1/p/{project_key}/price?item_id=P1001`
- **Only non-GET traffic in the whole system** → the browser uploading a file straight to S3 using a presigned URL. Our API only *hands out* that URL (via GET).

### Three engineering rules this forces on us

1. 🚫 **`Cache-Control: no-store` on every response.**
   Because writes are GETs, a browser or CDN caching one would silently replay a mutation. Non-negotiable, set globally in the Lambda response helper.

2. 📏 **URL budget = 6 KB.**
   API Gateway caps the request line + headers around 8 KB. Rule/schema JSON is the only thing that gets close. Keep configs compact (short keys), and if any payload would exceed ~6 KB, it goes through the S3 presign path instead of the URL.

3. 🔒 **Tokens in URLs get logged.**
   Query strings land in CloudWatch access logs and browser history. Mitigations: disable query-string capture in API Gateway access logging (or mask `token` and `api_key`), give session tokens a short TTL (24h) with server-side revocation, and keep them out of `Referer` by serving the SPA from a different origin than the API.

---

# PART 2 — SYSTEM ARCHITECTURE

## 2.1 Three planes

The whole system separates into three planes that never block each other.

### 🎛️ Control Plane — *the analyst configuring things*
- Signup, login, profile, projects
- Domain config, pricing items, historical uploads
- Rules, strategies, guardrails
- **AI natural-language → configuration** (draft only, never live)
- Simulation, backtesting, shadow mode
- Analytics, audit, decision replay
- **Latency tolerance: generous** (100–800 ms is fine; AI calls up to ~3 s)

### ⚡ Runtime Plane — *the customer's backend calling us*
- `GET /price` — the hot path, must be single-digit/low-double-digit ms
- `GET /event` — event ingestion, fire-and-forget
- Deterministic engine → conflict resolution → guardrails → price
- **Latency tolerance: near zero.** Nothing slow is allowed in here.

### 📱 Mobile Plane — *the analyst away from their desk*
- Critical FCM push only
- Read-only analytics snapshots
- Emergency actions (pause / rollback / safe mode) — reuses control-plane APIs, no duplicate endpoints

---

## 2.2 Request flow diagram

```
┌───────────────┐   ┌───────────────┐   ┌────────────────────┐
│  WEB (React)  │   │ ANDROID APP   │   │ CUSTOMER BACKEND   │
│  Analyst      │   │ Emergency     │   │ (their e-com/hotel)│
└───────┬───────┘   └───────┬───────┘   └─────────┬──────────┘
        │ GET +token        │ GET +token          │ GET /v1/p/{key}/price · /price/bulk · /price/cart
        │                   │                     │ GET /v1/t/{key}/event · /v1/g/.../context · /v1/u/.../update
        └─────────┬─────────┘                     │
                  ▼                               ▼
        ┌─────────────────────────────────────────────────────┐
        │     API GATEWAY — HTTP API ($default, GET+OPTIONS)  │
        │          routing · throttling · access logs         │
        └──┬──────────────┬───────────────┬──────────────┬────┘
           │              │               │              │
   CONTROL PLANE    RUNTIME HOT PATH  INGEST PATH   WEBSOCKET API
           │              │               │              │
           ▼              ▼               ▼              ▼
   ┌──────────────┐ ┌───────────┐  ┌────────────┐ ┌────────────┐
   │  api-fn      │ │ price-fn  │  │ event-fn   │ │ ws-fn      │
   │  ONE FastAPI │ │           │  │            │ │ connect/   │
   │  Lambdalith  │ │ ONE Batch │  │ validate + │ │ disconnect/│
   │  (~60 GETs:  │ │ GetItem   │  │ write-thru │ │ subscribe/ │
   │  auth…ai…    │ │ (ACTIVE + │  │ fields +   │ │ agent      │
   │  demo) +     │ │ GLOBAL +  │  │ enqueue    │ └─────┬──────┘
   │  /explain    │ │ item ctx) │  │ signals    │       │
   │              │ │ + in-mem  │  └─────┬──────┘       │
   │              │ │ engine    │        │              │
   └──────┬───────┘ └─────┬─────┘        ▼              │
          │               │        ┌──────────┐         │
          │               │        │   SQS    │ (events/decisions/
          │               │        │ 5 queues │  alerts/data/backtest,
          │               │        └────┬─────┘  each + DLQ)
          │               │             │               │
          │               │   ┌─────────┼──────────┐    │
          │               │   ▼         ▼          ▼    │
          │               │ feature-  decision-  alert- │
          │               │ worker    worker     worker │
          │               │ data-worker  backtest-worker│
          │               │   │   (workers publish live │
          │               │   │    frames DIRECTLY via   │
          ▼               ▼   ▼    core/realtime.py)──────┘
    ┌──────────────────────────────┐    ┌──────────────┐
    │          DynamoDB            │    │      S3      │
    │  devnexus-core     (config)  │    │ uploads/     │
    │  devnexus-context  (hot+WS)  │    │ (presigned   │
    │  devnexus-decisions(+rollup) │    │  PUT → data  │
    └──────────────────────────────┘    │  queue)      │
                   │                     └──────────────┘
                   ▼
            ┌─────────────┐      ┌──────────────┐
            │ alert-worker│─────▶│ Gemini → FCM │─▶ 📱
            │ (SSM creds) │      │ (approval)   │
            └─────────────┘      └──────────────┘
```

> The control plane is **one** Lambda (`api-fn`), not a function per group.
> There is no `ws-broadcast` function: workers post to sockets directly. The
> only non-GET traffic in the system is the browser's presigned `PUT` to S3.

---

## 2.3 Account & project model

This is the structural change that makes "multiple pricing setups" work.

```
USER  (email + password)
  │   one login identity
  ▼
TENANT  (company — created at profile completion)
  │   company_name, service_type, country, currency
  │   tenant_id = isolation boundary for ALL data
  ▼
PROJECT[]   ← they can create many
  │
  ├── Project "Flipkart Clone"   domain: E-commerce    key: pk_live_a1b2…
  │     ├── domain schema (entity + attributes + context signals)
  │     ├── pricing items
  │     ├── rules + strategies + versions
  │     ├── guardrails
  │     ├── events / features / decisions
  │     ├── analytics (fully separate)
  │     └── own dynamic API URLs
  │
  ├── Project "ABC Hotels"       domain: Hospitality   key: pk_live_c3d4…
  └── Project "RideGo"           domain: Transportation key: pk_live_e5f6…
```

- 🔑 Every project gets its **own API key** → its own dynamic endpoint URLs.
- 📊 Analytics, alerts, decisions, rules are **scoped per project**, never mixed.
- 🌍 A cross-project rollup view proves the "one engine, many domains" KPI.
- ⚙️ Adding a project with a brand-new domain = pure configuration. **Zero engine code changes.** This is the headline demo.

---

## 2.4 Dynamic per-project API

When a project is created, the backend generates its API key and returns ready-to-paste URLs:

```
Project: ABC Hotels   (key: pk_live_c3d4e5f6)

PRICE    GET https://api.devnexus.app/v1/p/pk_live_c3d4e5f6/price?item_id=R204
BULK     GET https://api.devnexus.app/v1/p/pk_live_c3d4e5f6/price/bulk?item_ids=R204,R205
CART     GET https://api.devnexus.app/v1/p/pk_live_c3d4e5f6/price/cart?cart=%5B%7B%22item_id%22%3A%22R204%22%2C%22quantity%22%3A2%7D%5D
EVENT    GET https://api.devnexus.app/v1/t/pk_live_c3d4e5f6/event?item_id=R204&event_type=booking
CONTEXT  GET https://api.devnexus.app/v1/g/pk_live_c3d4e5f6/context?signal_occupancy=0.82
UPDATE   GET https://api.devnexus.app/v1/u/pk_live_c3d4e5f6/update?item_id=R204&base_price=5400
EXPLAIN  GET https://api.devnexus.app/v1/p/pk_live_c3d4e5f6/explain?decision_id=DEC-982731
```

- The key resolves to `{tenant_id, project_id}` in one DynamoDB lookup (cached in Lambda memory).
- Routes are **static in API Gateway** (`/v1/p/{project_key}/price`); the *key* is dynamic, not the route. No infrastructure is provisioned per project — that keeps project creation instant.
- 🚦 Per-key throttling is applied at the gateway using a usage plan tier stored on the project.

---

## 2.5 Authentication without JWT

```
GET /auth/login?email=…&password=…
        │
        ▼
 scrypt-verify password hash          ← we still hash passwords. Non-negotiable.
        │
        ▼
 generate 32-byte random token  →  "sess_8Kd93jfk2…"
        │
        ▼
 DynamoDB PUT  SESSION#<token> → {user_id, tenant_id, expires_at(TTL=24h)}
        │
        ▼
 return token to client → stored in localStorage → sent as ?token= on every call
```

**Why this beats JWT here:**
- ✅ No signing keys, no crypto verification, no library
- ✅ **Instantly revocable** — delete the row, session dies (a JWT can't do this)
- ✅ DynamoDB TTL expires sessions for free
- ✅ One GetItem (~2 ms, and cached per warm Lambda) resolves `user_id` + `tenant_id`

**Tenant isolation rule (absolute):**
> `tenant_id` is **always** read from the session/API-key record. It is **never** accepted from a query param, even if the client sends one. Every DynamoDB access is prefixed with the derived `tenant_id`.

---

## 2.6 Lambda function map

Grouped by responsibility, and deliberately **not** micro-split. The control
plane is one Lambda; only the latency- or isolation-sensitive paths get their
own. Nine functions in total (names are suffixed with the stage, e.g.
`devnexus-api-dev`).

### Control plane — one Lambda ("Lambdalith")
| Function | Handler | Owns | Memory |
|---|---|---|---|
| `devnexus-api` | `app.main.handler` (FastAPI + Mangum) | **Every** control-plane GET — auth, projects, domain schema, items, data uploads, rules, strategies, simulate, backtest, decisions, analytics, alerts, audit, approvals, devices/mobile, AI, demo, and `/v1/p/{key}/explain` | 1769 MB |

> ~60 endpoints share one process. Splitting them into one Lambda each would
> multiply cold starts and deploy complexity for routes that already share
> auth, config and DB code. FastAPI is mounted at `/` behind API Gateway's
> `$default` stage, so there is no stage prefix in any URL.

### Runtime plane — dependency-free, model-free
| Function | Handler | Routes | Notes |
|---|---|---|---|
| `devnexus-price` | `runtime.price_handler.handler` | `/v1/p/{key}/price`, `/price/bulk`, `/price/cart` | 🔥 **HOT PATH.** No deps layer, **no SSM/model IAM at all** — it physically cannot reach a model. Parses the API GW event itself to skip FastAPI's cold start. |
| `devnexus-event` | `runtime.event_handler.handler` | `/v1/t/{key}/event`, `/event/batch`, `/v1/u/{key}/update`, `/v1/g/{key}/context` | Validate + enqueue. `…/update` writes product fields through to DynamoDB synchronously (so the caller knows it landed); signals still go via SQS. |

### WebSocket plane
| Function | Handler | Owns |
|---|---|---|
| `devnexus-ws` | `runtime.ws_handler.handler` | `$connect` / `$disconnect` / `subscribe` / `$default`, the connection registry, and the streaming schema-design agent (hence the deps layer for `httpx`). Auth happens inside `$connect`, the only frame carrying the query string. |

### Async workers (SQS-triggered, one queue each)
| Worker | Queue | Owns |
|---|---|---|
| `devnexus-feature-worker` | events | raw events → time-decayed demand/velocity/inventory signals → context table; anomaly detection → alert queue |
| `devnexus-decision-worker` | decisions | persists each priced decision (3 rows), updates `previous_price`, folds the hourly rollup, publishes live frames, raises fallback/saturation alerts |
| `devnexus-alert-worker` | alerts | severity routing; for critical decisions, calls Gemini to write the approval question + options, stores it, then sends FCM. Concurrency capped at 5 (finite Gemini RPM). Deps layer. |
| `devnexus-data-worker` | data | S3 historical upload → validate → features → DynamoDB (2048 MB, 15 min) |
| `devnexus-backtest-worker` | backtest | replay a strategy version over stored decisions (2048 MB, 15 min) |

> There is **no** `ws-broadcast` Lambda. Workers publish straight to connected
> sockets through `core/realtime.py` (ApiGatewayManagementApi) — a few ms to a
> handful of connections, and a publish can never fail a worker.

---

## 2.7 DynamoDB design

Access-pattern driven, not relational. **Three tables**, all `PAY_PER_REQUEST`,
all with TTL and SSE; `core` additionally has point-in-time recovery. Every key
is built by a function in `core/db.py` — no router assembles a `TENANT#…` string
by hand, which is how tenant-isolation bugs are kept out.

> DynamoDB has no float type. `core/db.py` converts float↔Decimal at the
> boundary, so the engine and routers only ever see plain Python floats.

### Table 1 — `devnexus-core-<stage>` (configuration & state)

| PK | SK | Item |
|---|---|---|
| `USER#<email>` | `PROFILE` | user, password hash, profile-complete flag |
| `SESSION#<token>` | `META` | user_id, tenant_id, TTL 24h (opaque token, not a JWT → instantly revocable) |
| `KEY#<project_key>` | `META` | → {tenant_id, project_id, revoked} — the runtime key resolve |
| `TENANT#<tid>` | `PROFILE` | company, service type, country, currency |
| `TENANT#<tid>` | `PROJECT#<pid>` | project + domain schema + guardrails + mode + active strategy pointer |
| `TENANT#<tid>` | `ITEM#<pid>#<item>` | id, base price, optional cost, item-scope attributes |
| `TENANT#<tid>` | `RULE#<pid>#<rid>` | clauses, adjustment, priority, stackable, conflict group, trigger_count |
| `TENANT#<tid>` | `STRAT#<pid>#<sid>` | strategy header + version list + state |
| `TENANT#<tid>` | `SVER#<pid>#<sid>#<ver>` | **immutable** compiled version snapshot |
| `TENANT#<tid>` | `ALERT#<ts>#<id>` | severity, status, payload, linked approval |
| `TENANT#<tid>` | `AUDIT#<ts>#<id>` | who / what / when / old / new |
| `TENANT#<tid>` | `APRV#<id>` | durable approval record (kept whatever its status) |
| `TENANT#<tid>` | `APRVOPEN#<ts>#<id>` | sparse "still open" pointer with full payload — **deleted on answer**, so `/approvals/pending` is a short Query, not a scan |
| `TENANT#<tid>` | `JOB#<pid>#<job>` | upload / backtest jobs |
| `TENANT#<tid>` | `DEVICE#<id>` | FCM token + warnings preference |
| `TENANT#<tid>` | `AICACHE#<key>` | cached AI configuration output |
| `TENANT#<tid>` | `AGENTCHAT#<pid>` | the schema-design conversation transcript |

- 🔑 `USER#<email>` as PK → **login is a GetItem**, no GSI, no scan.
- 🧊 `SVER#` rows are never updated after write — that immutability is what makes rollback instant and Decision Replay exact.

### Table 2 — `devnexus-context-<stage>` (hot path + live registry)

| PK | SK | Item |
|---|---|---|
| `CTX#<pid>#<item>` | `NOW` | item-scope signals, base_price, cost, previous_price, per-signal `signal_updated_at` |
| `CTX#<pid>#__GLOBAL__` | `NOW` | **project-wide (overall-scope) signals** — written once, shared by every item |
| `ACTIVE#<pid>` | `STRATEGY` | the compiled active ruleset + guardrails + `signal_meta` (scope map) + mode + version |
| `DEDUP#<pid>` | `EVT#<id>` | idempotency gate for events (conditional write, TTL 1h) |
| `CHAOS#<pid>` | `META` | injected fault from `/demo/chaos` |
| `WSCONN#<pid>` | `CONN#<id>` | a subscribed dashboard socket (TTL 12h) |
| `WSIDX#<id>` | — | reverse map socket→project (API GW drops the query string on `$disconnect`) |

- Kept **separate from `core`** so analytics traffic can never starve the pricing API of capacity.
- The hot path reads `ACTIVE#`, `CTX#…__GLOBAL__` and each `CTX#<item>` **in one BatchGetItem** (see §2.8). Because `ACTIVE#` is fetched every time, strategy activation takes effect immediately — there is no cached ruleset to expire.
- Written only by the workers; read by `devnexus-price`.

### Table 3 — `devnexus-decisions-<stage>` (immutable decisions + rollups)

| PK | SK | Item |
|---|---|---|
| `DEC#<pid>#<decision_id>` | `META` | full input **snapshot** + decision — this is what `/decisions/verify` re-runs; TTL 90d |
| `DECIDX#<pid>#<item>` | `<ts>#<id>` | compact per-item history (drill-down) |
| `DECFEED#<pid>` | `<ts>#<id>` | compact project-wide feed (dashboard + analytics) |
| `ROLLUP#<pid>` | `H#<hour>` and `H#<hour>#R#<rule>` | pre-aggregated hourly totals, written on the decision we were already persisting; TTL 100d |

- A `DEC#` snapshot carries enough to recompute the price offline → Decision Replay and determinism proofs are real, not cosmetic.
- The rollup is **why analytics is flat, not linear, in traffic**: aggregation happens once on write, not by scanning thousands of rows per dashboard load.

---

## 2.8 The hot path (the most important code in the project)

```
GET /v1/p/{key}/price?item_id=P1001&<request-scope signals…>
   │
   ├─ 1. resolve key → {tenant,project}      in-memory cache (TTL 60s), else 1 GetItem on KEY#
   │
   ├─ 2. ONE BatchGetItem on the context table, fetching together:
   │        • ACTIVE#<pid>            the compiled active strategy (+ guardrails + scope map)
   │        • CTX#<pid>#__GLOBAL__    project-wide (overall-scope) signals
   │        • CTX#<pid>#P1001         this item's signals, base, cost, previous_price
   │      (bulk/cart add more CTX keys to the SAME batch, chunked at DynamoDB's 100-key limit)
   │
   ├─ 3. merge the three signal scopes into one flat view:
   │        GLOBAL  <  ITEM  <  REQUEST          (most-specific wins)
   │      + derive day_of_week / hour_of_day from the request's now_ms (so replay matches)
   │
   ├─ 4. deterministic engine (core.engine.evaluate)   pure, in-memory, zero I/O
   │        filter → match clauses → order (priority DESC, rule_id ASC) →
   │        resolve (conflict groups, non-stackable short-circuit) →
   │        accumulate (percent summed vs base, absolute, multiplier, formula, set_price)
   │
   ├─ 5. guardrails, fixed order: max ±% (vs previous, else base) → min margin → min/max price
   │
   ├─ 6. build a deliberately small customer response (price, drivers, decision_id;
   │      rule names/ids withheld) + report any missing/stale signals
   │
   ├─ 7. SQS send the full decision record       fire-and-forget, AFTER the body is built
   │
   └─ 8. RETURN   (Cache-Control: no-store, X-Response-Time header)
```

**Banned from this path, permanently** (enforced by IAM, not code review): S3,
historical scans, Query operations, ML/LLM calls, analytics aggregation. The
price function's role grants DynamoDB read + one SQS send and nothing else.

**Three pricing shapes, one engine:** `/price` (one item), `/price/bulk`
(`item_ids=`), and `/price/cart` (URL-encoded JSON of lines). The cart injects
reserved basket signals — `cart_lines`, `cart_units`, `cart_subtotal`,
`line_quantity` — so "spend ₹5000 get 10% off" or "buy 3+, save per unit" work
with **no** basket-specific logic in the engine.

**Degradation ladder** — a price is *always* returned, never an error/null/∞:
1. Mode `paused` → refuse explicitly (`pricing_enabled:false` + base), so an accidental off-switch is visible rather than silently serving base.
2. Signal stale (> `CONTEXT_STALE_SECONDS`, default **6h**) → that rule is skipped, decision flagged `degraded`.
3. Signal missing → clause doesn't match (never read as zero); reported in `context`.
4. Context row missing → `{"error":"unknown item"}` for that item.
5. No active strategy / mode `safe` / engine raises → `safe_fallback`: previous price (else base), clamped by absolute guardrails, `fallback:true` → CRITICAL alert.

---

## 2.9 Event ingestion (async, spike-absorbing)

```
Customer backend
   │ GET /v1/t/{key}/event?item_id=P1001&event_type=purchase&quantity=2&event_id=e-9931
   │ (also: /event/batch, /v1/g/{key}/context for overall signals, /v1/u/{key}/update for fields)
   ▼
devnexus-event ──▶ validate shape → SQS (events) → return 200 in ~8 ms
   │                                   │
   │                                   ▼
   │                 feature-worker (batch 10, window 2s, partial-batch-failure, max 50 concurrent)
   │                                   │
   │                                   ├─ idempotency: conditional write on DEDUP#<pid> EVT#<id>
   │                                   ├─ time-decayed counters (EMA, per-signal half-life)
   │                                   ├─ atomic UpdateItem on CTX#<pid>#<item>
   │                                   ├─ anomaly check → alert queue if breached
   │                                   └─ realtime publish → live dashboard
   │
   └─ events-dlq after 3 attempts → surfaces on the Event Pipeline Health panel
```

- 🔁 **Idempotency is mandatory:** events arrive over GET, so proxies/retries duplicate them. The conditional `DEDUP#` write makes a repeat a no-op; without it a retry storm would inflate demand and move real prices.
- 📈 **Spike absorption:** `devnexus-event` does no computation, so the API stays responsive under a storm; SQS holds the backlog and freshness degrades *visibly* (§2.8 step 2–3) instead of the API falling over.
- Direct signals (inventory, availability, competitor price, traffic, supply) set a value outright; behavioural events (view/search/cart/purchase) feed the decayed counters.

---

## 2.10 Realtime dashboard

```
feature-worker / decision-worker / alert-worker
            │  core/realtime.py  (interesting change only)
            ▼
   API Gateway WebSocket ($default stage)  ──▶  browser
```

- `WSS …/{stage}?token=…&project_id=…` — authorized inside `$connect`; the connection id is stored under `WSCONN#<pid>` with a reverse `WSIDX#` row so `$disconnect` is a GetItem, not a scan.
- Server **pushes**; the dashboard never polls. Channels: `events`, `decisions`, `kpis`, `alerts`, `health` — a frame reaches only sockets subscribed to its channel.
- Batching happens at the **call site** (feature-worker groups by item), so a 20k/sec storm is one frame of many items, not many frames. Frames are capped at 120 KB (API GW's 128 KB limit).
- Publishing is best-effort and wrapped: a dead socket is pruned on `GoneException`, and a failed publish never fails the worker — the dashboard is a view onto already-durable state.

---

# PART 3 — COMPLETE API LIST

**Every endpoint is `GET`.** Base: `https://api.devnexus.app`
`token` = session token · `project_key` = per-project API key.

## 🔐 3.1 Auth & Account

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 1 | `/auth/signup` | `email, password` | **Step 1 — partial registration.** Creates user, returns `token` + `registration_complete:false` |
| 2 | `/auth/login` | `email, password` | Returns `token`. If profile incomplete, client routes to the company form |
| 3 | `/auth/complete-profile` | `token, company_name, service_type, country, currency, company_size?` | **Step 2.** Creates the tenant. `service_type` = the dropdown |
| 4 | `/auth/me` | `token` | Bootstrap: user + tenant + projects + registration state. One call on app load |
| — | `/meta/catalog` | — | Static reference catalog the UI builds its dropdowns from (domains, signal types, operators, adjustment kinds) — no auth, no per-tenant data |

❌ **Not building:** logout (TTL handles it), password reset, update profile, delete account, email verification.

## 🗂️ 3.2 Projects & Domain Config (6)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 5 | `/projects/create` | `token, name, domain_name, entity_label, currency` | New pricing project + generates API key |
| 6 | `/projects/list` | `token` | All projects + status + entity counts (project switcher) |
| 7 | `/projects/get` | `token, project_id` | Full config + API key + ready-to-paste dynamic URLs |
| 8 | `/domain/save` | `token, project_id, schema` | `schema` = URL-encoded JSON: attributes, context signals, types. **This is the no-code domain builder** |
| 9 | `/guardrails/save` | `token, project_id, min_price, max_price, max_increase_pct, max_decrease_pct, min_margin_pct` | Project-level safety limits |
| 10 | `/apikeys/rotate` | `token, project_id` | Key rotation (NFR requirement) |
| — | `/projects/rename` | `token, project_id, name` | Rename a project (audited) |
| — | `/projects/delete` | `token, project_id` | Remove a project and its data |
| — | `/projects/reset-data` | `token, project_id` | Wipe decisions/alerts/audit/approvals for a clean demo. **Leaves context (item) rows intact so pricing survives** |

## 📦 3.3 Pricing Items (3)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 11 | `/items/create` | `token, project_id, item_id, name, base_price, attributes` | Single item (`attributes` = encoded JSON) |
| 12 | `/items/list` | `token, project_id, search?, limit?, cursor?` | Paginated + searchable |
| 13 | `/items/get` | `token, project_id, item_id` | Item + live context + last decision. Used by web drill-down **and** Android |
| — | `/items/update` | `token, project_id, item_id, …` | Edit base price, cost or attributes; rebuilds the item's context row |
| — | `/items/delete` | `token, project_id, item_id` | Remove a single item |

> Bulk create still goes through file upload (§3.4); single-item edit/delete are above.

## 📁 3.4 Historical Data (3 + S3)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 14 | `/data/upload-url` | `token, project_id, filename, kind` | Returns **presigned S3 PUT URL** + `job_id`. Browser uploads direct to S3 — the one non-GET in the system |
| 15 | `/data/jobs` | `token, project_id` | Upload history + validation summary (valid / invalid / warnings) |
| 16 | `/data/job` | `token, project_id, job_id` | Row-level validation errors + presigned **download** URL for rejected rows |

## 📡 3.5 Runtime — Customer-Facing Dynamic APIs

These are the per-project endpoints a customer's backend calls. Auth = the
`project_key` in the path; every route is a GET. Routes are static in API
Gateway — only the key is dynamic — so creating a project provisions no
infrastructure and is instant.

| Endpoint | Served by | Params | Purpose |
|---|---|---|---|
| `/v1/p/{key}/price` | price-fn | `item_id`, + any request-scope signal as a bare param | 🔥 **THE hot path.** Returns price, currency, decision_id, strategy_version, drivers, and (only if anything is wrong) missing/stale signals |
| `/v1/p/{key}/price/bulk` | price-fn | `item_ids` (CSV, max 100) | Many prices in one BatchGetItem |
| `/v1/p/{key}/price/cart` | price-fn | `cart` (URL-encoded JSON `[{item_id,quantity}]`) | Whole basket in one call; rules can see cart totals and line quantities |
| `/v1/t/{key}/event` | event-fn | `item_id, event_type, event_id, quantity?, value?, ts?` | Single behavioural/direct event |
| `/v1/t/{key}/event/batch` | event-fn | `payload` (encoded JSON array, max 50) | Batched ingest for high-volume clients |
| `/v1/g/{key}/context` | event-fn | `signal_<name>=…` | Set **overall-scope** (project-wide) signals — one write shared by every item |
| `/v1/u/{key}/update` | event-fn | `item_id`, fields and/or signals | "This product changed": writes fields through synchronously, routes signals via SQS |
| `/v1/p/{key}/explain` | api-fn (live router) | `decision_id` | Customer-facing driver breakdown for a past decision |

> **Signal scopes on the wire.** Item and overall signals are *stored* (via
> events / `…/context`); request-scope signals are *supplied on the price call*
> as bare query params whose names match fields the schema declared
> `scope: request`. A param that isn't a declared request field, or fails its
> declared type, is dropped — never coerced — so a typo can't smuggle a value
> into the engine. Booleans are compared as the strings `"True"`/`"False"`.

## ⚔️ 3.6 Rules (4)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 22 | `/rules/create` | `token, project_id, name, conditions, adjustment, priority, stackable, conflict_group?` | `conditions` = encoded JSON expression tree |
| 23 | `/rules/update` | `token, project_id, rule_id, …same fields` | Creates a **new rule version**, old one retained for replay |
| 24 | `/rules/list` | `token, project_id, include_disabled?` | All rules + trigger counts + versions |
| 25 | `/rules/conflicts` | `token, project_id, rule_ids?` | Static conflict/overlap/unreachable-rule detection |

## 🎯 3.7 Strategies & Lifecycle (6)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 26 | `/strategies/create` | `token, project_id, name, rule_ids, guardrail_override?` | New strategy → version v1 |
| 27 | `/strategies/update` | `token, project_id, strategy_id, rule_ids, …` | Creates an **immutable new version** |
| 28 | `/strategies/list` | `token, project_id` | All strategies + current lifecycle state |
| 29 | `/strategies/validate` | `token, project_id, strategy_id, version` | Pre-activation gate: conflicts, missing signals, guardrail sanity, unreachable rules |
| 30 | `/strategies/promote` | `token, project_id, strategy_id, version, mode` | `mode = shadow \| active \| paused`. Single lifecycle transition endpoint |
| 31 | `/strategies/rollback` | `token, project_id, strategy_id, to_version` | Instant revert. Separate from promote for distinct audit semantics + it's a demo headline |
| — | `/strategies/approval-policy` | `token, project_id, require_approval` | Toggle human-in-the-loop: must a publish be approved before it goes live? |
| — | `/strategies/publish/pending` | `token, project_id` | Publishes waiting on approval |
| — | `/strategies/publish/approve` | `token, project_id, request_id` | Approve a pending publish → it goes active |
| — | `/strategies/publish/reject` | `token, project_id, request_id` | Reject a pending publish |

## 🧪 3.8 Simulation & Backtesting (6)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 32 | `/simulate/whatif` | `token, project_id, item_id, strategy_version, overrides` | Runs the **real engine** on hypothetical context. Returns price + rules fired + guardrail effect |
| 33 | `/simulate/compare` | `token, project_id, item_id, versions, overrides?` | Same scenario across strategy versions side by side |
| 34 | `/backtest/run` | `token, project_id, strategy_id, version, from, to` | Enqueues job → returns `job_id` |
| 35 | `/backtest/result` | `token, project_id, job_id` | Actual vs simulated: revenue, margin, orders, price changes, **correctness/determinism check** |
| 36 | `/backtest/list` | `token, project_id` | Backtest history |
| 37 | `/shadow/comparison` | `token, project_id, limit?` | Live actual price vs shadow recommendation + delta % |

## 🔍 3.9 Decisions & Replay (3)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 38 | `/decisions/list` | `token, project_id, item_id?, limit?, cursor?` | Decision feed |
| 39 | `/decisions/replay` | `token, project_id, decision_id` | **Full reconstruction**: inputs, features, strategy+ruleset version, each rule's contribution, guardrails, final price, timestamp |
| 40 | `/decisions/verify` | `token, project_id, decision_id` | **Re-executes the engine** on the stored snapshot and asserts the price matches. Machine-checkable proof of determinism — directly answers the correctness KPI |

## 📊 3.10 Analytics (5)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 41 | `/analytics/overview` | `token, project_id, range` | Dashboard KPI cards: revenue, margin, orders, avg price, conversion, demand, price changes, uplift |
| 42 | `/analytics/timeseries` | `token, project_id, metric, range, interval` | Chart data for any metric (price, demand, revenue, inventory, latency, throughput) |
| 43 | `/analytics/rules` | `token, project_id, range` | Rule health: triggers, conflicts, blocked, which rule won |
| 44 | `/analytics/system` | `token, project_id` | P50/P95/P99, RPS, error rate, SQS backlog, DLQ, data freshness per signal, fallback count, guardrail blocks |
| 45 | `/analytics/domains` | `token` | 🌍 Cross-project rollup — **the "one engine, many domains" proof panel** |
| — | `/analytics/portfolio` | `token` | Portfolio view across all the tenant's projects |
| — | `/analytics/pipeline` | `token, project_id` | Event-pipeline health read straight from SQS queue depth (instant, not CloudWatch-lagged) |
| — | `/live/events` | `token, project_id, limit?` | Recent raw events feed |
| — | `/live/decisions` | `token, project_id, limit?` | Recent pricing decisions feed (dashboard live panel) |
| — | `/live/pulse` | `token, project_id` | Lightweight "is anything happening" poll, the WS fallback |
| — | `/live/connections` | `token, project_id` | Currently-connected dashboard sockets |

## 🚨 3.11 Alerts & Audit (4)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 46 | `/alerts/list` | `token, project_id?, severity?, status?` | Alert center (web + Android). `project_id` optional → cross-project for mobile |
| 47 | `/alerts/get` | `token, alert_id` | Alert detail: problem, reason, impact, recommended action, linked decision |
| 48 | `/alerts/ack` | `token, alert_id, action` | `action = ack \| resolve \| dismiss` |
| 49 | `/audit/list` | `token, project_id, entity_type?, limit?, cursor?` | Audit trail: who/what/when/old/new/versions/decision_id |

## ✅ 3.11b Approvals — the human-in-the-loop decision flow (5)

The loop you asked for: something happens → a notification goes out → the analyst opens the app and immediately sees a question with options → they pick one → the action executes.

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 49a | `/approvals/pending` | `token, project_id?, limit?` | **Called on every home-screen open.** One Query over a sparse prefix, ~10 ms. Returns the question and its options ready to render |
| 49b | `/approvals/get` | `token, approval_id` | Deep-link target for a notification tap |
| 49c | `/approvals/answer` | `token, approval_id, option_id, note?, source?` | Records the choice and executes the mapped action. **Idempotent** — answering twice returns the first outcome |
| 49d | `/approvals/history` | `token, project_id?, limit?` | What was asked, what was chosen, what happened, median response time |
| 49e | `/notify/send` | `token, title, body, severity, approval_id?, project_id?` | Send a push. `info` is refused outright — it never leaves the dashboard |
| 49f | `/approvals/raise` | `token, project_id, reason` | Deterministically create a **real** approval + push, without waiting for an anomaly. Builds genuine options (keep monitoring / safe mode / pause) and is visible in decisions + audit — used to demo the notification loop on demand |

**The ordering is the whole design:**

```
anomaly detected (feature-worker)
        ↓
    SQS alert queue
        ↓
alert-worker:  store alert
               ↓
               Gemini writes the question + 2-4 options   ← ~1.2s, on the WRITE path
               ↓
               validate every option against a FIXED action enum
               ↓
               store approval + open pointer
               ↓
               FCM push                                    ← sent LAST
        ↓
📱 phone buzzes
        ↓
analyst opens app → /approvals/pending → ONE DynamoDB Query, no model call
        ↓
taps an option → /approvals/answer → executor runs → open pointer deleted
```

- ⏱️ **Gemini never runs while the analyst waits.** By the time the phone buzzes the question already exists in DynamoDB, so opening the app is a plain database read. A model call on the home screen would put a second of latency on the one screen that must feel instant.
- 🔒 **The model writes the button text; code decides what the button does.** Options may only carry an action from a fixed enum in `core/approvals/actions.py` (`PAUSE_STRATEGY`, `ROLLBACK_STRATEGY`, `ACTIVATE_SAFE_MODE`, `DISABLE_RULE`, `WIDEN_GUARDRAIL`, …). Validation drops any option whose action is unknown, or whose version/rule id doesn't exist. A button that cannot work is worse than no button at 3am.
- 🚪 **There is always a do-nothing option.** If the model doesn't offer one, `KEEP_MONITORING` is appended automatically. The analyst must always be able to decline.
- 🤝 **Gemini down? The analyst still gets a decision.** `alert_worker._fallback_approval` is a hand-written, deliberately conservative option set. On-call must never be blocked by a model being unavailable.
- 🔁 **Dedup window of 15 minutes.** A flapping anomaly produces one question, not twenty notifications.
- 📱 **No mobile-only mutation endpoints.** Emergency actions reuse `/strategies/promote`, `/strategies/rollback` and `/approvals/answer`.

## 📱 3.12 Mobile & Realtime (3)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 50 | `/devices/register` | `token, fcm_token, platform` | Register for push. Stale tokens pruned on FCM failure — no unregister endpoint needed |
| 51 | `/mobile/home` | `token` | One aggregated call for the Android home screen (status, revenue, demand, margin, alert count, active strategy). Saves the phone 5 round-trips on a weak network |
| 52 | `WSS /realtime` | `token, project_id` | WebSocket connect for the live dashboard |

📌 Android emergency actions (**Pause / Rollback / Safe Mode**) reuse `/strategies/promote` and `/strategies/rollback`. **No duplicate mobile APIs.**

## 🤖 3.13 AI & Demo (4)

| # | Endpoint | Params | Purpose |
|---|---|---|---|
| 53 | `/ai/configure` | `token, project_id, prompt` | ✨ **NL → structured configuration.** Classifies intent, emits config, returns interpretation + warnings + conflicts. Always a **draft**. See Part 4 |
| 54 | `/ai/forecast` | `token, project_id, item_id, horizon` | *Optional ML* — demand forecast + elasticity hint. Advisory only, never in the pricing path |
| — | `/ai/testcases` | `token, project_id` | Generate ready-to-run test cases for the project's rules |
| — | `/ai/rules/best` | `token, project_id` | Suggest strong rules for the declared schema (draft only) |
| — | `/ai/chat/history` | `token, project_id` | The schema-design conversation transcript (also streamed over the WS agent) |
| — | `/ai/health` | `token` | Gemini key-pool / model-chain health |
| 55 | `/demo/traffic` | `token, project_id, events_per_sec, duration` | Synthetic event generator — makes the live dashboard move during the demo |
| 56 | `/demo/chaos` | `token, project_id, scenario` | `stale_data \| engine_error \| sqs_delay \| duplicate_event \| traffic_spike`. Proves resilience live instead of claiming it |

📌 **No separate AI-draft endpoints.** The AI returns config JSON → the UI loads it into the visual rule builder → the analyst edits → saves through the normal `/rules/create` or `/guardrails/save`. Anomaly detection needs no endpoint either: `feature-worker` detects it and emits alerts through the existing alert pipeline.

---

## 3.14 Summary

~90 GET endpoints in total. By module (indicative):

| Module | Count |
|---|---|
| Auth & Account | 5 |
| Projects & Domain | 9 |
| Pricing Items | 5 |
| Historical Data | 3 |
| Runtime (dynamic/customer) | 8 |
| Rules | 6 |
| Strategies & Lifecycle | 11 |
| Simulation & Backtesting | 4 |
| Decisions & Replay | 3 |
| Analytics & Live feeds | 11 |
| Alerts & Audit | 4 |
| Approvals & Notifications | 6 |
| Mobile & Realtime | 3 |
| AI & Demo | 8 |
| **TOTAL** | **~90** |

> The hot-path, ingest and WebSocket endpoints are served by their own Lambdas
> (`price-fn`, `event-fn`, `ws-fn`); everything else is the one `api-fn`
> FastAPI Lambdalith.

### Deliberately excluded
❌ logout (TTL handles it) · ❌ password reset · ❌ update/delete profile · ❌ delete account ·
❌ email verification · ❌ team/user invites · ❌ roles & permissions UI · ❌ billing ·
❌ webhooks · ❌ separate mobile *mutation* APIs (the app reuses promote/rollback/answer)

Every one of those is enterprise-admin scaffolding that does not demonstrate the
core problem statement. (Delete/rename project, item edit/delete, and the
publish-approval flow **do** exist — see §3.2, §3.3, §3.7.)

---

# PART 4 — AI CONFIGURATION LAYER ✨

## 4.1 What it is (and what it is not)

**It is:** a translator. Plain English in → structured pricing configuration out, as a **draft** the analyst reviews.

**It is not:** a chatbot, a pricing authority, or anything the runtime plane ever calls.

> 🔒 **The one rule that governs this entire layer:**
> **AI output is data, never an action.** It produces a *proposal*. Only a human, through the existing endpoints, turns a proposal into an active rule.

```
Natural Language
      ↓
  AI Layer  (Gemini · 23-key pool)      ← can be wrong, and that's fine
      ↓
Structured Config (draft)
      ↓
Schema Validation                        ← mechanical, deterministic
      ↓
Conflict Detection                       ← reuses /rules/conflicts logic
      ↓
Simulation / What-if                     ← reuses the real engine
      ↓
👤 Human Approval
      ↓
Versioned Rule
      ↓
Deterministic Pricing Engine             ← the only thing that sets prices
```

The AI sits entirely in the **control plane**. `price-fn` has no network path to Bedrock. That's enforced by IAM, not by convention — the pricing Lambda's execution role simply has no `bedrock:InvokeModel` permission.

---

## 4.2 🌍 How it stays domain-agnostic (the important part)

This is the mechanism that makes the feature valuable rather than a gimmick, and it's the same mechanism that satisfies the core KPI.

**The AI is never told what industry it's working in. It's handed the project's schema as its only vocabulary.**

```
GET /ai/configure?token=…&project_id=…&prompt=Increase+room+prices+when+occupancy+exceeds+85%25
         │
         ├─ load the project's domain schema from DynamoDB
         │     entity: "Room"
         │     attributes:      room_type(enum), base_price(currency), location(string)
         │     context_signals: occupancy(0-100), availability(0-100),
         │                      competitor_price(currency), season(enum)
         │     guardrails:      max_increase 10%, min_price ₹1500
         │
         ├─ build prompt: schema as the ALLOWED FIELD LIST + the config JSON grammar
         │
         ├─ Bedrock → Claude → config JSON
         │
         ├─ VALIDATE against the schema          ← every `field` must exist in context_signals
         │     ├─ unknown field?  → 1 repair retry with the error fed back
         │     └─ still invalid?  → return clarification_needed, open the visual builder
         │
         ├─ RANGE CHECK                          ← thresholds within the signal's declared range
         ├─ GUARDRAIL CHECK                      ← flag if the adjustment exceeds project limits
         ├─ CONFLICT CHECK                       ← run the existing deterministic conflict detector
         │
         └─ return { kind, config, interpretation[], warnings[], conflicts[] }
```

Same code path, different schema:

| Domain | Analyst types | AI emits `field` |
|---|---|---|
| 🛒 E-commerce | "when demand is high and stock is low" | `demand_score`, `inventory` |
| 🏨 Hotel | "when occupancy exceeds 80%" | `occupancy` |
| 🚕 Ride-hailing | "when requests far exceed available drivers" | `demand_score`, `driver_supply` |
| 🔌 EV charging *(new domain, live)* | "when grid load is high at peak hours" | `grid_load`, `hour_of_day` |

🎯 The last row is the demo moment: a domain the AI has never seen, configured in the UI minutes earlier, and the NL feature works on it immediately — **because the schema is an input, not hardcoded.**

---

## 4.3 The five configuration kinds it must handle

The analyst doesn't pick a type from a dropdown. `/ai/configure` **classifies** the intent itself and returns a `kind`.

**1️⃣ `rule`** — simple condition → adjustment
> *"Increase price by 10% when demand is above 80 and inventory is below 20."*
```json
{ "kind": "rule",
  "config": {
    "condition": { "all": [
      { "field": "demand_score", "operator": ">", "value": 80 },
      { "field": "inventory",    "operator": "<", "value": 20 }]},
    "adjustment": { "type": "percentage", "value": 10 },
    "priority": 50, "stackable": true }}
```

**2️⃣ `tiered_rule`** — banded thresholds
> *"50–70 demand → +5%, 70–90 → +10%, above 90 → +15%."*
```json
{ "kind": "tiered_rule",
  "config": { "field": "demand_score", "tiers": [
    { "from": 50, "to": 70,   "adjustment": { "type": "percentage", "value": 5  }},
    { "from": 70, "to": 90,   "adjustment": { "type": "percentage", "value": 10 }},
    { "from": 90, "to": null, "adjustment": { "type": "percentage", "value": 15 }}]}}
```
> ⚙️ The engine compiles tiers into N mutually-exclusive rules in one `conflict_group`. Bands are validated as non-overlapping and gap-free — tier maths is checked mechanically, not trusted to the AI.

**3️⃣ `constraint`** — a guardrail, not a rule
> *"Never allow the price to go below ₹1,500."*
```json
{ "kind": "constraint", "config": { "min_price": 1500 } }
```
> Saves through `/guardrails/save`, not `/rules/create`. The AI routes it correctly — the analyst doesn't have to know the difference.

**4️⃣ `schedule`** — time-scoped effectiveness
> *"Increase prices by 10% on weekends."*
```json
{ "kind": "schedule",
  "config": { "condition": { "all": [{ "field": "day_of_week", "operator": "in", "value": ["SAT","SUN"] }]},
              "adjustment": { "type": "percentage", "value": 10 },
              "effective": { "days": ["SAT","SUN"], "timezone": "Asia/Kolkata" }}}
```
> ⏰ `day_of_week` / `hour_of_day` / `season` are **injected into every project's schema automatically** as built-in context signals. Time comes from the context row, never from `Date.now()` inside the engine — otherwise replay and backtesting break.

**5️⃣ `strategy`** — multiple rules plus a constraint in one sentence
> *"On weekends increase prices when demand is high, but never more than 20%."*
```json
{ "kind": "strategy",
  "config": { "rules": [ /* weekend rule, high-demand rule */ ],
              "guardrail_override": { "max_increase_pct": 20 }}}
```
> Returned as a **bundle of drafts**. The analyst reviews each piece separately — one sentence must not silently create five live objects.

---

## 4.4 🧠 Show the interpretation, never just the JSON

The response is built so the UI can render exactly this, with no extra calls:

```text
YOU SAID
"Increase price by 10% when demand is above 80 and inventory is below 20."

AI UNDERSTOOD
✓ Demand Score  >  80          (matched signal: demand_score, range 0–100)
✓ Inventory     <  20          (matched signal: inventory, range 0–100)
✓ Adjustment    =  +10%
✓ Applies to    =  Product     (this project's pricing entity)
✓ Stacking      =  Allowed
✓ Priority      =  50 (Medium)  ← inferred, editable

⚠️ POTENTIAL CONFLICT
Rule R-18 already adjusts price under overlapping conditions.
[Review Conflict]

⚠️ GUARDRAIL NOTE
+10% is exactly at this project's max-increase limit.
Some decisions will be capped.

Status: DRAFT

[Edit]  [Validate]  [Simulate]  [Save Rule]
```

Response shape:
```json
{
  "kind": "rule",
  "config": { "…": "structured config" },
  "interpretation": [
    { "label": "Demand Score > 80", "field": "demand_score",
      "matched_from": "demand is above 80", "confidence": "high" }
  ],
  "inferred": ["priority", "stackable"],
  "warnings": [{ "type": "guardrail_boundary", "message": "…" }],
  "conflicts": [{ "rule_id": "R-18", "overlap": "demand_score>80", "severity": "warn" }],
  "unmapped": [],
  "clarification_needed": null
}
```

Three fields that make this honest rather than magic:
- 🔍 **`matched_from`** — which words in the prompt produced each clause. The analyst can see the AI didn't invent anything.
- 🏷️ **`inferred`** — what the AI filled in that the analyst never said. Highlighted in the UI as "we guessed this."
- ❓ **`unmapped`** / **`clarification_needed`** — if the prompt mentions something not in the schema ("increase when the weather is bad" with no weather signal), we **say so and ask**, rather than quietly dropping it or hallucinating a field.

---

## 4.5 ✏️ Draft-only, editable, then the normal gates

AI output never writes to DynamoDB. It comes back to the browser, populates the **visual rule builder**, and the analyst edits in place:

```
Demand > 80   →   Demand > 75
+10%          →   +8%
```

Then it takes the same path as a hand-built rule, with no shortcuts:

```
Save as Draft → Validate → Simulate → Backtest → Shadow → Activate
```

- 📝 Every AI-originated rule is stamped `origin: "ai"` + the original prompt, and that lands in the audit log. Months later you can ask *"which rules came from AI and how have they performed?"*
- 🚫 There is no "AI, activate this" path. Not disabled — **not implemented.**

---

## 4.6 Reverse direction: config → English (no AI needed)

The spec asks for "configuration explanation." We do **not** use a model for this.

A deterministic template renderer turns any config back into a sentence:

```
{all:[demand_score>80, inventory<20]} → +10%
    ↓
"When Demand Score is above 80 and Inventory is below 20, increase the price by 10%."
```

- ✅ instant, free, offline, and **always correct**
- ✅ works inside Decision Replay to narrate why each rule fired
- ✅ one renderer, driven by the schema's display labels → works for any domain
- ❌ an LLM here would be slower, cost money, and could *misdescribe a live rule* — the one place we genuinely cannot tolerate being wrong

> 💡 General principle: **AI for the fuzzy direction (English → structure). Code for the exact direction (structure → English).**

---

## 4.7 Implementation notes

- 🧩 **Model**: Google Gemini via `generativelanguage.googleapis.com`, with a **23-key pool**. Keys are the new `AQ.Ab…` "Auth key" format (AI Studio no longer issues `AIza…` keys) and authenticate with the `x-goog-api-key` header. Keys live in SSM Parameter Store as a SecureString, never in the template or a Lambda env var.
- 🔀 **Model fallback chain in SSM, not code.** Measured reality: `gemini-2.5-flash` is retired for newer accounts (404), and `gemini-3.6-flash` / `gemini-3.8-flash` returned 503 across the entire pool at probe time. Hardcoding a model guarantees an outage, so the ordered chain lives at `/devnexus/<stage>/gemini/models` and is re-pointed without redeploying.
- 🩺 **Four failure modes, four reactions** (`core/ai/key_pool.py`). Most clients collapse these into one retry loop and either burn the pool during a model outage or discard keys that were briefly throttled:
  - `503` model saturated → **rotate the model**, keep the key
  - `429` key rate-limited → **cool the key** 45 s, keep the model
  - `403/401` project denied → key is **dead**, never retry
  - `404` model retired for that account → that **(key, model) pair** is dead
- 🏁 **Hedged requests.** Fire N attempts on different keys in parallel, take the first to answer, cancel the rest. Measured spread on identical prompts was 0.9 s → 1.5 s, so hedging collapses p99 toward p50. Costs N× tokens, so only interactive paths hedge.
- 🚫 **`thinkingBudget: 0`.** These are extraction tasks. Thinking tokens would double or triple latency for no accuracy gain on "parse this sentence into JSON".
- 📐 **Server-side `responseSchema`** at temperature 0. No markdown fences to strip, no preamble, no repair parse. The schema is flat and union-free because Gemini's schema subset supports neither recursion nor `oneOf` — so a condition tree is a flat clause list with one `logic` operator, which covers every real pricing rule and never fails to parse.
- 🔁 **One repair retry max.** The validation error is fed back verbatim; if it fails twice we stop and open the visual builder. Bounded latency beats a clever loop.
- 💾 **Cache on `hash(prompt + schema_version)`** in DynamoDB, 24 h TTL. A repeated demo prompt returns in ~15 ms instead of ~1.2 s, free. Editing the schema bumps its version and invalidates every stale draft automatically.
- 🛡️ **Prompt injection has nowhere to go.** The prompt is a free-text query param, but it can only produce JSON validated against a fixed grammar and a fixed field list. `/ai/configure` holds no write permission to anything but the draft cache, and `price-fn` has **no `ssm:GetParameter` and no network path to Gemini at all** — enforced by its IAM role, not by code review.
- 📊 **Where it lives in the UI**: `Rules & Strategies → ✨ AI Configuration`, plus a dashboard quick action **"✨ Create pricing rule with AI"**.

---

## 4.8 Final division of labour

| 🤖 AI does | ⚙️ Deterministic engine does |
|---|---|
| Natural language → configuration | Evaluate conditions |
| Demand prediction *(optional, advisory)* | Resolve conflicts |
| Anomaly detection *(optional, → alerts)* | Apply priorities & stacking |
| Suggest priority / stacking defaults | Apply constraints & guardrails |
| | Calculate the final price |
| | **Guarantee reproducibility** |

🎯 This keeps DevNexus a **backend/distributed-systems project with an AI assist**, not an ML project wearing a pricing costume — which is the right read of the problem statement, and the more defensible build.

---

# PART 5 — BUILD ORDER

> The `*-fn` names below are the *logical* build phases from early planning. In
> the final system every control-plane group (auth, project, item, rule,
> strategy, simulate, decision, analytics, audit, …) is one FastAPI Lambda —
> `api-fn` — as described in §2.6. Only `price-fn`, `event-fn` and `ws-fn`, plus
> the five SQS workers, are separate Lambdas. Read the names here as
> responsibilities, not deployment units.

| Phase | Deliverable | Why first |
|---|---|---|
| **1** | DynamoDB tables + `auth-fn` + `project-fn` (APIs 1–10) | Nothing exists without identity + a project to hang config on |
| **2** | 🎯 **Deterministic engine as a standalone, pure, unit-tested module** | The heart. Zero AWS dependencies → testable in milliseconds, reusable by price/simulate/backtest/verify |
| **3** | `item-fn` + `price-fn` + context table (APIs 11–13, 17–19) | First end-to-end price out of the API |
| **4** | `event-fn` + SQS + `feature-worker` (APIs 20–21) | Makes pricing *dynamic* instead of static |
| **5** | `rule-fn` + `strategy-fn` + lifecycle (APIs 22–31) | The no-code configuration surface |
| **6** | `simulate-fn` + `decision-fn` (APIs 32–33, 38–40) | Explainability + the determinism proof |
| **7** | S3 upload + `data-worker` + `backtest-fn` (APIs 14–16, 34–37) | Historical intelligence + shadow mode |
| **8** | Realtime WS + `analytics-fn` + dashboard UI (APIs 41–45, 52) | The live operations center |
| **9** | `alert-worker` + FCM + Android app (APIs 46–51) | Mobile emergency plane |
| **10** | ✨ AI configuration layer (APIs 53–54) | Only needs the schema + rule endpoints from phases 5–6, so **this can be built in parallel from phase 6 onward** — don't leave a demo headline until the last day |
| **11** | Load test, chaos endpoints, 4th-domain live demo (APIs 55–56) | Measured numbers + the winning demo |

> ⚠️ **Phase 2 is the single highest-leverage decision in this build.** Keeping the engine a pure function of `(base_price, context, ruleset_version, guardrails)` is what simultaneously delivers determinism, reproducibility, fast simulation, honest backtesting, and verifiable replay. If the engine ever reaches into a database or a clock directly, all five of those break at once.
