# Desktop app (planned)

A Linux and Windows desktop version of the client, built with [Tauri](https://tauri.app), as one executable (an AppImage on
Linux, a single `.exe` on Windows). It can connect to a bouncer you run elsewhere, or run one itself.

Status: **not built yet.** This is the plan, written down so it survives a change of plans.

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

## The risk to settle first: WebRTC in the webview

Tauri uses the system webview. On Windows that is WebView2 (Chromium), which has full WebRTC. On Linux it is WebKitGTK, whose
WebRTC and microphone support depends on the distribution's build and on settings (`enable-webrtc`, `enable-media-stream`) that
the app has to switch on, and which can still fall short (codecs, PipeWire, permission prompts). **Before building anything else,
build a minimal Tauri window on Linux that loads the client and passes the existing voice and direct-chat browser tests.** If
WebKitGTK cannot do it well enough, the Linux build falls back to a bundled Chromium-based shell (Electron) while Windows stays
on Tauri.

## Other things to remember

- Web Push does not work in a desktop webview, so notifications come from the app while it is running.
- Signing: an unsigned Windows build shows a SmartScreen warning. A code-signing certificate costs about $100 to $400 a year.
  AppImages on newer distributions need FUSE.
- Auto-update can come from Tauri's updater, with signed update manifests on the releases page.
- A remote self-signed certificate needs an explicit "trust this fingerprint" step in the app.
