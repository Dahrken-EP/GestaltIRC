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
| `Caddyfile` | HTTPS, security headers, and the proxy to the bouncer. WebSockets just work. |
| `bouncer.yaml.template` | Production settings: trusts Caddy for client addresses, `Secure` cookies, `sts`, and the TURN servers. |
| `turnserver.conf.template` | coturn with expiring credentials, relaying to private addresses refused, and limited ports and quotas. |
| `setup.sh` | Fills in the templates. |

## Things to know

- **TLS for `turns:`.** The template leaves the `cert` and `pkey` lines in `turnserver.conf`
  commented. To offer TURN over TLS (which gets through firewalls that only allow 443-like
  traffic), point them at a certificate for `TURN_HOST`, for example one copied from Caddy's
  volume, and uncomment them. Without it, the `turns:` address in `bouncer.yaml` will fail and
  browsers fall back to the others, so remove that line if you do not set it up.
- **Back up the `data` volume.** `secret.key` and `bouncer.db` must stay together. Losing the
  key makes every stored network password unreadable, and it also protects the push key.
- **Strict transport security.** `sts_duration` starts at one day. Raise it once you are sure
  HTTPS works everywhere you use it, since a client that has seen it will refuse plain-text for that long.
- **Updating.** `git pull`, then `docker compose up -d --build`.
- **Why coturn refuses private addresses.** A TURN server relays to whatever address a client
  names. Without `denied-peer-ip`, anyone with a credential could use it to reach machines on
  the server's own network.

## What has and has not been tested

`docker compose config` accepts `docker-compose.yml`. `setup.sh` was run, and the bouncer loads
the `bouncer.yaml` it writes (and rejects a broken one). The static build and the web build
that the `Dockerfile` runs were run outside Docker. The image itself, coturn, and Caddy were
not run, because the environment this was written in has no Docker daemon, so expect to read
the first `docker compose up` output carefully.
