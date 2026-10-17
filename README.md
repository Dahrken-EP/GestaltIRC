<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img alt="Gestalt" src="docs/assets/logo-light.png" width="420">
  </picture>
</p>

A self-hosted IRC bouncer with a compact web client. The bouncer keeps you connected to your IRC networks and keeps the history; the client runs in any browser, on a phone or a desktop, and adds direct chat, file transfer, voice and plugins. A gestalt is a whole that is more than its parts: IRC, kept alive by the bouncer, seen through one client, with the people on it able to reach each other directly.

The server is Go and the client is Svelte. Any other IRC client can use the same bouncer.

## Screenshots

**Managing servers.** The bar on the left has one icon per server and a **+** that always adds another. Click the server you are on for its menu: edit, switch off (it stays in the bar, dimmed, so you can switch it back on) or remove.
<p align="center">
  <img src="docs/assets/screenshot-servers.png" alt="The server bar with three servers, one switched off, a + button, and the menu for the selected server" width="900">
</p>

The server dialog has the server's details first, then who you are (with alternative nicks), how you log in, what to do after connecting, and the highlight words and notifications for that server only.
<p align="center">
  <img src="docs/assets/screenshot-server-dialog.png" alt="The Add a server dialog, filled in" width="420">
</p>

**Pictures and gifs in the conversation**, one after another: a picture link, a Giphy page, a plain gif link and an imgur page. Your browser never contacts those sites; the bouncer fetches them.
<p align="center">
  <img src="docs/assets/screenshot-media-images.png" alt="A chat with an image, a Giphy gif, a gif link and an imgur picture, each shown under the message that linked it" width="560">
</p>

**Sound, video and links**: an audio player for a sound file, a card for a YouTube link (nothing loads from YouTube until you press play), and a preview card for any page.
<p align="center">
  <img src="docs/assets/screenshot-media-embeds.png" alt="A chat with an audio player, a YouTube card and a link preview card" width="560">
</p>

**Direct chat** between two browsers, with file transfer. The safety code and certificates stay out of sight until you press Verify.
<p align="center">
  <img src="docs/assets/screenshot-direct.png" alt="A direct chat with a finished file transfer" width="900">
</p>

**Settings**, with a tab for each kind of thing: General, Appearance, Notifications, Highlights, Media and Plugins.
<p align="center">
  <img src="docs/assets/screenshot-settings-general.png" alt="Settings, General" width="300">
  <img src="docs/assets/screenshot-settings-appearance.png" alt="Settings, Appearance" width="300">
  <img src="docs/assets/screenshot-settings-notifications.png" alt="Settings, Notifications" width="300">
</p>
<p align="center">
  <img src="docs/assets/screenshot-settings-highlights.png" alt="Settings, Highlights" width="300">
  <img src="docs/assets/screenshot-settings-media.png" alt="Settings, Media" width="300">
  <img src="docs/assets/screenshot-settings-plugins.png" alt="Settings, Plugins" width="300">
</p>

