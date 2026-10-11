#!/usr/bin/env bash
#
# DevNexus deployment. Uses the plain AWS CLI — SAM CLI is not required, because
# SAM is just a CloudFormation transform and `aws cloudformation package` can
# upload the artifacts.
#
#   ./scripts/deploy.sh [stage] [region]
#
# Dependencies are installed into .build/ inside this project (gitignored).
# That is a project-local build directory in the normal Python-on-Lambda sense,
# not an install onto your system — nothing lands in your global site-packages.

set -euo pipefail

STAGE="${1:-dev}"
REGION="${2:-${AWS_REGION:-ap-south-1}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="devnexus-${STAGE}"
BUILD="${ROOT}/.build"

cyan() { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1" >&2; }

cyan "── DevNexus deploy ─────────────────────────────"
echo "stage:  ${STAGE}"
echo "region: ${REGION}"
echo "stack:  ${STACK}"
echo

command -v aws >/dev/null || { red "aws CLI not found"; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || {
  red "AWS credentials are not configured — run 'aws configure'"; exit 1; }
echo "account: ${ACCOUNT}"

ARTIFACT_BUCKET="devnexus-artifacts-${ACCOUNT}-${REGION}"

# ── 1. artifact bucket ──────────────────────────────────────────────────
if ! aws s3api head-bucket --bucket "${ARTIFACT_BUCKET}" --region "${REGION}" 2>/dev/null; then
  cyan "creating artifact bucket ${ARTIFACT_BUCKET}"
  if [ "${REGION}" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "${ARTIFACT_BUCKET}" --region "${REGION}"
  else
    aws s3api create-bucket --bucket "${ARTIFACT_BUCKET}" --region "${REGION}" \
      --create-bucket-configuration "LocationConstraint=${REGION}"
  fi
  aws s3api put-public-access-block --bucket "${ARTIFACT_BUCKET}" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
fi

# ── 2. dependency layer ─────────────────────────────────────────────────
# Built for manylinux aarch64 regardless of this machine's OS, because the
# Lambda functions run on ARM64 Amazon Linux. Building for the host platform is
# the classic way to ship a bundle that imports fine locally and explodes in
# Lambda with "invalid ELF header".
cyan "building dependency layer (arm64 / python3.12)"
rm -rf "${BUILD}/layer"
mkdir -p "${BUILD}/layer/python"

python3 -m pip install \
  --target "${BUILD}/layer/python" \
  --platform manylinux2014_aarch64 \
  --implementation cp \
  --python-version 3.12 \
  --only-binary=:all: --upgrade \
  -r "${ROOT}/backend/requirements.txt" \
  --quiet

# Trim what Lambda already provides or never executes. This typically halves
# the layer, which directly reduces cold-start unpack time.
find "${BUILD}/layer/python" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "${BUILD}/layer/python" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true
find "${BUILD}/layer/python" -type d -name "*.dist-info" -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "${BUILD}/layer/python/boto3" "${BUILD}/layer/python/botocore" 2>/dev/null || true

echo "layer size: $(du -sh "${BUILD}/layer" | cut -f1)"

# ── 3. package ──────────────────────────────────────────────────────────
cyan "packaging template"
aws cloudformation package \
  --template-file "${ROOT}/infra/template.yaml" \
  --s3-bucket "${ARTIFACT_BUCKET}" \
  --s3-prefix "${STACK}" \
  --output-template-file "${BUILD}/packaged.yaml" \
  --region "${REGION}"

# ── 4. deploy ───────────────────────────────────────────────────────────
cyan "deploying ${STACK}"
aws cloudformation deploy \
  --template-file "${BUILD}/packaged.yaml" \
  --stack-name "${STACK}" \
  --parameter-overrides "Stage=${STAGE}" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --region "${REGION}" \
  --no-fail-on-empty-changeset

# ── 5. report ───────────────────────────────────────────────────────────
green "deployed"
echo
API_URL="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text)"

cyan "── endpoints ───────────────────────────────────"
echo "API:   ${API_URL}"
echo "Docs:  ${API_URL}/docs"
echo
echo "Smoke test:"
echo "  curl '${API_URL}/health'"
echo
echo "Next: push secrets, then run the smoke test"
echo "  ./scripts/load-secrets.sh ${STAGE} ${REGION}"
echo "  ./scripts/smoke-test.sh ${STAGE} ${REGION}"
echo "  python3 scripts/test-scopes.py --stage ${STAGE} --region ${REGION}"
echo "  python3 scripts/test-domains.py --stage ${STAGE} --region ${REGION}"
echo "  python3 scripts/test-advanced.py --stage ${STAGE} --region ${REGION}"
