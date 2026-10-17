# irc-webclient

A self-hosted IRC bouncer and compact web client. See [DESIGN.md](DESIGN.md)
for the architecture and roadmap.

## Status

Phase 1 (protocol core) and phase 2 (bouncer MVP) are done. Phase 3 (multi-user
and multi-network) is in place:

- Users and networks live in the database and are managed with admin commands.
  A running bouncer picks up new and removed networks within 5 seconds.
- Network passwords are encrypted at rest with AES-256-GCM. The key is in
  `secret.key`, which `bouncer init` creates.
- Clients log in as `user/network` with SASL PLAIN (or `PASS user/network:password`).
  A user with exactly one network can log in as just `user`.
- `server/internal/accounts`: user and network management, shared by the CLI and the bouncer.
- `server/internal/secret`: the AES-GCM box and key file handling.

Phase 2 pieces, still in place:

- `server/internal/bouncer`: networks kept alive in the background, with reconnect
  and backoff. Clients attach over WebSocket at `/ws`. On attach,
  a client gets its channels, topics and members, then the messages it missed.
  `CHATHISTORY LATEST|BEFORE|AFTER` is supported. A watchdog pings quiet
  network connections and drops ones that stop answering.
- `server/internal/store`: SQLite history, capped per buffer.
- `server/internal/auth`: argon2id password hashes.
- `server/cmd/bouncer`: the binary. Run `bouncer -config bouncer.yaml`, or
  `bouncer hash-password` to make a hash.

Phase 1 pieces:

- `server/internal/irc`: line parser and formatter, IRCv3 message tags with
  escaping, size limits, SASL PLAIN and SCRAM-SHA-256.
- `server/internal/upstream`: registration client. It negotiates IRCv3
  capabilities (CAP LS 302, REQ, ACK, NAK, NEW, DEL), runs SASL, and answers PING.
- `server/internal/ws`: IRC over WebSocket, using the `text.ircv3.net` subprotocol.

## Running the tests

Unit tests:

```bash
cd server
go test -race ./...
```

Set up and run the bouncer with a config based on `server/bouncer.example.yaml`
(`chmod 600` it):

```bash
cd server
go build -o bouncer ./cmd/bouncer
./bouncer -config bouncer.yaml init
echo 'a-long-password' | ./bouncer -config bouncer.yaml user add matt
echo 'sasl-password'   | ./bouncer -config bouncer.yaml network add matt libera \
    --host irc.libera.chat --port 6697 --tls --nick matt \
    --sasl PLAIN --join '#irc-webclient-test'
./bouncer -config bouncer.yaml serve
```

Admin commands:

```
bouncer -config FILE init
bouncer -config FILE user add|passwd NAME        (password on stdin)
bouncer -config FILE user list | remove NAME
bouncer -config FILE network add USER NAME --host H --nick N [--port P] [--tls]
                    [--sasl PLAIN|SCRAM-SHA-256] [--sasl-user U] [--join '#a,#b']
                    [--server-password-stdin]    (SASL password is the first stdin line)
bouncer -config FILE network list USER
bouncer -config FILE network remove USER NAME
bouncer hash-password                            (prints a hash; not needed by the admin commands)
```

`secret.key` and `bouncer.db` must stay together. Losing the key makes every
stored network password unreadable.

Phase 2 databases are not migrated. `bouncer` refuses to open one, so move the
data directory aside and run `init` again.

Integration tests run against a real [Ergo](https://github.com/ergochat/ergo)
server. Download a release, then point `ERGO_DIR` at the directory that
contains `ergo` and `default.yaml`. The tests need `openssl` for a throwaway
TLS certificate.

```bash
cd server
ERGO_DIR=/path/to/ergo-release go test -tags integration -race ./integration/
```
