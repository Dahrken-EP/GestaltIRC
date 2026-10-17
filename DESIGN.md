# IRC Bouncer + Web Client: Design

Status: draft for review. Nothing is implemented yet.

## 1. Goals

A self-hosted, multi-user IRC bouncer with a compact, modern web client. The
bouncer keeps IRC connections alive when the browser closes. The web client is
one client of the bouncer, not the only one. Any IRCv3-capable client can also
connect to it.

Feature targets are the list in the request: the Lounge-style features, a
Discord-like layout that is denser, mention highlighting, nick colours, inline
media, P2P chat and file transfer, mesh voice channels, a mIRC-style plugin
system, light and dark themes, and desktop notifications.

## 2. Key decisions (proposed)

| Area | Choice | Why |
|---|---|---|
| Bouncer language | **Go** | Single static binary, cheap goroutines per IRC connection, low idle RSS. Fits the "low memory footprint" goal. |
| Storage | **SQLite** (one file per instance) | No external database to run. Enough for many users on one host. |
| Web client | **TypeScript + Svelte** | Small runtime and small bundle. Fine-grained reactivity suits a high-volume message list. |
| Browser transport | **IRC over WebSocket** (IRCv3 WebSocket convention) | The client speaks plain IRC. It can be swapped for any IRC client without special casing. |
| Multi-network | IRCv3 **bouncer-networks** extension (soju-style) | Lets one login hold many networks, each shown as its own server in the UI. Not on the ircv3.net index; verify against soju's docs before implementing. |
| History | IRCv3 **chathistory** + **server-time** + **msgid** | Standard replay on reconnect. Works with other clients too. |
| Plugins | Sandboxed **JavaScript in Web Workers** (client) and **WASM** (server, later) | Matches the mIRC model of aliases and event hooks. Workers keep a bad plugin from touching the DOM or the page. |
| Voice / P2P | **WebRTC**. Signalling runs over IRC via client-only tags. | No extra signalling server. The IRC network already carries presence. |
| Test IRCd | **Ergo** (Go, supports IRCv3 well) | Local dev and integration tests without touching a public network. |

## 3. Architecture

```
 Browser (web client)           Any IRC client (HexChat, WeeChat, ...)
        │  WSS (IRC lines)              │  TLS (IRC lines)
        ▼                               ▼
 ┌──────────────────────────── bouncer (Go, one process) ───────────────────┐
 │  listeners: WSS + TLS IRC  ── auth (SASL / login)  ── per-user session    │
 │  per-user: N upstream network connections (TLS, SASL, reconnect/backoff)  │
 │  message router ─► history store (SQLite, ring-buffered per target)       │
 │  media proxy (SSRF-safe, size-capped)   TURN credential issuer            │
 │  admin CLI (add user, reset password, list networks)                      │
 └────────────┬───────────────────────────────────────────────┬─────────────┘
              ▼                                               ▼
     IRC networks (Libera, OFTC, your own Ergo)           coturn (STUN/TURN)
                                                            ▲
 Browser ◄──── WebRTC DataChannels (P2P chat/files) ────► Browser
 Browser ◄──── WebRTC audio mesh (voice channels) ─────► Browser
           (signalling only goes through IRC, never through the bouncer)
```

Two things make this work:

1. **The bouncer owns the IRC connections.** Closing the browser does not
   disconnect anyone. On reconnect the client requests history, then gets live
   messages again.
2. **The bouncer is a thin, standards-first layer.** Clients see IRC. Our
   features that IRC lacks (voice signalling, P2P) ride on client-only tags, so
   they cost nothing for users on other clients.

### 3.1 Bouncer (Go)

- **Users:** username plus argon2id password hash. Each user has networks,
  preferences, and a nick colour map. Admin commands manage users from the
  shell. No self-signup by default.
- **Networks:** each user can attach several upstream networks. Each has host,
  port, TLS, SASL credentials (stored encrypted at rest with a per-instance key),
  and auto-join channels.
- **Sessions:** a logged-in browser is a client session on the user's bouncer
  connection. Several clients can attach at once (desktop, phone, web), and
  each sees the same state.
- **Storage:** SQLite with WAL mode. Each buffer (channel or query) keeps the
  last N messages (default 2000, configurable). Older rows are pruned. Memory
  stays bounded even on a busy channel.
- **Limits:** per-user connection and rate caps, max line length enforced,
  max WebSocket message size, idle timeouts.
- **Config:** one YAML file. TLS certs come from the reverse proxy or
  autocert.

### 3.2 Protocol support (IRCv3 targets)

Capability negotiation uses CAP LS 302 and CAP REQ. The bouncer and the web
client support these stable specs:

`message-tags`, `server-time`, `batch`, `labeled-response`, `echo-message`,
`sasl` (PLAIN, EXTERNAL, SCRAM-SHA-256), `account-tag`, `account-notify`,
`away-notify`, `extended-join`, `multi-prefix`, `userhost-in-names`,
`invite-notify`, `chghost`, `setname`, `cap-notify`, `standard-replies`,
`message-ids`, `monitor`, `whox`, `sts`, `UTF8ONLY`.

