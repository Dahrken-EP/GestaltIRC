#!/usr/bin/env bash
# Builds what the microVM boots from, into deploy/firecracker/out/:
#   rootfs.ext4  the bouncer and web client from the Dockerfile, with vminit as its init. Read-only when booted.
#   data.ext4    the database and secret key. Made once, never replaced, so a rebuilt rootfs keeps your accounts.
#   vmlinux      a kernel, downloaded unless you have one (KERNEL=/path).
#
#   deploy/firecracker/build.sh          needs Docker, e2fsprogs (mkfs.ext4 -d), curl and tar. No root.
#   DATA_SIZE=10G deploy/firecracker/build.sh      a bigger data disk, the first time only
#   NO_IMAGE_BUILD=1 GESTALT_IMAGE=name deploy/firecracker/build.sh      an image you already have, built or pulled
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need docker; need mkfs.ext4; need curl; need tar

mkdir -p "$out"
work=$(mktemp -d)
cleanup() { docker rm -f "gestalt-rootfs-$$" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

if [ -z "${NO_IMAGE_BUILD:-}" ]; then
  echo "build: the image ($image)"
  docker build -q -t "$image" "$root" >/dev/null
else
  echo "build: using the image $image as it is"
fi

echo "build: vminit"
docker run --rm -v "$root/server":/src:ro -v "$work":/out -w /src -e CGO_ENABLED=0 -e GOFLAGS=-mod=readonly golang:1.27-alpine \
  go build -trimpath -ldflags="-s -w" -o /out/vminit ./cmd/vminit

echo "build: rootfs.ext4"
mkdir "$work/root"
docker create --name "gestalt-rootfs-$$" "$image" >/dev/null
docker export "gestalt-rootfs-$$" | tar -x -C "$work/root" --no-same-owner
mkdir -p "$work/root"/{proc,sys,dev,run,tmp,data,sbin}
chmod 1777 "$work/root/tmp"
# vminit lays the resolver's file over this one at boot, because the disk is read-only.
: > "$work/root/etc/resolv.conf"
install -m 0755 "$work/vminit" "$work/root/sbin/init"
mb=$(( $(du -sm "$work/root" | cut -f1) + 32 ))
rm -f "$out/rootfs.ext4"
truncate -s "${mb}M" "$out/rootfs.ext4"
mkfs.ext4 -q -F -L gestalt-root -d "$work/root" "$out/rootfs.ext4"

if [ ! -e "$out/data.ext4" ]; then
  echo "build: data.ext4 (${DATA_SIZE:-2G}, kept when the image is rebuilt)"
  truncate -s "${DATA_SIZE:-2G}" "$out/data.ext4"
  # The bouncer runs as 65532 inside the machine, so that user owns the disk's top directory.
  mkfs.ext4 -q -F -L gestalt-data -E root_owner=65532:65532 "$out/data.ext4"
fi

if [ ! -e "$kernel" ]; then
  echo "build: kernel from $kernel_url"
  curl -fL --progress-bar -o "$kernel.part" "$kernel_url"
  mv "$kernel.part" "$kernel"
fi
echo "build: done. Next: sudo deploy/firecracker/run.sh"
