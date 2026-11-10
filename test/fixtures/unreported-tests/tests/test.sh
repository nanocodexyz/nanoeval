#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
a-test-runner-that-was-not-installed --ctrf "$logs/ctrf.json"
if [ $? -eq 0 ]; then
  printf '1\n' >"$logs/reward.txt"
else
  printf '0\n' >"$logs/reward.txt"
fi
