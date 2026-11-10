#!/bin/sh
logs=/logs/verifier
if [ "$(id -u)" != 1000 ] || [ "$(stat -c %u greeting.txt)" != 1000 ]; then
  printf 'the agent or the verifier did not run as the user of the image\n'
  exit 1
fi
mkdir -p "$logs/extra"
printf '{"results":{"summary":{"tests":1,"passed":1,"failed":0}}}\n' >"$logs/ctrf.json"
printf '\377\000\376' >"$logs/extra/data.bin"
if [ "$(cat greeting.txt)" = "hello from nanoeval" ]; then
  printf '1\n' >"$logs/reward.txt"
else
  printf '0\n' >"$logs/reward.txt"
fi
