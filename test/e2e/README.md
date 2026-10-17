# Browser tests

`run.sh` starts a real bouncer and a scripted IRC network, then drives the built
web client in Chromium. It checks what unit tests cannot: that the pieces work
together in a browser.

What it covers:

- login, the session cookie (HttpOnly, SameSite=Strict), no password kept in the page, reload and logout
- a channel: topic, members, mentions, links, message text never becoming markup
- reply, reaction and delete on messages, the typing indicator, away members
- preferences following the account to a second browser
- read position following the account between two browsers
- an 800-message channel in the windowed list: only a window of rows in the page, the
  view not jumping when older messages load, the input bar staying on screen
- the service worker turning a push into a notification, and the push switch failing politely
- layout at phone width
- a voice room of three browsers (Chromium's fake microphone, real WebRTC audio): joining, everyone
  connected to everyone, the speaking indicator lighting from the other side's audio, mute, leaving,
  audio continuing in another window, and a private call: ring, answer, hear each other, hang up, decline
- pictures, video, link previews and the YouTube card, and that the browser never contacts a linked site
- a direct chat between two logged-in browsers over real WebRTC (loopback): the request and acceptance,
  matching safety codes, chat both ways, a 300 KB file saved byte for byte, declined and empty files,
  hanging up and starting again

```bash
npm --prefix web run build
test/e2e/run.sh
VOICE_LOAD=1 test/e2e/run.sh   # instead: ten browsers in one voice room, an eleventh turned away
```

It needs Go, Node, Python 3 and Playwright. Install Playwright with
`npm i -g playwright`, or point `PLAYWRIGHT_MODULE` at it. Set `CHROMIUM_PATH` to use
a Chromium you already have. On a CI machine or a container running as root, set
`NO_SANDBOX=1`. The push test needs a Chromium that honours a notification permission grant, which
Playwright's headless shell does not; `run.sh` picks a full Chromium from `PLAYWRIGHT_BROWSERS_PATH`
when there is one. `OUT_DIR` keeps the screenshots.

`fake_irc.py` plays the other people. A message starting with `!` asks it to act:
`!msg TEXT` (alice says TEXT), `!typing`, `!away`, `!back`. It also passes messages between three real
logins (`matt`, `jane` and `kim`) and into the channels they have joined, which is how the direct chat test gets its signalling across. The `#bulk` channel holds
800 old messages.
