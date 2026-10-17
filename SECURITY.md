# Security

Gestalt is a self-hosted bouncer. The person running it is trusted; the people with accounts on it are
trusted less; the IRC networks, the people on them, and every web page a link points to are not trusted at
all. This page says what is defended against, how, what was tested, and what is not covered.

It is written by the people who built it, not by an outside auditor. Treat it as a description of intent
and of the tests that exist, not as a guarantee.

## Reporting a problem

Please do not open a public issue for a vulnerability. Use GitHub's "Report a vulnerability" on the
repository's Security tab (private advisories), or contact the maintainer privately. Say what you found, how
to reproduce it, and which version. There is no bug bounty and no promised response time; it is a small project.

## What is defended against

**A stranger on the internet.** Passwords are hashed with argon2id, at most four hashes run at once so a burst
of logins cannot use all the memory. Failed logins, over HTTP or WebSocket, are rate limited per client address
and per account. The session cookie is `HttpOnly` and `SameSite=Strict`, and `Secure` when the request arrived
over TLS. State-changing requests must be JSON and must not come from another origin. A password change ends
every session. A client may send a burst of 30 lines and then 10 a second; past that, lines are dropped and a
client that keeps on is disconnected.

**A malicious IRC network or user.** Message text is never inserted into the page as HTML; only `http` and
`https` links are clickable. Every response carries a content security policy (`default-src 'self'`, no inline
script, no objects, `frame-ancestors 'none'`), `nosniff`, `no-referrer`, frame denial, and a permissions
policy. Over HTTPS, `Strict-Transport-Security` is sent once `sts_duration` is set.

**A malicious link.** The browser never contacts the linked site. The bouncer fetches pictures, video, sound
and page previews itself, refuses private, loopback and link-local addresses (checked at connect time, on the
address actually dialled, so a redirect or a DNS answer that changes cannot get past it), judges the type by the
bytes and not the server's header, refuses SVG and HTML as media, caps sizes, time and concurrency, and
forwards no cookies. Imgur turns away the addresses of many servers, so there is an opt-in setting that makes the browser load imgur pictures itself (the policy allows `i.imgur.com` for pictures and video, and imgur then sees the user's address). A YouTube or Streamable player loads only after you press play, in a sandboxed frame, and is told this site's address (and nothing more of the page's) because YouTube will not play without one.

**A guest, or someone who finds a guest link.** Guest links are off until a user switches them on, and the operator can
switch them off with `disable_guests`. A link is 144 random bits, wrong ones are counted per address and block it, a direct
link works for one person, and a room link for four, for as long as its host is in the room. A guest reaches only the host's
browser, through the bouncer, with nothing but signalling and a room roster: no IRC, account or history. Lines about guests that
come from the network are dropped, so nobody can pose as one, and a guest's name is reduced to plain text and shown as a guest.
Joining shows the guest that their address is shared with the host, and a link shows the host's address to whoever opens it, which is
what making the link means. See [docs/GUESTS.md](docs/GUESTS.md).

**A network impersonating your IRC server.** The bouncer verifies a server's TLS certificate like a browser. A server
can be set to accept an untrusted one (self-signed, or from a private authority). That setting is weaker: the first
connection cannot tell the real server from an impostor. So the bouncer remembers the SHA-256 of the first certificate it
sees and refuses any other afterwards, until the person asks it to forget. Use it only for a server you run or trust.

**An account that wants to reach the bouncer's own network.** The network editor lets any account make the
bouncer open connections. A network added or moved there may reach public addresses only (checked again at
connect time) and ports from 1024, and an account may have ten. Fields sent to the IRC network (nicks,
passwords, the commands to run after connecting) cannot hold line breaks, and those commands cannot be PASS, USER, CAP,
AUTHENTICATE or QUIT. The operator can lift the address rule with `allow_private_networks`. Networks added with the
command line are the operator's choice and are not restricted.

**A plugin.** A plugin is code the user pasted in, so the question is what it can do, not whether it is
trustworthy. It runs in a Web Worker in a frame with `sandbox="allow-scripts"` (no origin, so no cookies,
storage or access to the page) under a policy that forbids every connection, and the worker removes the network
and cross-window functions, from the prototype chain too, before the plugin's code runs. Everything it asks for
goes through the page, which checks the permissions the user granted, limits how fast it may act, and stops it
if it stops answering or keeps trying what it was refused. It cannot replace built-in commands, send commands
that act on the browser (`/voice`, `/call`, `/direct`, `/clear`), take over `/ns`, `/identify`, `/oper` and the
other commands people type passwords into, or write in a direct chat. The browser test has a plugin try each
route out that the authors could think of, and checks the test website never hears from it.

**The IRC network or the bouncer reading private conversations.** They can read channel and query traffic, as
they always can. Direct chat, file transfer and voice go browser to browser over WebRTC; the IRC network
carries only the offer and answer. Both sides are shown a code made from both certificate fingerprints, which
they can compare over another channel to know nobody in between changed the connection. TURN credentials given
to browsers expire; the shared secret never leaves the bouncer.

**Someone who gets the database.** Network passwords, SASL passwords, client certificates and the push key are
encrypted with AES-256-GCM under `secret.key`. The database and its side files are readable only by the
bouncer's user. Keep the key and the database in separate backups if you can, since together they read
everything. Account passwords are hashed, not encrypted.

## What was tested

- Go unit tests with the race detector, covering rate limits, headers, the media proxy (including SSRF cases
  and files that lie about their type), the network editor (including another account's networks, private
  addresses, line breaks, secrets never being returned), cookie sessions and SASL.
- Integration tests against a real Ergo server.
- Browser tests in real Chromium: cookies not readable from script, no password stored in the page, the
  plugin sandbox, the media proxy ("the browser never contacted the linked site"), the network editor.
- `govulncheck` and `npm audit` run in CI on every push and daily, and pass. CodeQL for Go and TypeScript runs through
  GitHub's code scanning default setup, so its results are on the repository's Security tab, not in the workflows.

Problems found by this testing during phase 8, and fixed: a plugin could reach the network through a function
recovered from the prototype chain; a plugin's `send` could issue commands that act on the browser; a plugin
that never answered was not stopped; the sample proxy configuration added a frame-denial header that would
have stopped plugins from running; ten simultaneous logins pushed memory to about 200 MB.

## What is not covered

- **The bouncer holds your plugins' code.** They are kept on your account so they follow you, which means anyone who can
  act as your account (a stolen session, or the operator) can change them. They remain inside the sandbox and the
  permissions you granted, but with `send` that is speaking as you, which that person could do anyway.
- **A plugin you install can read your channels and speak as you if you grant it `events` and `send`.** The
  sandbox stops it leaving the browser and touching the page; it does not stop it misusing what you gave it.
  Install code you trust.
- **A compromised browser, or a browser extension, can do anything the page can.**
- **The operator can read everything.** The bouncer holds the keys and sees plaintext IRC.
- **Denial of service is limited, not prevented.** There are rate limits and size caps, but a determined
  flood from many addresses is for the reverse proxy and firewall.
- **Direct chat and voice reveal each person's network address to the other**, as WebRTC does, once they
  accept; a TURN server hides it at the cost of relaying. Nothing is connected before acceptance.
- **Untested:** the Docker image and Compose files, the GitHub workflows, a real TURN server across real
  NATs, Firefox and Safari, hundreds of simultaneous users, and long-running behaviour.
- **No outside review.** Nobody independent has audited this.
