# Gestalt in a Firecracker microVM

The same bouncer and web client as the Docker image, run as a [Firecracker](https://firecracker-microvm.github.io/)
microVM: its own kernel, a read-only root disk, one data disk, and one network link to the host. It is for people who
want the isolation of a virtual machine instead of a container, with nothing else running inside it.

```
browser ──HTTPS──▶ reverse proxy on the host ──▶ 172.16.0.2:8080 (microVM: vminit ▶ bouncer) ──▶ IRC networks
                                                  host 172.16.0.1 on a private tap link, NAT out
```

**Status.** The scripts and `vminit` are written to Firecracker's documented behaviour, and everything that can be tried
without `/dev/kvm` was: the image builds, the root disk checks clean and holds the bouncer, the web client and `vminit`,
`admin.sh` makes accounts on the data disk, and `vminit` runs through its mounts and network setup in a namespace. **The
boot itself has not been run**, because the machine this was written on has no KVM. Expect to fix a detail or two on the
first boot, and tell us what it was.

## What you need

- A Linux host with `/dev/kvm` (on a cloud server, one that allows nested virtualisation), x86_64 (aarch64 needs
  `KERNEL_URL` or `KERNEL` pointing at an arm64 kernel).
- The `firecracker` binary from its [releases page](https://github.com/firecracker-microvm/firecracker/releases) on your `PATH`.
- Docker, `mkfs.ext4` from e2fsprogs 1.43 or later, `curl`, `iptables` and `ip`. Docker is used to build and to run
  `admin.sh`, not to run Gestalt.

## Set up

```bash
git clone https://github.com/Dahrken-EP/GestaltIRC.git && cd GestaltIRC
deploy/firecracker/build.sh                     # image, root disk, data disk, kernel: deploy/firecracker/out/
echo 'a-long-password' | sudo deploy/firecracker/admin.sh user add alice
sudo deploy/firecracker/run.sh                  # Ctrl+C shuts it down cleanly
```

The bouncer is then at `http://172.16.0.2:8080`, reachable from the host only. For people to use it, put a reverse
proxy on the host that forwards to that address, with HTTPS and WebSocket support. With Caddy:

```
irc.example.org {
    reverse_proxy 172.16.0.2:8080
}
```

and tell the bouncer to trust the proxy and mark cookies secure: `sudo deploy/firecracker/admin.sh config` opens
`bouncer.yaml` on the data disk (the machine must be stopped), and you add

```yaml
trust_proxy: true
cookie_secure: always
```

`docs/SERVER.md` lists every setting. To start at boot, use `gestalt-vm.service` (instructions in the file).

## What each piece does

| File | What it is |
|---|---|
| `build.sh` | Builds the root disk from the repository's `Dockerfile` image, with `vminit` as `/sbin/init`; makes the data disk once; fetches a kernel. `NO_IMAGE_BUILD=1 GESTALT_IMAGE=name` uses an image you already have. |
| `run.sh` | Needs root. Makes the tap device and a NAT rule, starts Firecracker, and undoes both when it stops. `CPUS`, `MEM_MIB`, `VM_IP`, `HOST_IP`, `SUBNET`, `DNS`, `UPLINK` change the defaults (2 CPUs, 512 MiB). |
| `admin.sh` | Runs bouncer commands (`user add`, `network add`, `config`, any other) against the data disk while the machine is stopped. The machine has no shell and no login on purpose. |
| `../../server/cmd/vminit` | The first program in the machine: mounts what Linux needs, writes the resolver file, brings the network up, mounts the data disk, runs the bouncer as an unprivileged user, and shuts the machine down when it stops. |

## Why it is built this way

- **The root disk is read-only** and holds nothing but the image. Everything that changes lives on `data.ext4`, which
  `build.sh` never replaces. Update by pulling, running `build.sh` and starting again; accounts and history stay.
- **No shell, no SSH, no console login.** A compromised bouncer finds no tools. Administration happens with the machine
  stopped, from the host, with `admin.sh`.
- **The bouncer runs as user 65532**, as in the Docker image, not as root inside the machine.
- **One network link, to the host only**, with outbound NAT so it can reach IRC networks. Nothing on your network can
  reach it except through the host, and the host decides what is forwarded.
- **A stop is a clean stop.** `run.sh` sends Firecracker's Ctrl+Alt+Del; `vminit` passes it to the bouncer as SIGTERM,
  waits up to 20 seconds for the database to close, syncs the disks, and restarts into Firecracker's exit.

## Voice and direct chat

The microVM carries only the bouncer. Voice and file transfer across NATs still need a TURN relay (coturn). Run it
from the Docker setup on the same host (`docker compose up -d setup coturn` in the repository root, with `PUBLIC_IP` set
in `.env`), copy the `turn_secret` from its config volume to the data disk (with the machine stopped), and list its address in `bouncer.yaml`:

```yaml
stun_uris: ["stun:irc.example.org:3478"]
turn_uris: ["turn:irc.example.org:3478?transport=udp"]
turn_secret_file: "/data/turn_secret"
turn_ttl: 86400
```

See [deploy/README.md](../README.md) for the coturn side and its firewall ports.

## Backups

With the machine stopped, copy `deploy/firecracker/out/data.ext4`: it holds the database and the secret key, which belong
together. The file is sparse, so `cp --sparse=always` keeps the copy small.

## If it does not boot

`run.sh` shows the machine's console. The lines to look for come from `vminit:`. A kernel panic about the root disk means
the kernel lacks ext4 or virtio-block (use the default kernel); `mount /dev/vdb ... failed` means `data.ext4` is
missing or not an ext4 file system; no network from the machine means the `ip=` boot argument was not applied, which needs a kernel built with
`CONFIG_IP_PNP` (Firecracker's own CI kernels are meant for this; a distribution kernel may not have it).
