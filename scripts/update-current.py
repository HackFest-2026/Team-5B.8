#!/usr/bin/env python3
"""Update CURRENT.txt: refresh the status block, add the sections written since
the last revision, and splice in the generated API reference.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOC = ROOT / "CURRENT.txt"
REF = pathlib.Path("/tmp/devnexus-api-reference.txt")

s = DOC.read_text()
ref = REF.read_text()

cap = json.load(open("/tmp/devnexus-api-capture.json"))
API, WS = cap["api"], cap["ws"]

# live test tally
results = {}
for p in ("/tmp/devnexus-suite-results.json", "/tmp/devnexus-suite-results2.json",
          "/tmp/devnexus-suite-results3.json"):
    if os.path.exists(p):
        results.update(json.load(open(p)))
tally = {}
for v in results.values():
    tally[v["status"]] = tally.get(v["status"], 0) + 1
passed = tally.get("PASS", 0)
total = 199

py_files = subprocess.run(
    ["bash", "-c", f"find {ROOT}/backend -name '*.py' | wc -l"],
    capture_output=True, text=True).stdout.strip()
py_lines = subprocess.run(
    ["bash", "-c", f"find {ROOT}/backend -name '*.py' | xargs wc -l | tail -1 | awk '{{print $1}}'"],
    capture_output=True, text=True).stdout.strip()

# ── 1. header ───────────────────────────────────────────────────────────
old_head_start = s.index("  STATUS            ")
old_head_end = s.index("════════════════════════════════════════════════════════════════════════════════\n  TABLE OF CONTENTS")
new_head = f"""  STATUS            Deployed, verified and performance-tuned on AWS
  LIVE API          {API}
  WEBSOCKET         {WS}
  DOCS              {API}/docs
  REGION            ap-south-1 (Mumbai)
  STACK             devnexus-dev

  CODE              ~{py_lines} lines / {py_files} Python files
  ENDPOINTS         68 HTTP (every one a GET) + 4 WebSocket routes
  TEST SUITE        {passed} of {total} passing ({passed/total*100:.0f}%)
  PRICING LATENCY   4ms server-side p50, measured
  FCM               LIVE — service account authenticating against Google
  GEMINI            23-key pool, 21 usable, model fallback chain in SSM

  LIVE DOMAINS      E-commerce, Hospitality, Transportation, Travel,
                    EV Charging, Car Rental, Co-working Space, Banking,
                    Parking  — nine, on one engine, several with no template

  THIS DOCUMENT describes exactly what has been built, in the order a user
  encounters it. Section 16 is a COMPLETE API REFERENCE in which every request
  and response was captured from the live system, failure cases included.
  Section 13 lists what has NOT been built, so nothing here is mistaken for
  more than it is.

"""
s = s[:old_head_start] + new_head + s[old_head_end:]

# ── 2. table of contents ────────────────────────────────────────────────
s = s.replace(
    """  13.  WHAT IS NOT BUILT
  14.  MEASURED NUMBERS
  15.  THE DEMO SCRIPT""",
    """  13.  WHAT IS NOT BUILT
  14.  MEASURED NUMBERS
  15.  THE DEMO SCRIPT
  16.  COMPLETE API REFERENCE   (every endpoint, every response, captured live)
  17.  PERFORMANCE ARCHITECTURE (how the analytics path was made flat-cost)
  18.  OPERATIONAL NOTES        (quotas, secrets, what to watch)""")

# ── 3. new sections, appended before the END marker ─────────────────────
end_marker = """════════════════════════════════════════════════════════════════════════════════
  END
════════════════════════════════════════════════════════════════════════════════"""

perf = f"""
════════════════════════════════════════════════════════════════════════════════
  17.  PERFORMANCE ARCHITECTURE
