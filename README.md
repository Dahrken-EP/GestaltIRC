# irc-webclient

A self-hosted IRC bouncer and compact web client. See [DESIGN.md](DESIGN.md)
for the architecture and roadmap.

## Status

Phase 1 (protocol core) is in progress:

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

Integration tests run against a real [Ergo](https://github.com/ergochat/ergo)
server. Download a release, then point `ERGO_DIR` at the directory that
contains `ergo` and `default.yaml`. The tests need `openssl` for a throwaway
TLS certificate.

```bash
cd server
ERGO_DIR=/path/to/ergo-release go test -tags integration -race ./integration/
```
