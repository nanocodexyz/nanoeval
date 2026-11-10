#!/bin/sh
set -eu
mkdir -p /logs/verifier
answer=$(cat /tests/.nanoeval/final_message.txt)
response=/tests/.nanoeval/judge-response.json
if [ ! -f "$response" ]; then
  printf '{"requests":[{"id":"grade","prompt":"JUDGE-FIXTURE Reply PASS if the answer is nanoeval and FAIL otherwise. answer: %s"}]}\n' "$answer" >/logs/verifier/judge-request.json
  exit 0
fi
if grep -q '"text":"PASS"' "$response"; then
  echo 1 >/logs/verifier/reward.txt
else
  echo 0 >/logs/verifier/reward.txt
fi
