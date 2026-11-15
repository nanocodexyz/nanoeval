#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
grep Cpus_allowed_list /proc/self/status | tr -dc 0-9,- >"$logs/threads.txt"
end=$(($(date +%s) + 4))
while [ "$(date +%s)" -lt "$end" ]; do :; done
if [ "$(cat alone.txt)" = ready ]; then printf '1\n' >"$logs/reward.txt"; else printf '0\n' >"$logs/reward.txt"; fi
