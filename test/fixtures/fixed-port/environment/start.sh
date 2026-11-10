#!/bin/sh
set -eu

od -An -N16 -tx1 /dev/urandom | tr -d ' \n' >port.token
setsid nc -lk -p 5329 -e cat /app/port.token >/dev/null 2>&1 &
tries=0
until [ "$(nc -w 2 127.0.0.1 5329 </dev/null)" = "$(cat port.token)" ]; do
  tries=$((tries + 1))
  [ "$tries" -lt 50 ] || exit 1
  sleep 0.1
done

: >agent.checks
if wget -q -T 20 -O /dev/null https://example.com/; then echo https >>agent.checks; fi
if wget -q -T 5 -O /dev/null "http://127.0.0.1:$NANOEVAL_E2E_SESSION_PORT/health"; then echo session >>agent.checks; fi
if ! wget -q -T 5 -O /dev/null "http://127.0.0.1:$NANOEVAL_E2E_HOST_PORT/"; then echo isolated >>agent.checks; fi
