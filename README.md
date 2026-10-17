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

The web client (DESIGN.md phase 3) is in `web/`. It is Svelte 5 and TypeScript, about
40 KB gzipped. It has:

- login with an account name and password, then a session cookie (HttpOnly, SameSite=Strict).
  No password is kept in the page. One WebSocket per network, shown as icons in the left
  rail, logged in with the cookie
- channels, queries and a status buffer, with unread and mention badges
- the full command set from the design (`/help` lists it), and any other `/command` is
  sent to the server as it is
- nick colours with per-nick overrides, mention and keyword highlighting, tab completion
  for nicks, channels and commands, and input history on Up and Down
- scrollback through `CHATHISTORY`, with replay on reconnect and de-duplication, in a list
  that renders only the rows near the view, so memory stays flat in a long channel
- replies, reactions, deleting your own messages, "is typing" (off until you turn it on),
  and away members shown dimmed
- light, dark and system themes and compact and comfortable density. Preferences are saved
  on the bouncer and follow the account to other devices
- read position kept by the bouncer, so reading a channel on one device clears it on the others
- desktop notifications while the page is open, and background notifications through Web
  Push when no client is connected

Phase 5 adds pictures, video, link previews and direct chat:

- **Media.** Pictures and video in links are shown inline, and other links get a title and
  picture. The browser never contacts the linked site: the bouncer fetches it
  (`/api/media`, `/api/preview`), refuses private addresses (checked at connect time, so a
  redirect or DNS trick cannot get past it), sniffs the bytes instead of trusting the
  server's content type, refuses SVG and HTML, and caps size and concurrency. YouTube and
  Streamable show a card, and nothing loads from them until you press play. Three switches
  in Settings turn media, previews and players off.
- **Direct chat and file transfer.** `/direct NICK`, or the "Direct chat" button in a query,
  asks the other person to connect browser to browser over WebRTC. The IRC network only
  carries the offer and answer, as client-only message tags. Nothing is connected until they
  accept, so no network address is revealed before that. Chat lines and files then go
  straight between the browsers and are not stored anywhere. Files are accepted one by one,
  streamed with back-pressure, checked against the size that was offered and a SHA-256, and
  held in memory until you save them (up to 512 MB each). Both sides see a safety code made
  from both certificate fingerprints; if you read it out to each other over another channel
  and it matches, nobody in between, including the IRC server and the bouncer, altered the
  connection. Without a TURN server (below) it only connects when a direct path exists.
- **STUN and TURN.** `/api/ice` gives a logged-in browser the servers from `stun_uris` and
  `turn_uris`, with TURN credentials that expire (`turn_ttl`, a day by default) and are derived from a secret
  shared with coturn. `deploy/` has a Docker Compose setup with the bouncer, Caddy for HTTPS
  and coturn. See `deploy/README.md` for what was and was not run.

Phase 6 adds voice, in two forms (see DESIGN.md section 6):

- **A channel's voice room.** Press "Join voice" in a channel (or `/voice`; `/voice leave` to go).
  The room is the channel itself: you announce yourself with a client-only tag, the people
  already there answer you, and every pair of people holds one WebRTC connection (a mesh), so
  there is no media server. The person whose nick sorts first makes the offer, so nobody offers
  twice. Up to 10 people (`MAX_VOICE` in `web/src/lib/voice/presence.ts`); an eleventh is told the
  room is full and does not join, and members also refuse their own unexpected offers beyond the
  cap. You see who is speaking, can mute, set each person's volume, and compare a safety code
  with each person. Audio keeps playing while you look at another window.
- **A private call between two people.** `/call NICK`, or the "Call" button in a query, rings
  them in their direct chat window. Their microphone stays off and nothing connects until they
  answer; yours is asked for only when you place the call.

Both use the same signalling and ICE servers as direct chat, and you can be in only one voice
chat at a time. The microphone needs HTTPS (or localhost). Echo cancellation and noise
suppression are the browser's own; use headphones.

Voice limits to know about: who is "in voice" is only what your browser has seen since it
connected (people who joined before that appear when you join, because they answer you), so the
list on an idle channel is a hint. Someone who changes nick while in a room keeps their place under the new name; a call or direct chat
keeps working but still goes by the nick it started with, so its goodbye may not reach the other side.
Only people who are in the channel can be in its voice room. The same account in two browsers should not join the same room
from both. A room is a mesh, so 10 people means nine connections each. `VOICE_LOAD=1 test/e2e/run.sh`
puts ten real Chromium instances in one room (all connected to all, in about 10 s, each playing
nine streams) and checks an eleventh is turned away. On the 4-core test machine, with a fake
microphone and no hardware audio, the eleven browsers together used about 3.4 cores while
everyone was connected (about a third of a core per participant) and each page's JavaScript
heap stayed near 6 MB. That is a rough guide only: a phone with ten people is the case to try
before relying on it. Push-to-talk and
listen-only joining are not built.

Things to know about direct chat: the same account logged in on two devices gets the request
on both, and the first to accept connects. Chat is not kept after the page closes. A browser
tab that sleeps (a phone with the screen off) may drop the connection.

Phase 7 adds plugins (see DESIGN.md section 7). Open Settings, then Plugins, paste a plugin (one JSON
document with `name`, `version`, `description`, `permissions` and `source`) or choose a file, and
review what it asks for before it is installed. "Use the example" fills in a small working one.

