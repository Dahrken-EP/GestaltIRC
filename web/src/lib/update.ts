// Automatic update checks for the desktop app. When running under Tauri, the
// built-in updater checks GitHub Releases for a new AppImage. In a browser this
// is a no-op: updates are the browser's responsibility.

export type UpdateStatus =
  | "checking"
  | "up-to-date"
  | "update-available"
  | "error"

export interface UpdateInfo {
  status: UpdateStatus
  version?: string
  error?: string
}

let lastCheck = 0
const CHECK_INTERVAL_MS = 60 * 60 * 1000 // check at most once an hour

/** Check for a new version. Returns cached info if checked recently. */
export async function checkUpdate(): Promise<UpdateInfo> {
  const now = Date.now()
  if (now - lastCheck < CHECK_INTERVAL_MS) {
    return cached
  }
  lastCheck = now

  // Tauri exposes its updater through `window.__TAURI__.invoke`. The command
  // names match the tauriUpdater configuration in tauri.conf.json. When not
  // running under Tauri there is nothing to check: the browser handles its own
  // updates.
  const tauri = (window as unknown as { __TAURI__?: unknown })?.__TAURI__
  if (tauri) {
    try {
      const invoke = (tauri as { invoke: (cmd: string) => Promise<unknown> }).invoke
      const result = (await invoke("tauri://updater/check")) as {
        available?: boolean
        version?: string
        error?: string
      }
      if (result.error) {
        return (cached = { status: "error", error: result.error })
      }
      if (result.available && result.version) {
        return (cached = { status: "update-available", version: result.version })
      }
      return (cached = { status: "up-to-date" })
    } catch (e) {
      return (cached = { status: "error", error: e instanceof Error ? e.message : "update check failed" })
    }
  }

  return { status: "up-to-date" }
}

let cached: UpdateInfo = { status: "up-to-date" }

/** Download and install the update. Tauri only. */
export async function installUpdate(): Promise<void> {
  const tauri = (window as unknown as { __TAURI__?: unknown })?.__TAURI__
  if (tauri) {
    const invoke = (tauri as { invoke: (cmd: string) => Promise<unknown> }).invoke
    await invoke("tauri://updater/download-and-install")
  }
}
