#!/bin/sh
logs=${NANOEVAL_VERIFIER_LOGS:-/logs/verifier}
mkdir -p "$logs"
reward=1

check() {
  what=$1
  shift
  if "$@"; then
    printf 'ok: %s\n' "$what"
  else
    printf 'failed: %s\n' "$what"
    reward=0
  fi
}

unreachable() {
  ! wget -q -T 5 -O /dev/null "http://127.0.0.1:$1" 2>/dev/null
}

check 'port 5329 answers with the token of this slot' test "$(nc -w 2 127.0.0.1 5329 </dev/null)" = "$(cat port.token)"
check 'the agent had outbound HTTPS' grep -qx https agent.checks
check 'the agent reached its session on the loopback' grep -qx session agent.checks
check 'the agent did not reach a listener on the loopback of the host' grep -qx isolated agent.checks
check 'the verifier has outbound HTTPS' wget -q -T 20 -O /dev/null https://example.com/
check 'the verifier does not reach a listener on the loopback of the host' unreachable "$NANOEVAL_E2E_HOST_PORT/"
check 'the verifier does not reach the session of the agent' unreachable "$NANOEVAL_E2E_SESSION_PORT/health"
printf '%s\n' "$reward" >"$logs/reward.txt"
