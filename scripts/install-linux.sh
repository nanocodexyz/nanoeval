#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
install-linux.sh [--name nanoeval] [--worker-port 8787] [--sandbox-port 8788] [--runs DIR]
                 [--store DIR] [--cache DIR] [--layers DIR] [--state DIR] [--krun DIR]
                 [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT]...
                 [--claude-login FILE] [--codex-login FILE]
install-linux.sh --remove [--name nanoeval]

Keep nanoeval running on this machine as two systemd user services on loopback,
NAME-sandboxd and NAME-worker, and put a command called NAME on the PATH that talks
to them. Imports write their blobs to --store and keep the image layers they read in
--layers. The runners of the machine read the blobs there and keep unpacked
environment disks in --cache. The Worker's tables and the slots of the machine live
under --state. --krun names a directory that holds a built launcher (nanoeval-krun,
nanoeval-krun-guest, nanoeval-net), and without it cargo builds one from this
checkout when it is first needed. Run it again to change an option. Tokens are
generated once and kept, in the configuration directory called NAME.

With --remove, stop and remove the two services, the command and the configuration
directory of NAME. The store, the caches, the state and the jobs stay.
EOF
}

die() {
  printf 'install-linux: %s\n' "$*" >&2
  exit 2
}

name=nanoeval
worker_port=8787
sandbox_port=8788
runs=
store=
cache=
layers=
state=
krun=
remove=false
sandboxd_options=()
worker_options=()
while [ $# -gt 0 ]; do
  case $1 in
    --remove)
      remove=true
      shift
      continue
      ;;
    --name) name=$2 ;;
    --worker-port) worker_port=$2 ;;
    --sandbox-port) sandbox_port=$2 ;;
    --runs) runs=$(readlink -m "$2") ;;
    --store) store=$(readlink -m "$2") ;;
    --cache) cache=$(readlink -m "$2") ;;
    --layers) layers=$(readlink -m "$2") ;;
    --state) state=$(readlink -m "$2") ;;
    --krun)
      [ -x "$2/nanoeval-krun" ] || die "$2 holds no nanoeval-krun"
      krun=$(readlink -f "$2")
      ;;
    --ca-bundle | --slot-env)
      [ -f "$2" ] || die "$2 is not a file"
      sandboxd_options+=("$1" "$(readlink -f "$2")")
      ;;
    --slot-forward) sandboxd_options+=("$1" "$2") ;;
    --claude-login | --codex-login)
      [ -f "$2" ] || die "$2 is not a file"
      worker_options+=("$1" "$(readlink -f "$2")")
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift 2
done

[[ $name =~ ^[a-z][a-z0-9-]*$ ]] || die "a name is lowercase letters, digits and dashes: $name"
command -v systemctl >/dev/null || die 'systemctl is not on the PATH'
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
config=${XDG_CONFIG_HOME:-$HOME/.config}/$name
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
bin=$HOME/.local/bin

if [ "$remove" = true ]; then
  systemctl --user disable --now "$name-worker.service" "$name-sandboxd.service" 2>/dev/null || true
  systemctl --user reset-failed "$name-worker.service" "$name-sandboxd.service" 2>/dev/null || true
  rm -f "$units/$name-worker.service" "$units/$name-sandboxd.service" "$bin/$name"
  rm -rf "$config"
  systemctl --user daemon-reload
  printf 'removed the services, the command and the configuration of %s\n' "$name"
  exit 0
fi

repo=$(readlink -f "$(dirname "$0")/..")
node=$(readlink -f "${NANOEVAL_NODE:-$(command -v node)}") || die 'node is not on the PATH: set NANOEVAL_NODE'
"$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || die "$node is older than Node 24"
[ -d "$repo/node_modules/wrangler" ] || die "run npm ci in $repo first"

runs=${runs:-$HOME/$name-runs}
state=${state:-${XDG_STATE_HOME:-$HOME/.local/state}/$name}
store=${store:-${XDG_DATA_HOME:-$HOME/.local/share}/$name/store}
cache=${cache:-${XDG_CACHE_HOME:-$HOME/.cache}/$name}
layers=${layers:-$cache/oci}
mkdir -p "$config" "$state" "$units" "$bin" "$runs" "$store" "$cache" "$layers"
chmod 700 "$config"

