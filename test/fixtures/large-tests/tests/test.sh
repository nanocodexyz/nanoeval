#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
size=$(wc -c <"$(dirname "$0")/large.bin")
printf 'large.bin holds %s bytes\n' "$size"
if [ "$size" -eq 3145728 ]; then printf '1\n' >"$logs/reward.txt"; else printf '0\n' >"$logs/reward.txt"; fi
