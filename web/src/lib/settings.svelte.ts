// User preferences. They are kept in this browser's localStorage so the page
// looks right before login, and saved to the bouncer once logged in so they
// follow the user to other devices. `notify` is the one exception: permission to
// show notifications belongs to a browser, not an account, so it never leaves.

export type Theme = 'system' | 'light' | 'dark'
export type Density = 'compact' | 'comfortable'

interface Stored {
  theme: Theme
  density: Density
  keywords: string[]
  /** Extra highlight words for one network, by the name it was given. */
  networkKeywords: Record<string, string[]>
  /** Networks whose mentions do not raise a desktop notification. */
  networkMuted: Record<string, boolean>
  nickColors: Record<string, string>
  showMembers: boolean
  showBufferList: boolean
  timestamps: boolean
  sendTyping: boolean
  /** In a voice room, the microphone is open only while the talk key or button is held. */
  pushToTalk: boolean
  /** Say in a channel, with a link, when I join its voice room, if guests are allowed. */
  announceVoice: boolean
  inlineMedia: boolean
  embeds: boolean
  previews: boolean
  notify: boolean
}

const DEFAULTS: Stored = {
  theme: 'system',
  density: 'compact',
  keywords: [],
  networkKeywords: {},
  networkMuted: {},
  nickColors: {},
  showMembers: true,
  showBufferList: true,
  timestamps: true,
  sendTyping: false,
  pushToTalk: false,
  announceVoice: true,
  inlineMedia: true,
  embeds: true,
  previews: true,
  notify: false,
}

/** The keys saved to the bouncer. */
const SYNCED = ['theme', 'density', 'keywords', 'networkKeywords', 'networkMuted', 'nickColors', 'showMembers', 'showBufferList', 'timestamps', 'sendTyping', 'pushToTalk', 'announceVoice', 'inlineMedia', 'embeds', 'previews'] as const

const KEY = 'irc:settings'
const PUSH_DELAY_MS = 800

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    // storage unavailable or corrupt: use defaults
  }
  return { ...DEFAULTS }
}

const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark'
const isDensity = (v: unknown): v is Density => v === 'compact' || v === 'comfortable'
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isKeywordMap = (v: unknown): v is Record<string, string[]> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isStringList)
const isFlagMap = (v: unknown): v is Record<string, boolean> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean')
const isColorMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')

class Settings {
  theme = $state<Theme>(DEFAULTS.theme)
  density = $state<Density>(DEFAULTS.density)
  keywords = $state<string[]>([])
  networkKeywords = $state<Record<string, string[]>>({})
  networkMuted = $state<Record<string, boolean>>({})
  nickColors = $state<Record<string, string>>({})
  showMembers = $state(true)
  showBufferList = $state(true)
  timestamps = $state(true)
  sendTyping = $state(false)
  pushToTalk = $state(false)
  announceVoice = $state(true)
  /** Show pictures and video from links in the message list, fetched through the bouncer. */
  inlineMedia = $state(true)
  /** Offer YouTube and Streamable players. Nothing from them loads until the user clicks play. */
  embeds = $state(true)
  /** Show a title and picture for other links, which the bouncer fetches. */
  previews = $state(true)
  notify = $state(false)

  private remote: ((prefs: Record<string, unknown>) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    this.assign(load())
  }

  private assign(s: Partial<Stored>): void {
    if (isTheme(s.theme)) this.theme = s.theme
    if (isDensity(s.density)) this.density = s.density
    if (isStringList(s.keywords)) this.keywords = s.keywords
    if (isKeywordMap(s.networkKeywords)) this.networkKeywords = s.networkKeywords
    if (isFlagMap(s.networkMuted)) this.networkMuted = s.networkMuted
    if (isColorMap(s.nickColors)) this.nickColors = s.nickColors
    if (typeof s.showMembers === 'boolean') this.showMembers = s.showMembers
    if (typeof s.showBufferList === 'boolean') this.showBufferList = s.showBufferList
    if (typeof s.timestamps === 'boolean') this.timestamps = s.timestamps
    if (typeof s.sendTyping === 'boolean') this.sendTyping = s.sendTyping
    if (typeof s.pushToTalk === 'boolean') this.pushToTalk = s.pushToTalk
    if (typeof s.announceVoice === 'boolean') this.announceVoice = s.announceVoice
    if (typeof s.inlineMedia === 'boolean') this.inlineMedia = s.inlineMedia
    if (typeof s.embeds === 'boolean') this.embeds = s.embeds
    if (typeof s.previews === 'boolean') this.previews = s.previews
    if (typeof s.notify === 'boolean') this.notify = s.notify
  }

  /** What is sent to the bouncer. */
  synced(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const k of SYNCED) out[k] = $state.snapshot(this[k])
    return out
  }

  /**
   * Starts saving changes to the bouncer through `push`. If the bouncer already
   * holds preferences for this account they replace the local ones; otherwise the
   * local ones are uploaded, so a user's existing settings carry over.
   */
  connectRemote(prefs: Record<string, unknown> | null, push: (prefs: Record<string, unknown>) => void): void {
    if (prefs && Object.keys(prefs).length > 0) {
      // Permission to notify belongs to this browser, so the server never gets a say in it.
      const { notify: _ignored, ...rest } = prefs as Partial<Stored>
      this.assign(rest)
      this.writeLocal()
    }
    this.remote = push
    if (!prefs || Object.keys(prefs).length === 0) this.schedulePush()
  }

  /** Stops saving to the bouncer, for example after logout. Local values stay. */
  disconnectRemote(): void {
    clearTimeout(this.timer)
    this.remote = null
  }

  save(): void {
    this.writeLocal()
    this.schedulePush()
  }

  private writeLocal(): void {
    const s: Stored = {
      ...(this.synced() as Omit<Stored, 'notify'>),
      notify: this.notify,
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {
      // not persisted; the setting still applies for this page
    }
  }

  private schedulePush(): void {
    if (!this.remote) return
    clearTimeout(this.timer)
    // Several quick changes, such as typing a keyword list, become one request.
    this.timer = setTimeout(() => this.remote?.(this.synced()), PUSH_DELAY_MS)
  }

  /** The words that highlight a line on this network: the global ones and the network's own. */
  keywordsFor(network: string): string[] {
    return [...this.keywords, ...(this.networkKeywords[network] ?? [])]
  }

  setNetworkKeywords(network: string, words: string[]): void {
    const next = { ...this.networkKeywords }
    if (words.length) next[network] = words
    else delete next[network]
    this.networkKeywords = next
    this.save()
  }

  setNetworkMuted(network: string, muted: boolean): void {
    const next = { ...this.networkMuted }
    if (muted) next[network] = true
    else delete next[network]
    this.networkMuted = next
    this.save()
  }

  /** Forgets what was kept for a network that no longer exists. */
  forgetNetwork(network: string): void {
    this.setNetworkKeywords(network, [])
    this.setNetworkMuted(network, false)
  }

  setNickColor(nick: string, color: string | null): void {
    const next = { ...this.nickColors }
    if (color) next[nick.toLowerCase()] = color
    else delete next[nick.toLowerCase()]
    this.nickColors = next
    this.save()
  }
}

export const settings = new Settings()
