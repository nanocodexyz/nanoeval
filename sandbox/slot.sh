#!/usr/bin/env bash
set -euo pipefail

home=${NANOEVAL_HOME:-$HOME/.nanoeval}
rt=$home/rt
krun=$rt/krun
net=$rt/nanoeval-net
cache=${NANOEVAL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/nanoeval}
disks=$cache/disks
self=$(readlink -f "$0")
agent_home=/var/lib/nanoeval-agent
tools=/var/cache/nanoeval-verifier
trust='CARGO_HTTP_CAINFO CURL_CA_BUNDLE GIT_SSL_CAINFO NODE_EXTRA_CA_CERTS PIP_CERT REQUESTS_CA_BUNDLE SSL_CERT_FILE'
cgroups=/sys/fs/cgroup
capabilities=-all,+audit_write,+chown,+dac_override,+fowner,+fsetid,+kill,+net_bind_service,+net_raw,+setfcap,+setgid,+setpcap,+setuid,+sys_chroot
masked='acpi kcore keys latency_stats sched_debug scsi timer_list timer_stats'
guarded='bus fs irq sys sysrq-trigger'
subnet=10.213
links=16384
PATH=$PATH:/usr/sbin:/sbin

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

endpoint() {
  local dir=$1 url=$2
  [ "$(cat "$dir/network" 2>/dev/null)" = private ] || return 0
  case $url in
    https://*)
      if grep -qx agent "$dir/offline" 2>/dev/null; then die "a slot whose agent has no network reaches its model endpoint only at http://127.x.x.x:PORT: $url"; fi
      ;;
    *)
      [[ $url =~ ^http://(127(\.[0-9]{1,3}){3}:[0-9]{1,5})(/|$) ]] || die "a private slot reaches its model endpoint over https:// or at http://127.x.x.x:PORT: $url"
      printf '%s\n' "${BASH_REMATCH[1]}"
      ;;
  esac
}

cmd_probe() {
  local cpus memory kvm=false microvm=false userns=false bwrap=false ca_bundle=false slot_env=false slot_forward=false cgroup=false ns=false
  cpus=$(getconf _NPROCESSORS_ONLN)
  memory=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
  if [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then kvm=true; fi
  if [ "$kvm" = true ] && [ -x "$krun/nanoeval-krun" ] && "$krun/nanoeval-krun" check >/dev/null 2>&1; then microvm=true; fi
  if has unshare && unshare -U true >/dev/null 2>&1; then userns=true; fi
  if has bwrap; then bwrap=true; fi
  if [ -s "$home/limits" ]; then cgroup=true; fi
  if (namespaces) >/dev/null 2>&1; then ns=true; fi
  if [ -f "$rt/trust" ]; then ca_bundle=true; fi
  if [ -n "${NANOEVAL_SLOT_ENV:-}" ]; then slot_env=true; fi
  if [ -n "${NANOEVAL_SLOT_FORWARD:-}" ]; then slot_forward=true; fi
  printf '{"arch":"%s","backend":"%s","bwrap":%s,"ca_bundle":%s,"cgroup":%s,"cpus":%s,"kernel":"%s","krun":%s,"kvm":%s,"memory_mb":%s,"network":"%s","ns":%s,"slot_env":%s,"slot_forward":%s,"userns":%s}\n' \
    "$(uname -m)" "$(cat "$home/backend" 2>/dev/null || printf none)" "$bwrap" "$ca_bundle" "$cgroup" "$cpus" "$(uname -r)" "$microvm" "$kvm" "$memory" "$(cat "$home/network" 2>/dev/null || printf none)" "$ns" "$slot_env" "$slot_forward" "$userns"
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
  [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ] || die 'the krun backend needs read and write access to /dev/kvm'
  launcher_files
  awk '$1 == "nameserver"' /etc/resolv.conf >"$krun/resolv.conf"
  [ -s "$krun/resolv.conf" ] || die 'the krun backend found no nameserver in /etc/resolv.conf'
  if awk '$2 ~ /^127\./ || $2 == "::1" { loopback = 1 } END { exit !loopback }' "$krun/resolv.conf"; then
    printf 'options use-vc\n' >>"$krun/resolv.conf"
  fi
  "$krun/nanoeval-krun" check >/dev/null
}

namespaces() {
  local tool
  [ "$(id -u)" = 0 ] || die 'the ns backend needs root'
  grep -qw overlay /proc/filesystems || die 'the ns backend needs overlayfs in the kernel'
  for tool in chroot losetup mke2fs mount mountpoint pgrep setpriv unshare; do
    has "$tool" || die "the ns backend needs $tool"
  done
}

launcher_files() {
  local guest host
  host=$(built nanoeval-krun)
  guest=$(built nanoeval-krun-guest "$(uname -m)-unknown-linux-musl")
  mkdir -p "$krun/boot/dev" "$krun/boot/mnt" "$krun/boot/proc" "$krun/boot/sys" "$disks"
  cp "$host" "$krun/nanoeval-krun.$$"
  mv "$krun/nanoeval-krun.$$" "$krun/nanoeval-krun"
  cp "$guest" "$krun/nanoeval-krun-guest.$$"
  mv "$krun/nanoeval-krun-guest.$$" "$krun/boot/nanoeval-krun-guest"
}

firewall() {
  nft -f - <<EOF
table ip nanoeval
delete table ip nanoeval
table ip nanoeval {
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "nev*" oifname "nev*" drop
  }
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "nev*" drop
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr $subnet.0.0/16 oifname != "nev*" masquerade
  }
}
EOF
}

