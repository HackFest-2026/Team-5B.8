#!/usr/bin/env bash
#
# Push secrets into SSM Parameter Store as SecureStrings.
#
#   ./scripts/load-secrets.sh [stage] [region]
#
# Reads from .secrets/ (gitignored) and writes to:
#   /devnexus/<stage>/gemini/keys              the Gemini key pool
#   /devnexus/<stage>/fcm/service-account      Firebase service account JSON
#
# Secrets never appear in the CloudFormation template or in a Lambda's
# environment-variable panel. The functions read them from SSM at cold start and
# cache them in module scope for the life of the execution environment.

set -euo pipefail

STAGE="${1:-dev}"
REGION="${2:-${AWS_REGION:-ap-south-1}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS="${ROOT}/.secrets"

cyan() { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1" >&2; }

cyan "── DevNexus secrets -> SSM (${STAGE} / ${REGION}) ──"

put() {
  local name="$1" value="$2" desc="$3"
  aws ssm put-parameter \
    --name "${name}" \
    --value "${value}" \
    --type SecureString \
    --description "${desc}" \
    --overwrite \
    --region "${REGION}" >/dev/null
  green "  wrote ${name}"
}

# ── Gemini key pool ─────────────────────────────────────────────────────
# Prefer the validated set if the validator has run, since it excludes keys that
# are known-dead (403 "project denied access") rather than merely rate limited.
KEYS_FILE=""
KEYS=""

# Try the validated set first, but only trust it if it is non-empty. A
# validation run made while the probe MODEL was down (503 across the board)
# produces an empty healthy list even though every key authenticates fine —
# and pushing an empty parameter would take the AI layer down for no reason.
if [ -f "${SECRETS}/gemini-keys.valid.json" ]; then
  CANDIDATE="$(python3 -c "
import json
d=json.load(open('${SECRETS}/gemini-keys.valid.json'))
print(','.join(d.get('healthy',[]) + d.get('retryable',[])))
" 2>/dev/null || true)"
  if [ -n "${CANDIDATE}" ]; then
    KEYS_FILE="${SECRETS}/gemini-keys.valid.json"
    KEYS="${CANDIDATE}"
    yellow "  using validated key set"
  else
    yellow "  validated set is empty (probe model was likely down) — using raw key file"
  fi
fi

if [ -z "${KEYS}" ] && [ -f "${SECRETS}/gemini-keys.txt" ]; then
  KEYS_FILE="${SECRETS}/gemini-keys.txt"
  # Strip comments, blanks and the trailing dots that paste artifacts leave
  # behind — a trailing '.' silently invalidates an AQ. key.
  KEYS="$(grep -v '^#' "${KEYS_FILE}" | sed 's/[[:space:]]*$//; s/\.*$//' \
          | grep -v '^$' | paste -sd, -)"
  yellow "  using raw key file (run validate-gemini-keys.mjs to filter dead keys)"
fi

if [ -z "${KEYS}" ]; then
  red "  no usable keys found — checked gemini-keys.valid.json and gemini-keys.txt in ${SECRETS}"
  exit 1
fi

COUNT="$(echo "${KEYS}" | tr ',' '\n' | grep -c . || true)"
echo "  ${COUNT} key(s) from $(basename "${KEYS_FILE}")"
put "/devnexus/${STAGE}/gemini/keys" "${KEYS}" "DevNexus Gemini API key pool"

# ── Firebase service account ────────────────────────────────────────────
SA_FILE=""
for candidate in \
  "${SECRETS}/firebase-service-account.json" \
  "${SECRETS}/fcm-service-account.json" \
  "${SECRETS}/service-account.json"; do
  [ -f "${candidate}" ] && SA_FILE="${candidate}" && break
done

if [ -n "${SA_FILE}" ]; then
  # Validate before uploading: a malformed service account fails at FCM send
  # time, inside a worker, where nobody is watching.
  PROJECT_ID="$(python3 -c "
import json,sys
d=json.load(open('${SA_FILE}'))
missing=[k for k in ('type','project_id','private_key','client_email') if not d.get(k)]
if missing:
    sys.exit('missing keys: '+', '.join(missing))
if d['type']!='service_account':
    sys.exit(\"type must be 'service_account', got '\"+d['type']+\"'\")
print(d['project_id'])
")" || { red "  invalid service account JSON"; exit 1; }

  echo "  firebase project: ${PROJECT_ID}"
  put "/devnexus/${STAGE}/fcm/service-account" "$(cat "${SA_FILE}")" \
      "DevNexus Firebase service account for FCM"

  # The project id is not secret; a plain parameter saves a decrypt per read.
  aws ssm put-parameter \
    --name "/devnexus/${STAGE}/fcm/project-id" \
    --value "${PROJECT_ID}" --type String --overwrite --region "${REGION}" >/dev/null
  green "  wrote /devnexus/${STAGE}/fcm/project-id"

  cyan "  updating Lambda env with FCM_PROJECT_ID"
  for fn in "devnexus-alert-worker-${STAGE}" "devnexus-api-${STAGE}"; do
    if aws lambda get-function --function-name "${fn}" --region "${REGION}" >/dev/null 2>&1; then
      CURRENT="$(aws lambda get-function-configuration --function-name "${fn}" \
        --region "${REGION}" --query 'Environment.Variables' --output json)"
      UPDATED="$(python3 -c "
import json
env=json.loads('''${CURRENT}''')
env['FCM_PROJECT_ID']='${PROJECT_ID}'
print(json.dumps({'Variables':env}))
")"
      aws lambda update-function-configuration --function-name "${fn}" \
        --environment "${UPDATED}" --region "${REGION}" >/dev/null
      green "    ${fn}"
    fi
  done
else
  yellow "  no Firebase service account found — push notifications will be disabled"
  yellow "  drop it at ${SECRETS}/firebase-service-account.json and re-run"
fi

echo
green "secrets loaded"
echo
cyan "verify:"
echo "  aws ssm get-parameters-by-path --path /devnexus/${STAGE} --region ${REGION} \\"
echo "    --query 'Parameters[].Name' --output table"
echo
cyan "check the key pool through the API:"
echo "  curl '<API_URL>/ai/health?token=<SESSION_TOKEN>'"
