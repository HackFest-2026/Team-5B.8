# DevNexus — Research & Analysis

**A single configurable pricing engine across industries.**
This document records the industry research that shaped the engine, the common
patterns we abstracted, the differences we deliberately pushed out of the core,
and the assumptions and limitations of the result.

It is written to stand alongside [`ARCHITECTURE.md`](./ARCHITECTURE.md), which
covers the system design and the full API. Where this document says "the
engine", it means the deterministic price calculation described in
ARCHITECTURE.md §2.8 (the hot path).

---

## 1. Method

We studied how price is actually *decided* in a range of industries, then built
working implementations in three of them — **E-commerce**, **Banking (lending)**
and **Ride-hailing** — against one engine, with no domain-specific code on the
pricing path. The simulation sites in [`real-time-simulation/`](./real-time-simulation/)
drive those three domains through the live external API, which is our ongoing
proof that the abstraction holds in motion, not just on paper.

For each industry we asked the nine questions the brief poses:

1. What factors influence price?
2. How are those factors combined?
3. What pricing strategies are used?
4. How frequently can prices change?
5. What constraints exist?
6. How are competing pricing rules resolved?
7. What information is required at pricing time?
8. How is the final price explained?
9. How are pricing strategies configured and changed?

---

## 2. Three industries, studied in depth

### 2.1 E-commerce (retail dynamic pricing)

Our built domain: **holistic product pricing** — the whole catalogue reprices,
not one hero SKU.

| Question | Finding |
|---|---|
| **Factors** | Inventory on hand, demand velocity, competitor price, time-of-day / season, promotional events (flash sale, festival), product cost (margin floor) |
| **Combined** | Additive and multiplicative adjustments off a **base price**; margin acts as a hard floor, not an adjustment |
| **Strategies** | Markup over cost, demand-following, inventory clearance, competitive matching, promotional override |
| **Change frequency** | Minutes to hours; flash events flip in seconds |
| **Constraints** | Never sell below a minimum margin; price caps to avoid gouging/optics; rounding to charm prices |
| **Conflict resolution** | Promotion usually wins over demand; margin floor overrides everything |
| **Info at pricing time** | Item id, base price, cost, current inventory/demand signals, active promo flags |
| **Explanation** | "Base ₹X, +demand, −clearance, clamped to margin floor" line items |

**Key insight:** most "product data" (title, images, categories) never touches
pricing. Only an **id, a base price, and an optional cost** are structurally
required. Everything else is a *signal*, not a field.

### 2.2 Banking — lending (the "price" is an APR)

Our built domain: **lending APR** — the interest rate is the price.

| Question | Finding |
|---|---|
| **Factors** | Applicant risk (credit score, DTI), loan amount & tenure, collateral, policy/benchmark rate, market conditions, regulatory floor/ceiling |
| **Combined** | **Base rate + risk premium ± adjustments**; risk is a tiered add-on, not a free-form multiplier |
| **Strategies** | Risk-based pricing, relationship discounts, benchmark-linked (repo/prime + spread), promotional APR |
| **Change frequency** | Rates move on policy/benchmark changes (days–weeks); per-application the rate is computed once and *locked* |
| **Constraints** | Hard regulatory ceiling (usury) and floor; the rate offered must be reproducible for audit/dispute |
| **Conflict resolution** | Regulatory bounds override; higher-risk premium takes precedence over relationship discount up to the floor |
| **Info at pricing time** | Applicant risk signals (request scope), loan attributes, current benchmark (overall scope) |
| **Explanation** | "Benchmark 9.0% + risk premium 3.5% − relationship 0.5% = 12.0% APR, within policy band" |

**Key insight:** banking proved the engine must not assume "price goes up when
demand is high." Here the price is a **rate**, the drivers are **risk and
policy**, and the binding constraints are **regulatory bands**. The same
`base + adjustments within guardrails` shape still fits — which is exactly why
it is the right abstraction.

### 2.3 Ride-hailing (surge)

Our built domain: **ride pricing**, including **device-type signalling**
(iPhone vs Android) as a request-scope attribute.

