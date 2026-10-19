// Gestalt on the desktop: a window around the web client. It either shows a bouncer someone runs elsewhere, or
// starts the bouncer that comes with the app and shows that one. The launcher page, which is part of the app, is
// where that is chosen; everything after it is the bouncer's own page, exactly as a browser would show it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The experimental native media stack lives behind this: the web client's voice and
// calls are handled here on Linux, instead of by WebKitGTK's WebRTC. Everything the
// module registers is Linux-only with it.
#[cfg(target_os = "linux")]
mod media;

use std::{
    fs,
    io::Write,
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    /// "", "remote" or "local".
    mode: String,
    /// The remote bouncer's address.
    url: String,
    /// The port the local bouncer used last, kept so its address (and so the cookies the page holds) stays the same.
    port: u16,
    /// The account made for local mode.
    user: String,
    /// Closing the window hides it to the tray instead of quitting.
    #[serde(default = "yes")]
    close_to_tray: bool,
}

fn yes() -> bool {
    true
}

/// The live-check driver, evaluated against the page every couple of seconds until
/// nothing is left to do: submit the launcher form, sign in, open the room, join voice.
/// It looks at shapes, not words — the form ids the launcher owns, the autocomplete
/// attributes the login form owns, the voice section's own class and button count — so
/// word changes in any language leave it working.
const DRIVER_JS: &str = r#"
;(function () {
  if (location.protocol.startsWith('tauri')) {
    const f = document.querySelector('#remote-form')
    if (f) f.requestSubmit()
    return 'launcher'
  }
  const u = document.querySelector('input[autocomplete="username"]')
  if (u) {
    const p = document.querySelector('input[type="password"]')
    if (p && !p.value) {
      if (!u.value) {
        u.value = '__USER__'
        u.dispatchEvent(new Event('input', { bubbles: true }))
      }
      p.value = '__PASS__'
      p.dispatchEvent(new Event('input', { bubbles: true }))
      setTimeout(() => {
        if (u.form) u.form.requestSubmit()
      }, 80)
      return 'login sent'
    }
  }
  if (!document.querySelector('section.voice')) {
    const spots = [...document.querySelectorAll('a,button,li,div,span')].filter(
      (e) => e.textContent.trim() === '#chat' && e.offsetParent && !e.firstElementChild,
    )
    if (spots.length) {
      spots[spots.length - 1].click()
      return 'opened #chat'
    }
  }
  const sec = document.querySelector('section.voice')
  const buttons = sec ? [...sec.querySelectorAll('button')] : []
  const on = sec ? sec.classList.contains('on') : false
  if (sec && !on && buttons.length > 1) {
    // Not on, more than one button: the join pair. One button alone is cancel while
    // joining; the road in is only when the panel offers both ways.
    buttons[0].click()
    return 'joined'
  }
  if (!sec || !on) {
    return JSON.stringify({ login: !!u, voice: !!sec, on: null, buttons: buttons.length })
  }
  // In the room: exercise the controls a person would — mute, unmute, leave — spaced
  // out by the tick, so one round covers talking, quiet, and a clean goodbye.
  window.__GC = (window.__GC ?? 0) + 1
  const tick = window.__GC
  const find = (prefix) => buttons.find((b) => b.textContent.trim().startsWith(prefix))
  if (tick > 4 && !window.__GM1) {
    const mute = find('Mute')
    if (mute) {
      mute.click()
      window.__GM1 = true
      return 'muted'
    }
  }
  if (tick > 6 && !window.__GM2) {
    const unmute = find('Mute')
    if (unmute) {
      unmute.click()
      window.__GM2 = true
      return 'unmuted'
    }
  }
  if (tick > 8 && !window.__GLV) {
    const leave = find('Leave voice')
    if (leave) {
      leave.click()
      window.__GLV = true
      return 'left'
    }
  }
  const people = [...document.querySelectorAll('[data-testid="voice-person"]')].map((li) => ({
    who: li.textContent.trim().slice(0, 18),
    st: li.getAttribute('data-state'),
  }))
  return JSON.stringify({ on, people })
})()
"#;

struct App {
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    child: Mutex<Option<Child>>,
    /// The address of the launcher page, to come back to.
    launcher: Mutex<Option<Url>>,
    /// The one address the window may show besides the launcher.
    allowed: Mutex<Option<Url>>,
}