- **What a plugin can do.** Inside `source`, a plugin has an `irc` object: `irc.alias(name, fn)` adds a
  `/name` command (it cannot replace a built-in one); `irc.on(EVENT, fn)` hears `TEXT`, `ACTION`, `NOTICE`,
  `MENTION`, `JOIN`, `PART`, `QUIT`, `NICK`, `KICK`, `MODE`, `TOPIC`, `CONNECT` and `DISCONNECT`;
  `irc.setTimer(ms, fn, repeat)`; `irc.send(line, window)` and `irc.say(nick, text)` (sent as you, by the
  same path a typed command takes); `irc.print(text)` (a line only you see); `irc.storage.get/set/delete/keys`;
  and `irc.log(...)`.
- **Permissions.** `events`, `send`, `output`, `timers`, `storage`. You can untick any when installing. The
  page, not the plugin, checks every call, and a plugin that keeps trying what it was refused is stopped.
- **Where it runs.** In a Web Worker inside a frame with `sandbox="allow-scripts"` (no origin of its own, so
  no cookies, storage or access to the page; requests carry no credentials) whose content security
  policy forbids every connection, and the worker deletes `fetch`, `WebSocket`, `Worker`, `importScripts`
  and the like before the plugin's code runs. The browser test has a plugin try to get out by each route
  it can think of, and checks that the test website never hears from it.
- **What `send` cannot do.** Lines a plugin sends go to the network. Commands that act on your browser
  (`/voice`, `/call`, `/direct`, `/clear`) are refused, and a plugin cannot write in a direct chat. A plugin
  cannot take over `/ns`, `/identify`, `/oper` and the other commands people type passwords into.
- **Limits.** A few actions a second, 20 aliases, 20 timers (at least 100 ms apart), 100 KB of stored data.
  A plugin that does not answer for five seconds, or crashes, or floods, is stopped and switched off, with
  the reason shown. Direct chats are not passed to plugins.
- **Not done.** Popups and dialogs (the design puts them later), and server-side WASM hooks. Plugins and
  their data are kept in this browser, per account, and are not synced to your other devices. A plugin
  with `events` can read your channels, and with `send` can speak as you: only install code you trust.

Message text is never inserted as HTML. Only `http` and `https` links are clickable.

Limits to know about: replying, reacting and deleting appear when you hover a message, so a
touch screen has no way to reach them yet. Reactions, replies and typing need the network
to support message tags.

To run it:

```bash
cd web
npm install
npm run build                    # writes web/dist
npm test                         # unit tests
npm run check                    # type check
```

Set `web_dir: ../web/dist` in `bouncer.yaml` and the bouncer serves the client at `/` with the
WebSocket at `/ws` on the same origin. For development, `npm run dev` serves the client on
port 5173 and proxies `/ws` and `/api` to a bouncer on `127.0.0.1:8080`.

`test/e2e/run.sh` drives the built client in Chromium against a real bouncer and a scripted
IRC network. See `test/e2e/README.md`.

## Accounts, networks and the bouncer's HTTP API

Users and networks are managed with the admin commands below. The web client logs in at
`/api/login`, which sets the session cookie; `/api/session` returns the user's networks and
preferences, and `/api/prefs` saves preferences. Failed logins, over HTTP or WebSocket, are
rate limited per client address and per user. A password change ends every session.

Put the bouncer behind a TLS reverse proxy. The cookie gets the `Secure` flag when the request
arrives over TLS or the proxy sends `X-Forwarded-Proto: https` (`cookie_secure` forces it either
way). Set `trust_proxy: true` only when the proxy sets `X-Forwarded-For`, so rate limits count
real client addresses. Set `sts_duration` once the site works over TLS, to tell clients to keep
using it.

**Background notifications** use Web Push. Keys are created on first start and the private key
is sealed with the instance key. When a private message or a mention arrives and no client is
attached to the network, the bouncer pushes to the user's browsers, at most one push per buffer
every five seconds. Services notices and CTCP requests are not pushed. It needs HTTPS in the
browser. Set `push_contact` to a real `mailto:` address, since Apple's push service rejects an
implausible one.

**Client certificates and SASL EXTERNAL** are supported for upstream networks:

```
bouncer network add matt libera --host irc.libera.chat --tls --nick matt --sasl EXTERNAL --generate-cert
bouncer network cert matt libera        # prints the fingerprint to register with NickServ
```

or `--cert-file` and `--key-file` for a certificate you already have.

## IRCv3 support for other clients

The bouncer is not only for the web client. It offers these capabilities to any client, and
adapts each message to what that client asked for, so clients with different capabilities can
share one network connection: `message-tags`, `server-time`, `batch`, `echo-message`, `sasl`
(PLAIN), `chathistory`, `message-ids`, `away-notify`, `account-notify`, `account-tag`,
`extended-join`, `multi-prefix`, `userhost-in-names`, `invite-notify`, `chghost`, `setname`,
`cap-notify`, `standard-replies`, `draft/read-marker` and `draft/message-redaction`. It also
advertises `UTF8ONLY`, and `sts` when configured.

Not offered, and why:

- `labeled-response`: replies to a labelled command would need routing to the one client that
  sent it, and the bouncer sends every reply to every client.
- `draft/multiline`: networks rarely support it, and splitting it for those that do not is not done.
- `MONITOR` and `WHOX` are passed through from the network when it has them, but one `MONITOR`
  list is shared by all clients of a network.
- `soju.im/bouncer-networks`: the web client lists a user's networks through `/api/session`
  instead, and other clients log in once per network as `user/network`.
- SASL SCRAM-SHA-256 and EXTERNAL from a client to the bouncer: accounts store an argon2id
  hash, which cannot answer a SCRAM exchange, and TLS client certificates are terminated at
  the reverse proxy. Use PLAIN over TLS.
- `CHGHOST` is dropped for clients without the capability. A server may fake it with a QUIT
  and JOIN; this one does not.

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
