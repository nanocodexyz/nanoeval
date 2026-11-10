#!/usr/bin/env bash
set -euo pipefail

home=${NANOEVAL_HOME:-$HOME/.nanoeval}
rt=$home/rt
self=$(readlink -f "$0")

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

launcher() {
  if [ -x "$rt/ld.so" ]; then
    printf '%s\n' "$1/ld.so" --library-path "$1/lib" "$1/nanocode"
  else
    printf '%s\n' "$1/nanocode"
  fi
}

cmd_probe() {
  local cpus memory docker=false kvm=false userns=false bwrap=false
  cpus=$(getconf _NPROCESSORS_ONLN)
  memory=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
  if has docker && docker info >/dev/null 2>&1; then docker=true; fi
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then kvm=true; fi
  if has unshare && unshare -U true >/dev/null 2>&1; then userns=true; fi
  if has bwrap; then bwrap=true; fi
  printf '{"arch":"%s","bwrap":%s,"cpus":%s,"docker":%s,"kernel":"%s","kvm":%s,"memory_mb":%s,"userns":%s}\n' \
    "$(uname -m)" "$bwrap" "$cpus" "$docker" "$(uname -r)" "$kvm" "$memory" "$userns"
}

cmd_setup() {
  mkdir -p "$home/slots"
  case $(state "$home/setup.status") in
    running | exit:0) return 0 ;;
  esac
  spawn "$home/setup.status" "$home/setup.log" bash "$self" _setup "$@"
}

cmd__setup() {
  local release=$1 sum=$2 docker=${3:-keep} target tmp
  if [ "$docker" = install ] && ! has docker; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo chmod 666 /var/run/docker.sock
  fi
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
  for bundle in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
    if [ -f "$bundle" ]; then
      cp -L "$bundle" "$rt/ca.pem"
      break
    fi
  done
  mapfile -t run < <(launcher "$rt")
  "${run[@]}" --version
}

cmd_up() {
  local slot=$1
  valid "$slot"
  local dir=$home/slots/$slot
  [ -f "$dir/task.tar" ] || die "slot $slot has no task.tar"
  case $(state "$dir/up.status") in
    running | exit:0) return 0 ;;
  esac
  spawn "$dir/up.status" "$dir/up.log" bash "$self" _up "$@"
}

cmd__up() {
  local slot=$1 backend=$2 cpus=$3 memory=$4 limits=$5 network=$6 image=${7:-}
  local dir=$home/slots/$slot
  rm -rf "$dir/task" "$dir/verifier"
  mkdir -p "$dir/task" "$dir/verifier"
  tar -xf "$dir/task.tar" -C "$dir/task"
  printf '%s\n' "$backend" >"$dir/backend"
  case $backend in
    dir)
      mkdir -p "$dir/work"
      if [ -d "$dir/task/environment" ]; then
        tar -C "$dir/task/environment" --exclude=./Dockerfile -cf - . | tar -C "$dir/work" -xf -
      fi
      printf '%s\n' "$dir/work" >"$dir/workdir"
      ;;
    docker)
      if [ -z "$image" ]; then
        [ -f "$dir/task/environment/Dockerfile" ] || die "task has neither docker_image nor environment/Dockerfile"
        local hash
        hash=$(tar -C "$dir/task/environment" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | sha256sum | cut -c1-24)
        image=nanoeval-env:$hash
        flock "$home/build-$hash.lock" bash -c 'docker image inspect "$1" >/dev/null 2>&1 || docker build -q --force-rm -t "$1" "$2"' bash "$image" "$dir/task/environment"
      else
        flock "$home/pull.lock" bash -c 'docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1"' bash "$image"
      fi
      local options=()
      if [ -f "$dir/env" ]; then options+=(--env-file "$dir/env"); fi
      docker rm -f "nanoeval-$slot" >/dev/null 2>&1 || true
      case $limits in
        enforce) options+=(--cpus "$cpus" --memory "${memory}m") ;;
        none) ;;
        *) die "limits is enforce or none: $limits" ;;
      esac
      case $network in
        bridge | host) ;;
        *) die "network is bridge or host: $network" ;;
      esac
      docker run -d --name "nanoeval-$slot" --label "nanoeval=$home" \
        --network "$network" \
        -v "$rt:/opt/nanoeval:ro" "${options[@]}" \
        --entrypoint sh "$image" -c 'sleep infinity' >/dev/null
      local workdir
      workdir=$(docker inspect -f '{{.Config.WorkingDir}}' "nanoeval-$slot")
      printf '%s\n' "${workdir:-/}" >"$dir/workdir"
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
  IFS= read -r token
  NANOCODE_RUNNER_TOKEN=$token spawn "$dir/hand.status" "$dir/hand.log" bash "$self" _hand "$slot" "$url" "$name"
}