| Question | Finding |
|---|---|
| **Factors** | Live demand/supply ratio (surge), pickup location/zone, time (peak hours), trip distance/duration, customer segment / device |
| **Combined** | **Base fare × surge multiplier**, plus per-segment adjustments |
| **Strategies** | Surge multiplier, zone pricing, time-of-day, segment pricing |
| **Change frequency** | Seconds to minutes — the most volatile of the three |
| **Constraints** | Surge cap (regulatory/optics); never below base fare |
| **Conflict resolution** | Zone and surge compose multiplicatively; cap clamps the result |
| **Info at pricing time** | Zone + live demand/supply (overall/request), rider segment/device (request), trip attributes (request) |
| **Explanation** | "Base ₹X × 1.8 surge (high demand), zone +₹Y, capped at 2.0×" |

**Key insight:** ride-hailing is where **request-scope context** dominates —
the price depends overwhelmingly on *this* request's time, place and rider, not
on stored item data. This forced the three-scope signal model below.

### 2.4 Industries studied for generalization (not built)

To test the abstraction beyond the three we implemented, we checked it against:

- **Hotels** — occupancy, season, lead time, length of stay → base rate ×
  occupancy/season adjustments, min-rate floor. Maps cleanly: room = item,
  occupancy = overall signal, lead time/LOS = request signals.
- **Airlines** — fare buckets, load factor, days-to-departure, route. Maps as
  item = fare class, load factor = overall signal, days-to-departure = request.
- **Car rental** (the likely new-domain challenge) — vehicle class as item;
  fleet utilization as an overall signal; rental duration, pickup location and
  lead time as request signals; base daily rate with utilization and
  duration adjustments inside a min/max band. **Adding it is configuration only
  — a schema + a few rules + guardrails — no engine change.** This is the claim
  the brief's §8 tests, and the three-scope model is what makes it true.

---

## 3. Common patterns (what we abstracted into the core)

Across every domain, the *same shape* appeared under different vocabulary:

1. **There is a base, and the dynamic price is the base plus signed
   adjustments.** Retail markup, loan benchmark+spread, ride base×surge — all
   reduce to `base → apply adjustments → clamp`.
2. **Price is driven by context, and context lives at three distinct scopes:**
   - **Item scope** — differs per product (base price, cost, inventory).
   - **Overall scope** — shared by the whole project at a moment in time
     (benchmark rate, city-wide demand, "flash sale on").
   - **Request scope** — arrives with each individual pricing call (this
     rider's device, this applicant's risk, this booking's lead time).
   This three-scope split is the single most important research outcome: it is
   what lets one engine serve item-dominated (retail) and request-dominated
   (ride, lending) domains without special-casing either.
3. **A rule is `WHEN <condition on a signal> THEN <adjustment>`**, with a
   **priority** so order is deterministic. Conditions are comparisons on named
   signals; adjustments are percentage or absolute moves on the running price.
4. **Hard limits are separate from rules.** Every domain has bounds the price
   may *never* cross (margin floor, regulatory band, surge cap). These are
   **guardrails** — max increase %, max decrease %, min margin % — applied
   *after* the rules, so a rule can never breach them. Limits protect; rules
   decide.
5. **Pricing must be explainable and reproducible.** Every domain needs to
   answer "why this price" — for the customer, the regulator, or the analyst.
   So the engine records the base, each applied driver and its contribution, and
   the clamp, for every decision.
6. **Pricing changes go through a lifecycle, not a hot edit.** Draft → validate
   → simulate → approve → publish → active → retire. No domain lets you change a
   live price band without a safety gate.

## 4. Differences (what we deliberately kept *out* of the core)

| Difference | Why it is NOT in the engine |
|---|---|
| **The meaning of "price"** (amount vs APR vs multiplier) | The engine prices a **number**; what it *represents* is the domain's concern. Nothing in the hot path knows "rupees" or "percent". |
| **Which signals exist** (occupancy, risk, surge…) | Signals are **declared per project** in the schema, never enumerated in code. The engine reads signals by name and scope only. |
| **Direction of movement** (demand ↑ price vs risk ↑ rate) | Encoded by the analyst's rules, not assumed. Banking disproves any built-in "demand raises price" bias. |
| **Domain fields** (title, images, SEO, seat map) | Not stored. The customer's own system stays the source of truth; DevNexus holds only id/base/cost + signals. |
| **Rounding / formatting conventions** | A presentation concern left to the caller; the engine returns the computed number and the drivers. |

The discipline is: **if it varies by domain, it is data (schema, rules,
guardrails, signals) — not code.**

## 5. Proposed abstraction (the result)

> A **project** is one pricing system. It declares a **schema** of signals at
> three scopes (item / overall / request). Its **items** carry only
> `id`, `name`, `price`, and optional `cost`. Its **rules**
> (`WHEN signal-condition THEN adjustment`, ordered by priority) move the price;
> its **guardrails** (max up %, max down %, min margin %) bound the result. A
> **strategy** groups rules and moves through a lifecycle. The **engine**
> evaluates `base → ordered rules → clamp to guardrails`, deterministically,
> and emits a **decision** recording every driver so the price is explainable
> and reproducible. **AI assists configuration only** (natural language →
> draft rules the analyst edits); it never touches the price calculation.

This is why only `id/name/price` are universal, and cost/min/max are optional
and analyst-decided — see the standing design note in memory
(*General-purpose schema*). Any domain-specific default would be a bias that a
future domain (the next banking) would have to fight.

---

## 6. Assumptions

1. **The customer's system is the source of truth.** DevNexus stores only what
   pricing needs (id, base, cost, signals). Catalogue details, inventory of
   record, and customer master data live in the caller's systems; we price
   against values supplied at call time or synced as signals.
2. **One currency/unit per project.** The engine treats price as a dimensionless
   number; the project owner interprets the unit. Mixed-currency pricing within a
   single project is out of scope.
3. **Signals are supplied truthfully and in time.** Overall signals are set by
   the operator; request signals arrive on the call. The engine does not predict
   or source signals itself (no built-in demand forecasting).
4. **Adjustments compose in rule-priority order.** Where two rules both apply,
   the lower-priority number wins the ordering; guardrails then clamp. We assume
   the analyst expresses intent through priority rather than expecting the engine
   to "resolve" semantic conflicts on its own.
5. **Determinism over the request inputs.** Given the same item, the same active
   strategy/rules and the same signal values, the engine always returns the same
   price. Time-varying results come only from changed signals, which are recorded.
6. **Booleans are passed as the strings `"True"`/`"False"`** on the external API,
   matching the engine's comparison semantics (documented; see the simulation
   loop memory note).
