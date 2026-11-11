#!/usr/bin/env bash
set -euo pipefail

slot=$(dirname "$(readlink -f "$0")")/slot.sh

die() {
  printf 'nanoeval-convert: %s\n' "$*" >&2
  exit 2
}

command=${1:-}
[ -n "$command" ] || die 'usage: temporary-docker-convert.sh <tools|build|pack|unpack> ...'
shift
case $command in
  tools)
    bash "$slot" tools
    ;;
  build)
    kind=$1 source=$2 storage=$3 out=$4 meta=$5
    added='' container=''
    trap 'if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi; if [ -n "$added" ]; then docker rmi "$added" >/dev/null 2>&1 || true; fi' EXIT
    case $kind in
      ref)
        image=$source
        if ! docker image inspect "$image" >/dev/null 2>&1; then
          docker pull -q "$image" >&2
          added=$image
        fi
        ;;
      dockerfile)
        [ -f "$source/Dockerfile" ] || die "the environment has no Dockerfile: $source"
        hash=$(tar -C "$source" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | sha256sum | cut -c1-24)
        image=nanoeval-convert:$hash
        if ! docker image inspect "$image" >/dev/null 2>&1; then
          docker build -q --force-rm --label nanoeval=convert -t "$image" "$source" >&2
          added=$image
        fi
        ;;
      *) die "build takes ref or dockerfile: $kind" ;;
    esac
    container=$(docker create --label nanoeval=convert "$image")
    docker export "$container" | bash "$slot" disk "$storage" "$out"
    docker image inspect -f '{"architecture":{{json .Architecture}},"config":{{json .Config}},"digest":{{json .Id}}}' "$image" >"$meta"
    ;;
  pack)
    disk=$1 file=$2
    tar -C "$(dirname "$disk")" --sparse --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=0444 --transform 's|.*|disk.ext4|' -cf - "$(basename "$disk")" | zstd -q -T0 -3 -o "$file" -f
    ;;
  unpack)
    file=$1 disk=$2
    if [ -f "$disk" ]; then exit 0; fi
    tmp=$(mktemp -d "$disk.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    zstd -q -d -c "$file" | tar -C "$tmp" --sparse -xf -
    chmod a-w "$tmp/disk.ext4"
    mv "$tmp/disk.ext4" "$disk"
    ;;
  *) die "unknown command: $command" ;;
esac
