# Running Gestalt on a server

One server runs the bouncer with the web client, Caddy for HTTPS, and coturn so that direct chat, file transfer
and voice work across NATs. It is all in the `docker-compose.yml` at the root of the repository.

```
browser ──HTTPS──▶ Caddy ──▶ bouncer ──▶ IRC networks
   │
   └──UDP/TCP────────────────▶ coturn   (only when two browsers cannot reach each other directly)
```

## Set up

You need a server with Docker and a name pointing at it (`DOMAIN`). From the repository root:

```bash
cp .env.example .env        # set DOMAIN; set PUBLIC_IP if the server is behind NAT; set ADMIN_EMAIL
docker compose up -d
echo 'a-long-password' | docker compose exec -T bouncer bouncer user add alice
```

Then open `https://DOMAIN`, log in, and press **Add a server** (later, the **+** in the bar on the left). Or from the command line:

```bash
docker compose exec bouncer bouncer network add alice libera --host irc.libera.chat --port 6697 --tls --nick alice --join '#chat'
```

`DOMAIN=localhost` works for trying the stack on your own machine; your browser will warn about the certificate.
`PUBLIC_IP` matters for voice and file transfer: most cloud servers sit behind NAT and do not know their own
public address, so coturn must be told it. The provider's dashboard shows it.

The first `up` starts a one-off `setup` container that writes `bouncer.yaml`, `turnserver.conf` and a fresh TURN
secret (shared by the bouncer and coturn) into the `config` volume. It never overwrites a file that is already
there, so editing the copy in the volume is safe and starting again changes nothing.

`docker compose ps -a` lists `setup` as *Exited (0)*, which is expected. To remove the stopped container (the
configuration is in the volume and stays), run `docker compose rm -f setup`; the next `up` runs the job again and
leaves another, so this is housekeeping, not a required step. (`--remove-orphans` does not help: `setup` is part of
the compose file, so it is not an orphan.)

It is a separate container for two reasons. The bouncer image is distroless, with no shell to run the script in.
And only this job needs to write the configuration, so the bouncer and coturn mount it read-only: a compromised
bouncer cannot rewrite its own settings or the TURN secret it shares with coturn.

## Behind Traefik

If Traefik already terminates HTTPS on the server, leave Caddy out and let Traefik find the bouncer through labels:

```bash
cp .env.example .env     # DOMAIN=gestalt.example.org, PUBLIC_IP if behind NAT, and the TRAEFIK_* names below
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d
echo 'a-long-password' | docker compose -f docker-compose.yml -f docker-compose.traefik.yml exec -T bouncer bouncer user add alice
```

`docker-compose.traefik.yml` joins the bouncer to the Docker network Traefik watches and gives it a router for
`Host(DOMAIN)`. Nothing is published on the host for the bouncer. Three names must match your Traefik, set in `.env`:

| Variable | Is | Default |
|---|---|---|
| `TRAEFIK_NETWORK` | the Docker network Traefik watches (`docker network ls`; it must already exist) | `traefik` |
| `TRAEFIK_ENTRYPOINT` | its HTTPS entrypoint | `websecure` |
| `TRAEFIK_HTTP_ENTRYPOINT` | its plain HTTP entrypoint, where a redirect to HTTPS is set up so that typing the bare name works | `web` |
| `TRAEFIK_CERTRESOLVER` | the certificate resolver that gets the certificate; set it empty (`TRAEFIK_CERTRESOLVER=`) if a wildcard or default certificate already covers the name | `letsencrypt` |

Things that matter with Traefik:

- **WebSockets** work without any setting.
- **Do not attach a security-headers middleware** to this router. The bouncer sets its own, and they differ by page (only
  the plugin sandbox page may be framed). A middleware that adds `frameDeny` or a content security policy silently
  stops plugins from running.
- **Client addresses.** Traefik sets `X-Forwarded-Proto` and `X-Forwarded-For` itself, and on an entrypoint without
  `forwardedHeaders.trustedIPs` it replaces whatever a client sent, which is what the bouncer needs (it counts failed
  logins per address). Tested: forged `X-Forwarded-For` headers did not get around the login limit. If Traefik sits behind
  another proxy or a CDN, add that proxy's addresses to `trustedIPs` and expect the bouncer to see the CDN's address
  unless you also make the CDN the last hop it trusts.
- **If Traefik does not use the Docker provider** (a file provider, or Traefik running on the host), use
  `docker-compose.proxy.yml` instead, which publishes the bouncer on `127.0.0.1:8081`, and point a router at it:

  ```yaml
  http:
    routers:
      gestalt: { rule: "Host(`gestalt.example.org`)", entryPoints: [websecure], service: gestalt, tls: { certResolver: letsencrypt } }
    services:
      gestalt: { loadBalancer: { servers: [{ url: "http://127.0.0.1:8081" }] } }
  ```

  (If Traefik itself runs in a container, `127.0.0.1` is that container; use the host's address, publish the bouncer
  with `BOUNCER_BIND=0.0.0.0`, and firewall port 8081 to the Traefik machine.)

