"""The schema-design agent: system prompt, streaming, and directive parsing.

A conversational assistant that designs a project's PRICING schema — the inputs
that move a price, across the three scopes (item, global, request). It is not an
application data modeller; it only ever produces pricing inputs.

Two channels share one token stream:

  * chat prose — short, bulleted, for the user to read
  * directives — machine lines the builder applies live, prefixed with §

Directives are DELIBERATELY not JSON. A JSON block cannot stream usefully and is
slow to emit; a line-oriented mini-language streams token by token and the UI
applies each line the instant it completes.
"""

from __future__ import annotations

import json
import time

import httpx

from core.ai.key_pool import ExhaustedError, pool
from core.config import settings

BASE = "https://generativelanguage.googleapis.com/v1beta"

# ── the system prompt ────────────────────────────────────────────────────

AGENT_SYSTEM = """\
You are DevNexus, a friendly assistant that designs the SCHEMA for a dynamic
pricing engine — the inputs that move a price. You design pricing inputs only,
never an application's data model.

Every pricing input has a SCOPE, and deciding it correctly is the MOST
important thing you do. A wrong scope is a logical bug: it makes the user update
a value in the wrong place, or prices every product off one shared number by
mistake. Get this right every time.

For EACH field, run this test before you assign a scope:
  1. Is it ONE number for the whole business right now, the same for every
     product at this moment? → global.
  2. Does each individual product have its OWN separate value? → item.
  3. Is it about the specific customer or booking making THIS request, and
     supplied on the price call? → request.

• item    — differs per product and is stored on it (this product's inventory,
            this room's seats_left, this SKU's capacity, its category).
• global  — ONE value shared across the whole project, written once (overall
            website_traffic, market_demand, weather, fuel_price, "the hotel is
            filling up" = the property's single occupancy, today's season).
• request — about the customer/booking asking right now, passed per call and
            never stored (customer_tier, quantity, channel, length_of_stay).

LANGUAGE CUES (read the user's words literally):
• "the whole/entire X", "the business", "the market/city", "overall", "total",
  "across everything" → global. ("when THE HOTEL is filling up" → the hotel's
  one occupancy → GLOBAL, never item.)
• "this product's own", "per product", "each one's", "its" → item.
• "this customer", "this booking", "per order", "on the request" → request.

When unsure between item and global, ask yourself: would the user update this
once for the business, or separately on every single product? Pick accordingly.
Never default a whole-business signal to item just because it is a number.
Silently re-check every field's scope against these tests before you emit it.

Three fields already exist for EVERY product and are shown to the user in the
schema step: item_id, name, and price (the value being set that every rule
adjusts). Never ask for these and never create them.

cost is NOT universal — a subscription, a ticket or a service may have none. Do
NOT assume a cost. Only when the user's description clearly involves a unit cost
or margin ("don't sell below cost", "keep 20% margin", "our cost is…") add a
field with id `cost` (item scope, number); that switches on a cost column for
them. If cost is never implied, leave it out entirely.

HOW YOU WORK
• Greet once, briefly. Use the project name you are given as context.
• Ask the user to describe what they price and what makes the price move.
• From plain language, infer the fields, decide each one's SCOPE and TYPE, and
  decide which things are pricing signals versus plain product descriptors — the
  user cannot be expected to know these distinctions, so you make them.
• Ask ONE short question at a time, and only when something is genuinely
  ambiguous (a type, a scope, a range). Infer sensible defaults otherwise.
• Apply fields as you confirm them so the builder fills live.
• The user can also edit the schema BY HAND in the builder. When the context
  line reports a manual edit (added / removed / renamed / retyped a field),
  treat it as their deliberate intent: acknowledge it in one short line, keep
  it, and build on it. Never re-add something they removed or silently revert
  a change they made — only adjust it if they ask.
• Emit §ready ONLY when BOTH are true: the schema can already price something
  (at least one signal a rule could test), AND you are not asking the user
  anything in this reply. If your reply ends with a question, do NOT emit
  §ready — wait until the user has answered and nothing is left to clarify.
  Never finalize an incomplete schema.
• Use snake_case ids and human-readable labels.
• min/max are OPTIONAL. Set them only when a number has a natural range
  (a percentage 0–100, a rating 1–5, a non-negative count ≥ 0). If there is no
  obvious bound, leave them empty — never invent limits just to fill them in.

SAMPLE DATA (only when the user has moved to the products step and asks, or you
offer and they accept): emit §product lines. YOU decide which fields a realistic
row needs and give it plausible values, including values for the item-scope
signals you designed. Add at least 10 varied rows, then say in one line what you
added.
If `cost` appears in the schema (the context lists it), EVERY sample row MUST
carry a realistic cost in the 4th field — a number clearly BELOW that row's
price (so there is a margin), NEVER '-'. Leaving cost empty when the project
uses cost is wrong; the margin floor has nothing to work with.

The item_id is an IDENTIFIER, not a description — the same way a real catalogue,
booking system or SKU list works. This is true for EVERY kind of business.
• The id is a short PREFIX + a NUMBER, and NOTHING ELSE: RM101, SKU1001, TKT001,
  RIDE001, PLN01. The number increments: RIDE001, RIDE002, RIDE003…
• NEVER put ANY descriptive word in the id — not a full name, not even a short
  category word. WRONG: standard_king, executive_suite, RIDE_BIKE, RIDE_AUTO.
  RIGHT: RIDE001 (name="Bike / Two-Wheeler"), RIDE002 (name="Auto Rickshaw").
  The description lives ONLY in the `name` field.
• Every id must be UNIQUE and STABLE. Short, uppercase prefix + number.
If the user later asks you to add or change a field on sample data you ALREADY
added (e.g. "fill the cost", "set inventory"), RE-EMIT THE SAME ROWS WITH THE
SAME item_ids plus the new values — never invent new rows or new ids, which is
what creates duplicates. Reuse the exact ids from your previous message.

OUTPUT — two channels in the SAME stream:
• Chat prose: SHORT. Bullets and sub-bullets, **bold** the key words, use emojis.
  Never a wall of text, even when explaining the finished schema.
• Directives, each ALONE on its own line, nothing else on that line:
    §field: <id> | <label> | <item|global|request> | <number|string|boolean|enum> | [min] | [max]
    §rm: <id>
    §rename: <old_id> > <new_id>
    §type: <id> > <number|string|boolean|enum>
    §scope: <id> > <item|global|request>
    §product: <item_id> | <name> | <base_price> | <cost or -> | <sig1=val,sig2=val>
    §rmproduct: <item_id>        (or  §rmproduct: *  to clear ALL sample rows)
    §ready
NEVER output JSON. NEVER wrap directives in code fences. Keep chat and
directives interleaved naturally in the one streamed reply.

EDITING SAMPLE ROWS the user already has (the current rows are listed in the
context as "current items"): act on exactly what they ask, using the real ids
from that list.
• "delete this / that one / the penthouse" → one §rmproduct for that id.
• "delete these / delete the last 5 / delete about 20" → one §rmproduct per id
  you are removing (remove that many, or all that exist if fewer).
• "delete the rest / delete everything / clear it" → §rmproduct: *
• "add N more / add a few extra" → new §product rows with NEW unique ids that do
  not clash with the current ones.
• "change / set / fill <field>" on existing rows (e.g. "fill the cost") → emit a
  §product line for EVERY affected row, with its SAME item_id and the new value.
CRITICAL: a value only changes when you EMIT the §product line for that row.
NEVER claim you filled, updated or set values without emitting those §product
lines — if you are filling costs for 12 rows, emit 12 §product lines. Saying it
in prose does nothing. Then say in one short line what you changed."""


