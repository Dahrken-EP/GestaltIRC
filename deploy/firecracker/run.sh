#!/usr/bin/env bash
# Starts the Gestalt microVM and keeps it in the foreground, with its console on this terminal. Stop it with
# Ctrl+C (or systemctl stop): the machine is asked to shut down, and the bouncer closes its database first.
#
#   sudo deploy/firecracker/run.sh
#
# Needs root (a network tap, a NAT rule), /dev/kvm and the firecracker binary. The machine is at 172.16.0.2 and the
# host at 172.16.0.1 on a private link; the bouncer answers on http://172.16.0.2:8080 and nowhere else. Put your
# reverse proxy in front (see README.md), or run `ssh -L`/socat from the host if you only want to look at it.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need firecracker; need ip; need iptables; need curl
[ "$(id -u)" = 0 ] || { echo "run as root: it makes a network device and a firewall rule" >&2; exit 1; }
[ -e /dev/kvm ] || { echo "/dev/kvm is missing: Firecracker needs hardware virtualisation (on a cloud server, one that allows nested virtualisation)" >&2; exit 1; }
for f in rootfs.ext4 data.ext4; do [ -e "$out/$f" ] || { echo "$out/$f is missing: run build.sh first" >&2; exit 1; }; done
[ -e "$kernel" ] || { echo "no kernel at $kernel: run build.sh first" >&2; exit 1; }
[ ! -e "$out/vm.pid" ] || ! kill -0 "$(cat "$out/vm.pid")" 2>/dev/null || { echo "the machine is already running (pid $(cat "$out/vm.pid"))" >&2; exit 1; }

tap=${TAP:-gestalt0}
host_ip=${HOST_IP:-172.16.0.1}
vm_ip=${VM_IP:-172.16.0.2}
subnet=${SUBNET:-172.16.0.0/24}
dns=${DNS:-1.1.1.1,9.9.9.9}
uplink=${UPLINK:-$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p')}
sock="$out/firecracker.sock"
[ -n "$uplink" ] || { echo "no route to the internet found; set UPLINK=eth0" >&2; exit 1; }

old_forward=$(cat /proc/sys/net/ipv4/ip_forward)
rules=(
  "POSTROUTING -s $subnet ! -o $tap -j MASQUERADE"
  "FORWARD -i $tap -o $uplink -j ACCEPT"
  "FORWARD -i $uplink -o $tap -m state --state RELATED,ESTABLISHED -j ACCEPT"
)
cleanup() {
  trap - EXIT
  for r in "${rules[@]}"; do
    # shellcheck disable=SC2086
    case $r in POSTROUTING*) iptables -t nat -D $r 2>/dev/null ;; *) iptables -D $r 2>/dev/null ;; esac || true
  done
  ip link del "$tap" 2>/dev/null || true
  echo "$old_forward" > /proc/sys/net/ipv4/ip_forward
  rm -f "$sock" "$out/vm.pid" "$out/vm.json"
}
trap cleanup EXIT

ip link del "$tap" 2>/dev/null || true
ip tuntap add dev "$tap" mode tap
ip addr add "$host_ip/24" dev "$tap"
ip link set "$tap" up
echo 1 > /proc/sys/net/ipv4/ip_forward
for r in "${rules[@]}"; do
  # shellcheck disable=SC2086
  case $r in POSTROUTING*) iptables -t nat -A $r ;; *) iptables -A $r ;; esac
done

cat > "$out/vm.json" <<JSON
{
  "boot-source": {
    "kernel_image_path": "$kernel",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off 8250.nr_uarts=1 ip=$vm_ip::$host_ip:255.255.255.0::eth0:off gestalt.dns=$dns"
  },
  "drives": [
    { "drive_id": "rootfs", "path_on_host": "$out/rootfs.ext4", "is_root_device": true, "is_read_only": true },
    { "drive_id": "data", "path_on_host": "$out/data.ext4", "is_root_device": false, "is_read_only": false }
  ],
  "network-interfaces": [
    { "iface_id": "eth0", "guest_mac": "AA:FC:00:00:00:01", "host_dev_name": "$tap" }
  ],
  "machine-config": { "vcpu_count": ${CPUS:-2}, "mem_size_mib": ${MEM_MIB:-512} }
}
JSON

rm -f "$sock"
# Its own session, so a Ctrl+C reaches this script (which shuts the machine down properly) and not Firecracker.
setsid firecracker --api-sock "$sock" --config-file "$out/vm.json" </dev/null &
fc=$!
echo "$fc" > "$out/vm.pid"
echo "run: the bouncer will answer on http://$vm_ip:8080 (Ctrl+C to stop)"

stop() {
  echo "run: asking the machine to shut down"
  curl -s --unix-socket "$sock" -X PUT http://localhost/actions -H 'Content-Type: application/json' -d '{"action_type":"SendCtrlAltDel"}' >/dev/null || true
  for _ in $(seq 40); do kill -0 "$fc" 2>/dev/null || return 0; sleep 1; done
  echo "run: it did not stop in 40 seconds; ending it" >&2
  kill "$fc" 2>/dev/null || true
}
trap stop INT TERM
# wait is cut short by the trap; wait again until Firecracker has really gone.
while kill -0 "$fc" 2>/dev/null; do wait "$fc" 2>/dev/null || true; done
