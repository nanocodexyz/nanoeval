#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
if [ -s busy.txt ]; then
  cp busy.txt "$logs/busy.txt"
  printf '1\n' >"$logs/reward.txt"
else
  printf '0\n' >"$logs/reward.txt"
fi