Voice and direct chat still need coturn reachable on its own ports (see below), directly and not through Traefik.

## Behind a proxy you already have

If the server already has a reverse proxy handling HTTPS on 80 and 443, Caddy would fight it for those ports. Leave
Caddy out and let your proxy forward to the bouncer:

```bash
cp .env.example .env     # DOMAIN=gestalt.example.org, PUBLIC_IP if behind NAT, BOUNCER_PORT if 8081 is taken
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d
```

The bouncer is then published on `127.0.0.1:8081` only. Your proxy must terminate TLS for `DOMAIN`, forward
WebSockets, and tell the bouncer the truth about the request, because the bouncer decides from these headers
whether the connection was HTTPS and who the client is (`trust_proxy` is on in this setup):

- `X-Forwarded-Proto: https`, or the session cookie is not marked `Secure` and HSTS is not sent;
- `X-Forwarded-For` with the real client address as its **last** entry (appending, as nginx's
  `$proxy_add_x_forwarded_for` does, is right; passing along one from the client unchecked is wrong, since it lets
  anyone dodge the login rate limit);
- no security headers of your own on this site (see below).

nginx:

```nginx
server {
    listen 443 ssl;
    server_name gestalt.example.org;
    # ssl_certificate / ssl_certificate_key as for your other sites

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;   # map $http_upgrade $connection_upgrade { default upgrade; '' close; }
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1d;                              # the WebSocket stays open
    }
}
```

Caddy: `gestalt.example.org { reverse_proxy 127.0.0.1:8081 }` (it handles the headers and WebSockets itself).

If your proxy only passes raw TLS through by name (SNI) rather than terminating it, tell the bouncer's own Caddy to
take that traffic instead: use the normal compose file, and change Caddy's published ports to ones your proxy
forwards to.

Voice and direct chat across NATs still need coturn reachable on its own ports (below), directly, not through the
proxy. The name in `DOMAIN` (or `TURN_HOST`) must point at the server's real address, not at a CDN.

Before starting, check nothing else is using the ports coturn wants:

```bash
sudo ss -lntup | grep -E ':(3478|5349|8081)\b' || echo "free"
```

## Ports

| Port | Used by | For |
|---|---|---|
| 80/tcp | Caddy | the certificate challenge, and the redirect to HTTPS |
| 443/tcp, 443/udp | Caddy | the web client (udp is HTTP/3) |
| 3478/udp, 3478/tcp | coturn | STUN and TURN |
| 49152-49252/udp | coturn | the relay range for media that cannot go direct |
| 5349/tcp | coturn | TURN over TLS, only once you give it a certificate (see below) |

Only these should be reachable from outside. The bouncer listens on a Docker-internal port that Caddy reaches; do
not publish it. coturn is on the host network (a relay needs a range of UDP ports and its real address), so a host
firewall (ufw, nftables, a cloud security group) is what limits it.

## What is in here

| File | Purpose |
|---|---|
| `../Dockerfile` | Builds the web client and a static bouncer into one small image with no operating system in it. Also runs on its own: see the README. |
| `../docker-compose.yml` | `setup` (one-off), the bouncer (not published), Caddy, and coturn on the host network. |
| `../docker-compose.proxy.yml` | An override that leaves Caddy out and publishes the bouncer on 127.0.0.1 for a proxy you already have. |
| `../docker-compose.traefik.yml` | An override that leaves Caddy out and gives the bouncer Traefik labels instead. |
| `../.env.example` | `DOMAIN`, `PUBLIC_IP`, `TURN_HOST`, `ADMIN_EMAIL`. |
| `Caddyfile` | HTTPS and the proxy to the bouncer. WebSockets just work. The bouncer sets the security headers. |
| `bouncer.yaml.template` | Production settings: trusts Caddy for client addresses, `Secure` cookies, `sts`, and the TURN servers. |
| `turnserver.conf.template` | coturn with expiring credentials, relaying to private addresses refused, and limited ports and quotas. |
| `bouncer.default.yaml` | The settings inside the image when it runs on its own. |
| `init-config.sh` | What the `setup` container runs. |

## Things to know

- **TLS for `turns:`.** Left off, because without a certificate it cannot work. To offer TURN over TLS (which gets
  through firewalls that only allow HTTPS-like traffic), put a certificate for `TURN_HOST` in the config volume as
  `tls.crt` and `tls.key`, readable by coturn, uncomment `tls-listening-port`, `cert` and `pkey` in
  `turnserver.conf`, and uncomment the `turns:` line in `bouncer.yaml`.