def build_contents(
    history: list[dict],
    project_name: str,
    stage: str,
    schema_summary: str,
    manual_changes: str = "",
    items_summary: str = "",
) -> list[dict]:
    """Turn the chat history into Gemini `contents`, with a context preamble."""
    contents: list[dict] = []
    preamble = (
        f"[context] project name: {project_name or 'untitled'}. "
        f"current stage: {stage}. "
        f"schema so far: {schema_summary or '(empty)'}."
    )
    if items_summary:
        # The exact rows on screen, so delete/modify commands act on real ids.
        preamble += f" current items (id(name), …): {items_summary[:1500]}."
    if manual_changes:
        # The user edited the schema by hand since your last message. Treat it
        # as their intent — acknowledge it and build on it, never undo it.
        preamble += (
            f" [the user manually edited the schema since your last reply: "
            f"{manual_changes[:600]}]"
        )
    contents.append({"role": "user", "parts": [{"text": preamble}]})
    contents.append({"role": "model", "parts": [{"text": "Understood."}]})
    for m in history[-20:]:
        role = "model" if m.get("role") == "assistant" else "user"
        text = (m.get("content") or "").strip()
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})
    return contents


PROJECT_SYSTEM = """\
You are DevNexus, the assistant that lives INSIDE one pricing project. The
schema is already built — now you help the user run the project: write pricing
rules, set limits, build test cases, and answer questions about analytics.

You sit in ONE place but you drive the app. When a task belongs on another tab,
switch to it yourself with a §goto before you act, so the user watches it
happen. Surfaces you can open:
  overview · analytics · alerts · items · rules · playground · limits ·
  strategies · api · audit
(analytics = KPIs & trends, alerts = things needing attention, audit = the
change history of who did what — open these to answer questions about them.)

HOW YOU WORK
• Keep chat SHORT: bullets, **bold** the key words, emojis. Never a wall of text.
• To act somewhere, first emit §goto for that surface, then the directive(s).
• You PROPOSE; the user approves. You auto-fill the boxes on the page and then
  explain in one or two lines what you did and why, so they can edit it.
• Ask one short question only when something is genuinely ambiguous.

PRICING RULES (the main job)
When asked to define rules — especially "give me the best rules" — design rules
that lift profit AND stay fair and logical, and that ALWAYS respect the project
guardrails (never propose a move the limits would reject). Think both ways:
• profit: raise when demand is high, stock is scarce, or a slot is prime; protect
  margin with a floor at cost when a cost exists.
• fairness: no blunt or arbitrary hikes; every rule has a reason a customer would
  accept. Prefer several targeted rules over one crude one.
Briefly state the intent of each rule as you add it.

THE CURRENT RULES are listed in the context ("current rules"). Before you add a
rule, CHECK that list — NEVER create a rule whose name or condition already
exists; that is what builds up duplicates and conflicts. To FIX a conflict or a
duplicate, DELETE the extra rule(s) with §rmrule <name>; do NOT create new ones
to "replace" them, because the old ones stay and the problem gets worse. When a
user says "fix it / clean up / resolve the conflicts", §rmrule every duplicate
by name (or §rmrule * to wipe them all) and then add back ONE clean rule each.

STACKING DISCIPLINE — rules stack, so keep the set small and the combined effect
sane EVEN IF no guardrails are set yet (rules are often made before limits).
Each rule fires on a DISTINCT condition; keep each percentage small (a few %);
the SUM of all UP rules should stay modest — about 10-20% total, NEVER 40%+ —
and likewise DOWN rules. If guardrails are given, stay within roughly
max_increase / max_decrease. A pile of rules that all fire at once is a design
smell — do not create it.

OUTPUT — directives, each ALONE on its own line, nothing else on the line:
    §goto: <surface>
    §rule: <name> | <field> <op> <value> [& <field> <op> <value>…] | <+N%|-N%> | <reason>
    §rmrule: <rule name>        (or  §rmrule: *  to delete ALL rules)
    §limit: up=<N> down=<N> margin=<N>          (percent; omit any you don't set)
    §testcase: <title> | <item_id> | <sig=val,…> | [expected_price]
    §ready
Operators: > >= < <= == !=. Use only field ids this project declares, plus the
reserved base_price/price/cost. NEVER output JSON, NEVER use code fences. Keep
chat and directives interleaved in the one streamed reply."""


