#!/usr/bin/env bash
set -euo pipefail

home=${NANOEVAL_HOME:-$HOME/.nanoeval}
rt=$home/rt
krun=$rt/krun
net=$rt/nanoeval-net
cache=${NANOEVAL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/nanoeval}
disks=$cache/disks
self=$(readlink -f "$0")
tools=/var/cache/nanoeval-verifier
trust='CARGO_HTTP_CAINFO CURL_CA_BUNDLE GIT_SSL_CAINFO NODE_EXTRA_CA_CERTS PIP_CERT REQUESTS_CA_BUNDLE SSL_CERT_FILE'

die() {
  printf 'nanoeval-slot: %s\n' "$*" >&2
  exit 2
}

valid() {
  [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,47}$ ]] || die "invalid slot name: $1"
}

spawn() {
  local status=$1 log=$2
  shift 2
  printf 'running\n' >"$status"
  setsid nohup bash -c 'status=$1; shift; "$@"; code=$?; printf "exit:%s\n" "$code" >"$status.tmp"; mv "$status.tmp" "$status"' bash "$status" "$@" >"$log" 2>&1 </dev/null &
  printf '%s\n' "$!" >"$status.pid"
}

reap() {
  local file
  for file in "$1"/*.status.pid; do
    [ -f "$file" ] || continue
    [ "$(state "${file%.pid}")" = running ] || continue
    pkill -KILL -s "$(cat "$file")" 2>/dev/null || true
  done
}

state() {
  if [ -f "$1" ]; then tr -d '\n' <"$1"; else printf 'none'; fi
}

has() {
  command -v "$1" >/dev/null 2>&1
}

key() {
  printf '%s' "$1" | sha256sum | cut -c1-24
}

launcher() {
  if [ -x "$rt/ld.so" ]; then
    printf '%s\n' "$1/ld.so" --library-path "$1/lib" "$1/nanocode"
  else
    printf '%s\n' "$1/nanocode"
  fi
}

vm() {
  local dir=$1
  shift
  (cd "$dir" && exec "$krun/nanoeval-krun" "$@")
}

format() {
  truncate -s "$2M" "$1"
  PATH=$PATH:/usr/sbin:/sbin mke2fs -q -t ext4 -O '^has_journal' -E root_owner=0:0 "$1"
}

guest_options() {
  local dir=$1 name
  printf '%s\n' --socket vm.sock --cwd "$(cat "$dir/workdir")" --user "$(cat "$dir/user")" --env-file "$dir/image.env"
  if [ -f "$rt/trust" ]; then
    for name in $trust; do printf '%s\n' --env "$name=/opt/nanoeval/ca.pem"; done
  fi
  if [ -n "${NANOEVAL_SLOT_ENV:-}" ]; then printf '%s\n' --env-file "$NANOEVAL_SLOT_ENV"; fi
  if [ -f "$dir/env" ]; then printf '%s\n' --env-file "$dir/env"; fi
}

guest_copy() {
  local dir=$1 name=$2
  shift 2
  rm -rf "$dir/io/$name"
  cp -R "$dir/task/$name" "$dir/io/$name"
  vm "$dir" exec "$@" --user 0 -- sh -c 'rm -rf "$1"' sh "/$name"
  vm "$dir" copy-in --socket vm.sock "$name" "/$name"
  rm -rf "$dir/io/$name"
}

stop_process() {
  local dir=$1 pid
  pid=$(cat "$dir/$2" 2>/dev/null) || return 0
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$(readlink -f "$dir")" ] || return 0
  kill -KILL "$pid" 2>/dev/null || true
  tail --pid="$pid" -f /dev/null -s 0.01
}

forwards() {
  local forward
  for forward in ${NANOEVAL_SLOT_FORWARD:-}; do
    [[ $forward =~ ^127(\.[0-9]{1,3}){3}:[0-9]{1,5}$ ]] || die "NANOEVAL_SLOT_FORWARD lists loopback ADDRESS:PORT pairs: $forward"
    printf '%s\n' "$forward"
  done
}

reach() {
  local dir=$1 phase=$2
  [ -f "$dir/forwards" ] || return 0
  printf '%s\n' "$phase" >"$dir/phase"
  if grep -qx "$phase" "$dir/offline" 2>/dev/null; then
    rm -f "$dir/net/open"
    : >"$dir/allow.tmp"
  else
    : >"$dir/net/open"
    cp "$dir/forwards" "$dir/allow.tmp"
  fi
  mv "$dir/allow.tmp" "$dir/allow"
}

relay() {
  local dir=$1
  mkdir -p "$dir/net"
  forwards >"$dir/forwards"
  reach "$dir" agent
  (cd "$dir" && exec "$net" detach relay.log host net/relay.sock allow) >"$dir/relay.pid"
}

session() {
  local dir=$1 url=$2
  [ "$(cat "$dir/network" 2>/dev/null)" = private ] || return 0
  case $url in
    wss://*)
      if grep -qx agent "$dir/offline" 2>/dev/null; then die "a slot whose agent has no network reaches its session only at ws://127.x.x.x:PORT: $url"; fi
      ;;
    *)
      [[ $url =~ ^ws://(127(\.[0-9]{1,3}){3}:[0-9]{1,5})(/|$) ]] || die "a private slot reaches its session over wss:// or at ws://127.x.x.x:PORT: $url"
      printf '%s\n' "${BASH_REMATCH[1]}"
      ;;
  esac
}

cmd_probe() {
  local cpus memory kvm=false microvm=false userns=false bwrap=false ca_bundle=false slot_env=false slot_forward=false
  cpus=$(getconf _NPROCESSORS_ONLN)
  memory=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
  if [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then kvm=true; fi
  if [ "$kvm" = true ] && [ -x "$krun/nanoeval-krun" ] && "$krun/nanoeval-krun" check >/dev/null 2>&1; then microvm=true; fi
  if has unshare && unshare -U true >/dev/null 2>&1; then userns=true; fi
  if has bwrap; then bwrap=true; fi
  if [ -f "$rt/trust" ]; then ca_bundle=true; fi
  if [ -n "${NANOEVAL_SLOT_ENV:-}" ]; then slot_env=true; fi
  if [ -n "${NANOEVAL_SLOT_FORWARD:-}" ]; then slot_forward=true; fi
  printf '{"arch":"%s","bwrap":%s,"ca_bundle":%s,"cpus":%s,"kernel":"%s","krun":%s,"kvm":%s,"memory_mb":%s,"network":"%s","slot_env":%s,"slot_forward":%s,"userns":%s}\n' \
    "$(uname -m)" "$bwrap" "$ca_bundle" "$cpus" "$(uname -r)" "$microvm" "$kvm" "$memory" "$(cat "$home/network" 2>/dev/null || printf none)" "$slot_env" "$slot_forward" "$userns"
}

cmd_setup() {
  mkdir -p "$home/slots"
  case $(state "$home/setup.status") in
    running | exit:0) return 0 ;;
  esac
  spawn "$home/setup.status" "$home/setup.log" bash "$self" _setup "$@"
}

built() {
  local package=$1 target=${2:-}
  if [ -n "${NANOEVAL_KRUN:-}" ]; then
    printf '%s\n' "$NANOEVAL_KRUN/$package"
  elif [ -n "${NANOEVAL_KRUN_SOURCE:-}" ]; then
    has cargo || PATH=$HOME/.cargo/bin:$PATH
    has cargo || die "$package is built with cargo, which is not installed"
    (cd "$NANOEVAL_KRUN_SOURCE" && flock . cargo build --release --locked -p "$package" ${target:+--target "$target"}) >&2
    printf '%s\n' "${CARGO_TARGET_DIR:-$NANOEVAL_KRUN_SOURCE/target}/${target:+$target/}release/$package"
  else
    die "$package comes from NANOEVAL_KRUN, a directory with the built binaries, or from NANOEVAL_KRUN_SOURCE, the krun workspace"
  fi
}

setup_krun() {
  local guest host
  [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] || die 'the krun backend needs read and write access to /dev/kvm'
  host=$(built nanoeval-krun)
  guest=$(built nanoeval-krun-guest "$(uname -m)-unknown-linux-musl")
  mkdir -p "$krun/boot/dev" "$krun/boot/mnt" "$krun/boot/proc" "$krun/boot/sys" "$disks"
  cp "$host" "$krun/nanoeval-krun.$$"
  mv "$krun/nanoeval-krun.$$" "$krun/nanoeval-krun"
  cp "$guest" "$krun/nanoeval-krun-guest.$$"
  mv "$krun/nanoeval-krun-guest.$$" "$krun/boot/nanoeval-krun-guest"
  awk '$1 == "nameserver"' /etc/resolv.conf >"$krun/resolv.conf"
  [ -s "$krun/resolv.conf" ] || die 'the krun backend found no nameserver in /etc/resolv.conf'
  if awk '$2 ~ /^127\./ || $2 == "::1" { loopback = 1 } END { exit !loopback }' "$krun/resolv.conf"; then
    printf 'options use-vc\n' >>"$krun/resolv.conf"
  fi
  "$krun/nanoeval-krun" check >/dev/null
}

setup_private() {
  local backend=$1 helper
  forwards >/dev/null
  helper=$(built nanoeval-net "$(uname -m)-unknown-linux-musl")
  mkdir -p "$rt/net"
  cp "$helper" "$net"
  if [ "$backend" = krun ]; then
    has passt || die 'the private network of krun slots needs passt, which is not installed'
  fi
}

cmd__setup() {
  local release=$1 sum=$2 backend=${3:-krun} network=${4:-host} target tmp
  case $backend-$network in
    dir-host | krun-host | krun-private) ;;
    *) die "the $backend backend has no $network network" ;;
  esac
  mkdir -p "$rt/lib"
  if [ -n "${NANOEVAL_NANOCODE:-}" ]; then
    cp "$NANOEVAL_NANOCODE" "$rt/nanocode"
  elif [ ! -x "$rt/nanocode" ] || [ "$(cat "$rt/nanocode.sha256" 2>/dev/null)" != "$sum" ]; then
    case $(uname -m) in
      x86_64) target=x86_64-unknown-linux-gnu ;;
      aarch64 | arm64) target=aarch64-unknown-linux-gnu ;;
      *) die "nanocode has no build for $(uname -m)" ;;
    esac
    tmp=$(mktemp -d)
    curl -fsSL "$release/nanocode-$target.gz" -o "$tmp/nanocode.gz"
    [ "$(sha256sum "$tmp/nanocode.gz" | cut -d' ' -f1)" = "$sum" ] || die "checksum mismatch for nanocode-$target.gz"
    gunzip -c "$tmp/nanocode.gz" >"$rt/nanocode"
    printf '%s\n' "$sum" >"$rt/nanocode.sha256"
    rm -rf "$tmp"
  fi
  chmod +x "$rt/nanocode"
  local interpreter library bundle
  interpreter=$(ldd "$rt/nanocode" | awk '$1 ~ /^\/.*ld-linux/ {print $1}')
  if [ -n "$interpreter" ]; then
    cp -L "$interpreter" "$rt/ld.so"
    ldd "$rt/nanocode" | awk '$2 == "=>" && $3 ~ /^\// {print $3}' | while read -r library; do
      cp -L "$library" "$rt/lib/"
    done
  fi
  if [ -n "${NANOEVAL_CA_BUNDLE:-}" ]; then
    [ -f "$NANOEVAL_CA_BUNDLE" ] || die "NANOEVAL_CA_BUNDLE is not a file: $NANOEVAL_CA_BUNDLE"
    cp -L "$NANOEVAL_CA_BUNDLE" "$rt/ca.pem"
    : >"$rt/trust"
  else
    for bundle in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
      if [ -f "$bundle" ]; then
        cp -L "$bundle" "$rt/ca.pem"
        break
      fi
    done
  fi
  mapfile -t run < <(launcher "$rt")
  "${run[@]}" --version
  if [ "$backend" = krun ]; then setup_krun; fi
  if [ "$network" = private ]; then setup_private "$backend"; fi
  printf '%s\n' "$network" >"$home/network"
}

cmd_up() {
  local slot=$1
  valid "$slot"
  local dir=$home/slots/$slot
  case $(state "$dir/up.status") in
    running | exit:0) return 0 ;;
  esac
  spawn "$dir/up.status" "$dir/up.log" bash "$self" _up "$@"
}

drop_disk() {
  local base=$1
  [ -f "$base.ext4" ] || return 0
  flock -xn "$base.use" rm -f "$base.ext4" "$base.env" "$base.user" "$base.workdir"
}

cmd_tools() {
  mkdir -p "$rt"
  setup_krun
}

cmd__up() {
  local slot=$1 backend=$2 cpus=$3 memory=$4 network=$5 storage=$6 base=${7:-}
  local dir=$home/slots/$slot archive
  rm -rf "$dir/task" "$dir/verifier"
  mkdir -p "$dir/task" "$dir/verifier"
  for archive in "$dir"/*.tar; do
    [ -f "$archive" ] || continue
    tar -xf "$archive" -C "$dir/task"
  done
  printf '%s\n' "$backend" >"$dir/backend"
  case $backend-$network in
    dir-host | krun-host | krun-private) ;;
    *) die "the $backend backend has no $network network" ;;
  esac
  if [ "$network" = private ] && [ "$(cat "$home/network" 2>/dev/null)" != private ]; then die 'the sandbox was not set up for the private network'; fi
  if [ -s "$dir/offline" ] && [ "$network" != private ]; then die "a $backend slot on the $network network cannot close its network"; fi
  printf '%s\n' "$network" >"$dir/network"
  case $backend in
    dir)
      mkdir -p "$dir/work"
      if [ -d "$dir/task/environment" ]; then
        tar -C "$dir/task/environment" --exclude=./Dockerfile -cf - . | tar -C "$dir/work" -xf -
      fi
      printf '%s\n' "$dir/work" >"$dir/workdir"
      ;;
    krun)
      [ -x "$krun/nanoeval-krun" ] || die 'the sandbox was not set up for the krun backend'
      if [ -n "${NANOEVAL_SLOT_ENV:-}" ] && [ ! -f "$NANOEVAL_SLOT_ENV" ]; then die "NANOEVAL_SLOT_ENV is not a file: $NANOEVAL_SLOT_ENV"; fi
      [ -n "$base" ] || die 'a krun slot boots an environment disk and was given none'
      exec 8>"$base.use"
      flock -s 8
      [ -f "$base.ext4" ] || die "the environment disk $base.ext4 is not in the cache"
      local vcpus workdir
      vcpus=$(awk -v cpus="$cpus" 'BEGIN { whole = int(cpus); print (whole < cpus ? whole + 1 : whole) }')
      printf '%s\n' "$base" >"$dir/disk"
      cp "$base.env" "$dir/image.env"
      cp "$base.user" "$dir/user"
      workdir=$(cat "$base.workdir")
      printf '%s\n' "${workdir:-/}" >"$dir/workdir"
      mkdir -p "$dir/io"
      format "$dir/upper.ext4" "$storage"
      local options=() forward
      if [ "$network" = private ]; then
        relay "$dir" 8>&-
        options+=(--passt "$(command -v passt)" --relay net/relay.sock)
        if [ -s "$dir/offline" ]; then options+=(--gate net/open); fi
        while IFS= read -r forward; do options+=(--forward "$forward"); done <"$dir/forwards"
      fi
      : >"$dir/vm.log"
      (cd "$dir" && exec "$krun/nanoeval-krun" vm --boot "$krun/boot" --rt "$rt" --io io --socket vm.sock --cpus "$vcpus" --memory-mib "$memory" --lower "$base.ext4" --upper upper.ext4 "${options[@]}") >"$dir/vm.log" 2>&1 </dev/null 8>&- &
      printf '%s\n' "$!" >"$dir/vm.pid"
      (cd "$dir" && exec tail --pid="$!" -f /dev/null -s 0.01) >/dev/null 2>&1 </dev/null &
      printf '%s\n' "$!" >"$dir/use.pid"
      vm "$dir" ready --log vm.log --pid "$(cat "$dir/vm.pid")" --socket vm.sock
      ;;
    *) die "unsupported backend: $backend" ;;
  esac
}

cmd_hand() {
  local slot=$1 url=$2 name=$3
  valid "$slot"
  local dir=$home/slots/$slot token
  [ "$(state "$dir/up.status")" = exit:0 ] || die "slot $slot is not up"
  if [ "$(state "$dir/hand.status")" = running ]; then return 0; fi
  session "$dir" "$url" >/dev/null
  IFS= read -r token
  NANOCODE_RUNNER_TOKEN=$token spawn "$dir/hand.status" "$dir/hand.log" bash "$self" _hand "$slot" "$url" "$name"
}

cmd__hand() {
  local slot=$1 url=$2 name=$3
  local dir=$home/slots/$slot workdir session
  workdir=$(cat "$dir/workdir")
  session=$(session "$dir" "$url")
  if [ -n "$session" ]; then printf '%s\n' "$session" >>"$dir/allow"; fi
  case $(cat "$dir/backend") in
    dir)
      mapfile -t run < <(launcher "$rt")
      cd "$workdir"
      printf '%s\n' "$$" >"$dir/hand.pid"
      NANOCODE_HOME=$dir/nanocode exec "${run[@]}" hand "$url" --name "$name" -C "$workdir"
      ;;
    krun)
      mapfile -t run < <(launcher /opt/nanoeval)
      mapfile -t options < <(guest_options "$dir")
      if [ -f "$rt/ca.pem" ] && ! vm "$dir" exec "${options[@]}" -- sh -c 'test -f /etc/ssl/certs/ca-certificates.crt || test -f /etc/ssl/cert.pem || test -f /etc/pki/tls/certs/ca-bundle.crt'; then
        options+=(--env SSL_CERT_FILE=/opt/nanoeval/ca.pem)
      fi
      if [ -n "$session" ]; then options+=(--forward "$session"); fi
      cd "$dir"
      printf '%s\n' "$$" >"$dir/hand.pid"
      exec "$krun/nanoeval-krun" exec "${options[@]}" --env NANOCODE_RUNNER_TOKEN --env NANOCODE_HOME=/tmp/.nanoeval-hand -- \
        "${run[@]}" hand "$url" --name "$name" -C "$workdir"
      ;;
  esac
}

stop_hand() {
  local slot=$1
  local dir=$home/slots/$slot
  if [ -f "$dir/hand.pid" ]; then kill "$(cat "$dir/hand.pid")" 2>/dev/null || true; fi
  reach "$dir" "$(cat "$dir/phase" 2>/dev/null || printf agent)"
}

cmd_solve() {
  local slot=$1
  valid "$slot"
  local dir=$home/slots/$slot
  [ "$(state "$dir/up.status")" = exit:0 ] || die "slot $slot is not up"
  [ -f "$dir/task/solution/solve.sh" ] || die "slot $slot has no solution/solve.sh"
  case $(state "$dir/solve.status") in
    running | exit:*) return 0 ;;
  esac
  spawn "$dir/solve.status" "$dir/solve.log" bash "$self" _solve "$@"
}

cmd__solve() {
  local slot=$1 seconds=$2
  local dir=$home/slots/$slot workdir line
  workdir=$(cat "$dir/workdir")
  local run='if command -v bash >/dev/null 2>&1; then exec bash "$1"; else exec sh "$1"; fi'
  local options=()
  case $(cat "$dir/backend") in
    dir)
      if [ -f "$dir/solution.env" ]; then
        while IFS= read -r line; do options+=("$line"); done <"$dir/solution.env"
      fi
      cd "$workdir"
      exec env "${options[@]}" timeout -k 10 "$seconds" sh -c "$run" sh "$dir/task/solution/solve.sh"
      ;;
    krun)
      mapfile -t options < <(guest_options "$dir")
      guest_copy "$dir" solution "${options[@]}"
      if [ -f "$dir/solution.env" ]; then options+=(--env-file "$dir/solution.env"); fi
      cd "$dir"
      exec timeout -k 10 "$seconds" "$krun/nanoeval-krun" exec "${options[@]}" -- sh -c "$run" sh /solution/solve.sh
      ;;
  esac
}

cmd_verify() {
  local slot=$1 round=${3:-1}
  valid "$slot"
  local dir=$home/slots/$slot
  [ "$(state "$dir/up.status")" = exit:0 ] || die "slot $slot is not up"
  if [ "$(cat "$dir/verify.round" 2>/dev/null || printf 1)" = "$round" ]; then
    case $(state "$dir/verify.status") in
      running | exit:*) return 0 ;;
    esac
  fi
  [ "$(state "$dir/verify.status")" != running ] || die "slot $slot is still verifying"
  printf '%s\n' "$round" >"$dir/verify.round"
  stop_hand "$slot"
  reach "$dir" verifier
  spawn "$dir/verify.status" "$dir/verify.log" bash "$self" _verify "$@"
}

cmd__verify() {
  local slot=$1 seconds=$2
  local dir=$home/slots/$slot workdir code=0 line
  workdir=$(cat "$dir/workdir")
  local run='if command -v bash >/dev/null 2>&1; then exec bash "$1"; else exec sh "$1"; fi'
  local options=()
  rm -rf "$dir/verifier"
  mkdir -p "$dir/verifier"
  case $(cat "$dir/backend") in
    dir)
      if [ -f "$dir/verifier.env" ]; then
        while IFS= read -r line; do options+=("$line"); done <"$dir/verifier.env"
      fi
      (cd "$workdir" && env "${options[@]}" NANOEVAL_VERIFIER_LOGS="$dir/verifier" timeout -k 10 "$seconds" sh -c "$run" sh "$dir/task/tests/test.sh") || code=$?
      ;;
    krun)
      mapfile -t options < <(guest_options "$dir")
      vm "$dir" exec "${options[@]}" --user 0 -- sh -c 'rm -rf /logs/verifier && mkdir -p /logs/verifier && chmod 777 /logs/verifier'
      guest_copy "$dir" tests "${options[@]}"
      local kept='' fill='' key mode user
      if [ -f "$dir/verifier.cache" ]; then
        read -r key mode <"$dir/verifier.cache"
        kept=$cache/verifier/$key
        if [ -d "$kept" ]; then
          rm -rf "$dir/io/cache"
          cp -R "$kept" "$dir/io/cache"
          vm "$dir" exec "${options[@]}" --user 0 -- rm -rf "$tools"
          vm "$dir" copy-in --socket vm.sock cache "$tools"
          rm -rf "$dir/io/cache"
        elif [ "$mode" = write ]; then
          fill=1
          vm "$dir" exec "${options[@]}" --user 0 -- sh -c 'rm -rf "$1" && mkdir -p "$1"' sh "$tools"
        else
          kept=''
        fi
      fi
      if [ -n "$kept" ]; then
        user=$(cat "$dir/user")
        if [ -n "$user" ]; then vm "$dir" exec "${options[@]}" --user 0 -- chown -R "$user" "$tools"; fi
        options+=(--env "UV_CACHE_DIR=$tools/uv" --env "UV_PYTHON_CACHE_DIR=$tools/python")
      fi
      if [ -f "$dir/verifier.env" ]; then options+=(--env-file "$dir/verifier.env"); fi
      (cd "$dir" && timeout -k 10 "$seconds" "$krun/nanoeval-krun" exec "${options[@]}" -- sh -c "$run" sh /tests/test.sh) || code=$?
      if [ -n "$fill" ] && [ "$code" = 0 ]; then
        rm -rf "$dir/io/cache"
        if vm "$dir" copy-out --socket vm.sock "$tools" cache && [ -n "$(ls -A "$dir/io/cache")" ]; then
          mkdir -p "$cache/verifier"
          mv "$dir/io/cache" "$kept.$$"
          mv -T "$kept.$$" "$kept" 2>/dev/null || rm -rf "$kept.$$"
        fi
        rm -rf "$dir/io/cache"
      fi
      rm -rf "$dir/io/verifier"
      if vm "$dir" copy-out --socket vm.sock /logs/verifier verifier; then cp -R "$dir/io/verifier/." "$dir/verifier/"; fi
      vm "$dir" exec "${options[@]}" --user 0 -- /opt/nanoeval/krun/boot/nanoeval-krun-guest oom-kills >"$dir/oom" 2>/dev/null || true
      ;;
  esac
  return "$code"
}

cmd_down() {
  local slot=$1 release=${2:-keep}
  valid "$slot"
  local dir=$home/slots/$slot disk=''
  case $release in
    keep | remove) ;;
    *) die "down keeps or removes the environment disk: $release" ;;
  esac
  if [ -f "$dir/disk" ]; then disk=$(cat "$dir/disk"); fi
  stop_hand "$slot"
  reap "$dir"
  if [ "$(cat "$dir/backend" 2>/dev/null)" = krun ]; then
    stop_process "$dir" vm.pid
    stop_process "$dir" use.pid
  fi
  stop_process "$dir" relay.pid
  rm -rf "$dir"
  if [ "$release" = remove ] && [ -n "$disk" ]; then drop_disk "$disk" || true; fi
}

cmd_prune() {
  local mode=${1:-remove} base blob
  case $mode in
    dry-run | remove) ;;
    *) die "prune takes dry-run or nothing: $mode" ;;
  esac
  for base in "$disks"/*.ext4; do
    [ -f "$base" ] || continue
    base=${base%.ext4}
    if [ "$mode" = dry-run ]; then
      if flock -xn "$base.use" true; then printf 'unused disk %s\n' "$base.ext4"; else printf 'used disk %s\n' "$base.ext4"; fi
    elif drop_disk "$base"; then
      rm -f "$base.use" "$base.lock"
      printf 'removed disk %s\n' "$base.ext4"
    else
      printf 'kept disk %s\n' "$base.ext4"
    fi
  done
  for base in "$cache"/verifier/*; do
    [ -d "$base" ] || continue
    if [ "$mode" = dry-run ]; then
      printf 'verifier cache %s\n' "$base"
    else
      rm -rf "$base"
      printf 'removed verifier cache %s\n' "$base"
    fi
  done
  for blob in "$cache"/blobs/*; do
    [ -f "$blob" ] || continue
    if [ "$mode" = dry-run ]; then
      printf 'cached blob %s\n' "$blob"
    else
      rm -f "$blob"
      printf 'removed blob %s\n' "$blob"
    fi
  done
}

cmd_destroy() {
  local dir
  stop_process "$home" runner.pid
  for dir in "$home" "$home"/slots/*/; do
    reap "$dir"
    stop_process "$dir" relay.pid
  done
  pkill -f "$home/rt/nanocode hand" >/dev/null 2>&1 || true
  pkill -KILL -f "$krun/nanoeval-krun vm " >/dev/null 2>&1 || true
  rm -rf "$home"
}