setup_ns() {
  local network=$1 tool
  namespaces
  launcher_files
  if [ "$network" = private ]; then
    for tool in ip nft; do
      has "$tool" || die "the private network of ns slots needs $tool"
    done
    awk '$1 == "nameserver" && $2 !~ /^127\./ && $2 != "::1"' /etc/resolv.conf >"$krun/resolv.conf"
    [ -s "$krun/resolv.conf" ] || die 'the private network of ns slots needs a nameserver that is not on the loopback of the machine'
    printf '1\n' >/proc/sys/net/ipv4/ip_forward
    if ! nft list table ip nanoeval >/dev/null 2>&1; then firewall; fi
  else
    awk '$1 == "nameserver"' /etc/resolv.conf >"$krun/resolv.conf"
    [ -s "$krun/resolv.conf" ] || die 'the ns backend found no nameserver in /etc/resolv.conf'
  fi
  rm -f "$home/limits"
  if grep -qw memory "$cgroups/cgroup.controllers" 2>/dev/null; then
    mkdir -p "$cgroups/nanoeval"
    if printf '+cpu +memory\n' >"$cgroups/cgroup.subtree_control" && printf '+cpu +memory\n' >"$cgroups/nanoeval/cgroup.subtree_control"; then
      printf '%s\n' "$cgroups/nanoeval" >"$home/limits"
    fi
  fi
  if [ ! -s "$home/limits" ]; then printf 'nanoeval-slot: no cgroup v2 memory controller here, so ns slots run without CPU and memory limits\n' >&2; fi
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
    dir-host | krun-host | krun-private | ns-host | ns-private) ;;
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
  if [ "$backend" = ns ]; then setup_ns "$network"; fi
  if [ "$network" = private ]; then setup_private "$backend"; fi
  printf '%s\n' "$backend" >"$home/backend"
  printf '%s\n' "$network" >"$home/network"
}

