#!/bin/sh
set -eu
tests=$(dirname "$0")
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
answer=$(cat "$tests/.nanoeval/final_message.txt")
response=$tests/.nanoeval/judge-response.json
if [ ! -f "$response" ]; then
  printf '{"requests":[{"id":"grade","prompt":"JUDGE-FIXTURE Reply PASS if the answer is nanoeval and FAIL otherwise. answer: %s"}]}\n' "$answer" >"$logs/judge-request.json"
  exit 0
fi
if grep -q '"text":"PASS"' "$response"; then
  echo 1 >"$logs/reward.txt"
else
  echo 0 >"$logs/reward.txt"
fi
