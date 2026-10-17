# irc-webclient

A self-hosted IRC bouncer and compact web client. See [DESIGN.md](DESIGN.md)
for the architecture and roadmap.

## Status

Phase 1 (protocol core) is done. Phase 2 (bouncer MVP) is in place:

- `server/internal/bouncer`: one user and one network kept alive in the
  background, with reconnect and backoff. Clients attach over WebSocket at
  `/ws` and authenticate with SASL PLAIN (or `PASS user:password`). On attach,
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

Run the bouncer with a config based on `server/bouncer.example.yaml`:

```bash
cd server
go build -o bouncer ./cmd/bouncer
echo 'your-password' | ./bouncer hash-password
./bouncer -config bouncer.yaml
```

Integration tests run against a real [Ergo](https://github.com/ergochat/ergo)
server. Download a release, then point `ERGO_DIR` at the directory that
contains `ergo` and `default.yaml`. The tests need `openssl` for a throwaway
TLS certificate.

```bash
cd server
ERGO_DIR=/path/to/ergo-release go test -tags integration -race ./integration/
```