cmd_agents() {
  local kind=$1 version=$2 entry=$3 format=$4
  shift 4
  [[ $kind =~ ^[a-z][a-z0-9-]*$ ]] || die "invalid agent: $kind"
  local target=$rt/agents/$kind store=$cache/agents/$kind-$version machine variable override libc sum url tmp
  mkdir -p "$cache/agents" "$rt/agents"
  exec 9>"$cache/agents/$kind.lock"
  flock 9
  variable=NANOEVAL_AGENT_$(printf '%s' "$kind" | tr 'a-z-' 'A-Z_')
  override=${!variable:-}
  if [ "$(cat "$target/version" 2>/dev/null)" = "$version ${override:-release}" ]; then return 0; fi
  rm -rf "$target.new"
  mkdir -p "$target.new"
  if [ -n "$override" ]; then
    [ -f "$override" ] || die "$variable is not a file: $override"
    mkdir -p "$(dirname "$target.new/any/$entry")"
    cp "$override" "$target.new/any/$entry"
    chmod 755 "$target.new/any/$entry"
  else
    machine=$(uname -m)
    if [ "$machine" = arm64 ]; then machine=aarch64; fi
    while [ $# -ge 4 ]; do
      if [ "$1" = "$machine" ]; then
        libc=$2 sum=$3 url=$4
        if [ ! -f "$store/$libc/.complete" ]; then
          tmp=$(mktemp -d "$cache/agents/fetch.XXXXXX")
          curl -fsSL "$url" -o "$tmp/download"
          [ "$(sha256sum "$tmp/download" | cut -d' ' -f1)" = "$sum" ] || die "checksum mismatch for $url"
          mkdir -p "$tmp/out"
          case $format in
            file)
              mkdir -p "$(dirname "$tmp/out/$entry")"
              mv "$tmp/download" "$tmp/out/$entry"
              chmod 755 "$tmp/out/$entry"
              ;;
            tar.gz) tar -xzf "$tmp/download" -C "$tmp/out" ;;
            *) die "unknown release format: $format" ;;
          esac
          [ -x "$tmp/out/$entry" ] || die "the release of $kind has no $entry"
          : >"$tmp/out/.complete"
          rm -rf "${store:?}/$libc"
          mkdir -p "$store"
          mv "$tmp/out" "$store/$libc"
          rm -rf "$tmp"
        fi
        cp -al "$store/$libc" "$target.new/$libc" 2>/dev/null || cp -a "$store/$libc" "$target.new/$libc"
      fi
      shift 4
    done
    [ -n "$(ls -A "$target.new")" ] || die "$kind has no build for $machine"
  fi
  printf '%s\n' "$version ${override:-release}" >"$target.new/version"
  rm -rf "$target"
  mv "$target.new" "$target"
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
  flock -xn "$base.use" bash "$self" _drop "$base"
}

cmd__drop() {
  local base=$1
  if [ -d "$base.mnt" ]; then
    if mountpoint -q "$base.mnt"; then umount "$base.mnt"; fi
    rmdir "$base.mnt"
  fi
  rm -f "$base.ext4" "$base.env" "$base.user" "$base.workdir"
}

cmd_tools() {
  mkdir -p "$rt"
  if [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then setup_krun; else launcher_files; fi
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
    dir-host | krun-host | krun-private | ns-host | ns-private) ;;
    *) die "the $backend backend has no $network network" ;;
  esac
  if [ "$network" = private ] && [ "$(cat "$home/network" 2>/dev/null)" != private ]; then die 'the sandbox was not set up for the private network'; fi
  if [ -s "$dir/offline" ] && [ "$backend-$network" != krun-private ]; then die "a $backend slot on the $network network cannot close its network"; fi
  printf '%s\n' "$network" >"$dir/network"
  case $backend in
    dir)
      mkdir -p "$dir/work"
      if [ -d "$dir/task/environment" ]; then
        tar -C "$dir/task/environment" --exclude=./Dockerfile -cf - . | tar -C "$dir/work" -xf -
      fi
      printf '%s\n' "$dir/work" >"$dir/workdir"
      ;;
    krun | ns)
      [ -x "$krun/nanoeval-krun" ] || die "the sandbox was not set up for the $backend backend"
      if [ -n "${NANOEVAL_SLOT_ENV:-}" ] && [ ! -f "$NANOEVAL_SLOT_ENV" ]; then die "NANOEVAL_SLOT_ENV is not a file: $NANOEVAL_SLOT_ENV"; fi
      [ -n "$base" ] || die "a $backend slot boots an environment disk and was given none"
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
      local options=() forward
      : >"$dir/vm.log"
      if [ "$backend" = ns ]; then
        mkdir -p "$dir/ctl/io"
        chmod 700 "$dir/ctl"
        ln -sfn ctl "$dir/net"
        ln -sfn ctl/io "$dir/io"
        ln -sfn ctl/vm.sock "$dir/vm.sock"
        format "$dir/upper.ext4" "$storage"
        if [ "$network" = private ]; then relay "$dir" 8>&-; fi
        namespace "$dir" "$slot" "$base" "$network" "$vcpus" "$memory" 8>&-
      else
        mkdir -p "$dir/io"
        format "$dir/upper.ext4" "$storage"
        if [ "$network" = private ]; then
          relay "$dir" 8>&-
          options+=(--passt "$(command -v passt)" --relay net/relay.sock)
          if [ -s "$dir/offline" ]; then options+=(--gate net/open); fi
          while IFS= read -r forward; do options+=(--forward "$forward"); done <"$dir/forwards"
        fi
        (cd "$dir" && exec "$krun/nanoeval-krun" vm --boot "$krun/boot" --rt "$rt" --io io --socket vm.sock --cpus "$vcpus" --memory-mib "$memory" --lower "$base.ext4" --upper upper.ext4 "${options[@]}") >"$dir/vm.log" 2>&1 </dev/null 8>&- &
        printf '%s\n' "$!" >"$dir/vm.pid"
      fi
      (cd "$dir" && exec tail --pid="$(cat "$dir/vm.pid")" -f /dev/null -s 0.01) >/dev/null 2>&1 </dev/null &
      printf '%s\n' "$!" >"$dir/use.pid"
      if ! vm "$dir" ready --log vm.log --pid "$(cat "$dir/vm.pid")" --socket vm.sock; then
        cat "$dir/vm.log" >&2
        exit 1
      fi
      ;;
    *) die "unsupported backend: $backend" ;;
  esac
}

