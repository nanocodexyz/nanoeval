#!/bin/sh
logs=/logs/verifier
mkdir -p "$logs"
sleep 8
if [ "$(cat cached.txt)" = ready ]; then echo 1 >"$logs/reward.txt"; else echo 0 >"$logs/reward.txt"; fi
