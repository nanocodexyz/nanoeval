#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
install-linux.sh [--worker-port 8787] [--sandbox-port 8788] [--runs DIR]
                 [--store DIR] [--cache DIR]
                 [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT]...
                 [--claude-login FILE] [--codex-login FILE]

Keep nanoeval running on this machine as two systemd user services on loopback,
nanoeval-sandboxd and nanoeval-worker, and put a nanoeval command on the PATH that
talks to them. Imports write their blobs to --store, and the runners of the machine
read them there and keep unpacked environment disks in --cache. Run it again to
change an option. Tokens are generated once and kept.
EOF
}

die() {
  printf 'install-linux: %s\n' "$*" >&2
  exit 2
}

worker_port=8787
sandbox_port=8788
runs=$HOME/nanoeval-runs
store=${XDG_DATA_HOME:-$HOME/.local/share}/nanoeval/store
cache=${XDG_CACHE_HOME:-$HOME/.cache}/nanoeval
sandboxd_options=()
worker_options=()
while [ $# -gt 0 ]; do
  case $1 in
    --worker-port) worker_port=$2 ;;
    --sandbox-port) sandbox_port=$2 ;;
    --runs) runs=$(readlink -f "$2") ;;
    --store) store=$(readlink -m "$2") ;;
    --cache) cache=$(readlink -m "$2") ;;
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

repo=$(readlink -f "$(dirname "$0")/..")
node=$(readlink -f "${NANOEVAL_NODE:-$(command -v node)}") || die 'node is not on the PATH: set NANOEVAL_NODE'
"$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || die "$node is older than Node 24"
[ -d "$repo/node_modules/wrangler" ] || die "run npm ci in $repo first"
command -v docker >/dev/null || die 'docker is not on the PATH: the temporary converter of nanoeval import calls it'
command -v systemctl >/dev/null || die 'systemctl is not on the PATH'
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

config=${XDG_CONFIG_HOME:-$HOME/.config}/nanoeval
state=${XDG_STATE_HOME:-$HOME/.local/state}/nanoeval
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
bin=$HOME/.local/bin
mkdir -p "$config" "$state" "$units" "$bin" "$runs" "$store" "$cache"
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
EOF
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

cat >"$units/nanoeval-sandboxd.service" <<EOF
[Unit]
Description=nanoeval sandbox daemon

[Service]
EnvironmentFile=$config/env
ExecStart=/bin/sh -c 'NANOEVAL_TOKEN="\$\$NANOEVAL_SANDBOX_TOKEN" exec "\$\$@"' sh $(unit_quote "$node" "$repo/cli/nanoeval.ts" sandboxd --host 127.0.0.1 --port "$sandbox_port" --root "$state/sandboxes" "${sandboxd_options[@]}")
KillMode=process
Restart=on-failure

[Install]
WantedBy=default.target
EOF

cat >"$units/nanoeval-worker.service" <<EOF
[Unit]
Description=nanoeval Worker under local workerd
After=nanoeval-sandboxd.service
Wants=nanoeval-sandboxd.service

[Service]
EnvironmentFile=$config/env
Environment=TMPDIR=%t/nanoeval
RuntimeDirectory=nanoeval
RuntimeDirectoryMode=0700
ExecStart=$(unit_quote "$node" "$repo/cli/nanoeval.ts" worker --host 127.0.0.1 --port "$worker_port" --state "$state/worker" --sandbox-url "http://127.0.0.1:$sandbox_port" "${worker_options[@]}")
Restart=on-failure

[Install]
WantedBy=default.target
EOF

cat >"$bin/nanoeval" <<EOF
#!/usr/bin/env bash
set -a
. $(quote "$config/env")
set +a
exec $(quote "$node" "$repo/cli/nanoeval.ts") "\$@"
EOF
chmod 755 "$bin/nanoeval"

systemctl --user daemon-reload
systemctl --user enable nanoeval-sandboxd.service nanoeval-worker.service
systemctl --user restart nanoeval-sandboxd.service nanoeval-worker.service

for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$worker_port/health" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:$sandbox_port/health" >/dev/null 2>&1; then
    printf 'nanoeval is running: the Worker on 127.0.0.1:%s, sandboxd on 127.0.0.1:%s\n' "$worker_port" "$sandbox_port"
    printf 'command %s, jobs under %s, blobs under %s, tokens in %s\n' "$bin/nanoeval" "$runs" "$store" "$config/env"
    exit 0
  fi
  sleep 0.5
done
die 'the services did not answer: see journalctl --user -u nanoeval-worker -u nanoeval-sandboxd'
