#!/usr/bin/env bash
#
# Seed a demo tenant with FOUR live pricing domains on one engine.
#
#   ./scripts/seed-demo.sh [stage] [region]
#
# Three are built from catalog templates. The fourth — Co-working Space — has
# NO template and is typed from scratch through /domain/save, which is the
# actual claim being proved: a brand-new industry needs configuration, not a
# code change or a deployment.
#
# Prints a credentials block at the end for use in the demo.

set -uo pipefail

STAGE="${1:-dev}"
REGION="${2:-${AWS_REGION:-ap-south-1}}"
STACK="devnexus-${STAGE}"

cyan()   { printf "\033[36m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
red()    { printf "\033[31m  ✗ %s\033[0m\n" "$1"; }
info()   { printf "    %s\n" "$1"; }

API="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text 2>/dev/null)"
WS="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue" --output text 2>/dev/null)"

[ -z "${API}" ] || [ "${API}" = "None" ] && { red "could not read ApiBaseUrl"; exit 1; }

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
call() { curl -sS --max-time 40 "$@"; }

cyan "── DevNexus demo seed ──────────────────────────"
info "api: ${API}"

# ── account ─────────────────────────────────────────────────────────────
EMAIL="demo-$(date +%s)@devnexus.test"
R="$(call "${API}/auth/signup?email=${EMAIL}&password=devnexusdemo1&name=Demo%20Analyst")"
TOKEN="$(echo "${R}" | jqf 'token')"
[ -z "${TOKEN}" ] && { red "signup failed: ${R:0:200}"; exit 1; }
green "account: ${EMAIL}"

R="$(call "${API}/auth/complete-profile?token=${TOKEN}&company_name=DevNexus%20Demo%20Group&service_type=other&currency=INR&country=IN")"
TENANT="$(echo "${R}" | jqf 'tenant_id')"
[ -z "${TENANT}" ] && { red "profile failed: ${R:0:200}"; exit 1; }
green "tenant: ${TENANT}"

declare -a SUMMARY=()

# ── helper: build one complete domain ───────────────────────────────────
# $1 project name   $2 domain name   $3 entity label   $4 template_id (may be "")
# $5 item id        $6 item name     $7 base price     $8 cost
# $9 conditions json  $10 adjustment json  $11 rule name
build_domain() {
  local pname="$1" dname="$2" entity="$3" tpl="$4"
  local iid="$5" iname="$6" price="$7" cost="$8"
  local cond="$9" adj="${10}" rname="${11}"

  cyan "── ${dname} ──"

  local url="${API}/projects/create?token=${TOKEN}&name=$(enc "${pname}")&domain_name=$(enc "${dname}")&entity_label=$(enc "${entity}")&currency=INR"
  [ -n "${tpl}" ] && url="${url}&template_id=${tpl}"

  local r pid key
  r="$(call "${url}")"
  pid="$(echo "${r}" | jqf 'project_id')"
  key="$(echo "${r}" | jqf 'api_key')"
  if [ -z "${pid}" ]; then red "project failed: ${r:0:220}"; return 1; fi
  green "project ${pid}"

  # Schema: templates prefill it. A domain with no template gets one typed in.
  if [ -z "${tpl}" ]; then
    r="$(call "${API}/domain/save?token=${TOKEN}&project_id=${pid}&schema=$(enc "${SCHEMA_JSON}")")"
    local n; n="$(echo "${r}" | jqf 'signal_count')"
    if [ -z "${n}" ]; then red "schema failed: ${r:0:220}"; return 1; fi
    green "schema typed from scratch — ${n} signals, NO template"
  fi

  r="$(call "${API}/items/create?token=${TOKEN}&project_id=${pid}&item_id=${iid}&name=$(enc "${iname}")&base_price=${price}&cost=${cost}")"
  [ "$(echo "${r}" | jqf 'item_id')" = "${iid}" ] && green "item ${iid} @ Rs${price}" || red "item: ${r:0:160}"

  call "${API}/guardrails/save?token=${TOKEN}&project_id=${pid}&max_increase_pct=12&max_decrease_pct=15&min_margin_pct=10" >/dev/null
  green "guardrails"

  r="$(call "${API}/rules/create?token=${TOKEN}&project_id=${pid}&name=$(enc "${rname}")&conditions=$(enc "${cond}")&adjustment=$(enc "${adj}")&priority=60")"
  local rid; rid="$(echo "${r}" | jqf 'rule_id')"
  if [ -z "${rid}" ]; then red "rule failed: ${r:0:260}"; return 1; fi
  green "rule: $(echo "${r}" | jqf 'explanation')"

  r="$(call "${API}/strategies/create?token=${TOKEN}&project_id=${pid}&name=$(enc "${dname}%20Strategy")&rule_ids=${rid}")"
  local sid; sid="$(echo "${r}" | jqf 'strategy_id')"
  if [ -z "${sid}" ]; then red "strategy failed: ${r:0:220}"; return 1; fi

  r="$(call "${API}/strategies/validate?token=${TOKEN}&project_id=${pid}&strategy_id=${sid}&version=v1")"
  if [ "$(echo "${r}" | jqf 'passed')" != "True" ]; then
    red "validation failed: $(echo "${r}" | jqf 'errors')"; return 1
  fi
  call "${API}/strategies/promote?token=${TOKEN}&project_id=${pid}&strategy_id=${sid}&version=v1&mode=active" >/dev/null
  green "strategy active"

  local p0; p0="$(call "${API}/v1/p/${key}/price?item_id=${iid}" | jqf 'price.price')"
  info "price before events: Rs${p0}"

  SUMMARY+=("${dname}|${pid}|${key}|${iid}|${p0}")
  echo "${pid}|${key}|${iid}" >> /tmp/devnexus-seed-$$.txt
}