Draft specs used where they exist (names may change):

`chathistory`, `read-marker`, `message-redaction`, `typing` (client-only tag),
`reply` (client-only tag), `multiline`, `draft/react`.

Client-only tags are the mechanism for voice signalling and P2P. A
`TAGMSG` carries tags only and has no body. Clients drop unknown tags, so
other clients ignore them.

### 3.3 Full IRC command set

Every standard command is handled. These are sent through the normal IRC path,
with a parser that matches RFC 1459/2812 and the IRCv3 message format:

`/join /part /quit /nick /msg /query /notice /me /topic /names /list /whois
/whowas /who /mode /kick /ban /unban /invite /away /back /ctcp /ping /time
/version /motd /stats /links /raw`, plus anything else, which is forwarded
as raw.

Commands the server does not know are forwarded. The web client does not
hard-code the set. Its help output comes from the server's ISUPPORT where it is
available.

## 4. Web client

### 4.1 Layout (dense, Discord-like but compact)

- **Left rail (narrow):** network icons. Click one to switch network. Unread
  and mention badges appear on the icon.
- **Channel list (about 220 px):** channels and queries per network. Mentions
  are highlighted. Unread messages are bold. Collapsible.
- **Message pane:** one line per message by default: `time  nick  text`. Nick
  colour applies to the nick. Continuation lines from the same sender are
  merged. Avatars are not shown.
- **Member list:** toggleable, one line per member, sorted by prefix.
- **Input bar:** single line that grows to 5 lines. Tab completion for nicks,
  channels, and commands. History with Up and Down.

Density setting: "compact" (default) and "comfortable". The difference is row
height and font size. Both are CSS variables.

### 4.2 Theming

All colours are CSS custom properties on `:root`. Dark is the default when the
OS prefers it. There is a toggle, and the choice is stored server-side per user
so it follows them across devices.

### 4.3 Rendering rules

- Message text is never inserted as HTML. The parser turns it into safe nodes:
  text, link, nick, channel, emote.
- Mentions: a nick matches on word boundaries and is case-insensitive. Users
  can add keywords and regex-free patterns. A mention:
  - highlights the line,
  - adds the buffer to the mention badge,
  - fires a desktop notification (Notification API) when the tab is not focused
    or the window is minimised.
- Background notifications: a service worker plus Web Push, when the user
  opts in. The bouncer is always online, so it can send these.

### 4.4 Nick colours

Each nick gets a colour from a hash of its lowercase form. It maps to a hue
with fixed saturation and lightness, adjusted so it stays readable in both
themes. Users can override any nick's colour. Overrides are stored on the
server and synced across devices.

### 4.5 Inline media

- Images, GIFs, and video links render inline. Images are fetched by the
  media proxy, so the browser never contacts the third-party host directly.
  That keeps the user's IP private and avoids mixed content.
- The proxy blocks private, loopback, and link-local ranges (SSRF defence). It
  enforces size and type limits and rewrites URLs.
- YouTube and Streamable use oEmbed or their player iframes, with a setting to
  turn embeds off.
- Other links show a small preview card. Title, description, and image come
  from the proxy and are cached.

## 5. P2P chat and file transfer

- **Initiation:** the user clicks a nick and chooses "P2P chat". The client
  sends a `TAGMSG` to the peer with a `+` client tag carrying the SDP offer.
  The peer answers the same way.
- **Transport:** a WebRTC DataChannel per peer pair. It is reliable and ordered
  and DTLS-encrypted, so chat is end-to-end between browsers.
- **File sending:** chunked (64 KiB chunks), with back-pressure, progress,
  cancel, and a SHA-256 check at the end. The receiver is asked to accept first.
- **NAT traversal:** STUN is used first. TURN is the fallback. The bouncer
  issues short-lived TURN credentials using the TURN REST API (HMAC over
  expiry time), so no long-lived secret reaches the browser.
- **Limitation:** signalling runs over IRC. The IRC server could in theory
  rewrite the SDP to put itself in the middle. Mitigation: show the DTLS
  fingerprints and let users confirm them out of band. This is documented for
  users, and an automatic check is noted as future work.

## 6. Voice channels (mesh)

### 6.1 Why a mesh

Each participant opens one RTCPeerConnection to each other participant. There
is no media server, which matches the decentralised goal. The cost scales with
N:

- Upload per peer is (N-1) Opus streams. At about 32 to 48 kbps each, a peer
  in a 10-person call uploads roughly 0.3 to 0.5 Mbit/s.
- Decode cost per peer is also (N-1) streams. For audio this is small.
- Audio mesh is therefore practical for small channels. Video is not in scope,
  and a mesh of video would not scale.

**Default cap: 8 voice participants per channel.** Extra joiners see a notice
and can listen only. The cap is configurable. Above it, an optional
selective-forwarding unit on the bouncer host would be the next step. That is
not in the first version.

### 6.2 Signalling (through IRC)

The voice room is the channel itself, with no extra server state.

1. A user toggles voice on. The client sends `TAGMSG #channel` with a client tag
   `+voice=join`. Clients that understand it show a "in voice" marker.
