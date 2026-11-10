#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
if [ -f slow.txt ]; then printf '1\n' >"$logs/reward.txt"; else printf '0\n' >"$logs/reward.txt"; fi
