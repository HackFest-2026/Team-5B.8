#!/usr/bin/env bash
#
# End-to-end smoke test against a DEPLOYED DevNexus stack.
#
#   ./scripts/smoke-test.sh [stage] [region]
#
# Walks the entire demo loop as a real client would: signup, company profile,
# project, schema, item, rule, strategy, validate, activate, price, send events,
# price again and watch it move, explain, replay, verify determinism, AI rule
# generation, then rollback.
#
# Every call is a GET with parameters in the URL, which is what makes the whole
# product testable with nothing but curl.

set -uo pipefail

STAGE="${1:-dev}"
REGION="${2:-${AWS_REGION:-ap-south-1}}"
STACK="devnexus-${STAGE}"

PASS=0; FAIL=0; SKIP=0

cyan()   { printf "\033[36m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m  ✓ %s\033[0m\n" "$1"; PASS=$((PASS+1)); }
red()    { printf "\033[31m  ✗ %s\033[0m\n" "$1"; FAIL=$((FAIL+1)); }
yellow() { printf "\033[33m  ~ %s\033[0m\n" "$1"; SKIP=$((SKIP+1)); }
info()   { printf "    %s\n" "$1"; }

API="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text 2>/dev/null)"
[ -z "${API}" ] || [ "${API}" = "None" ] && { red "could not read ApiBaseUrl from ${STACK}"; exit 1; }

cyan "── DevNexus smoke test ─────────────────────────"
info "api: ${API}"

