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

```bash
npm --prefix web run build
test/e2e/run.sh
```

It needs Go, Node, Python 3 and Playwright. Install Playwright with
`npm i -g playwright`, or point `PLAYWRIGHT_MODULE` at it. Set `CHROMIUM_PATH` to use
a Chromium you already have. On a CI machine or a container running as root, set
`NO_SANDBOX=1`. `OUT_DIR` keeps the screenshots.

`fake_irc.py` plays the other people. A message starting with `!` asks it to act:
`!msg TEXT` (alice says TEXT), `!typing`, `!away`, `!back`. The `#bulk` channel holds
800 old messages.