## Get it
Gestalt has two parts: the **bouncer** (a small server that stays connected to IRC for you, and serves the web client) and the
**clients** that show it: any web browser, or the desktop apps. Everything is on the **[releases page](https://github.com/Dahrken-EP/GestaltIRC/releases/latest)**.

| You want | Get |
|---|---|
| to run the bouncer (a server, or your own computer) | **Docker**, below, from this repository |
| the web client, to host it yourself | `gestalt-web-<version>.zip` on the releases page (the bouncer serves it with `web_dir`; the Docker image already includes it) |
| a desktop app for Linux | `Gestalt-<version>.AppImage` on the releases page |
| a desktop app for Windows | `Gestalt_<version>_x64-setup.exe` on the releases page |

## Desktop apps
Both desktop apps connect to a bouncer you run elsewhere (the address is remembered), or start a bouncer of their own on your
computer, which is connected to IRC only while the app is open. Linux uses Electron and Windows uses Tauri; see **[docs/DESKTOP.md](docs/DESKTOP.md)**.

- **Linux:** download **[Gestalt-0.1.3.AppImage](https://github.com/Dahrken-EP/GestaltIRC/releases/download/v0.1.3/Gestalt-0.1.3.AppImage)**, then `chmod +x Gestalt-0.1.3.AppImage && ./Gestalt-0.1.3.AppImage`. On a recent distribution you may need FUSE 2 (`sudo apt install libfuse2`).
- **Windows:** download **[Gestalt_0.1.3_x64-setup.exe](https://github.com/Dahrken-EP/GestaltIRC/releases/download/v0.1.3/Gestalt_0.1.3_x64-setup.exe)** and run it. The installer is not signed yet, so Windows SmartScreen will warn: choose *More info*, then *Run anyway*.
- Newer versions are always on the **[releases page](https://github.com/Dahrken-EP/GestaltIRC/releases/latest)**.

## Run the bouncer with Docker
You need Docker with the Compose plugin (`docker compose version`), and `git`.

### Try it on your own machine
One container, no HTTPS, reachable only from this computer:

    docker build -t gestalt https://github.com/Dahrken-EP/GestaltIRC.git
    docker run -d --name gestalt -p 127.0.0.1:8080:8080 -v gestalt-data:/data gestalt
    echo 'a-long-password' | docker exec -i gestalt bouncer user add alice

Open <http://localhost:8080>, log in as `alice`, and press **Add a server** (Libera is `irc.libera.chat`, port 6697, TLS). The first
start creates the database and secret key in the `gestalt-data` volume. Back that volume up: the key protects your saved passwords.

### On a server, with HTTPS and voice
`docker-compose.yml` runs the whole stack: the bouncer and web client, [Caddy](https://caddyserver.com) for HTTPS (it gets and
renews the certificate by itself), and [coturn](https://github.com/coturn/coturn) so that direct chat, file transfer and voice work
between people behind NATs. Step by step:

1. **Get a server and a name.** Any Linux machine with Docker and a public address will do. Make a DNS record (for example
   `irc.example.org`) that points at it. Caddy cannot get a certificate until the name resolves.
2. **Open the firewall.** With `ufw` (note the colon in a port range, and `sudo`):

        sudo ufw allow 80/tcp
        sudo ufw allow 443
        sudo ufw allow 3478
        sudo ufw allow 49152:49252/udp

   | Port | Used by | For |
   |---|---|---|
   | 80/tcp | Caddy | the certificate challenge, and the redirect to HTTPS |
   | 443/tcp and 443/udp | Caddy | the web client (udp is HTTP/3) |
   | 3478/udp and 3478/tcp | coturn | STUN and TURN |
   | 49152-49252/udp | coturn | the relay range for media that cannot go direct |
   | 5349/tcp | coturn | TURN over TLS, once you give it a certificate (optional) |

   The bouncer's own port, 8080, is never published. A cloud provider's own firewall (security groups) needs the same ports.
3. **Get the code and configure it.**

        git clone https://github.com/Dahrken-EP/GestaltIRC.git
        cd GestaltIRC
        cp .env.example .env
        nano .env

   Set `DOMAIN` to your name. Set `PUBLIC_IP` to the server's public address if it sits behind NAT, as most cloud servers do (the
   provider's dashboard shows it); without it voice and file transfer fail for people on other networks. `ADMIN_EMAIL` is the
   contact push services are given. The other lines are explained in the file.
4. **Start it.**

        docker compose up -d
        docker compose ps

   The first start builds the image, creates the database and secret key in a volume, and writes the bouncer's and coturn's
   configuration. `docker compose logs -f bouncer` shows it running, and `docker compose logs caddy` the certificate being issued.
   `docker compose ps -a` also lists a `setup` container with the status *Exited (0)*. That is expected: it is a one-off job
   that writes the configuration and stops. Once the stack is up you can tidy it away (it is only a stopped container; the
   configuration lives in a volume and is kept):

        docker compose rm -f setup

   It is a container of its own on purpose. The bouncer image has no shell, so it cannot run the setup script; and only this job
   needs to write the configuration, which lets the bouncer and coturn mount it read-only. A bouncer that could rewrite its own
   settings and the TURN secret is a bigger target if it is ever compromised. The cost is one stopped container. `docker compose up`
   runs the job again (it never overwrites a file that is already there), so remove it again after an update if you want the list
   tidy.
5. **Make your account.** The password is read from standard input, so it is not left in your shell history's arguments:

        echo 'a-long-password' | docker compose exec -T bouncer bouncer user add alice

6. **Log in** at `https://irc.example.org`, press **Add a server**, and fill it in. You can add more servers any time with the **+**
   in the left bar. Everything else (alternative nicks, passwords, SASL, certificates) is in that dialog.
7. **Check voice** by joining a voice room from two different networks (a phone on mobile data is a good second one). If it will
   not connect, see the coturn notes in [deploy/README.md](deploy/README.md).

**Already have Traefik, nginx or another proxy handling HTTPS?** Leave Caddy out by adding a second file to every `docker compose`
command: `-f docker-compose.yml -f docker-compose.traefik.yml` (set `TRAEFIK_NETWORK`, `TRAEFIK_ENTRYPOINT` and
`TRAEFIK_CERTRESOLVER` in `.env` to match yours), or `-f docker-compose.yml -f docker-compose.proxy.yml` for any other proxy (it
publishes the bouncer on `127.0.0.1:8081`). Keep the same files for every later command.

**Updating.** Back up first (the update may change the database), then:

    git pull
    docker compose build --pull
    docker compose up -d

then hard-refresh the browser (Ctrl+Shift+R). Your `.env`, accounts and history stay in their volumes.

**Backing up.** The data volume holds the database and the secret key, which belong together: a database without its key
cannot decrypt the saved passwords. `docker volume ls` shows the volume's name (`gestalt_data` with the project name `gestalt`):

    docker run --rm -v gestalt_data:/data -v "$PWD":/backup alpine tar czf /backup/gestalt-data-$(date +%F).tgz -C /data .

**Running other commands.** `docker compose exec bouncer bouncer user list`, `... user passwd NAME`, `... user remove NAME`, and
`... network add ...` are described in [docs/BUILDING.md](docs/BUILDING.md). Settings live in `bouncer.yaml` in the config volume
(for example `disable_guests: true`); [docs/SERVER.md](docs/SERVER.md) lists them.

**If something is wrong**

| What you see | Look at |
|---|---|
| the page does not load, or a certificate warning | DNS points at the server; ports 80 and 443 are open; `docker compose logs caddy` |
| log in works, a server will not connect | the status window in the web client, which says why (for example a plain-text port with *Use TLS* ticked) |
| voice or direct chat fails between networks | `PUBLIC_IP` is set; 3478 and 49152:49252/udp are open in the machine's and the provider's firewall |
| guest links are not offered | Settings, General, Guests: they are off until you switch them on |
| anything else | `docker compose logs --tail=100 bouncer` |

[deploy/README.md](deploy/README.md) has the full detail, including what has and has not been tested.

## Features
- **Many servers, one login.** Each server has its own icon in the left bar, with channels, queries and a status window. Unread counts are grey, mentions are coloured, and the tab title shows the total. The **+** adds a server; click the one you are on to edit, switch off or remove it. A server can have a server password, alternative nicks (tried in order when the first is taken), SASL PLAIN or SCRAM or a NickServ password, channels to join, and commands to run after connecting, plus highlight words and notifications of its own. A server with a self-signed certificate, or one from a private authority, can be accepted with one switch: the bouncer remembers the first certificate it sees and refuses a different one later.
- **Always connected.** Close the browser and the bouncer stays on IRC. When you come back you get the messages you missed, and older ones by scrolling up (`CHATHISTORY`). The list draws only the rows near the view, so a channel with thousands of lines stays light: ten channels of 2000 messages each use about 16 MB in the browser.
- **Your settings follow you.** Reading a channel on your laptop clears it on your phone. Preferences, highlight words, each server's settings and your installed plugins (with what they store) are kept on the bouncer, so a new browser has them as soon as you log in. The one exception is permission for desktop notifications, which each browser grants for itself.
- **Notifications.** Mentions and private messages raise a desktop notification while the page is open. With Web Push, the bouncer notifies your browser even when the tab is closed and no client is connected.
- **Inline media.** Pictures (PNG, JPG, GIF, WEBP, AVIF, plus imgur and Giphy links) and video (MP4, WEBM, imgur GIFV) show in the chat, and sound files (MP3, OGG, OPUS, WAV, FLAC, M4A) get a player. Other links get a title and a picture. YouTube and Streamable show a card, and nothing loads from them until you press play. Your browser never contacts the linked site: the bouncer fetches it, so the site never sees your address. Each kind can be turned off.
- **Direct chat and file transfer.** `/direct NICK` asks someone to connect browser to browser over WebRTC. Nothing is connected until they accept. Chat and files then go straight between you, are not stored anywhere, and both sides can open a safety code to compare over another channel (**Verify**), so nobody in between, including the IRC server and the bouncer, can alter the connection unnoticed. Files are accepted one by one and checked against a SHA-256.
- **Voice.** Press **Join voice** in any channel to talk with up to ten people at once, with no media server: everyone connects to everyone. You see who is speaking, can mute, and set each person's volume. `/call NICK` rings one person privately.
- **Plugins.** Aliases, event hooks, timers and storage, written in JavaScript, run in a sandbox and limited to the permissions you grant. See [docs/PLUGINS.md](docs/PLUGINS.md).
- **Replies, reactions, typing.** Reply to a message, react with emoji, delete your own messages, and see who is typing (off until you turn it on). Away members are dimmed.
- **Commands.** Every IRC command works, and `/help` lists the built-in ones. Anything the client does not recognise is sent to the server as it is.
- **Nick colours.** Automatic per nick, with overrides in Settings. Your nick and any highlight words colour the line and raise a badge.
- **Themes.** Light, dark or follow the system, in compact or comfortable density.
- **Emoji.** The smiley beside the input, or Ctrl+E, opens all 1,900 emoji with search, recently used and groups. Type `:tada:` and it becomes 🎉 when you close the colon; type `:tad` and a list offers matches (Up/Down to choose, Tab or Enter to take one, Esc to dismiss). Times like 10:30 and links are left alone. The emoji list is a separate download, fetched the first time it is needed.
- **Keyboard.** Ctrl+K jumps to any channel on any network. Ctrl+F searches the messages of the channel you are in (`from:nick` narrows it to one person). Alt+A goes to the next unread, mentions first. Alt+Up and Alt+Down switch buffers. Tab completes nicks, channels and commands, and Up and Down recall what you typed. A button takes you back to the latest message when you have scrolled up.
- **Guests.** Switch it on in Settings and someone with no account and no Gestalt can join you from a browser. Joining a voice room says so in the channel, with a link; a direct chat or call that nobody's client answers sends them a one-time link by private message. They give a name, press connect, and are in: a guest in a voice room is listed for everyone, marked as a guest, and talks through your browser. See **[docs/GUESTS.md](docs/GUESTS.md)**.
- **Installable.** A browser can install it as an app on a phone or desktop. When the browser offers it, a ⬇ button appears at the bottom of the server bar, and Settings, General says how to do it in a browser that does not (Safari, for one). It needs the bouncer, so there is no offline mode.
- **Your layout.** Drag the bars between the columns to resize the channel list and the member list (arrow keys work too, and double-click puts a bar back). The server bar can be hidden with the ‹ button, leaving a thin strip to bring it back. Widths are remembered per browser.
- **Right-click a name** in the member list (or press the menu key on it) for message, direct chat, voice call, who is, client version and copy, and, if you are an operator, give or take operator and voice, kick, and ban and kick.

## Plugins
A plugin is one JSON document, pasted into **Settings, Plugins**; it is kept on your account and follows you to other browsers. You see what it asks for and can untick any permission before it is installed. This one adds `/greet`:

    {
      "name": "greeter", "version": "1.0.0", "description": "Adds /greet.",
      "permissions": ["send"],
      "source": "irc.alias('greet', function (args, ctx) { irc.send('Hello, ' + (args[0] || ctx.nick) + '!', ctx.buffer) })"
    }

Plugins can react to messages, joins, parts, kicks, nick changes, topics and more, add their own commands, use timers, keep data and, if you allow it, ask you questions in a window the client draws and labels. They cannot reach the network or the page, and cannot send commands that act on your browser or ask for passwords. **[Plugin guide and API reference](docs/PLUGINS.md)**

## Use other IRC clients
The bouncer speaks IRCv3 to clients, and the web client is one of them. An IRCv3 client such as HexChat or WeeChat can log in as `user/network` with SASL PLAIN, get the history it missed, and share one network connection with the web client. This is tested with the project's own scripted clients and a real Ergo server, not yet with those programs themselves. **[docs/SERVER.md](docs/SERVER.md)** lists the capabilities offered and the ones deliberately not.

## Security
IRC text is never rendered as HTML, and the page has a strict content security policy. Passwords are hashed with argon2id, saved network passwords are encrypted, and the bouncer fetches links for you but refuses to reach private addresses. Plugins run in a sandbox that cannot connect anywhere, and the browser tests try to get out of it. Dependencies are scanned daily, and the code is scanned with CodeQL. To report a problem privately, and to see what is and is not covered, read **[SECURITY.md](SECURITY.md)**.

## Roadmap
Not built yet:
- **A desktop app** for Linux (Electron) and Windows (Tauri): one executable that connects to a bouncer elsewhere, or starts one of its own. Built in `desktop/`; Linux is tested here, Windows is not yet. See **[docs/DESKTOP.md](docs/DESKTOP.md)**.
- **Plugins that run on the server.**
- **Multiline messages** (`draft/multiline`).
- **DCC.** Direct chat and file transfer use WebRTC, so people on other IRC clients cannot be sent files this way.

Reactions, replies and typing need the IRC network to support message tags.

## Build from source
See **[docs/BUILDING.md](docs/BUILDING.md)** for requirements, running it without Docker, the admin commands and the tests, and [DESIGN.md](DESIGN.md) for how it is put together and why.

    docker build -t gestalt .

The server's Go module is still called `gestalt/server`, and the binary `bouncer`.
