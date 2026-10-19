# Running the bouncer

This is for the person who runs the server. For a ready-made setup with HTTPS and a TURN relay, see
[deploy/README.md](../deploy/README.md). Everything below is set in `bouncer.yaml`; `server/bouncer.example.yaml`
lists every option with its default.

## Accounts and networks

Accounts are made with the command line (`bouncer user add`). People then add and edit their own servers with the **+**
in the server bar and the menu on each server, or you add them with `bouncer network add`. Network passwords are encrypted at rest with
AES-256-GCM; the key is `secret.key`.

Because the web editor lets any account make the bouncer open connections, a network added or moved there may
reach public addresses only, on ports 1024 and up, and an account can have ten. Set `allow_private_networks: true`
if your IRC server is on the same private network as the bouncer. Networks added on the command line are not
restricted.

Clients other than the web one log in as `user/network` with SASL PLAIN (or `PASS user/network:password`); a user
with exactly one network can log in as just `user`.

## HTTPS and proxies

Put the bouncer behind a TLS reverse proxy. The session cookie gets the `Secure` flag when the request arrives over
TLS or the proxy sends `X-Forwarded-Proto: https` (`cookie_secure` forces it either way). Set `trust_proxy: true`
only when the proxy sets `X-Forwarded-For`, so that rate limits count real client addresses. Set `sts_duration`
once the site works over HTTPS, to tell clients to keep using it. The bouncer sends the security headers itself;
do not add your own in front (see SECURITY.md and the note in `deploy/Caddyfile`).

## Background notifications

Web Push keys are created on first start, and the private key is sealed with `secret.key`. When a private message
or a mention arrives and no client is attached to the network, the bouncer pushes to the user's browsers, at most
once per buffer every five seconds. It needs HTTPS in the browser. Set `push_contact` to a real `mailto:` address:
Apple's push service rejects an implausible one.

## Servers with a certificate nobody vouches for

By default the bouncer checks a server's TLS certificate like a browser does. For a server with a self-signed
certificate, or one from a private authority, switch on **Accept an untrusted certificate** in the server's dialog (or
`--tls-insecure` with `network add`). The bouncer then skips the usual check, which means the first connection cannot
tell the real server from an impostor, so use it only for a server you run or trust. It remembers the SHA-256 of the
certificate it sees first, shows it in the dialog, and from then on refuses any other, with a message in the status
window. If the certificate was replaced on purpose, tick **Forget it** in the dialog (changing the address, or turning
the setting off, forgets it too). It needs TLS.

## Client certificates (SASL EXTERNAL)

```
bouncer network add matt libera --host irc.libera.chat --tls --nick matt --sasl EXTERNAL --generate-cert
bouncer network cert matt libera        # prints the fingerprint to register with NickServ
```

or `--cert-file` and `--key-file` for a certificate you already have.

## Limits you can tune

`history_limit` (messages kept per buffer), `replay_limit` (replayed to a client on attach), `command_burst` and
`command_rate` (how fast a client may send), `api_rate` (API requests an account may make a minute, default 600; a client address gets twice that), `turn_ttl`, `sts_duration`, `allow_private_networks` and `disable_guests` (see [GUESTS.md](GUESTS.md)).

## Connection limits

A client WebSocket that has not logged in within 60 seconds is dropped, and no more than 20 connections per address
may be waiting to log in at once (a connection that has logged in stops counting against its address, so a
household or an office behind one address is not held to it). All client connections together are limited to 2000.
A request body that stops arriving for 10 seconds (30 for an upload) is cut off, and a connection idle between
requests for two minutes is closed. These are fixed values, not settings.

## Hosted attachments

The web client's paper-clip button puts a file up on the bouncer itself and links it in the chat message. The
bouncer serves the file at `/uploads/…` and deletes it when its days run out. These settings hold the rules:

| setting | default | what it does |
| --- | --- | --- |
| `disable_uploads` | `false` | switches the whole feature off: no paper clip, no storage, nothing served |
| `uploads_max_bytes` | `52428800` (50 MiB) | the most one file may weigh; larger ones are refused before any storage starts |
| `uploads_user_quota_bytes` | `524288000` (500 MiB) | the most one account may have up at once; an upload past it is refused (507) until older files expire. Must be at least `uploads_max_bytes` |
| `uploads_max_days` | `7` | how long a file is kept; after that it disappears and its links answer "gone" |
| `uploads_dir` | `data_dir/uploads` | where the files are kept (one file per random id, name remembered in the database) |

The files never leave the bouncer: an uploaded link resolves to the bouncer's own address, and the database
remembers the id, the name and the expiry. Anything the browser should not render on its own (HTML, SVG, and
everything not a picture, a sound, a video, a PDF or text) downloads instead of running, so a stored page can
never run on the bouncer's address with a reader's session around.

## Using other IRC clients

The bouncer is not only for the web client. It offers these capabilities to any client, and adapts each message to
what that client asked for, so clients with different capabilities can share one network connection:
`message-tags`, `server-time`, `batch`, `echo-message`, `sasl` (PLAIN), `chathistory`, `message-ids`,
`away-notify`, `account-notify`, `account-tag`, `extended-join`, `multi-prefix`, `userhost-in-names`,
`invite-notify`, `chghost`, `setname`, `cap-notify`, `standard-replies`, `draft/read-marker` and
`draft/message-redaction`. It also advertises `UTF8ONLY`, and `sts` when configured. Clients attach over
WebSocket at `/ws` (the `text.ircv3.net` subprotocol).

Not offered, and why:

- `labeled-response`: replies to a labelled command would need routing to the one client that sent it, and the
  bouncer sends every reply to every client.
- `draft/multiline`: networks rarely support it, and splitting it for those that do not is not done.
- `MONITOR` and `WHOX` are passed through when the network has them, but one `MONITOR` list is shared by all
  clients of a network.
- `soju.im/bouncer-networks`: the web client lists a user's networks through `/api/session`, and other clients log
  in once per network as `user/network`.
- SASL SCRAM-SHA-256 and EXTERNAL from a client to the bouncer: accounts store an argon2id hash, which cannot
  answer a SCRAM exchange, and TLS client certificates are terminated at the reverse proxy. Use PLAIN over TLS.
- `CHGHOST` is dropped for clients without the capability. A server may fake it with a QUIT and JOIN; this one
  does not.

## The HTTP API

The web client logs in at `POST /api/login`, which sets the session cookie. `GET /api/session` returns the user's
networks and preferences, `PUT /api/prefs` saves preferences, `GET/POST/PUT/DELETE /api/networks` is the server
editor, `GET/PUT /api/docs/plugins` keeps the account's installed plugins, `GET /api/media` and `GET /api/preview` are the proxy for links, and `GET /api/ice` gives a browser STUN and
TURN servers with expiring credentials. State-changing requests must be JSON and must not come from another
origin. Failed logins, over HTTP or WebSocket, are rate limited per client address and per account, and a password
change ends every session.
