#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
ci-machine.sh

Give a machine that is thrown away after one job, a GitHub-hosted ubuntu-24.04 runner
or a box of the same kind, what krun and ns slots need and such a machine lacks:
/dev/kvm for every user through a udev rule, passt, musl-tools, e2fsprogs,
libkrunfw 5.5.0 from its release, checked against its SHA-256, and the Rust
toolchain that krun/ pins, which rustup installs at the first cargo call there:
it is made here, once, because tests that build the launcher at the same time
would each start that install. It asks sudo for what the machine lacks and needs
no other argument. On a machine that is kept, put the user in the kvm
group instead: the rule here opens KVM to everyone on it.
EOF
}

if [ $# -gt 0 ]; then
  usage
  [ "$1" = --help ] || [ "$1" = -h ] || exit 2
  exit 0
fi

version=5.5.0
case $(uname -m) in
  x86_64) sha256=c169206b01c89fbe134f1728bf4f988702bc7f73b4cf73e6fdece447d6fceca1 ;;
  *)
    printf 'ci-machine: no libkrunfw checksum for %s\n' "$(uname -m)" >&2
    exit 2
    ;;
esac

[ -c /dev/kvm ] || {
  printf 'ci-machine: this machine has no /dev/kvm\n' >&2
  exit 1
}
printf 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"\n' |
  sudo tee /etc/udev/rules.d/99-nanoeval-kvm.rules >/dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm
sudo udevadm settle

sudo env DEBIAN_FRONTEND=noninteractive apt-get update -q
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
  ca-certificates curl e2fsprogs musl-tools passt

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
file=libkrunfw-$(uname -m).tgz
curl -fsSL --retry 3 -o "$work/$file" \
  "https://github.com/containers/libkrunfw/releases/download/v$version/$file"
printf '%s  %s\n' "$sha256" "$work/$file" | sha256sum -c - >/dev/null
tar -xzf "$work/$file" -C "$work"
sudo install -m 755 "$work/lib64/libkrunfw.so.$version" /usr/local/lib/
sudo ln -sf "libkrunfw.so.$version" /usr/local/lib/libkrunfw.so.5
sudo ldconfig

[ -r /dev/kvm ] && [ -w /dev/kvm ] || {
  printf 'ci-machine: %s still cannot open /dev/kvm\n' "$(id -un)" >&2
  exit 1
}
PATH=$PATH:/usr/sbin:/sbin ldconfig -p | grep -q 'libkrunfw\.so\.5'
for tool in passt "$(uname -m)-linux-musl-gcc" mke2fs; do
  PATH=$PATH:/usr/sbin:/sbin command -v "$tool" >/dev/null || {
    printf 'ci-machine: %s is not installed\n' "$tool" >&2
    exit 1
  }
done
toolchain=$(cd "$(dirname "$0")/../krun" && cargo --version)
printf 'ci-machine: /dev/kvm, libkrunfw %s, %s, musl-gcc, mke2fs and %s are ready for %s\n' \
  "$version" "$(passt --version 2>&1 | head -n 1)" "$toolchain" "$(id -un)"
