#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
sh check.sh /tmp/verifier.checks
reward=1

expect() {
  if grep -qx "$2" "$1"; then
    printf 'ok: %s has %s\n' "$1" "$2"
  else
    printf 'failed: %s lacks %s\n' "$1" "$2"
    reward=0
  fi
}

for line in 'internet yes' 'forward yes' 'gateway no' 'session yes'; do expect network.checks "$line"; done
for line in 'internet no' 'address no' 'forward no' 'gateway no' 'session no'; do expect /tmp/verifier.checks "$line"; done
printf '%s\n' "$reward" >"$logs/reward.txt"
