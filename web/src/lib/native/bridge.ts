// The page's way into the Rust bridge, rounded off into an interface tests can
// stand in for. The desktop app puts `window.__TAURI__` on every page
// (withGlobalTauri in tauri.conf.json); a plain browser has none, so there is
// nothing native there to reach. Tauri 2 keeps firing under names ONCE removed:
// invoke lives in __TAURI__.core, events in __TAURI__.event.

export interface Bridge {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>
  /** Returns the unlisten function. */
  listen(event: string, onEvent: (payload: unknown) => void): Promise<() => void>
}

interface TauriWindow {
  __TAURI__?: {
    core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    /** Older Tauri builds put invoke at the top; a tolerant check costs nothing. */
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
    event?: { listen: (event: string, handler: (e: unknown) => void) => Promise<() => void> }
  }
}

/** This window's bridge, or null in a plain browser. */
export function tauriBridge(): Bridge | null {
  const tauri = (window as unknown as TauriWindow).__TAURI__
  const fire = tauri?.core?.invoke ?? tauri?.invoke
  const events = tauri?.event
  if (!fire || !events) return null
  return {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => fire.call(tauri, cmd, args) as Promise<T>,
    listen: async (event, onEvent) =>
      events.listen(event, (e: unknown) => {
        const payload = (e as { payload?: unknown })?.payload
        onEvent(payload)
      }),
  }
}