- **Who can read the TURN secret.** `turnserver.conf` and `turn_secret` in the config volume are readable by every
  user inside the containers, because coturn and the bouncer run unprivileged and I could not test which user each
  needs. On the host, only root and members of the `docker` group can read the volume. Anyone who can read the
  secret can mint TURN credentials and use your server as a relay.
- **Credential lifetime.** `turn_ttl` defaults to a day. A call or transfer relayed through coturn ends when the
  credential it started with expires, because an allocation cannot be refreshed with an expired one. Direct
  connections are not affected.
- **Strict transport security.** `sts_duration` starts at one day. Raise it once you are sure HTTPS works everywhere
  you use it, since a client that has seen it will refuse plain text for that long.
- **Do not change the security headers in front of the bouncer.** The bouncer sends them, and they differ by page:
  the plugin sandbox page (`/plugin-sandbox.html`) must be allowed to be framed by the site itself and everything
  else must not. A proxy rule that adds `X-Frame-Options: DENY` to every page silently stops plugins from running.
- **Private addresses.** The web editor refuses servers on private addresses unless `allow_private_networks: true`
  is set in `bouncer.yaml` in the config volume. A TURN server relays to whatever address a client names, which is
  why coturn is configured to refuse every private range.
- **Updating.** `git pull`, then `docker compose up -d --build`. Existing config and data are kept.
- **Tuning.** `history_limit`, `replay_limit`, `command_burst`, `command_rate`, `turn_ttl` and `sts_duration` are in
  `bouncer.yaml`; `server/bouncer.example.yaml` documents each.

To edit the config in the volume:

```bash
docker compose run --rm --no-deps --entrypoint sh setup -c 'vi /config/bouncer.yaml'
docker compose restart bouncer
```

## Size

Measured with `test/load/run.sh` on a 4-core machine: an idle bouncer with one user is about 19 MB, and 50 users
with two networks and 20 channels each, every one with a client attached, about 60 MB. History is kept in SQLite on
disk, about 0.5 KB a message.

## Backing up and restoring

State is the `data` volume: `bouncer.db` (history, accounts, sessions) and `secret.key` (which protects the stored
network passwords and the push key). Back them up together, and keep the backup as private as the server: with both
files, someone can read every stored network password. The `config` volume holds the TURN secret and can be made
again, but then coturn and the bouncer must both be given the new secret.

```bash
docker compose stop bouncer
docker run --rm -v gestalt_data:/data -v "$PWD":/backup alpine tar czf /backup/gestalt-data-$(date +%F).tgz -C /data .
docker compose start bouncer
```

(The volume is named after the directory the compose file is in; `docker volume ls` shows it.) To restore, stop the
bouncer, empty the volume, unpack the archive into it as user 65532, and start it. Stopping first matters: the
database runs in WAL mode, and copying it while it is being written can produce a file that does not open.

## Logs and watching it

`docker compose logs -f bouncer` shows networks starting, reconnecting and failing. A client dropped for flooding
and logins refused for too many failures show in the client's own window and in Caddy's logs. Nothing is sent
anywhere. The bouncer container has a health check (`bouncer healthcheck`), which Caddy waits for; for uptime
monitoring, point any HTTP checker at `https://DOMAIN/`.

## What has and has not been tested

Run in a real Docker daemon: the image builds; `docker run` on its own creates its data on first start, takes the
first user and network from `docker exec`, passes its health check, serves the client with the security headers,
logs in, and keeps its data across a restart. The full compose stack comes up (`setup`, bouncer healthy, Caddy,
coturn); over `https://localhost` it serves the client, redirects http to https, sends HSTS (so the bouncer sees
the proxy's `X-Forwarded-Proto`), frames the plugin sandbox page by this site only, logs in, hands out TURN
credentials, and coturn answers a STUN request on 3478 (udp and tcp).

The proxy override was also run: no Caddy, the bouncer published on 127.0.0.1 only, HSTS and a `Secure` cookie
only when the request carries `X-Forwarded-Proto: https`. The nginx snippet above was not run.

The Traefik override was run against a real Traefik v3 (Docker provider, default self-signed certificate): the router
found the bouncer, HTTPS served the client, a WebSocket upgrade returned 101, the session cookie was `Secure`, HSTS was
sent, forged `X-Forwarded-For` headers did not get around the login limit, and another host name got Traefik's 404, and plain `http://` was redirected to `https://`. Not
run: a certificate resolver getting a real certificate, Traefik v2, the file provider, and Traefik behind a CDN.

**Not tested:** a real domain with a real certificate, Caddy renewing it, coturn relaying media between two real
browsers behind real NATs (the browser tests use loopback), TURN over TLS, the `PUBLIC_IP` path, and an upgrade
from an earlier layout of this directory (the old `setup.sh` and `deploy/docker-compose.yml` are gone).