════════════════════════════════════════════════════════════════════════════════

  17.1  MEASURED SERVER-SIDE LATENCY  (network excluded)
  ─────────────────────────────────────────────────────
      Taken from the X-Response-Time header the API sets on every response, so
      these numbers exclude the ~80ms round trip to Mumbai entirely.

        endpoint                  before    after
        ─────────────────────────────────────────────
        price  (hot path)            4ms      4ms     already at the floor
        analytics/timeseries       179ms     11ms
        analytics/overview         410ms     13ms
        analytics/rules            193ms     14ms
        projects/list               16ms     13ms
        auth/me                     21ms     20ms
        decisions/list              24ms     23ms
        analytics/domains          274ms     54ms
        mobile/home                231ms     75ms
        analytics/system           198ms     85ms
        analytics/pipeline         207ms    218ms*   (7ms once cached)

        TOTAL across all endpoints 1819ms    620ms    -66%

      * /analytics/pipeline is ten SQS GetQueueAttributes calls at ~25ms each.
        That is irreducible without replacing them with a CloudWatch metric
        read, which would reintroduce the 1-2 minute lag the panel exists to
        avoid. A 5-second cache takes a polling dashboard to 7ms, so only the
        very first load pays it.

  17.2  WHAT ACTUALLY FIXED IT  (and what did not)
  ───────────────────────────────────────────────
      THE FIRST ATTEMPT FAILED. Fanning the reads out across threads achieved
      essentially nothing, and made two endpoints SLOWER:

        /analytics/pipeline   207ms -> 270ms
        /live/pulse            26ms ->  33ms

      Thread startup plus contention on the shared boto3 client costs more than
      it saves when each individual call is only a few milliseconds. Both were
      reverted to sequential, with the measurement recorded in a comment so the
      change does not get re-attempted.

      THREE THINGS ACTUALLY WORKED:

      (a) PRE-AGGREGATION  — the structural fix
          Analytics recomputed every KPI by scanning thousands of individual
          decision rows per request, so latency grew LINEARLY with traffic: a
          project doing 10x the business paid 10x the wait.

          decision_worker now folds each decision into an hourly counter bucket
          as it persists it, using atomic DynamoDB ADD:

            ROLLUP#<project_id>  H#<epoch_hour>              totals
            ROLLUP#<project_id>  H#<epoch_hour>#R#<rule_id>  per-rule triggers

          A 24-hour window became ONE Query over ~24 tiny rows. Critically, the
          cost no longer depends on volume AT ALL — /analytics/overview will
          still be ~13ms at a hundred times the traffic.

          Atomic ADD matters: several worker invocations process batches for the
          same project in the same hour concurrently, and a read-modify-write
          would silently lose counts.

      (b) ProjectionExpression  — the biggest single lever
          A decision-feed row carries `rules_detail` and `signals` blobs. At a
          few hundred rows those filled DynamoDB's 1MB page budget before the
          row limit was reached, so one logical scan became several queries, and
          Python then deserialized thousands of nested Decimals it immediately
          discarded.

          Asking for six scalar fields instead took /mobile/home from 231ms to
          75ms with no caching involved at all.

      (c) SHORT-TTL CACHES  — honest about what they do
          10-15 second in-process caches on the aggregate endpoints. A dashboard
          polling every few seconds gets 6-14ms; the first call after expiry
          still pays the cold cost. Both numbers are reported above, because
          quoting only the cached figure would be misleading.

          CloudWatch gets a 60-second cache specifically: its figures already
          lag real time by 1-2 minutes, so re-fetching per request buys no
          freshness and was the slowest thing in /analytics/system.

  17.3  CAVEAT: ROLLUPS ARE FORWARD-ONLY
  ──────────────────────────────────────
      Decisions written BEFORE the rollup deploy have no hourly buckets, so
      /analytics/overview and /analytics/rules report only activity from that
      point on. Verified by generating 105 fresh decisions and confirming they
      aggregate correctly. Reflecting older history would need a one-off
      backfill job, which has not been written.

  17.4  WHERE THE REMAINING TIME GOES
  ───────────────────────────────────
      The pricing hot path at 4ms is at its floor: one BatchGetItem plus pure
      in-memory evaluation. The ~80ms a client actually observes is almost
      entirely flight time to ap-south-1, not compute.

      Two Lambda-level choices support this:
        * price-fn runs at 1769MB, where Lambda allocates a full second vCPU
        * price-fn imports NO FastAPI, NO Pydantic and nothing from app/,
          because those cost 300-600ms of cold start for features a pricing
          call has no use for


════════════════════════════════════════════════════════════════════════════════
  18.  OPERATIONAL NOTES