reward() {
  local file=$1/verifier/reward.txt value
  if [ -f "$file" ]; then
    value=$(tr -d ' \n\r' <"$file")
    if [[ $value =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
      printf '%s' "$value"
      return
    fi
  fi
  printf 'null'
}

oom() {
  local value
  value=$(cat "$1/oom" 2>/dev/null) || true
  if [[ $value =~ ^[0-9]+$ ]]; then printf '%s' "$value"; else printf 'null'; fi
}

free_disk() {
  local paths=("$home")
  if [ -d "$cache" ]; then paths+=("$cache"); fi
  df --output=avail -BM "${paths[@]}" 2>/dev/null | awk 'NR > 1 { free = $1 + 0; if (least == "" || free < least) least = free } END { print least == "" ? 0 : least }'
}

cmd_status() {
  local first=1 dir slot
  printf '{"disk_mb":%s,"setup":"%s","slots":{' "$(free_disk)" "$(state "$home/setup.status")"
  for dir in "$home"/slots/*/; do
    [ -d "$dir" ] || continue
    dir=${dir%/}
    slot=${dir##*/}
    [ "$first" = 1 ] || printf ','
    first=0
    printf '"%s":{"hand":"%s","oom":%s,"reward":%s,"solve":"%s","up":"%s","verify":"%s"}' \
      "$slot" "$(state "$dir/hand.status")" "$(oom "$dir")" "$(reward "$dir")" "$(state "$dir/solve.status")" "$(state "$dir/up.status")" "$(state "$dir/verify.status")"
  done
  printf '}}\n'
}

cmd_log() {
  local slot=$1 phase=$2 bytes=${3:-65536} file size
  case $phase in
    setup) file=$home/setup.log ;;
    up | hand | solve | verify)
      valid "$slot"
      file=$home/slots/$slot/$phase.log
      ;;
    judge)
      valid "$slot"
      file=$home/slots/$slot/verifier/judge-request.json
      ;;
    *) die "unknown log: $phase" ;;
  esac
  [ -f "$file" ] || return 0
  size=$(stat -c %s "$file")
  if [ "$size" -gt "$bytes" ]; then printf 'nanoeval-slot: the last %s of the %s bytes of this log follow\n' "$bytes" "$size"; fi
  tail -c "$bytes" "$file"
}

cmd_files() {
  local slot=$1
  valid "$slot"
  local dir=$home/slots/$slot/verifier
  [ -d "$dir" ] || return 0
  (cd "$dir" && find . -type f ! -name $'*[\t\n]*' -printf '%s\t%P\n' | LC_ALL=C sort -t $'\t' -k 2)
}

cmd_file() {
  local slot=$1 path=$2
  valid "$slot"
  local dir file
  dir=$(readlink -f "$home/slots/$slot/verifier")
  file=$(readlink -f "$dir/$path")
  [ -f "$file" ] && [ "${file#"$dir"/}" != "$file" ] || die "slot $slot has no verifier file $path"
  base64 -w 0 "$file"
}

command=${1:-}
[ -n "$command" ] || die 'usage: nanoeval-slot <probe|setup|tools|up|hand|solve|verify|down|destroy|prune|status|log|files|file> ...'
shift
case $command in
  probe | setup | _setup | tools | up | _up | hand | _hand | solve | _solve | verify | _verify | down | destroy | prune | status | log | files | file)
    "cmd_$command" "$@"
    ;;
  *) die "unknown command: $command" ;;
esac