namespace() {
  local dir=$1 slot=$2 base=$3 network=$4 vcpus=$5 memory=$6
  local cgroup='' child index='' options=(--mount --pid --ipc --uts --fork --kill-child) parent third fourth forwards=()
  (
    flock 9
    if ! mountpoint -q "$base.mnt"; then
      mkdir -p "$base.mnt"
      mount -o loop,ro,noload "$base.ext4" "$base.mnt"
    fi
  ) 9>"$disks/mounts.lock"
  if [ -s "$home/limits" ]; then
    cgroup=$(cat "$home/limits")/$(key "$dir")
    mkdir "$cgroup"
    printf '%sM\n' "$memory" >"$cgroup/memory.max"
    if [ -f "$cgroup/memory.swap.max" ]; then printf '0\n' >"$cgroup/memory.swap.max"; fi
    printf '%s 100000\n' "$((vcpus * 100000))" >"$cgroup/cpu.max"
    printf '%s\n' "$cgroup" >"$dir/cgroup"
    options+=(--cgroup)
  fi
  if [ "$network" = private ]; then
    options+=(--net)
    mapfile -t forwards <"$dir/forwards"
  fi
  (
    if [ -n "$cgroup" ]; then printf '%s\n' "$BASHPID" >"$cgroup/cgroup.procs"; fi
    cd "$dir" && exec unshare "${options[@]}" bash "$self" _ns "$slot" "$base.mnt" "$network" "${forwards[@]}"
  ) >"$dir/vm.log" 2>&1 </dev/null &
  parent=$!
  printf '%s\n' "$parent" >"$dir/vm.pid"
  [ "$network" = private ] || return 0
  until child=$(pgrep -P "$parent") && [ -n "$child" ]; do
    kill -0 "$parent" 2>/dev/null || die "the slot ended before its namespaces existed: $(cat "$dir/vm.log")"
    sleep 0.01
  done
  for ((index = 0; index < links; index++)); do
    [ ! -e "/sys/class/net/nev$index" ] || continue
    if ip link add "nev$index" type veth peer name eth0 netns "$child" 2>"$dir/link.log"; then break; fi
    [ -e "/sys/class/net/nev$index" ] || die "the slot got no network link: $(cat "$dir/link.log")"
  done
  [ "$index" -lt "$links" ] || die "every one of the $links network links of ns slots is taken"
  third=$((index * 4 / 256))
  fourth=$((index * 4 % 256))
  ip address add "$subnet.$third.$((fourth + 1))/30" dev "nev$index"
  ip link set "nev$index" up
  printf '%s %s\n' "$subnet.$third.$((fourth + 2))/30" "$subnet.$third.$((fourth + 1))" >"$dir/address.tmp"
  mv "$dir/address.tmp" "$dir/address"
}