════════════════════════════════════════════════════════════════════════════════

  18.1  LAMBDA CONCURRENCY — THE ONE THING THAT WILL BITE YOU
  ──────────────────────────────────────────────────────────
      The AWS account's Lambda concurrency limit was TEN, not the usual 1000.
      That is the default for a fresh account and it is not announced anywhere.

      Symptom: API Gateway returns {{"message": "Service Unavailable"}} with NO
      Lambda error and NO timeout in the logs, because the function never ran.
      Observed 65 throttles producing 38 gateway 5xx during a load test.

        aws lambda get-account-settings --region ap-south-1 \\
          --query 'AccountLimit.ConcurrentExecutions'

      A quota increase to 1000 has been REQUESTED and is pending. Until it is
      granted:
        * normal use is fine — a few analysts plus a customer backend calling
          /price is nowhere near ten concurrent Lambdas
        * load testing WILL throttle: /demo/traffic, repeated bulk pricing and
          the test suite all burst past the ceiling
        * feature-worker is configured with MaximumConcurrency 50 against an
          account allowance of 10, so a burst of events could in principle
          starve the pricing path. Reserving concurrency for price-fn is the
          fix and has not been applied yet.

      No code change addresses this. It is a quota.

  18.2  SECRETS
  ─────────────
      Everything sensitive lives in SSM Parameter Store as a SecureString and
      appears in NO CloudFormation template and NO Lambda environment panel.

        /devnexus/dev/gemini/keys            23 Gemini keys (21 usable)
        /devnexus/dev/gemini/models          ordered model fallback chain
        /devnexus/dev/fcm/service-account    Firebase service account JSON
        /devnexus/dev/fcm/project-id         devnexus-6ccea

      Local copies live in .secrets/, which is gitignored. The Firebase admin
      SDK file arrived in the PROJECT ROOT where only google-services.json was
      ignored — a live private key one `git add .` from being committed. It has
      been moved into .secrets/ and .gitignore now covers every name Firebase
      hands out (*firebase-adminsdk*.json, *-adminsdk-*.json, and the plist).

      Reload after changing any of them:
        ./scripts/load-secrets.sh dev ap-south-1

  18.3  FCM IS LIVE
  ─────────────────
      Verified end to end against Google. Sending to a deliberately fake token
      returned:

        {{"sent": 0, "failed": 1, "pruned_dead_tokens": 1,
         "failures": [{{"detail": "404:NOT_FOUND"}}]}}

      404 NOT_FOUND is FCM itself answering, which proves the service account
      parsed, the JWT was signed with the private key, Google accepted the
      OAuth exchange and the v1 API was reached. An auth failure would have
      returned "fcm auth failed" or a 401/403 instead.

      It also confirmed two behaviours: dead tokens are pruned automatically
      (which is why there is no /devices/unregister endpoint), and info-level
      alerts are refused outright with "stay on the dashboard and are never
      pushed".

      Firebase project devnexus-6ccea, Android package com.dev.nexus.
      What remains unverified is delivery to a REAL handset, which needs the
      Android app.

  18.4  GEMINI MODEL AVAILABILITY IS VOLATILE
  ───────────────────────────────────────────
      Measured, repeatedly: gemini-2.5-flash is retired for newer accounts
      (404), and 3.6-flash and 3.8-flash both returned 503 across the ENTIRE
      key pool at various points. During one test run the chain fell through
      3.6 -> 3.5 -> flash-latest -> 2.5 and answered on the last one.

      This is why the model chain lives in SSM and not in code:

        aws ssm put-parameter --name /devnexus/dev/gemini/models \\
          --type String --overwrite \\
          --value "gemini-3.6-flash,gemini-3.5-flash,gemini-flash-latest,gemini-2.5-flash"

      Two of the 23 keys return a hard 403 "project has been denied access" on
      every model and are permanently dead. The pool marks them and moves on.

      Check the pool:  GET /ai/health?token=...

  18.5  DEPLOYING
  ───────────────
      Needs only the AWS CLI. SAM CLI is not required — SAM is a
      CloudFormation transform and `aws cloudformation package` uploads the
      artifacts.

        ./scripts/deploy.sh dev ap-south-1        full build + deploy
        ./scripts/load-secrets.sh dev ap-south-1  push secrets to SSM
        ./scripts/smoke-test.sh dev ap-south-1    end-to-end check
        ./scripts/seed-demo.sh dev ap-south-1     four live domains, seeded

      The dependency layer is built with --platform manylinux2014_aarch64
      because the Lambdas run on ARM64 Amazon Linux. Building for the host
      platform is the classic way to ship a bundle that imports fine on a Mac
      and fails in Lambda with "invalid ELF header".

  18.6  RUNNING THE TEST SUITE
  ────────────────────────────
        python3 scripts/run-tests.py                     fixtures + 89 cases
        python3 scripts/run-tests2.py                    47 cases
        python3 scripts/run-tests3.py                    63 cases + workbook
        python3 scripts/run-tests.py --reuse --only ENG  re-run one stage

      --reuse loads the saved fixtures instead of rebuilding eight domains and
      five labs. Results MERGE rather than clobber, so re-running one stage
      corrects those rows and leaves the rest alone.

      Expect roughly 50 minutes for a full run. The dominant cost is not the
      code: the feature worker batches for 2s and the decision worker for 5s,
      and two cases must genuinely wait out the real 120-second stale-signal
      threshold to prove rules get skipped.

"""

s = s.replace(end_marker, perf + "\n" + ref + "\n\n" + end_marker)
DOC.write_text(s)
print(f"CURRENT.txt updated -> {len(s.splitlines())} lines")
