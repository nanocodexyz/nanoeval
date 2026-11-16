#!/usr/bin/env bash
# What an instance allows that a slot backend needs, as one JSON line, then a verdict.
# Read-only apart from a scratch directory it removes. Exit 0 when ns slots can run.
set -u
scratch=$(mktemp -d)
trap 'umount -l "$scratch/m" "$scratch/o" 2>/dev/null; [ -n "${loop:-}" ] && losetup -d "$loop" 2>/dev/null; rm -rf "$scratch"' EXIT
ok() { if "$@" >/dev/null 2>&1; then printf true; else printf false; fi; }
capeff=$(awk '/^CapEff/ {print $2}' /proc/self/status)
uid=$(id -u)
kvm=$([ -c /dev/kvm ] && printf true || printf false)
fusedev=$([ -c /dev/fuse ] && printf true || printf false)
overlay_fs=$(grep -qw overlay /proc/filesystems && printf true || printf false)
userns=$(ok unshare -U true)
userns_mount=$(ok unshare -Urm true)
mountns=$(ok unshare -m --propagation private true)
pidns=$(ok unshare -m -p -i -u --fork --kill-child true)
truncate -s 64M "$scratch/disk.ext4"; mke2fs -q -F -t ext4 -O ^has_journal "$scratch/disk.ext4" >/dev/null 2>&1
loop=$(losetup -f --show -r "$scratch/disk.ext4" 2>/dev/null || true)
loopdev=$([ -n "$loop" ] && printf true || printf false)
mkdir -p "$scratch/m" "$scratch/o" "$scratch/u/upper" "$scratch/u/work"
ext4mount=false; overlaymount=false
if [ -n "$loop" ] && mount -o ro "$loop" "$scratch/m" 2>/dev/null; then
  ext4mount=true
  if mount -t overlay overlay -o "lowerdir=$scratch/m,upperdir=$scratch/u/upper,workdir=$scratch/u/work" "$scratch/o" 2>/dev/null; then overlaymount=true; fi
fi
cgroup=$(grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null && printf true || printf false)
cgroup_write=false
if [ "$cgroup" = true ] && mkdir /sys/fs/cgroup/nanoeval-probe 2>/dev/null; then cgroup_write=true; rmdir /sys/fs/cgroup/nanoeval-probe; fi
nft_ok=$(ok nft list tables)
cpus=$(nproc); mem=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
disk=$(df -Pm "${NANOEVAL_HOME:-/}" 2>/dev/null | awk 'NR == 2 {print $4}')
printf '{"uid":%s,"capeff":"%s","kernel":"%s","cpus":%s,"memory_mb":%s,"free_disk_mb":%s,"kvm":%s,"fuse":%s,"overlayfs":%s,"userns":%s,"userns_mount":%s,"mountns":%s,"pidns":%s,"loop":%s,"ext4_mount":%s,"overlay_mount":%s,"cgroup_memory":%s,"cgroup_write":%s,"nft":%s}\n' \
  "$uid" "$capeff" "$(uname -r)" "$cpus" "$mem" "${disk:-0}" "$kvm" "$fusedev" "$overlay_fs" "$userns" "$userns_mount" "$mountns" "$pidns" "$loopdev" "$ext4mount" "$overlaymount" "$cgroup" "$cgroup_write" "$nft_ok"
if [ "$uid" = 0 ] && [ "$pidns" = true ] && [ "$overlaymount" = true ]; then
  echo "probe: ns slots can run here$([ "$cgroup_write" = true ] || echo ', without CPU and memory limits')$([ "$nft_ok" = true ] || echo ', on the host network only')"
  exit 0
fi
echo "probe: ns slots cannot run here: krun needs /dev/kvm ($kvm), ns needs root, namespaces, loop devices and overlayfs"
exit 1