cmd__ns() {
  local slot=$1 lower=$2 network=$3
  shift 3
  local dir=$home/slots/$slot address arguments=() forward gateway name root
  root=$dir/root
  mount --make-rprivate /
  mkdir -p "$dir/upper" "$root"
  mount -o loop "$dir/upper.ext4" "$dir/upper"
  mkdir -p "$dir/upper/upper" "$dir/upper/work"
  mount -t overlay overlay -o "lowerdir=$lower,upperdir=$dir/upper/upper,workdir=$dir/upper/work" "$root"
  mkdir -p "$root/.nanoeval" "$root/dev" "$root/opt/nanoeval" "$root/proc" "$root/sys"
  chmod 700 "$root/.nanoeval"
  mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
  for name in $guarded; do
    [ -e "$root/proc/$name" ] || continue
    mount --bind "$root/proc/$name" "$root/proc/$name"
    mount -o remount,bind,ro "$root/proc/$name"
  done
  for name in $masked; do
    if [ -d "$root/proc/$name" ]; then
      mount -t tmpfs -o ro,size=0 tmpfs "$root/proc/$name"
    elif [ -e "$root/proc/$name" ]; then
      mount --bind /dev/null "$root/proc/$name"
    fi
  done
  mount -t sysfs -o ro,nosuid,nodev,noexec sysfs "$root/sys"
  if [ -s "$dir/cgroup" ]; then mount -t cgroup2 -o ro,nosuid,nodev,noexec cgroup2 "$root/sys/fs/cgroup"; fi
  mount -t tmpfs -o nosuid,mode=755 tmpfs "$root/dev"
  mknod -m 666 "$root/dev/null" c 1 3
  mknod -m 666 "$root/dev/zero" c 1 5
  mknod -m 666 "$root/dev/full" c 1 7
  mknod -m 666 "$root/dev/random" c 1 8
  mknod -m 666 "$root/dev/urandom" c 1 9
  mknod -m 666 "$root/dev/tty" c 5 0
  mkdir "$root/dev/pts" "$root/dev/shm"
  mount -t devpts -o newinstance,ptmxmode=0666,mode=620,gid=5 devpts "$root/dev/pts"
  mount -t tmpfs -o nosuid,nodev,mode=1777 tmpfs "$root/dev/shm"
  ln -s pts/ptmx "$root/dev/ptmx"
  ln -s /proc/self/fd "$root/dev/fd"
  ln -s /proc/self/fd/0 "$root/dev/stdin"
  ln -s /proc/self/fd/1 "$root/dev/stdout"
  ln -s /proc/self/fd/2 "$root/dev/stderr"
  mount --bind "$rt" "$root/opt/nanoeval"
  mount -o remount,bind,ro "$root/opt/nanoeval"
  mount --bind "$dir/ctl" "$root/.nanoeval"
  if [ "$network" = private ]; then
    until [ -s "$dir/address" ]; do sleep 0.01; done
    read -r address gateway <"$dir/address"
    ip link set lo up
    ip address add "$address" dev eth0
    ip link set eth0 up
    ip route add default via "$gateway"
  fi
  if has hostname; then hostname localhost; fi
  for forward; do arguments+=("forward=$forward"); done
  cd "$root"
  mount --move . /
  exec setpriv --bounding-set "$capabilities" chroot . /opt/nanoeval/krun/boot/nanoeval-krun-guest ns "${arguments[@]}"
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
    krun | ns)
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

cmd_agent() {
  local slot=$1 url=$3
  valid "$slot"
  local dir=$home/slots/$slot token
  [ "$(state "$dir/up.status")" = exit:0 ] || die "slot $slot is not up"
  [ -f "$dir/agent/run.sh" ] && [ -f "$dir/agent/instruction.md" ] || die "slot $slot has no agent to run"
  case $(state "$dir/agent.status") in
    running | exit:*) return 0 ;;
  esac
  endpoint "$dir" "$url" >/dev/null
  IFS= read -r token
  NANOEVAL_AGENT_TOKEN=$token spawn "$dir/agent.status" "$dir/agent.log" bash "$self" _agent "$@"
}

cmd__agent() {
  local slot=$1 seconds=$2 url=$3
  local dir=$home/slots/$slot workdir address run
  workdir=$(cat "$dir/workdir")
  address=$(endpoint "$dir" "$url")
  if [ -n "$address" ]; then printf '%s\n' "$address" >>"$dir/allow"; fi
  run=$(cat "$dir/agent/run.sh")
  case $(cat "$dir/backend") in
    dir)
      cd "$workdir"
      printf '%s\n' "$$" >"$dir/agent.pid"
      NANOEVAL_AGENT_HOME=$dir/agent/home NANOEVAL_AGENT_RT=$rt exec timeout -k 10 "$seconds" sh -c "$run" sh <"$dir/agent/instruction.md" >"$dir/agent.out" 2>"$dir/agent.err"
      ;;
    krun | ns)
      mapfile -t options < <(guest_options "$dir")
      if [ -f "$rt/ca.pem" ] && ! vm "$dir" exec "${options[@]}" -- sh -c 'test -f /etc/ssl/certs/ca-certificates.crt || test -f /etc/ssl/cert.pem || test -f /etc/pki/tls/certs/ca-bundle.crt'; then
        options+=(--env SSL_CERT_FILE=/opt/nanoeval/ca.pem)
      fi
      vm "$dir" exec "${options[@]}" --user 0 -- sh -c 'mkdir -p "$1" && chmod 1777 "$1"' sh "$agent_home"
      if [ -n "$address" ]; then options+=(--forward "$address"); fi
      cd "$dir"
      printf '%s\n' "$$" >"$dir/agent.pid"
      exec timeout -k 10 "$seconds" "$krun/nanoeval-krun" exec "${options[@]}" --env NANOEVAL_AGENT_TOKEN --env NANOEVAL_AGENT_HOME="$agent_home" --env NANOEVAL_AGENT_RT=/opt/nanoeval -- \
        sh -c "$run" sh <"$dir/agent/instruction.md" >"$dir/agent.out" 2>"$dir/agent.err"
      ;;
  esac
}

