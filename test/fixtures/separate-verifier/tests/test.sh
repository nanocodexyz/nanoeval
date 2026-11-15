#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
reward=0
if [ "$(cat greeting.txt)" = "$EXPECTED" ] && [ -f notes/copy.txt ] && [ ! -e notes/skip.tmp ] && [ ! -e secret.txt ]; then reward=1; fi
ls -A . notes
printf '%s\n' "$reward" >"$logs/reward.txt"
