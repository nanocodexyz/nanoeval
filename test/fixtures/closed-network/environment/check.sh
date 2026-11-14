#!/bin/sh
if [ $# -eq 0 ]; then
  out=network.checks
  reaches=$(cat reaches)
else
  out=$1
  shift
  reaches=$*
fi

probe() {
  name=$1
  shift
  until timeout 6 "$@" >/dev/null 2>&1 </dev/null; do
    case " $reaches " in
      *" $name "*) sleep 1 ;;
      *)
        echo "$name no"
        return
        ;;
    esac
  done
  echo "$name yes"
}

probe internet wget -q -O /dev/null https://example.com/ >"$out.internet" &
probe address nc 1.1.1.1 80 >"$out.address" &
probe forward wget -q -O /dev/null "http://127.0.0.1:$NANOEVAL_E2E_HOST_PORT/" >"$out.forward" &
probe gateway wget -q -O /dev/null "http://10.0.2.2:$NANOEVAL_E2E_HOST_PORT/" >"$out.gateway" &
probe session wget -q -O /dev/null "http://127.0.0.1:$NANOEVAL_E2E_SESSION_PORT/health" >"$out.session" &
wait
cat "$out.internet" "$out.address" "$out.forward" "$out.gateway" "$out.session" >"$out"
