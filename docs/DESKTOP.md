# Desktop app

A Linux and Windows desktop version of the client, built with [Tauri](https://tauri.app), as one executable (an AppImage on
Linux, a single `.exe` on Windows). It can connect to a bouncer you run elsewhere, or run one itself.

Status: **built.** Linux uses Electron and Windows uses Tauri, because Linux's own web view has no WebRTC (below). Both show the same
launcher page (`desktop/ui/index.html`) and do the same: connect to a bouncer elsewhere, or start the one the app carries.

- **Linux (Electron, `desktop/electron/`):** checked here. The launcher runs, WebRTC is complete (the headless check finds
  `RTCPeerConnection`, a data channel, an offer with a fingerprint), and `desktop/test/electron-smoke.cjs` drives the real app:
  start local mode, reach the bouncer's login page, log in through the real client, and check that the bouncer's page is given no
  way to talk to the app. Build it with `cd desktop && npm ci && npm run build:linux` (an AppImage in `dist-electron/`).
- **Windows (Tauri, `desktop/src-tauri/`):** compiles on Linux, but is untried on Windows. WebView2 is Chromium, so WebRTC should
  be complete. Build it with `npm run build`.

`.github/workflows/desktop.yml` builds both on their own runners and runs the Linux smoke test. It is the first run of that
workflow that will show whether the AppImage and the Windows installer build.

## The tray

Both apps put an icon in the system tray. Clicking it shows or hides the window; its menu has *Show Gestalt*, *Change server…*,
a switch for whether closing the window keeps the app in the tray, and *Quit*. By default **closing the window hides it to the
tray** and the app stays connected; *Quit* (tray or app menu) really quits. On Linux, launching the app a second time brings the
first back, so a hidden window is never lost. Linux caveat: GNOME shows tray icons only with the AppIndicator extension, so on
a stock GNOME desktop the icon may not be visible; turn the switch off there so closing quits, or use a second launch to bring
the window back.

## Two ways to run

- **Remote.** A first-run "Server address" prompt, remembered afterwards. The window then shows that bouncer's web page, so
  cookies, `/api`, `/ws` and the content security policy all work as they do in a browser, and YouTube embeds still get a real
  origin as referrer. No change to the bouncer is needed.
- **Local.** The app starts the Go bouncer as a sidecar process on `127.0.0.1` (a random port, data in the user's app-data
  directory, a generated secret key, one account made for the user on first run) and shows its page. It stops with the app.
  That the bouncer is offline when the computer is off is accepted: this mode is for people who do not run a server.

Both can be set up, and the user can switch between them from the app's menu.

## Build plan

1. `desktop/` with a Tauri 2 project. The Rust side stays small: choose remote or local, start and stop the sidecar, wait for it to
   answer on its port, open the window, keep a single instance.
2. The bouncer binary is built for each target (`GOOS`/`GOARCH`, pure Go with modernc SQLite, no cgo) and bundled with the app as a
   resource, next to a copy of `web/dist` that the bouncer serves through `web_dir`.
3. The webview must allow the microphone for the bouncer's origin and nothing else, and refuse to navigate anywhere else.
4. CI: a matrix on Linux and Windows runners that builds the sidecar and the app and uploads the AppImage and `.exe` to releases.
5. Desktop extras once it runs: a tray icon, start on login, an unread badge, and a system-wide push-to-talk key (which a
   browser cannot offer).

## Why Linux uses Electron

The launcher checks what the web view can do. The Tauri build, headless on Ubuntu 24.04, found WebKitGTK 2.52 with the microphone
and audio API but **no `RTCPeerConnection` at all**: Ubuntu and Debian build WebKitGTK without WebRTC, and the app's own settings
cannot add it. A Tauri Linux app would have had no voice, no direct chat and no files. Electron carries Chromium, and the same
check on it finds everything. (The Tauri code still builds on Linux and shows a warning in the launcher if WebRTC is missing.)

## Other things to remember

- Web Push does not work in a desktop webview, so notifications come from the app while it is running.
- Signing: an unsigned Windows build shows a SmartScreen warning. A code-signing certificate costs about $100 to $400 a year.
  AppImages on newer distributions need FUSE.
- Auto-update can come from Tauri's updater, with signed update manifests on the releases page.
- A remote self-signed certificate needs an explicit "trust this fingerprint" step in the app.