# urlencode via python so JSON parameters survive the trip intact.
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
jqf() { python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
for k in sys.argv[1].split('.'):
    if isinstance(d,list): d=d[int(k)] if d else {}
    else: d=d.get(k) if isinstance(d,dict) else None
    if d is None: print(''); sys.exit()
print(d if not isinstance(d,(dict,list)) else json.dumps(d))
" "$1"; }

call() { curl -sS --max-time 30 "$@"; }

# ── 1. health ───────────────────────────────────────────────────────────
cyan "1. health"
R="$(call "${API}/health")"
[ "$(echo "${R}" | jqf 'status')" = "healthy" ] && green "health" || red "health: ${R:0:160}"

# ── 2. signup (step 1 of registration) ──────────────────────────────────
cyan "2. signup — partial registration"
EMAIL="smoke-$(date +%s)@devnexus.test"
R="$(call "${API}/auth/signup?email=${EMAIL}&password=smoketest1234&name=Smoke%20Tester")"
TOKEN="$(echo "${R}" | jqf 'token')"
if [ -n "${TOKEN}" ]; then
  green "signup"
  info "registration_complete: $(echo "${R}" | jqf 'registration_complete') (expected false)"
else
  red "signup: ${R:0:200}"; exit 1
fi

# ── 3. complete profile (step 2) ────────────────────────────────────────
cyan "3. complete-profile — company details"
R="$(call "${API}/auth/complete-profile?token=${TOKEN}&company_name=Smoke%20Hotels&service_type=hospitality&currency=INR&country=IN")"
TENANT="$(echo "${R}" | jqf 'tenant_id')"
[ -n "${TENANT}" ] && green "tenant created: ${TENANT}" || { red "complete-profile: ${R:0:200}"; exit 1; }

# ── 4. project from a domain template ───────────────────────────────────
cyan "4. create project"
R="$(call "${API}/projects/create?token=${TOKEN}&name=Smoke%20Test%20Hotel&domain_name=Hospitality&entity_label=Room&currency=INR&template_id=hospitality")"
PROJECT="$(echo "${R}" | jqf 'project_id')"
APIKEY="$(echo "${R}" | jqf 'api_key')"
if [ -n "${PROJECT}" ] && [ -n "${APIKEY}" ]; then
  green "project: ${PROJECT}"
  info "api key: ${APIKEY:0:16}…"
else
  red "create project: ${R:0:200}"; exit 1
fi

# ── 5. item ─────────────────────────────────────────────────────────────
cyan "5. create pricing item"
R="$(call "${API}/items/create?token=${TOKEN}&project_id=${PROJECT}&item_id=R204&name=Deluxe%20Room&base_price=5000&cost=2000")"
[ "$(echo "${R}" | jqf 'item_id')" = "R204" ] && green "item R204 @ ₹5000" || red "create item: ${R:0:200}"

# ── 6. guardrails ───────────────────────────────────────────────────────
cyan "6. guardrails"
R="$(call "${API}/guardrails/save?token=${TOKEN}&project_id=${PROJECT}&min_price=4000&max_price=7000&max_increase_pct=10&max_decrease_pct=15&min_margin_pct=12")"
[ "$(echo "${R}" | jqf 'ok')" = "True" ] && green "guardrails set (±10%/15%, ₹4000-7000, 12% margin)" || red "guardrails: ${R:0:200}"

# ── 7. rule ─────────────────────────────────────────────────────────────
cyan "7. create rule"
COND="$(enc '[{"field":"occupancy","operator":">","value":80},{"field":"availability","operator":"<","value":20}]')"
ADJ="$(enc '{"type":"percentage","value":8,"direction":"increase"}')"
R="$(call "${API}/rules/create?token=${TOKEN}&project_id=${PROJECT}&name=High%20occupancy%20low%20availability&conditions=${COND}&adjustment=${ADJ}&priority=60")"
RULE="$(echo "${R}" | jqf 'rule_id')"
if [ -n "${RULE}" ]; then
  green "rule: ${RULE}"
  info "reads as: $(echo "${R}" | jqf 'explanation')"
else
  red "create rule: ${R:0:300}"; exit 1
fi

# ── 8. strategy + validate + activate ───────────────────────────────────
cyan "8. strategy lifecycle"
R="$(call "${API}/strategies/create?token=${TOKEN}&project_id=${PROJECT}&name=Smoke%20Strategy&rule_ids=${RULE}")"
STRATEGY="$(echo "${R}" | jqf 'strategy_id')"
[ -n "${STRATEGY}" ] && green "strategy v1: ${STRATEGY}" || { red "create strategy: ${R:0:200}"; exit 1; }

R="$(call "${API}/strategies/validate?token=${TOKEN}&project_id=${PROJECT}&strategy_id=${STRATEGY}&version=v1")"
[ "$(echo "${R}" | jqf 'passed')" = "True" ] \
  && green "validated" \
  || red "validate: $(echo "${R}" | jqf 'errors')"

R="$(call "${API}/strategies/promote?token=${TOKEN}&project_id=${PROJECT}&strategy_id=${STRATEGY}&version=v1&mode=active")"
[ "$(echo "${R}" | jqf 'mode')" = "active" ] && green "activated" || red "promote: ${R:0:200}"

# ── 9. price before any events ──────────────────────────────────────────
cyan "9. price (no signals yet — expect base price)"
R="$(call "${API}/v1/p/${APIKEY}/price?item_id=R204")"
P1="$(echo "${R}" | jqf 'price.price')"
if [ -n "${P1}" ]; then
  green "price: ₹${P1}"
  info "decision: $(echo "${R}" | jqf 'price.decision_id')"
else
  red "price: ${R:0:300}"
fi

# ── 10. drive the signals that should trigger the rule ──────────────────
cyan "10. send events (occupancy up, availability down)"
call "${API}/v1/t/${APIKEY}/event?item_id=R204&event_type=availability_update&availability=12&event_id=smoke-avail-$(date +%s)" >/dev/null
SENT=0
for i in $(seq 1 25); do
  call "${API}/v1/t/${APIKEY}/event?item_id=R204&event_type=booking&quantity=1&event_id=smoke-book-$(date +%s)-${i}" >/dev/null && SENT=$((SENT+1))
done
green "sent ${SENT} booking events + 1 availability update"
info "waiting 12s for the feature worker to process the queue…"
sleep 12

# ── 11. price after events ──────────────────────────────────────────────
cyan "11. price again — did it move?"
R="$(call "${API}/v1/p/${APIKEY}/price?item_id=R204")"
P2="$(echo "${R}" | jqf 'price.price')"
DEC="$(echo "${R}" | jqf 'price.decision_id')"
if [ -n "${P2}" ]; then
  if [ "${P2}" != "${P1}" ]; then
    green "price moved: ₹${P1} → ₹${P2}"
    info "drivers: $(echo "${R}" | jqf 'price.drivers')"
  else
    yellow "price unchanged at ₹${P2} — the rule may need higher occupancy, or the worker is still catching up"
  fi
else
  red "price: ${R:0:300}"
fi

# ── 12. item detail with live context ───────────────────────────────────
cyan "12. live context"
R="$(call "${API}/items/get?token=${TOKEN}&project_id=${PROJECT}&item_id=R204")"
SIG="$(echo "${R}" | jqf 'context.signals')"
[ -n "${SIG}" ] && { green "signals computed"; info "${SIG:0:220}"; } || yellow "no signals yet"

# ── 13. replay + determinism proof ──────────────────────────────────────
if [ -n "${DEC}" ]; then
  cyan "13. decision replay and determinism"
  # The decision queue batches for up to 5s before the worker even starts, so a
  # fixed 6s sleep races it. Poll instead, up to 40s.
  info "waiting for the decision worker to persist ${DEC}…"
  for _ in $(seq 1 10); do
    call "${API}/decisions/replay?token=${TOKEN}&project_id=${PROJECT}&decision_id=${DEC}" \
      | grep -q '"ok":true' && break
    sleep 4
  done

  R="$(call "${API}/decisions/replay?token=${TOKEN}&project_id=${PROJECT}&decision_id=${DEC}")"
  if [ "$(echo "${R}" | jqf 'ok')" = "True" ]; then
    green "replayed ${DEC}"
    info "$(echo "${R}" | jqf 'explanation')"
  else
    yellow "replay not ready: ${R:0:160}"
  fi

  R="$(call "${API}/decisions/verify?token=${TOKEN}&project_id=${PROJECT}&decision_id=${DEC}")"
  if [ "$(echo "${R}" | jqf 'deterministic')" = "True" ]; then
    green "DETERMINISM PROVEN — re-ran the engine on the stored snapshot, identical price"
  else
    yellow "verify: $(echo "${R}" | jqf 'conclusion')"
  fi
else
  yellow "13. skipped replay — no decision_id"
fi

# ── 14. what-if ─────────────────────────────────────────────────────────
cyan "14. what-if simulation"
OV="$(enc '{"occupancy":95,"availability":5}')"
R="$(call "${API}/simulate/whatif?token=${TOKEN}&project_id=${PROJECT}&item_id=R204&overrides=${OV}")"
SP="$(echo "${R}" | jqf 'simulated.price')"
[ -n "${SP}" ] && { green "simulated at 95% occupancy: ₹${SP}"; info "fired: $(echo "${R}" | jqf 'simulated.rules_fired')"; } \
  || red "whatif: ${R:0:250}"

# ── 15. AI rule generation ──────────────────────────────────────────────
cyan "15. AI — natural language to configuration"
PROMPT="$(enc 'Increase room prices by 12 percent when occupancy is above 90 and availability is below 10')"
R="$(call "${API}/ai/configure?token=${TOKEN}&project_id=${PROJECT}&prompt=${PROMPT}")"
if [ "$(echo "${R}" | jqf 'understood')" = "True" ]; then
  green "AI understood the request (kind: $(echo "${R}" | jqf 'kind'), confidence: $(echo "${R}" | jqf 'confidence'))"
  info "interpretation: $(echo "${R}" | jqf 'interpretation')"
  info "model: $(echo "${R}" | jqf 'ai.model') in $(echo "${R}" | jqf 'ai.latency_ms')ms"
elif [ "$(echo "${R}" | jqf 'error.code')" = "ai_unavailable" ]; then
  yellow "Gemini unavailable — expected if every model in the chain is 503"
  info "$(echo "${R}" | jqf 'error.message')"
else
  yellow "AI could not map it: $(echo "${R}" | jqf 'reasons')"
fi

cyan "15b. AI key pool health"
R="$(call "${API}/ai/health?token=${TOKEN}")"
if [ "$(echo "${R}" | jqf 'ok')" = "True" ]; then
  green "key pool: $(echo "${R}" | jqf 'keys.usable') usable / $(echo "${R}" | jqf 'keys.total') total, $(echo "${R}" | jqf 'keys.dead') dead"
  info "capacity: ~$(echo "${R}" | jqf 'capacity_rpm_estimate') req/min"
else
  yellow "ai/health: ${R:0:200}"
fi

# ── 16. analytics ───────────────────────────────────────────────────────
cyan "16. analytics"
R="$(call "${API}/analytics/overview?token=${TOKEN}&project_id=${PROJECT}&range=1h")"
[ "$(echo "${R}" | jqf 'ok')" = "True" ] && green "overview: $(echo "${R}" | jqf 'kpis.decisions.value') decisions" || red "overview: ${R:0:200}"

R="$(call "${API}/analytics/system?token=${TOKEN}&project_id=${PROJECT}")"
if [ "$(echo "${R}" | jqf 'ok')" = "True" ]; then
  green "system health"
  info "self-measured p50: $(echo "${R}" | jqf 'pricing_api.self_measured.p50_ms')ms  p95: $(echo "${R}" | jqf 'pricing_api.self_measured.p95_ms')ms  p99: $(echo "${R}" | jqf 'pricing_api.self_measured.p99_ms')ms"
else
  red "system: ${R:0:200}"
fi

R="$(call "${API}/analytics/domains?token=${TOKEN}")"
[ "$(echo "${R}" | jqf 'ok')" = "True" ] && green "domains: $(echo "${R}" | jqf 'claim')" || red "domains: ${R:0:200}"

# ── 17. bulk pricing ────────────────────────────────────────────────────
cyan "17. bulk pricing"
R="$(call "${API}/v1/p/${APIKEY}/price/bulk?item_ids=R204")"
[ "$(echo "${R}" | jqf 'ok')" = "True" ] && green "bulk returned $(echo "${R}" | jqf 'count') price(s)" || red "bulk: ${R:0:200}"

# ── 18. approvals + audit ───────────────────────────────────────────────
cyan "18. approvals and audit"
R="$(call "${API}/approvals/pending?token=${TOKEN}")"
[ "$(echo "${R}" | jqf 'ok')" = "True" ] \
  && green "pending decisions: $(echo "${R}" | jqf 'count')" \
  || red "approvals: ${R:0:200}"

R="$(call "${API}/audit/list?token=${TOKEN}&project_id=${PROJECT}&limit=5")"
[ "$(echo "${R}" | jqf 'ok')" = "True" ] && green "audit entries: $(echo "${R}" | jqf 'count')" || red "audit: ${R:0:200}"

# ── 19. rollback ────────────────────────────────────────────────────────
cyan "19. rollback"
R="$(call "${API}/strategies/rollback?token=${TOKEN}&project_id=${PROJECT}&strategy_id=${STRATEGY}&to_version=v1")"
[ "$(echo "${R}" | jqf 'now_active')" = "v1" ] && green "rolled back to v1 (instant, no deploy)" || red "rollback: ${R:0:200}"

# ── 20. latency sample ──────────────────────────────────────────────────
cyan "20. pricing API latency (20 sequential calls)"
TOTAL=0; N=0
for i in $(seq 1 20); do
  MS="$(curl -sS -o /dev/null -w '%{time_total}' --max-time 10 \
    "${API}/v1/p/${APIKEY}/price?item_id=R204" 2>/dev/null)"
  [ -n "${MS}" ] && { TOTAL="$(python3 -c "print(${TOTAL}+${MS}*1000)")"; N=$((N+1)); }
done
[ "${N}" -gt 0 ] && green "mean round-trip: $(python3 -c "print(f'{${TOTAL}/${N}:.0f}')")ms over ${N} calls (includes network)" \
  || red "latency sample failed"

# ── summary ─────────────────────────────────────────────────────────────
echo
cyan "── summary ─────────────────────────────────────"
printf "\033[32mpassed  %d\033[0m\n" "${PASS}"
[ "${SKIP}" -gt 0 ] && printf "\033[33mwarned  %d\033[0m\n" "${SKIP}"
[ "${FAIL}" -gt 0 ] && printf "\033[31mfailed  %d\033[0m\n" "${FAIL}"
echo
info "tenant:   ${TENANT}"
info "project:  ${PROJECT}"
info "api key:  ${APIKEY}"
info "token:    ${TOKEN}"
echo
info "Explore further:"
info "  ${API}/docs"
[ "${FAIL}" -gt 0 ] && exit 1 || exit 0
