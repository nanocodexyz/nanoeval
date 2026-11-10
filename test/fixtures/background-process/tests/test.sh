#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
if kill -0 "$(cat background.pid)" 2>/dev/null; then
  printf 'the background process is running\n'
  printf '1\n' >"$logs/reward.txt"
else
  printf 'the background process is gone\n'
  printf '0\n' >"$logs/reward.txt"
fi
