# Running the bouncer

This is for the person who runs the server. For a ready-made setup with HTTPS and a TURN relay, see
[deploy/README.md](../deploy/README.md). Everything below is set in `bouncer.yaml`; `server/bouncer.example.yaml`
lists every option with its default.

## Accounts and networks

Accounts are made with the command line (`bouncer user add`). People then add and edit their own networks in
**Settings, Networks**, or you add them with `bouncer network add`. Network passwords are encrypted at rest with
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

## Client certificates (SASL EXTERNAL)

```
bouncer network add matt libera --host irc.libera.chat --tls --nick matt --sasl EXTERNAL --generate-cert
bouncer network cert matt libera        # prints the fingerprint to register with NickServ
```

or `--cert-file` and `--key-file` for a certificate you already have.

## Limits you can tune

`history_limit` (messages kept per buffer), `replay_limit` (replayed to a client on attach), `command_burst` and
`command_rate` (how fast a client may send), `turn_ttl`, `sts_duration` and `allow_private_networks`.

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
networks and preferences, `PUT /api/prefs` saves preferences, `GET/POST/PUT/DELETE /api/networks` is the network
editor, `GET /api/media` and `GET /api/preview` are the proxy for links, and `GET /api/ice` gives a browser STUN and
TURN servers with expiring credentials. State-changing requests must be JSON and must not come from another
origin. Failed logins, over HTTP or WebSocket, are rate limited per client address and per account, and a password
change ends every session.