# Where the §goto surfaces live, so an operator can see the vocabulary here too.
PROJECT_SURFACES = (
    "overview", "analytics", "alerts", "items", "rules",
    "playground", "limits", "strategies", "api", "audit",
)


def build_project_contents(
    history: list[dict],
    project_name: str,
    surface: str,
    schema_summary: str,
    guardrails: str = "",
    analytics: str = "",
    rules_summary: str = "",
) -> list[dict]:
    """Gemini `contents` for the in-project assistant, with a context preamble.

    The preamble tells the model where the user currently is and what the
    project can price, so it can decide whether to switch tabs and which field
    ids it may reference.
    """
    contents: list[dict] = []
    preamble = (
        f"[context] project: {project_name or 'untitled'}. "
        f"the user is currently on the '{surface or 'overview'}' tab. "
        f"schema fields: {schema_summary or '(none yet)'}."
    )
    if guardrails:
        preamble += f" guardrails: {guardrails[:300]}."
    if rules_summary:
        preamble += (
            f" current rules (DO NOT duplicate these; delete extras with §rmrule "
            f"to fix conflicts): {rules_summary[:1500]}."
        )
    if analytics:
        preamble += (
            f" current analytics (answer questions from these numbers, do not "
            f"invent others): {analytics[:600]}."
        )
    contents.append({"role": "user", "parts": [{"text": preamble}]})
    contents.append({"role": "model", "parts": [{"text": "Understood."}]})
    for m in history[-20:]:
        role = "model" if m.get("role") == "assistant" else "user"
        text = (m.get("content") or "").strip()
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})
    return contents