7. **Human-in-the-loop for risky changes.** Strategy publish and emergency
   decisions route through the approval pipeline; we assume an operator is
   reachable (mobile app) for critical approvals.
8. **GET-only external API with token auth** is sufficient for the pricing read
   path and simplifies integration/caching; mutations happen in the control
   plane. (Rationale in ARCHITECTURE.md Part 1.)

## 7. Limitations

1. **No cross-item / basket pricing.** Each price is computed for one item in
   isolation. Bundle discounts, cart-level promotions and "buy X get Y" are not
   modelled.
2. **Single active strategy per project at a time.** We do not run competing
   strategies as A/B cohorts within one project in the hot path; experimentation
   is done via simulate/backtest, not live split traffic.
3. **Conflict handling is priority-ordered, not solver-based.** The engine does
   not detect *semantic* contradictions between rules automatically (e.g. two
   rules whose intents oppose). AI-assisted conflict hints exist in the config
   layer, but the final arbiter is explicit priority.
4. **Signal freshness is the operator's responsibility.** There is no built-in
   staleness/TTL enforcement on overall signals; a stale "flash sale on" flag
   will keep applying until cleared.
5. **No native multi-currency or FX.** See assumption 2.
6. **Explainability is additive-driver based.** It attributes the price to base
   + named adjustments + clamp. Highly non-linear or interaction-heavy pricing
   (e.g. a single opaque ML score) would not decompose as cleanly — by design,
   we kept the engine deterministic and linear-composable rather than ML-driven
   on the hot path.
7. **Approvals assume operator availability.** If no operator responds, critical
   decisions fall back to the configured safe behaviour rather than escalating
   externally (no paging/on-call integration).
8. **Rounding/charm-pricing is left to the caller.** The engine returns the
   computed number; presentation rules are not applied server-side.
9. **Scale tested at demo volumes.** The architecture (DynamoDB hot path, async
   event ingestion) is designed for spikes, but we have validated correctness and
   the live loop at hackathon scale, not production-grade load.

---

*Companion documents: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (system design +
full API specification), and the live proof in
[`real-time-simulation/`](./real-time-simulation/).*
