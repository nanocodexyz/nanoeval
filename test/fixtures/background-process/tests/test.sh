#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
stat=/proc/$(cat background.pid)/stat
if [ -r "$stat" ] && [ "$(sed 's/.*) //' "$stat" | cut -c1)" != Z ]; then
  printf 'the background process is running
'
  printf '1
' >"$logs/reward.txt"
else
  printf 'the background process is gone
'
  printf '0
' >"$logs/reward.txt"
fi