stop_hand() {
  local slot=$1
  local dir=$home/slots/$slot
  if [ -f "$dir/hand.pid" ]; then kill "$(cat "$dir/hand.pid")" 2>/dev/null || true; fi
  if [ -f "$dir/agent.pid" ] && [ "$(state "$dir/agent.status")" = running ]; then kill "$(cat "$dir/agent.pid")" 2>/dev/null || true; fi
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
    krun | ns)
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
    krun | ns)
      mapfile -t options < <(guest_options "$dir")
      vm "$dir" exec "${options[@]}" --user 0 -- sh -c 'rm -rf /logs/verifier "$1" && mkdir -p /logs/verifier && chmod 777 /logs/verifier' sh "$agent_home"
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
      if [ -s "$dir/cgroup" ]; then
        awk '$1 == "oom_kill" { print $2 }' "$(cat "$dir/cgroup")/memory.events" >"$dir/oom"
      elif [ "$(cat "$dir/backend")" = krun ]; then
        vm "$dir" exec "${options[@]}" --user 0 -- /opt/nanoeval/krun/boot/nanoeval-krun-guest oom-kills >"$dir/oom" 2>/dev/null || true
      fi
      ;;
  esac
  return "$code"
}

cmd_down() {
  local slot=$1 release=${2:-keep}
  valid "$slot"
  local dir=$home/slots/$slot disk='' cgroup=''
  case $release in
    keep | remove) ;;
    *) die "down keeps or removes the environment disk: $release" ;;
  esac
  if [ -f "$dir/disk" ]; then disk=$(cat "$dir/disk"); fi
  stop_hand "$slot"
  reap "$dir"
  stop_process "$dir" vm.pid
  stop_process "$dir" use.pid
  stop_process "$dir" relay.pid
  if [ -s "$dir/cgroup" ]; then cgroup=$(cat "$dir/cgroup"); fi
  if [ -n "$cgroup" ] && [ -d "$cgroup" ]; then
    printf '1\n' >"$cgroup/cgroup.kill"
    until rmdir "$cgroup" 2>/dev/null; do sleep 0.01; done
  fi
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
  local dir mount
  stop_process "$home" runner.pid
  for dir in "$home" "$home"/slots/*/; do
    reap "$dir"
    stop_process "$dir" relay.pid
    stop_process "$dir" vm.pid
    if [ -s "$dir/cgroup" ] && [ -d "$(cat "$dir/cgroup")" ]; then
      printf '1\n' >"$(cat "$dir/cgroup")/cgroup.kill"
      until rmdir "$(cat "$dir/cgroup")" 2>/dev/null; do sleep 0.01; done
    fi
  done
  pkill -f "$home/rt/nanocode hand" >/dev/null 2>&1 || true
  pkill -KILL -f "$krun/nanoeval-krun vm " >/dev/null 2>&1 || true
  while IFS= read -r mount; do
    umount -l "$mount"
  done < <(awk -v home="$home/" 'index($2, home) == 1 { print $2 }' /proc/mounts | sort -r)
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
    agent)
      valid "$slot"
      file=$home/slots/$slot/agent.err
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
[ -n "$command" ] || die 'usage: nanoeval-slot <probe|setup|tools|agents|up|hand|agent|solve|verify|down|destroy|prune|status|log|files|file> ...'
shift
case $command in
  probe | setup | _setup | tools | agents | up | _up | _ns | _drop | hand | _hand | agent | _agent | solve | _solve | verify | _verify | down | destroy | prune | status | log | files | file)
    "cmd_$command" "$@"
    ;;
  *) die "unknown command: $command" ;;
esac
