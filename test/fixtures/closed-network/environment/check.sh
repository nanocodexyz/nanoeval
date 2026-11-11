#!/bin/sh
out=${1:-network.checks}

probe() {
  name=$1
  shift
  if timeout 6 "$@" >/dev/null 2>&1 </dev/null; then echo "$name yes"; else echo "$name no"; fi
}

probe internet wget -q -O /dev/null https://example.com/ >"$out.internet" &
probe address nc 1.1.1.1 80 >"$out.address" &
probe forward wget -q -O /dev/null "http://127.0.0.1:$NANOEVAL_E2E_HOST_PORT/" >"$out.forward" &
probe gateway wget -q -O /dev/null "http://10.0.2.2:$NANOEVAL_E2E_HOST_PORT/" >"$out.gateway" &
probe session wget -q -O /dev/null "http://127.0.0.1:$NANOEVAL_E2E_SESSION_PORT/health" >"$out.session" &
wait
cat "$out.internet" "$out.address" "$out.forward" "$out.gateway" "$out.session" >"$out"
