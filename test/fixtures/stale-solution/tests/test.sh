#!/bin/sh
set -eu

logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"

if [ -f word.txt ] && [ "$(cat word.txt)" = "current" ]; then
    printf '1\n' > "$logs/reward.txt"
    printf 'word.txt is correct\n'
else
    printf '0\n' > "$logs/reward.txt"
    printf 'word.txt is missing or incorrect\n' >&2
    exit 1
fi
