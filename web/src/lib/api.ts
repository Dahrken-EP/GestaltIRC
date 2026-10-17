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

/** A network as the editor sees it. Secrets are never sent to the browser, only whether one is set. */
export interface NetworkDetail {
  name: string
  host: string
  port: number
  tls: boolean
  nick: string
  ident: string
  realname: string
  sasl_mech: string
  sasl_user: string
  has_server_password: boolean
  has_sasl_password: boolean
  has_certificate: boolean
  has_nickserv_password: boolean
  tls_insecure: boolean
  /** The certificate the bouncer first saw on a server that accepts an untrusted one. */
  tls_fingerprint: string
  alt_nicks: string[]
  perform: string[]
  join: string[]
  enabled: boolean
  connected: boolean
}

/** What the editor sends. A secret left out is kept; an empty one is cleared. */
export interface NetworkRequest {
  name?: string
  host: string
  port: number
  tls: boolean
  nick: string
  ident: string
  realname: string
  sasl_mech: string
  sasl_user: string
  server_password?: string
  sasl_password?: string
  nickserv_password?: string
  tls_insecure: boolean
  /** Forget the remembered certificate, so the next one seen is remembered instead. */
  forget_tls_pin?: boolean
  alt_nicks: string[]
  perform: string[]
  join: string[]
  enabled: boolean
}

export interface NetworkList {
  networks: NetworkDetail[]
  /** How many networks an account may have. */
  max: number
  /** True when the operator lets the editor use addresses on the bouncer's own network. */
  private_allowed: boolean
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload,
    // A small change made just before the page closes still gets to the bouncer. (Browsers refuse the flag
    // for bodies over 64 KB, so larger ones are sent the ordinary way.)
    keepalive: payload !== undefined && payload.length < 60_000,
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
  listNetworks: () => request<NetworkList>('GET', '/api/networks'),
  addNetwork: (n: NetworkRequest) => request<{ ok: boolean }>('POST', '/api/networks', n),
  updateNetwork: (name: string, n: NetworkRequest) => request<{ ok: boolean }>('PUT', '/api/networks/' + encodeURIComponent(name), n),
  deleteNetwork: (name: string) => request<{ ok: boolean }>('DELETE', '/api/networks/' + encodeURIComponent(name)),
  /** One of the account's stored documents, or null if it was never saved. */
  async getDoc(name: string): Promise<Record<string, unknown> | null> {
    const doc = await request<Record<string, unknown> | null>('GET', '/api/docs/' + encodeURIComponent(name))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null
  },
  putDoc: (name: string, doc: Record<string, unknown>) => request<{ ok: boolean }>('PUT', '/api/docs/' + encodeURIComponent(name), doc),
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
