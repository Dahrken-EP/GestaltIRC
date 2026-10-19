fn main() {
    // The app's own commands are not ACL-visible to a remote page until the app
    // declares a manifest. Naming them here generates an allow-permission for each,
    // which the capability then hands to the window's remote context — the bouncer's
    // page is a real web address, so its voice bridge rides these.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_state", "connect_remote", "start_local", "report",
                "native_media", "pc_create", "pc_local", "pc_remote", "pc_track",
                "pc_uplink", "pc_channel", "pc_send", "pc_volume", "pc_close",
                "mic_start", "mic_mute", "mic_stop",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
