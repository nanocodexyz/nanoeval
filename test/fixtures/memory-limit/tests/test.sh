#!/bin/sh
logs=/logs/verifier
if [ -s hog.txt ]; then
  printf '1\n' >"$logs/reward.txt"
else
  printf 'hog.txt is missing\n'
  printf '0\n' >"$logs/reward.txt"
fi