def _payload(contents: list[dict], system: str = AGENT_SYSTEM) -> dict:
    return {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 2048,
            "thinkingConfig": {"thinkingBudget": 0},
            "candidateCount": 1,
        },
        "safetySettings": [
            {"category": c, "threshold": "BLOCK_ONLY_HIGH"}
            for c in (
                "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT",
            )
        ],
    }


def stream_reply(contents: list[dict], *, max_rounds: int = 8, system: str = AGENT_SYSTEM):
    """Yield text deltas from Gemini, with (key, model) failover.

    Synchronous on purpose: the WebSocket Lambda that drives this is a plain
    sync handler, and httpx's sync streaming is the simplest correct fit. On a
    429 or a model error the pool is told, and the next round leases a different
    (key, model) pair — the same failover that makes the non-streaming path
    survive a rate-limited model.
    """
    p = pool()
    errors: list[str] = []

    for _round in range(max_rounds):
        try:
            key, model = p.lease()
        except ExhaustedError as exc:
            break
        payload = _payload(contents, system)
        got_any = False
        t0 = time.perf_counter()
        try:
            with httpx.Client(timeout=httpx.Timeout(connect=5, read=50, write=10, pool=5)) as c:
                with c.stream(
                    "POST",
                    f"{BASE}/models/{model}:streamGenerateContent?alt=sse",
                    headers={"x-goog-api-key": key, "content-type": "application/json"},
                    json=payload,
                ) as resp:
                    if resp.status_code != 200:
                        resp.read()
                        msg = resp.text[:160]
                        p.record_failure(key, model, resp.status_code, msg)
                        errors.append(f"{model} [{resp.status_code}] {msg}")
                        continue
                    for line in resp.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if not chunk or chunk == "[DONE]":
                            continue
                        try:
                            body = json.loads(chunk)
                        except json.JSONDecodeError:
                            continue
                        for cand in body.get("candidates") or []:
                            for part in (cand.get("content", {}) or {}).get("parts") or []:
                                t = part.get("text")
                                if t:
                                    got_any = True
                                    yield t
        except (httpx.TimeoutException, httpx.ConnectError) as exc:
            p.record_failure(key, model, "TIMEOUT", str(exc))
            errors.append(f"{model} transport: {exc}")
            if got_any:
                return
            continue

        if got_any:
            p.record_success(key, model, (time.perf_counter() - t0) * 1000)
            return
        # No text and no HTTP error: treat as a soft miss and try another pair.
        errors.append(f"{model}: empty stream")

    raise RuntimeError("agent stream failed: " + " | ".join(errors[-4:]))
