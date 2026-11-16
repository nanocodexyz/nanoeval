#!/usr/bin/env bash
set -euo pipefail
aider=0.86.2
aider_sha256=64f6a0c66c9f4633ad9f479bca3e64ebcba02b9da03c6b604b74a44736b2416e
python=3.12.16
standalone=20261110
arch=${1:?usage: aider-release.sh <x86_64|aarch64> <out.tar.gz>}
out=$(realpath -m "${2:?usage: aider-release.sh <x86_64|aarch64> <out.tar.gz>}")
case $arch in
  x86_64) python_sha256=c2f87d4b4e8db3abddb0f116c6ccfc503d0cbdbb9ee8faacddad1b679ec12e99 ;;
  aarch64) python_sha256=4792f81750282597fb2a3389fe18b945ed2ba6aad5e45ad406d122c58cb33081 ;;
  *) echo "unknown arch: $arch" >&2; exit 2 ;;
esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL "https://github.com/astral-sh/python-build-standalone/releases/download/$standalone/cpython-$python+$standalone-$arch-unknown-linux-gnu-install_only.tar.gz" -o "$work/python.tar.gz"
echo "$python_sha256  $work/python.tar.gz" | sha256sum -c -
curl -fsSL "https://files.pythonhosted.org/packages/py3/a/aider-chat/aider_chat-$aider-py3-none-any.whl" -o "$work/aider_chat-$aider-py3-none-any.whl"
echo "$aider_sha256  $work/aider_chat-$aider-py3-none-any.whl" | sha256sum -c -
mkdir -p "$work/aider"
tar -xzf "$work/python.tar.gz" -C "$work/aider"
uv pip install --quiet --no-config --python-platform "$arch-manylinux_2_28" --python-version 3.12 --only-binary :all: --target "$work/aider/python/lib/python3.12/site-packages" "$work/aider_chat-$aider-py3-none-any.whl"
cat >"$work/aider/aider" <<'EOF'
#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
exec "$here/python/bin/python3.12" -I -m aider "$@"
EOF
chmod 755 "$work/aider/aider"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$work" -czf "$out" aider
sha256sum "$out"