cmd__hand() {
  local slot=$1 url=$2 name=$3
  local dir=$home/slots/$slot workdir
  workdir=$(cat "$dir/workdir")
  case $(cat "$dir/backend") in
    dir)
      mapfile -t run < <(launcher "$rt")
      cd "$workdir"
      printf '%s\n' "$$" >"$dir/hand.pid"
      NANOCODE_HOME=$dir/nanocode exec "${run[@]}" hand "$url" --name "$name" -C "$workdir"
      ;;
    docker)
      mapfile -t run < <(launcher /opt/nanoeval)
      local options=()
      if [ -f "$rt/ca.pem" ] && ! docker exec "nanoeval-$slot" sh -c 'test -f /etc/ssl/certs/ca-certificates.crt || test -f /etc/ssl/cert.pem || test -f /etc/pki/tls/certs/ca-bundle.crt'; then
        options+=(-e SSL_CERT_FILE=/opt/nanoeval/ca.pem)
      fi
      exec docker exec -i -e NANOCODE_RUNNER_TOKEN -e NANOCODE_HOME=/tmp/.nanoeval-hand "${options[@]}" -w "$workdir" "nanoeval-$slot" \
        sh -c 'echo $$ >/tmp/.nanoeval-hand.pid; exec "$@"' sh "${run[@]}" hand "$url" --name "$name" -C "$workdir"
      ;;
  esac
}

stop_hand() {
  local slot=$1
  local dir=$home/slots/$slot
  case $(cat "$dir/backend" 2>/dev/null) in
    dir)
      if [ -f "$dir/hand.pid" ]; then kill "$(cat "$dir/hand.pid")" 2>/dev/null || true; fi
      ;;
    docker)
      docker exec "nanoeval-$slot" sh -c 'kill "$(cat /tmp/.nanoeval-hand.pid)" 2>/dev/null; rm -f /tmp/.nanoeval-hand.pid' >/dev/null 2>&1 || true
      ;;
  esac
}

cmd_verify() {
  local slot=$1
  valid "$slot"
  local dir=$home/slots/$slot
  [ "$(state "$dir/up.status")" = exit:0 ] || die "slot $slot is not up"
  case $(state "$dir/verify.status") in
    running | exit:*) return 0 ;;
  esac
  stop_hand "$slot"
  spawn "$dir/verify.status" "$dir/verify.log" bash "$self" _verify "$@"
}

cmd__verify() {
  local slot=$1 seconds=$2
  local dir=$home/slots/$slot workdir code=0 line
  workdir=$(cat "$dir/workdir")
  local run='if command -v bash >/dev/null 2>&1; then exec bash "$1"; else exec sh "$1"; fi'
  local options=()
  case $(cat "$dir/backend") in
    dir)
      if [ -f "$dir/verifier.env" ]; then
        while IFS= read -r line; do options+=("$line"); done <"$dir/verifier.env"
      fi
      (cd "$workdir" && env "${options[@]}" NANOEVAL_VERIFIER_LOGS="$dir/verifier" timeout -k 10 "$seconds" sh -c "$run" sh "$dir/task/tests/test.sh") || code=$?
      ;;
    docker)
      if [ -f "$dir/verifier.env" ]; then options+=(--env-file "$dir/verifier.env"); fi
      docker exec "nanoeval-$slot" sh -c 'rm -rf /tests /logs/verifier && mkdir -p /logs/verifier'
      docker cp "$dir/task/tests" "nanoeval-$slot:/tests"
      timeout -k 10 "$seconds" docker exec "${options[@]}" -w "$workdir" "nanoeval-$slot" sh -c "$run" sh /tests/test.sh || code=$?
      docker cp "nanoeval-$slot:/logs/verifier/." "$dir/verifier/" || true
      ;;
  esac
  return "$code"
}

cmd_down() {
  local slot=$1
  valid "$slot"
  local dir=$home/slots/$slot
  stop_hand "$slot"
  reap "$dir"
  if [ "$(cat "$dir/backend" 2>/dev/null)" = docker ]; then
    docker rm -f "nanoeval-$slot" >/dev/null 2>&1 || true
  fi
  rm -rf "$dir"
}

cmd_destroy() {
  local dir
  for dir in "$home" "$home"/slots/*/; do
    reap "$dir"
  done
  if has docker; then
    docker ps -aq --filter "label=nanoeval=$home" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  pkill -f "$home/rt/nanocode hand" >/dev/null 2>&1 || true
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

cmd_status() {
  local first=1 dir slot
  printf '{"setup":"%s","slots":{' "$(state "$home/setup.status")"
  for dir in "$home"/slots/*/; do
    [ -d "$dir" ] || continue
    dir=${dir%/}
    slot=${dir##*/}
    [ "$first" = 1 ] || printf ','
    first=0
    printf '"%s":{"hand":"%s","reward":%s,"up":"%s","verify":"%s"}' \
      "$slot" "$(state "$dir/hand.status")" "$(reward "$dir")" "$(state "$dir/up.status")" "$(state "$dir/verify.status")"
  done
  printf '}}\n'
}

cmd_log() {
  local slot=$1 phase=$2 bytes=${3:-65536} file
  case $phase in
    setup) file=$home/setup.log ;;
    up | hand | verify)
      valid "$slot"
      file=$home/slots/$slot/$phase.log
      ;;
    ctrf)
      valid "$slot"
      file=$home/slots/$slot/verifier/ctrf.json
      ;;
    *) die "unknown log: $phase" ;;
  esac
  if [ -f "$file" ]; then tail -c "$bytes" "$file"; fi
}

command=${1:-}
[ -n "$command" ] || die 'usage: nanoeval-slot <probe|setup|up|hand|verify|down|destroy|status|log> ...'
shift
case $command in
  probe | setup | _setup | up | _up | hand | _hand | verify | _verify | down | destroy | status | log)
    "cmd_$command" "$@"
    ;;
  *) die "unknown command: $command" ;;
esac
