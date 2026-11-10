#!/bin/sh
set -eu
mkdir -p /logs/verifier
if [ "$(cat /tests/.nanoeval/final_message.txt)" = nanoeval ]; then
  echo 1 >/logs/verifier/reward.txt
else
  echo 0 >/logs/verifier/reward.txt
fi