# ══ 1. E-COMMERCE (template) ════════════════════════════════════════════
build_domain "Retail Storefront" "E-commerce" "Product" "ecommerce" \
  "P1001" "Wireless Headphones" 7000 3000 \
  '[{"field":"demand_score","operator":">","value":60},{"field":"inventory","operator":"<","value":30}]' \
  '{"type":"percentage","value":9,"direction":"increase"}' \
  "High demand low stock"

# ══ 2. HOSPITALITY (template) ═══════════════════════════════════════════
build_domain "City Hotel" "Hospitality" "Room" "hospitality" \
  "R204" "Deluxe Room" 5000 2000 \
  '[{"field":"occupancy","operator":">","value":70},{"field":"availability","operator":"<","value":30}]' \
  '{"type":"percentage","value":8,"direction":"increase"}' \
  "High occupancy low availability"

# ══ 3. RIDE-HAILING (template) ══════════════════════════════════════════
build_domain "RideGo" "Transportation" "Ride" "transportation" \
  "RIDE-X" "Sedan City Ride" 200 90 \
  '[{"field":"demand_score","operator":">","value":60},{"field":"driver_supply","operator":"<","value":40}]' \
  '{"type":"percentage","value":11,"direction":"increase"}' \
  "Surge: demand exceeds supply"

# ══ 4. CO-WORKING — NO TEMPLATE, SCHEMA TYPED FROM SCRATCH ══════════════
# This is the proof. Nothing in the codebase has ever heard of a co-working
# space, a desk, or a "noise_level" signal.
SCHEMA_JSON='{
 "domain_name":"Co-working Space",
 "entity_label":"Desk",
 "attributes":[
   {"id":"floor","label":"Floor","type":"string"},
   {"id":"desk_type","label":"Desk type","type":"string"}
 ],
 "context_signals":[
   {"id":"desk_occupancy","label":"Desk occupancy","type":"number","min":0,"max":100,
    "description":"Desks currently in use, %"},
   {"id":"meeting_room_demand","label":"Meeting room demand","type":"number","min":0,"max":100,
    "description":"Room booking pressure"},
   {"id":"walk_in_rate","label":"Walk-in rate","type":"number","min":0,"max":500,
    "description":"Unbooked arrivals per hour"},
   {"id":"noise_level","label":"Noise level","type":"number","min":0,"max":100,
    "description":"Measured ambient noise index"},
   {"id":"competitor_day_pass","label":"Competitor day pass","type":"number","min":0,"max":100000,
    "description":"Nearby day-pass price"}
 ]
}'

build_domain "WorkHub Central" "Co-working Space" "Desk" "" \
  "DESK-A12" "Hot Desk — Floor 3" 800 300 \
  '[{"field":"desk_occupancy","operator":">","value":65},{"field":"walk_in_rate","operator":">","value":5}]' \
  '{"type":"percentage","value":10,"direction":"increase"}' \
  "Busy floor with walk-in pressure"

