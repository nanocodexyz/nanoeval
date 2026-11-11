#!/bin/sh
logs=/logs/verifier
mkdir -p "$logs"
kept=${UV_CACHE_DIR:-$HOME/.cache/uv}/fixture
if [ -f "$kept/1500" ]; then
  echo hit >"$logs/cache.txt"
else
  echo miss >"$logs/cache.txt"
  mkdir -p "$kept"
  count=1
  while [ "$count" -le 1500 ]; do
    echo "$count" >"$kept/$count"
    count=$((count + 1))
  done
fi
echo "${UV_CACHE_DIR:-unset}" >"$logs/variable.txt"
if [ "$(cat cached.txt)" = ready ]; then echo 1 >"$logs/reward.txt"; else echo 0 >"$logs/reward.txt"; fi
