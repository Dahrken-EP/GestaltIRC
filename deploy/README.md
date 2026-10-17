# Deploying

One server runs the bouncer with the web client, Caddy for HTTPS, and coturn so that
direct chat, file transfer and voice work across NATs.

```
browser ──HTTPS──▶ Caddy ──▶ bouncer ──▶ IRC networks
   │                                 
   └──UDP/TCP───────────────▶ coturn   (only when two browsers cannot reach each other directly)
```

## Set up

You need a server with Docker, and two names pointing at it (they can be the same):
`DOMAIN` for the web client and `TURN_HOST` for coturn.

```bash
cd deploy
DOMAIN=irc.example.org ADMIN_EMAIL=you@example.org PUBLIC_IP=203.0.113.9 ./setup.sh
docker compose up -d
docker compose run --rm bouncer init
echo 'a-long-password' | docker compose run --rm -T bouncer user add alice
docker compose run --rm bouncer network add alice libera --host irc.libera.chat --tls --nick alice --join '#chat'
```

`setup.sh` makes a fresh secret, shared between the bouncer and coturn, and writes
`.env`, `bouncer.yaml`, `turnserver.conf` and `secrets/turn_secret`. It refuses to
overwrite them. `PUBLIC_IP` is the server's public address and is needed when it sits
behind NAT, as most cloud servers do. Keep this directory private: `turnserver.conf` and
`secrets/` hold the shared secret.

Open these ports: 80 and 443 (tcp, and 443 udp), 3478 (udp and tcp), 5349 (tcp), and udp
49152 to 49252 for relayed media.

## What is in here

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the web client and a static bouncer into one image. |
| `docker-compose.yml` | The bouncer (not published), Caddy, and coturn on the host network. |
| `Caddyfile` | HTTPS and the proxy to the bouncer. WebSockets just work. The bouncer sets the security headers. |
| `bouncer.yaml.template` | Production settings: trusts Caddy for client addresses, `Secure` cookies, `sts`, and the TURN servers. |
| `turnserver.conf.template` | coturn with expiring credentials, relaying to private addresses refused, and limited ports and quotas. |
| `setup.sh` | Fills in the templates. |

## Things to know

- **TLS for `turns:`.** The template leaves the `cert` and `pkey` lines in `turnserver.conf`
  commented. To offer TURN over TLS (which gets through firewalls that only allow 443-like
  traffic), point them at a certificate for `TURN_HOST`, for example one copied from Caddy's
  volume, and uncomment them, then uncomment the `turns:` line in `bouncer.yaml` too. It ships
  commented out because without a certificate it cannot work.
- **Who can read the TURN secret.** `turnserver.conf` holds the shared secret and `setup.sh`
  leaves it readable by every local user, because the coturn container runs unprivileged and I
  could not test which user it needs. Anyone who can read it can mint TURN credentials and use
  your server as a relay. Run this on a machine you control alone, or narrow the modes
  (`chmod 640`, a group the container shares) after trying it.
- **Credential lifetime.** `turn_ttl` defaults to a day. A call or transfer that is relayed
  through coturn ends when the credential it started with expires, because an allocation cannot
  be refreshed with an expired one. Direct connections are not affected.
- **Back up the `data` volume.** `secret.key` and `bouncer.db` must stay together. Losing the
  key makes every stored network password unreadable, and it also protects the push key.
- **Strict transport security.** `sts_duration` starts at one day. Raise it once you are sure
  HTTPS works everywhere you use it, since a client that has seen it will refuse plain-text for that long.
- **Updating.** `git pull`, then `docker compose up -d --build`.
- **Why coturn refuses private addresses.** A TURN server relays to whatever address a client
  names. Without `denied-peer-ip`, anyone with a credential could use it to reach machines on
  the server's own network.

## Before you rely on it

- **Firewall.** Only the ports above should be reachable from outside. The bouncer listens on a
  Docker-internal port that Caddy reaches; do not publish it. coturn is on the host network, so a
  host firewall (ufw, nftables, a cloud security group) is what limits it.
- **Do not change the security headers in front of the bouncer.** The bouncer sends them, and they differ
  by page: the plugin sandbox page (`/plugin-sandbox.html`) must be allowed to be framed by the
  site itself and everything else must not. A proxy rule that adds `X-Frame-Options: DENY` to every
  page, as the first version of this `Caddyfile` did, silently stops plugins from running.
- **First login.** Make the first user, log in, and open Settings. Check that the page is served over
  HTTPS with a padlock, that a plugin can be installed (try "Use the example"), and that two browsers
  can start a direct chat (this needs coturn only across strict NATs).
- **Limits you can tune** in `bouncer.yaml`: `history_limit`, `replay_limit`, `command_burst` and
  `command_rate` (how fast a client may send), `turn_ttl`, `sts_duration`, and `allow_private_networks` (whether
  the web editor may add servers on private addresses; off by default). See `server/bouncer.example.yaml`.
- **Size.** Measured with `test/load/run.sh` on a 4-core machine: an idle bouncer with one user is about
  19 MB, and 50 users with two networks and 20 channels each, every one with a client attached, about 60 MB
  (the budget in DESIGN.md is 25 MB and 300 MB). History is kept in SQLite on disk, about 0.5 KB a message.

## Backing up and restoring

State is the `data` volume: `bouncer.db` (history, accounts, sessions) and `secret.key` (which protects
the stored network passwords and the push key). Back them up together, and keep the backup as private as
the server: with both files, someone can read every stored network password.

```bash
docker compose stop bouncer
docker run --rm -v "$(docker compose ps -q bouncer | xargs docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')":/data -v "$PWD":/backup alpine \
  tar czf /backup/bouncer-data-$(date +%F).tgz -C /data .
docker compose start bouncer
```

To restore, stop the bouncer, empty the volume, unpack the archive into it as user 65532, and start it.
Stopping first matters: the database runs in WAL mode, and copying it while it is being written can
produce a file that does not open. Also keep `.env`, `bouncer.yaml` and `secrets/turn_secret`; they can be
made again with `setup.sh`, but then the TURN secret changes and `turnserver.conf` must be regenerated with it.

## Logs and watching it

`docker compose logs -f bouncer` shows networks starting, reconnecting and failing, and a warning if the
config file is readable by others while holding a TURN secret. A client that is dropped for flooding, and
logins refused for too many failures, are visible in the client's own window and in the logs of Caddy.
Nothing is sent anywhere. For uptime, point any HTTP checker at `https://DOMAIN/`; it answers 200 while the
bouncer is up.

## What has and has not been tested

`docker compose config` accepts `docker-compose.yml`. `setup.sh` was run, and the bouncer loads
the `bouncer.yaml` it writes (and rejects a broken one). The static build and the web build
that the `Dockerfile` runs were run outside Docker. The image itself, coturn, and Caddy were
not run, because the environment this was written in has no Docker daemon, so expect to read
the first `docker compose up` output carefully.
