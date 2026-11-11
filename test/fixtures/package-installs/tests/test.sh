#!/bin/sh
logs=/logs/verifier
mkdir -p "$logs"
if [ "$(cat version.txt)" = 1.16.0 ] && NODE_PATH=/usr/local/lib/node_modules node -e 'process.exit(require("is-number")(7) ? 0 : 1)'; then
  printf '1\n' >"$logs/reward.txt"
else
  printf '0\n' >"$logs/reward.txt"
fi