# ── drive events into every domain ──────────────────────────────────────
cyan "── driving live events into all domains ──"
while IFS='|' read -r pid key iid; do
  [ -z "${key}" ] && continue
  case "${iid}" in
    P1001)
      call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=inventory_update&inventory=18&event_id=seed-inv-$$-1" >/dev/null
      for i in $(seq 1 30); do
        call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=view&event_id=seed-v-$$-${i}" >/dev/null
      done
      for i in $(seq 1 8); do
        call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=purchase&quantity=1&event_id=seed-p-$$-${i}" >/dev/null
      done ;;
    R204)
      call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=availability_update&availability=22&event_id=seed-av-$$-1" >/dev/null
      for i in $(seq 1 20); do
        call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=booking&event_id=seed-b-$$-${i}" >/dev/null
      done ;;
    RIDE-X)
      call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=signal_update&signal_driver_supply=30&signal_surge_ratio=2.4&signal_traffic_index=70&event_id=seed-s-$$-1" >/dev/null
      for i in $(seq 1 25); do
        call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=search&event_id=seed-sr-$$-${i}" >/dev/null
      done
      for i in $(seq 1 10); do
        call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=purchase&event_id=seed-rp-$$-${i}" >/dev/null
      done ;;
    DESK-A12)
      # desk_occupancy, walk_in_rate and noise_level are signals this codebase
      # has never heard of. They arrive as signal_<id>= params, validated only
      # against the project's own schema.
      call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=signal_update&signal_desk_occupancy=78&signal_walk_in_rate=9&signal_noise_level=55&signal_meeting_room_demand=80&event_id=seed-d-$$-1" >/dev/null
      for i in $(seq 1 22); do
        call "${API}/v1/t/${key}/event?item_id=${iid}&event_type=booking&event_id=seed-db-$$-${i}" >/dev/null
      done ;;
  esac
  green "events sent for ${iid}"
done < /tmp/devnexus-seed-$$.txt

info "waiting 15s for the feature worker…"
sleep 15

# ── report ──────────────────────────────────────────────────────────────
cyan "── prices after events ──"
for row in "${SUMMARY[@]}"; do
  IFS='|' read -r dname pid key iid p0 <<< "${row}"
  p1="$(call "${API}/v1/p/${key}/price?item_id=${iid}" | jqf 'price.price')"
  drv="$(call "${API}/v1/p/${key}/price?item_id=${iid}" | jqf 'price.drivers')"
  if [ "${p1}" != "${p0}" ]; then
    green "${dname}: Rs${p0} -> Rs${p1}"
  else
    printf "\033[33m  ~ %s: unchanged at Rs%s\033[0m\n" "${dname}" "${p1}"
  fi
  [ -n "${drv}" ] && [ "${drv}" != "[]" ] && info "   ${drv}"
done

cyan "── multi-domain proof ──"
call "${API}/analytics/domains?token=${TOKEN}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  distinct domains:', d.get('distinct_domain_count'))
for x in d.get('distinct_domains',[]): print('    -', x)
print()
print(' ', d.get('claim'))
print()
for p in d.get('projects',[]):
    print(f\"    {p['domain_name']:<20} {p['entity_label']:<8} \"
          f\"signals={p['signals']:<3} decisions={p['decisions_24h']:<4} \"
          f\"changes={p['price_changes_24h']}\")
"

rm -f /tmp/devnexus-seed-$$.txt

echo
cyan "══ DEMO CREDENTIALS ══════════════════════════════"
echo "  API       ${API}"
echo "  WebSocket ${WS}"
echo "  email     ${EMAIL}"
echo "  password  devnexusdemo1"
echo "  token     ${TOKEN}"
echo "  tenant    ${TENANT}"
echo
for row in "${SUMMARY[@]}"; do
  IFS='|' read -r dname pid key iid p0 <<< "${row}"
  printf "  %-20s project=%s\n" "${dname}" "${pid}"
  printf "  %-20s key=%s  item=%s\n" "" "${key}" "${iid}"
done
echo
cyan "Try these:"
echo "  ${API}/live/pulse?token=${TOKEN}&project_id=<PROJECT_ID>"
echo "  ${API}/analytics/pipeline?token=${TOKEN}&project_id=<PROJECT_ID>"
echo "  ${API}/analytics/domains?token=${TOKEN}"
echo "  ${WS}?token=${TOKEN}&project_id=<PROJECT_ID>"
