#!/bin/sh
set -eu
tests=$(dirname "$0")
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
if [ "$(cat "$tests/.nanoeval/final_message.txt")" = nanoeval ]; then
  echo 1 >"$logs/reward.txt"
else
  echo 0 >"$logs/reward.txt"
fi
