# Building and testing

## Requirements

- Go (the version in `server/go.mod`)
- Node 22 and npm
- Python 3, for the scripted IRC network the browser tests use
- Docker, if you want to build the image

## Run it from source

```bash
cd web
npm install
npm run build                    # writes web/dist
cd ../server
go build -o bouncer ./cmd/bouncer
cp bouncer.example.yaml bouncer.yaml && chmod 600 bouncer.yaml   # set web_dir: ../web/dist
./bouncer -config bouncer.yaml init
echo 'a-long-password' | ./bouncer -config bouncer.yaml user add matt
./bouncer -config bouncer.yaml network add matt libera --host irc.libera.chat --port 6697 --tls --nick matt --join '#gestalt-test'
./bouncer -config bouncer.yaml serve
```

Open http://127.0.0.1:8080. For development of the client, `npm run dev` serves it on port 5173 and proxies
`/ws` and `/api` to a bouncer on `127.0.0.1:8080`.

`secret.key` and `bouncer.db` must stay together. Losing the key makes every stored network password unreadable.

## Admin commands

```
bouncer -config FILE init
bouncer -config FILE serve
bouncer -config FILE healthcheck                 (exit 0 if a running bouncer answers; used by the container)
bouncer -config FILE user add|passwd NAME        (password on stdin)
bouncer -config FILE user list | remove NAME
bouncer -config FILE network add USER NAME --host H --nick N [--port P] [--tls] [--tls-insecure]
                    [--sasl PLAIN|SCRAM-SHA-256|EXTERNAL] [--sasl-user U] [--join '#a,#b']
                    [--server-password-stdin] [--generate-cert | --cert-file F --key-file F]
bouncer -config FILE network list USER
bouncer -config FILE network cert USER NAME      (prints the client certificate's fingerprint)
bouncer -config FILE network remove USER NAME
bouncer hash-password                            (prints an argon2id hash of one stdin line)
```

The config path defaults to `$GESTALT_CONFIG`, then `bouncer.yaml`. With `GESTALT_AUTO_INIT=1`, `serve` creates the
database and key when the data directory has neither (the container sets it). With only one of the two present
it does nothing and reports the problem, so a new key can never be made next to an old database.

## Tests

```bash
cd server && go test -race ./...             # unit tests
cd web && npm run check && npm test          # type check and unit tests
```

Integration tests run against a real [Ergo](https://github.com/ergochat/ergo) server. Build or download it, then
point `ERGO_DIR` at the directory that holds the `ergo` binary and `default.yaml`. They need `openssl`.

```bash
cd server && ERGO_DIR=/path/to/ergo go test -tags integration -race ./integration/
```

**Browser tests** drive the built client in Chromium against a real bouncer and a scripted IRC network:

```bash
npm --prefix web run build
test/e2e/run.sh                  # SHOTS=1 OUT_DIR=dir takes the README's screenshots instead; VOICE_LOAD=1 puts ten browsers in a voice room
```

They need Playwright (`npm i -g playwright`, or set `PLAYWRIGHT_MODULE`) and a full Chromium (`CHROMIUM_PATH`),
since the headless shell ignores the notification permission. See `test/e2e/README.md` for what they cover.

**Load tests** measure memory against the budget in DESIGN.md:

```bash
test/load/run.sh                 # the bouncer: 50 users, 2 networks, 20 channels each, 100 clients attached
test/load/web.sh                 # the web client's JavaScript heap with 10 channels of 2000 messages loaded
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: formatting, `go vet` and `go test -race`, the web
type check, tests and build, the Ergo integration tests, and the browser tests. `security.yml` runs the same
triggers and daily: `govulncheck` and `npm audit` (for what ships to browsers). CodeQL for Go and TypeScript runs through the
repository's code scanning "default setup" in GitHub's settings, not from a workflow here. Dependabot proposes
updates weekly.

## Layout

```
server/cmd/bouncer         the binary and its admin commands
server/internal/irc        line parser, IRCv3 tags, SASL
server/internal/upstream   the client side of a connection to an IRC network
server/internal/bouncer    networks kept alive, client sessions, history replay
server/internal/api        login, sessions, preferences, the server editor, stored documents, security headers
server/internal/media      the proxy for pictures, video, sound and link previews
server/internal/netguard   refuses private addresses for outbound connections
web/src/lib                the client: IRC, state, p2p, voice, plugins
web/src/components         Svelte components
deploy/                    Caddyfile, config templates, notes for running on a server
test/                      browser and load tests
```