secret() {
  local value=
  if [ -f "$config/env" ]; then value=$(sed -n "s/^$1=//p" "$config/env" | head -n 1); fi
  if [ -z "$value" ]; then value=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n'); fi
  printf '%s' "$value"
}
token=$(secret NANOEVAL_TOKEN)
sandbox_token=$(secret NANOEVAL_SANDBOX_TOKEN)
(
  umask 077
  cat >"$config/env.tmp" <<EOF
NANOEVAL_URL=http://127.0.0.1:$worker_port
NANOEVAL_TOKEN=$token
NANOEVAL_SANDBOX_TOKEN=$sandbox_token
NANOEVAL_RUNS_DIR=$runs
NANOEVAL_STORE=$store
NANOEVAL_CACHE=$cache
NANOEVAL_LAYERS=$layers
EOF
  if [ -n "$krun" ]; then printf 'NANOEVAL_KRUN=%s\n' "$krun" >>"$config/env.tmp"; fi
)
mv "$config/env.tmp" "$config/env"

quote() {
  local text
  printf -v text ' %q' "$@"
  printf '%s' "${text# }"
}

unit_quote() {
  local word text=
  for word in "$@"; do
    word=${word//\\/\\\\}
    word=${word//\"/\\\"}
    word=${word//\$/\$\$}
    word=${word//%/%%}
    text+=" \"$word\""
  done
  printf '%s' "${text# }"
}

cat >"$units/$name-sandboxd.service" <<EOF
[Unit]
Description=$name sandbox daemon

[Service]
EnvironmentFile=$config/env
ExecStart=/bin/sh -c 'NANOEVAL_TOKEN="\$\$NANOEVAL_SANDBOX_TOKEN" exec "\$\$@"' sh $(unit_quote "$node" "$repo/cli/nanoeval.ts" sandboxd --host 127.0.0.1 --port "$sandbox_port" --root "$state/sandboxes" "${sandboxd_options[@]}")
KillMode=process
Restart=on-failure

[Install]
WantedBy=default.target
EOF

cat >"$units/$name-worker.service" <<EOF
[Unit]
Description=$name Worker under local workerd
After=$name-sandboxd.service
Wants=$name-sandboxd.service

[Service]
EnvironmentFile=$config/env
Environment=TMPDIR=%t/$name
RuntimeDirectory=$name
RuntimeDirectoryMode=0700
ExecStart=$(unit_quote "$node" "$repo/cli/nanoeval.ts" worker --host 127.0.0.1 --port "$worker_port" --state "$state/worker" --sandbox-url "http://127.0.0.1:$sandbox_port" "${worker_options[@]}")
Restart=on-failure

[Install]
WantedBy=default.target
EOF

cat >"$bin/$name" <<EOF
#!/usr/bin/env bash
set -a
. $(quote "$config/env")
set +a
exec $(quote "$node" "$repo/cli/nanoeval.ts") "\$@"
EOF
chmod 755 "$bin/$name"

systemctl --user daemon-reload
systemctl --user enable "$name-sandboxd.service" "$name-worker.service"
systemctl --user restart "$name-sandboxd.service" "$name-worker.service"

lacks=()
if ! { [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; }; then lacks+=('read and write access to /dev/kvm'); fi
PATH=$PATH:/usr/sbin:/sbin ldconfig -p 2>/dev/null | grep -q 'libkrunfw\.so\.5' || lacks+=('libkrunfw.so.5')
PATH=$PATH:/usr/sbin:/sbin command -v mke2fs >/dev/null || lacks+=('mke2fs')
command -v passt >/dev/null || lacks+=('passt, for slots on a private network')
if [ -z "$krun" ] && ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then lacks+=('cargo, or --krun with a built launcher'); fi

for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$worker_port/health" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:$sandbox_port/health" >/dev/null 2>&1; then
    printf '%s is running: the Worker on 127.0.0.1:%s, sandboxd on 127.0.0.1:%s\n' "$name" "$worker_port" "$sandbox_port"
    printf 'command %s, jobs under %s, blobs under %s, layers under %s, state under %s, tokens in %s\n' "$bin/$name" "$runs" "$store" "$layers" "$state" "$config/env"
    if [ ${#lacks[@]} -gt 0 ]; then
      printf 'microVM slots cannot run here, so use --backend dir. This machine lacks:\n'
      printf '  %s\n' "${lacks[@]}"
    fi
    exit 0
  fi
  sleep 0.5
done
die "the services did not answer: see journalctl --user -u $name-worker -u $name-sandboxd"