impl App {
    fn save(&self) {
        let s = self.settings.lock().unwrap().clone();
        if let Some(dir) = self.settings_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&self.settings_path, serde_json::to_vec_pretty(&s).unwrap_or_default());
    }

    fn stop_local(&self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[derive(Serialize)]
struct State_ {
    settings: Settings,
    /// Whether this build carries a bouncer, so local mode is on offer.
    local: bool,
    /// Whether the account for local mode exists.
    local_ready: bool,
}

fn resources(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("GESTALT_RESOURCES") {
        return PathBuf::from(p);
    }
    app.path().resource_dir().map(|d| d.join("resources")).unwrap_or_default()
}

fn bouncer_exe(res: &Path) -> PathBuf {
    res.join(if cfg!(windows) { "bouncer.exe" } else { "bouncer" })
}

fn local_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_default().join("bouncer")
}

#[tauri::command]
fn get_state(app: AppHandle, st: State<App>) -> State_ {
    let res = resources(&app);
    State_ {
        settings: st.settings.lock().unwrap().clone(),
        local: bouncer_exe(&res).exists(),
        local_ready: local_dir(&app).join("bouncer.db").exists(),
    }
}

fn show(win: &WebviewWindow, st: &App, url: &Url) -> Result<(), String> {
    *st.allowed.lock().unwrap() = Some(url.clone());
    win.navigate(url.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
fn connect_remote(window: WebviewWindow, st: State<App>, url: String) -> Result<(), String> {
    let mut u = Url::parse(url.trim()).map_err(|_| "That is not a web address. Try https://irc.example.org".to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err("The address must start with https:// (or http:// on a trusted network).".into());
    }
    u.set_path("/");
    u.set_query(None);
    u.set_fragment(None);
    st.stop_local();
    {
        let mut s = st.settings.lock().unwrap();
        s.mode = "remote".into();
        s.url = u.to_string();
    }
    st.save();
    show(&window, &st, &u)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(18199)
}

fn port_free(port: u16) -> bool {
    port != 0 && TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn run_bouncer(exe: &Path, config: &Path, args: &[&str], stdin: Option<&str>) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-config").arg(config).args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start the bouncer: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        if let Some(text) = stdin {
            let _ = writeln!(si, "{text}");
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().lines().last().unwrap_or("the bouncer failed").to_string())
    }
}

