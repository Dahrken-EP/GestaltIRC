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
  /** CSRF token for state-changing requests. */
  csrf_token?: string
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

// The CSRF token from the session response. It is sent on every state-changing
// request so the bouncer can reject cross-site request forgery.
let csrfToken = ''

/** The bouncer handed this out at login. Call after a successful session load. */
export function setCsrfToken(token: string): void {
  csrfToken = token
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  let headers: Record<string, string> | undefined
  if (payload !== undefined) {
    headers = { 'Content-Type': 'application/json' }
  }
  // State-changing requests need the CSRF token.
  if (method !== 'GET' && method !== 'HEAD' && csrfToken !== '') {
    if (headers === undefined) headers = {}
    headers['X-CSRF-Token'] = csrfToken
  }
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: headers,
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

/** A link someone without Gestalt can open to reach this user's browser. */
export interface GuestInvite {
  id: string
  token: string
  /** The path of the page, such as /guest/abc. */
  path: string
  network: string
  kind: 'room' | 'direct'
  target: string
  expires: string
}

export interface GuestSettings {
  /** False when the bouncer's operator has switched guest links off for everyone. */
  available: boolean
  enabled: boolean
}

export const api = {
  /** The current session, or null when not logged in. */
  async session(): Promise<SessionInfo | null> {
    try {
      const data = await request<SessionInfo & { csrf_token?: string }>('GET', '/api/session')
      if (data.csrf_token) setCsrfToken(data.csrf_token)
      return data
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },
  login: async (user: string, password: string) => {
    const data = await request<{ user: string; csrf_token?: string }>('POST', '/api/login', { user, password })
    if (data.csrf_token) setCsrfToken(data.csrf_token)
    return data
  },
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
  getGuests: () => request<GuestSettings>('GET', '/api/guests'),
  putGuests: (enabled: boolean) => request<GuestSettings>('PUT', '/api/guests', { enabled }),
  listGuestInvites: () => request<{ invites: GuestInvite[] }>('GET', '/api/guests/invites'),
  createGuestInvite: (req: { network: string; kind: 'room' | 'direct'; target: string }) => request<GuestInvite>('POST', '/api/guests/invites', req),
  revokeGuestInvite: (id: string) => request<null>('DELETE', '/api/guests/invites/' + encodeURIComponent(id)),
  notifications: () => request<{ id: number; kind: string; network: string; buffer: string; title: string; body: string; read: boolean; created: number }[]>('GET', '/api/notifications'),
  notificationsUnread: () => request<{ id: number; kind: string; network: string; buffer: string; title: string; body: string; read: boolean; created: number }[]>('GET', '/api/notifications?unread=1'),
  markNotificationsRead: () => request<{ ok: boolean }>('PUT', '/api/notifications/read', {}),
  pushKey: () => request<{ key: string }>('GET', '/api/push/key'),
  pushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: boolean }>('POST', '/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => request<{ ok: boolean }>('POST', '/api/push/unsubscribe', { endpoint }),
}

/** The WebSocket address of the bouncer that served this page. */
export function websocketUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`
}
