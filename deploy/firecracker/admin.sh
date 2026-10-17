#!/usr/bin/env bash
# Runs bouncer commands against the data disk while the machine is stopped, since the machine has no shell or login.
#
#   sudo deploy/firecracker/admin.sh user add alice            (the password is read from standard input)
#   sudo deploy/firecracker/admin.sh network add alice libera --host irc.libera.chat --port 6697 --tls --nick alice
#   sudo deploy/firecracker/admin.sh config                    edit bouncer.yaml on the data disk
#
# It mounts data.ext4, runs the same image the machine runs, and unmounts. Any bouncer command works
# (`bouncer help` lists them). Stop the machine first: the database must not be opened twice.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need docker
[ "$(id -u)" = 0 ] || { echo "run as root: it mounts the data disk" >&2; exit 1; }
[ -e "$out/data.ext4" ] || { echo "$out/data.ext4 is missing: run build.sh first" >&2; exit 1; }
if [ -e "$out/vm.pid" ] && kill -0 "$(cat "$out/vm.pid")" 2>/dev/null; then
  echo "the machine is running; stop it first (Ctrl+C in run.sh, or systemctl stop gestalt-vm)" >&2
  exit 1
fi
[ $# -gt 0 ] || { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

mnt=$(mktemp -d)
trap 'umount "$mnt" 2>/dev/null; rmdir "$mnt"' EXIT
mount -o loop "$out/data.ext4" "$mnt"

if [ "$1" = config ]; then
  [ -e "$mnt/bouncer.yaml" ] || { cp "$root/deploy/bouncer.default.yaml" "$mnt/bouncer.yaml"; chown 65532:65532 "$mnt/bouncer.yaml"; }
  "${EDITOR:-vi}" "$mnt/bouncer.yaml"
  exit 0
fi

cfg=/etc/gestalt/bouncer.yaml
[ ! -e "$mnt/bouncer.yaml" ] || cfg=/data/bouncer.yaml
run() { docker run --rm -i --user 65532:65532 -v "$mnt":/data -e GESTALT_CONFIG="$cfg" "$image" "$@"; }
# A new data disk has no secret key yet; the machine makes one when it first starts, and so does this.
[ -e "$mnt/secret.key" ] || run init </dev/null >/dev/null
run "$@"
