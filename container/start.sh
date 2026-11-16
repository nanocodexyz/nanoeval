#!/usr/bin/env bash
# Entry of the runner image. The Worker that starts the instance passes, as its env:
#   NANOEVAL_URL, NANOEVAL_TOKEN  the deployment the runner enrols in (never baked into the image)
#   NANOEVAL_SLOTS                rows at once, default: what the runner derives from the instance
#   NANOEVAL_NETWORK              host (default) or private (needs nft, which an instance may refuse)
#   NANOEVAL_LOCATION             the pool's region hint, optional
#   NANOEVAL_PROBE=1              print what the instance allows and exit, without enrolling
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
if [ "${NANOEVAL_PROBE:-}" = 1 ]; then exec bash "$here/probe.sh"; fi
: "${NANOEVAL_URL:?the instance needs NANOEVAL_URL}" "${NANOEVAL_TOKEN:?the instance needs NANOEVAL_TOKEN}"
bash "$here/probe.sh" >&2 || true
args=(runner --standing --url "$NANOEVAL_URL" --token "$NANOEVAL_TOKEN" --backend ns --network "${NANOEVAL_NETWORK:-host}"
  --home "$NANOEVAL_HOME/home" --cache "$NANOEVAL_HOME/cache" --store "$NANOEVAL_HOME/store"
  --free-disk-mb "${NANOEVAL_FREE_DISK_MB:-2048}")
if [ -n "${NANOEVAL_SLOTS:-}" ]; then args+=(--slots "$NANOEVAL_SLOTS"); fi
if [ -n "${NANOEVAL_LOCATION:-}" ]; then args+=(--location "$NANOEVAL_LOCATION"); fi
mkdir -p "$NANOEVAL_HOME"
exec node /opt/nanoeval/cli/nanoeval.ts "${args[@]}"