2. Each voice member sends an empty `+voice=here` in reply, so the newcomer
   learns who is present.
3. Pairs use WebRTC "perfect negotiation". To avoid glare, the peer with the
   lower nick initiates the offer. The other side is polite and rolls back if
   needed.
4. SDP and ICE candidates are sent as `TAGMSG` to the peer with a
   `+voice-sig` tag. The payload is JSON. Large SDPs are split into sequenced
   chunks, because tag data is size-limited.
5. Leaving sends `+voice=leave`. Connections close, and the others remove the
   stream.

Clients that do not support voice ignore these tags.

### 6.3 Audio handling

- Each remote stream goes through a Web Audio graph: a `GainNode` for per-user
  volume, an `AnalyserNode` for the speaking indicator, and a mute toggle.
- Echo cancellation, noise suppression, and auto gain come from the browser's
  constraints. The UI recommends headphones.
- Push-to-talk is a planned option.

### 6.4 Risks

- **Symmetric NAT and firewalls:** TURN is required for some networks. Coturn
  must be deployed alongside the bouncer. Without it, some users will not
  connect.
- **Signalling latency:** going through IRC adds delay to connection setup.
  Each voice join will take about 1 to 3 seconds. Acceptable for a voice room.
- **Mesh CPU on phones:** keep the cap low on mobile. Test on real devices.

## 7. Plugins (mIRC-style)

Plugins are JavaScript modules that run in a Web Worker. They have no DOM and
no network access unless granted. The host exposes:

- **Aliases:** `alias /greet { /msg $chan Hello $1 }` style, mapped to a
  JavaScript function with `$1`-like arguments.
- **Events:** `on TEXT`, `JOIN`, `PART`, `QUIT`, `NICK`, `KICK`, `NOTICE`,
  `CONNECT`, `DISCONNECT`, `MODE`, `TOPIC`, plus mention and timer events.
- **Timers:** `setTimer(ms, fn)`, cancelled on unload.
- **Popups:** menu items on nicks and channels.
- **Output:** write to a buffer, or send IRC commands through the same path a
  typed command uses.
- **Storage:** a per-plugin key-value store, per user.

Each plugin ships a manifest with name, version, and requested permissions.
The user approves the permissions at install time. The first version has
aliases, events, and timers. Popups and dialogs come later.

Server-side hooks (for logging or filtering) can use WASM through `wazero`, in a
later phase.

## 8. Security

- Passwords: argon2id. Session cookies are HttpOnly, Secure, SameSite=Strict.
- All network credentials are encrypted at rest.
- No HTML from messages reaches the DOM. Strict CSP on the web client.
- Media proxy: SSRF blocking, size and type limits, timeouts, no cookies forwarded.
- Rate limits on login, command sending, and file transfer offers.
- The bouncer never sends TURN secrets to the browser. It issues short-lived
  credentials.
- HSTS and STS: the bouncer sends the `sts` cap where TLS is in use.

## 9. Memory budget

Targets to measure in phase 6:

- Idle bouncer with 1 user and 1 network: under 25 MB RSS.
- 50 users, each with 2 networks and 20 channels: under 300 MB RSS, with
  history capped at the default.
- Web client: under 60 MB JS heap with 10 channels open and 2000 messages
  loaded. The message list is virtualised.

## 10. Repository layout (proposed)

```
irc-webclient/
  DESIGN.md
  server/            Go bouncer (cmd/bouncer, internal/irc, internal/store, internal/media)
  web/               Svelte client (src/lib/irc, src/lib/voice, src/lib/p2p, src/lib/plugins)
  deploy/            docker-compose (bouncer + coturn), example config, reverse proxy notes
  test/              integration tests against Ergo
```

The repository is standalone at `/home/matt/irc-webclient`, separate from the
Hugo blog. Phase 1 lives in `server/`.

## 11. Phases

1. **Protocol core.** IRC parser, IRCv3 cap negotiation, SASL, WebSocket. Tested
   against a local Ergo.
2. **Bouncer MVP.** One user, one network. Upstream reconnect. Ring-buffered
   history with chathistory replay.
3. **Web client MVP.** Channels, buffers, the full command set, nick colours,
   highlights, notifications, light and dark themes, compact layout.
4. **Multi-user and multi-network.** Accounts, admin CLI, bouncer-networks
   support.
5. **Media and P2P.** Media proxy with inline images and video embeds. P2P chat
   and file transfer over WebRTC DataChannels. Coturn integration.
6. **Voice mesh.** Signalling over client tags, audio graph, cap handling, and
   a memory and CPU test pass.
7. **Plugins.** Worker sandbox, aliases, events, timers, permission prompts.
8. **Hardening.** Security review, load and memory tests, deploy docs.

## 12. Open questions

1. Confirm **Go + Svelte**, or prefer Node/TypeScript end to end.
2. Confirm the repository location. This folder sits in the blog repo for now.
3. Confirm the default voice cap (proposed 8).
4. Should P2P file transfer fall back to DCC for non-web peers? DCC is not
   browser-friendly, so the proposal is no.
5. Target number of users per instance, which sets the SQLite and memory plan.
