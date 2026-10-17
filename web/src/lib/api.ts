// Calls to the bouncer's HTTP API. The session lives in an HttpOnly cookie that
// the browser sends by itself, so nothing here handles a password after login.

export interface NetworkInfo {
  name: string
  host: string
  nick: string
  enabled: boolean
  connected: boolean
}

export interface SessionInfo {
  user: string
  networks: NetworkInfo[]
  /** Saved preferences, or null if none were ever saved for this account. */
  prefs: Record<string, unknown> | null
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // an empty or non-JSON body: fall through to the status
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `request failed (${res.status})`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

export const api = {
  /** The current session, or null when not logged in. */
  async session(): Promise<SessionInfo | null> {
    try {
      return await request<SessionInfo>('GET', '/api/session')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },
  login: (user: string, password: string) => request<{ user: string }>('POST', '/api/login', { user, password }),
  logout: () => request<{ ok: boolean }>('POST', '/api/logout', {}),
  putPrefs: (prefs: Record<string, unknown>) => request<{ ok: boolean }>('PUT', '/api/prefs', prefs),
  ice: () => request<{ iceServers: RTCIceServer[]; ttl: number }>('GET', '/api/ice'),
  pushKey: () => request<{ key: string }>('GET', '/api/push/key'),
  pushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: boolean }>('POST', '/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => request<{ ok: boolean }>('POST', '/api/push/unsubscribe', { endpoint }),
}

/** The WebSocket address of the bouncer that served this page. */
export function websocketUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`
}