/// Starts the bouncer that comes with the app, making its files and the user's account the first time.
fn start_bouncer(app: &AppHandle, st: &App, user: &str, password: &str) -> Result<Url, String> {
    let res = resources(app);
    let exe = bouncer_exe(&res);
    if !exe.exists() {
        return Err("This build of the app does not carry a bouncer.".into());
    }
    let dir = local_dir(app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config = dir.join("bouncer.yaml");

    let port = {
        let last = st.settings.lock().unwrap().port;
        if port_free(last) { last } else { free_port() }
    };
    let quote = |p: &Path| p.to_string_lossy().replace('\'', "''");
    let yaml = format!(
        "listen: '127.0.0.1:{port}'\ndata_dir: '{}'\nweb_dir: '{}'\n# The bouncer runs on the user's own computer, so what it may reach is the user's business.\nallow_private_networks: true\n",
        quote(&dir),
        quote(&res.join("web")),
    );
    fs::write(&config, yaml).map_err(|e| e.to_string())?;

    if !dir.join("bouncer.db").exists() {
        run_bouncer(&exe, &config, &["init"], None)?;
    }
    if !user.is_empty() {
        if password.len() < 8 {
            return Err("Choose a password of at least 8 characters.".into());
        }
        run_bouncer(&exe, &config, &["user", "add", user], Some(password))?;
    }

    st.stop_local();
    let mut cmd = Command::new(&exe);
    cmd.arg("-config").arg(&config).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd.spawn().map_err(|e| format!("could not start the bouncer: {e}"))?;
    *st.child.lock().unwrap() = Some(child);

    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_err() {
        if Instant::now() > deadline {
            st.stop_local();
            return Err("The bouncer did not start.".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    {
        let mut s = st.settings.lock().unwrap();
        s.mode = "local".into();
        s.port = port;
        if !user.is_empty() {
            s.user = user.to_string();
        }
    }
    st.save();
    Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_local(app: AppHandle, window: WebviewWindow, st: State<App>, user: String, password: String) -> Result<(), String> {
    let url = start_bouncer(&app, &st, user.trim(), &password)?;
    show(&window, &st, &url)
}

#[tauri::command]
fn report(text: String) {
    // For checking a build without a person: GESTALT_DIAG=1 prints what the webview can do, then quits.
    if std::env::var("GESTALT_DIAG").is_ok() {
        println!("{text}");
        std::process::exit(0);
    }
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn back_to_launcher(win: &WebviewWindow, st: &App) {
    *st.allowed.lock().unwrap() = None;
    if let Some(u) = st.launcher.lock().unwrap().clone() {
        let _ = win.navigate(u);
    }
}

/// What the webview may do on Linux, where it is WebKitGTK: WebRTC and the microphone are there but must be switched on,
/// and the microphone permission is asked of the app, which answers yes (the window only ever shows the launcher or the
/// one bouncer the user chose).
#[cfg(target_os = "linux")]
fn allow_media(win: &WebviewWindow) {
    let _ = win.with_webview(|w| {
        use webkit2gtk::{glib::prelude::*, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};
        let view = w.inner();
        if let Some(s) = WebViewExt::settings(&view) {
            s.set_enable_media_stream(true);
            s.set_enable_mediasource(true);
            s.set_enable_webrtc(true);
            s.set_media_playback_requires_user_gesture(false);
        }
        view.connect_permission_request(|_, req| {
            if req.is::<UserMediaPermissionRequest>() {
                req.allow();
                true
            } else {
                false
            }
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn allow_media(_win: &WebviewWindow) {}

fn main() {
    // The media module's commands exist only where the module does; a handler list
    // cannot be built across a binding (its runtime type is only inferred inside the
    // invoke_handler call), so each platform builds its own list here.
    #[cfg(target_os = "linux")]
    let app = tauri::Builder::default().invoke_handler(tauri::generate_handler![
        get_state, connect_remote, start_local, report,
        media::native_media, media::pc_create, media::pc_local, media::pc_remote,
        media::pc_track, media::pc_uplink, media::pc_channel, media::pc_send, media::pc_volume,
        media::pc_close, media::mic_start, media::mic_mute, media::mic_stop
    ]);
    #[cfg(not(target_os = "linux"))]
    let app = tauri::Builder::default().invoke_handler(tauri::generate_handler![
        get_state, connect_remote, start_local, report
    ]);

    let app = app
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let settings_path = dir.join("settings.json");
            let settings: Settings = fs::read(&settings_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let st = App {
                settings_path,
                settings: Mutex::new(settings.clone()),
                child: Mutex::new(None),
                launcher: Mutex::new(None),
                allowed: Mutex::new(None),
            };
            app.manage(st);

            let handle = app.handle().clone();
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Gestalt")
                .inner_size(1200.0, 800.0)
                .min_inner_size(480.0, 400.0)
                .on_navigation(move |url| {
                    // The launcher, the bouncer the user chose, and nothing else. A link to elsewhere opens in the
                    // user's own browser (the page's links ask for a new window, which this does not allow).
                    let st = handle.state::<App>();
                    if matches!(url.scheme(), "tauri" | "about" | "blob" | "data") || url.host_str() == Some("tauri.localhost") {
                        return true;
                    }
                    let allowed = st.allowed.lock().unwrap().clone();
                    allowed.is_some_and(|a| url.origin() == a.origin())
                })
                .build()?;
            *app.state::<App>().launcher.lock().unwrap() = win.url().ok();
            allow_media(&win);

            // The native media stack gets the window it reports state on, and lives as
            // long as the app does (managed state is dropped at exit, which closes its
            // streams and connections).
            #[cfg(target_os = "linux")]
            app.manage(media::hub(win.clone()));
            if std::env::var("GESTALT_MEDIA_SELFTEST").is_ok() {
                // The whole native voice loop in one process: it plays through the real
                // speaker and captures the real microphone, says what it found, and exits.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let state = handle.state::<media::Hub>();
                    match media::selftest(&state) {
                        Ok(()) => {
                            media::log_line("selftest: PASS");
                            handle.exit(0);
                        }
                        Err(e) => {
                            media::log_line(&format!("selftest: FAIL {e}"));
                            handle.exit(1);
                        }
                    }
                });
            }
            if let Ok(live) = std::env::var("GESTALT_MEDIA_LIVE") {
                // The local live check's driver: it does around the page what a person
                // would — connect, sign in as the named nick, join the room — so two
                // instances can find each other with no hands. "nick:password" splits.
                std::thread::spawn(|| {
                    struct StdoutLog;
                    impl log::Log for StdoutLog {
                        fn enabled(&self, m: &log::Metadata) -> bool {
                            m.level() <= log::Level::Info
                        }
                        fn log(&self, r: &log::Record) {
                            println!("{}: [{}] {}", r.target(), r.level(), r.args());
                        }
                        fn flush(&self) {}
                    }
                    if log::set_boxed_logger(Box::new(StdoutLog)).is_ok() {
                        log::set_max_level(log::LevelFilter::Info);
                        log::info!("the log crates connected");
                    } else {
                        println!("media: the log crate could not connect");
                    }
                });
                let handle = app.handle().clone();
                let (user, pass) = match live.split_once(':') {
                    Some((u, p)) => (u.to_string(), p.to_string()),
                    None => (String::new(), String::new()),
                };
                std::thread::spawn(move || {
                    for i in 0..40u32 {
                        if i == 0 {
                            media::log_line(&format!("driver: up, user {user}"));
                        }
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        match handle.get_webview_window("main") {
                            Some(win) => {
                                let script = DRIVER_JS.replace("__USER__", &user).replace("__PASS__", &pass);
                                let h2 = handle.clone();
                                let script = DRIVER_JS.replace("__USER__", &user).replace("__PASS__", &pass);                                match win.eval_with_callback(&script, move |out| {
                                    if !out.is_empty() {
                                        media::log_line(&format!("driver got: {out}"));
                                    }
                                }) {
                                    Err(e) => {
                                        media::log_line(&format!("driver: {e}"));
                                        break;
                                    }
                                    Ok(()) => {}
                                }
                            }
                            None => media::log_line("driver: no main webview"),
                        }
                    }
                });
            }

            let menu = MenuBuilder::new(app)
                .item(
                    &SubmenuBuilder::new(app, "Gestalt")
                        .item(&MenuItem::with_id(app, "show", "Show Gestalt", true, None::<&str>)?)
                        .item(&MenuItem::with_id(app, "change", "Change server…", true, None::<&str>)?)
                        .item(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)
                        .build()?,
                )
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "show" => show_window(app),
                "change" => {
                    show_window(app);
                    if let Some(w) = app.get_webview_window("main") {
                        back_to_launcher(&w, &app.state::<App>());
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            });

            // The tray icon: a click shows or hides the window, and its menu is the way out of a hidden one.
            let tray_menu = MenuBuilder::new(app)
                .item(&MenuItem::with_id(app, "show", "Show Gestalt", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "change", "Change server…", true, None::<&str>)?)
                .separator()
                .item(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)
                .build()?;
            let mut tray = TrayIconBuilder::with_id("main").tooltip("Gestalt").menu(&tray_menu).show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let has_tray = tray
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window(app),
                    "change" => {
                        show_window(app);
                        if let Some(w) = app.get_webview_window("main") {
                            back_to_launcher(&w, &app.state::<App>());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        match app.get_webview_window("main") {
                            Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => {
                                let _ = w.hide();
                            }
                            _ => show_window(app),
                        }
                    }
                })
                .build(app)
                .is_ok();

            // Closing the window hides it to the tray, where Gestalt stays connected, unless the user chose
            // otherwise or there is no tray to bring it back from.
            let closer = win.clone();
            let h = app.handle().clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if has_tray && h.state::<App>().settings.lock().unwrap().close_to_tray {
                        api.prevent_close();
                        let _ = closer.hide();
                    }
                }
            });

            // Back to what was used last time, unless a person is checking a build.
            if std::env::var("GESTALT_DIAG").is_err() {
                let h = app.handle().clone();
                let w = win.clone();
                std::thread::spawn(move || {
                    let st = h.state::<App>();
                    match settings.mode.as_str() {
                        "remote" => {
                            if let Ok(u) = Url::parse(&settings.url) {
                                let _ = show(&w, &st, &u);
                            }
                        }
                        "local" => {
                            if let Ok(u) = start_bouncer(&h, &st, "", "") {
                                let _ = show(&w, &st, &u);
                            }
                        }
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build the app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<App>().stop_local();
        }
    });
}
