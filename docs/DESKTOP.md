# Desktop app

A Linux and Windows desktop version of the client, built with [Tauri](https://tauri.app), as one executable (an AppImage on
Linux, a single `.exe` on Windows). It can connect to a bouncer you run elsewhere, or run one itself.

Status: **first version built** in `desktop/` (Tauri 2). It compiles on Linux, the launcher runs, and the local mode's steps
(make the files, add the account, serve the web client, log in) were checked by hand against the bundled bouncer. **WebRTC does
not work in the Linux webview** (see below), so the Linux build cannot yet do voice or direct chat. Windows is untested here.

Build it with `cd desktop && npm ci && npm run build`, which builds the bouncer and web client it carries (`build-sidecar.sh`)
and then runs `tauri build`. `.github/workflows/desktop.yml` does the same on Linux and Windows runners.

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
2. The bouncer binary is built for each target (`GOOS`/`GOARCH`, pure Go with modernc SQLite, no cgo) and bundled as a Tauri
   sidecar. `web/dist` is embedded in it through `web_dir` pointing at an extracted copy, or served from the sidecar's own files.
3. The webview must allow the microphone for the bouncer's origin and nothing else, and refuse to navigate anywhere else.
4. CI: a matrix on Linux and Windows runners that builds the sidecar and the app and uploads the AppImage and `.exe` to releases.
5. Desktop extras once it runs: a tray icon, start on login, an unread badge, and a system-wide push-to-talk key (which a
   browser cannot offer).

## What was found about WebRTC in the webview

The launcher checks what the webview can do and shows a warning if voice and direct chat cannot work. Run headless with
`GESTALT_DIAG=1 xvfb-run target/debug/gestalt-desktop` to print the result.

- **Linux, WebKitGTK 2.52 from Ubuntu 24.04:** `RTCPeerConnection`, `RTCDataChannel` and the prefixed form are all
  **undefined**, although the microphone (`getUserMedia`), `MediaStream` and the audio API are there. Ubuntu and Debian build
  WebKitGTK without WebRTC, and the app's own settings (`enable-webrtc`) cannot add what the build left out. So a Tauri
  Linux app that uses the system webview has no voice, no direct chat and no files on these systems.
- **Windows, WebView2:** Chromium, so it should be complete. Not yet tried.

## Decision needed for Linux

1. **Tauri with the Chromium Embedded Framework** (an experimental community runtime for Tauri). One code base, WebRTC like Chrome,
   but the AppImage grows to about 200 MB and the runtime is young.
2. **Electron for Linux only.** Windows stays on Tauri. Two shells to maintain, but Electron is proven and has full WebRTC.
3. **Tauri as it is, with voice and direct chat off on Linux** until distributions ship WebKitGTK with WebRTC, and a message
   in the launcher saying so. The smallest and fastest; the Linux app would be a plain IRC client.

## Other things to remember

- Web Push does not work in a desktop webview, so notifications come from the app while it is running.
- Signing: an unsigned Windows build shows a SmartScreen warning. A code-signing certificate costs about $100 to $400 a year.
  AppImages on newer distributions need FUSE.
- Auto-update can come from Tauri's updater, with signed update manifests on the releases page.
- A remote self-signed certificate needs an explicit "trust this fingerprint" step in the app.
