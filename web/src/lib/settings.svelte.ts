// User preferences. The design stores these server-side so they follow the user
// across devices; the bouncer has no preferences API yet, so for now they live
// in this browser's localStorage.

export type Theme = 'system' | 'light' | 'dark'
export type Density = 'compact' | 'comfortable'

interface Stored {
  theme: Theme
  density: Density
  keywords: string[]
  nickColors: Record<string, string>
  showMembers: boolean
  showBufferList: boolean
  notify: boolean
  timestamps: boolean
}

const DEFAULTS: Stored = {
  theme: 'system',
  density: 'compact',
  keywords: [],
  nickColors: {},
  showMembers: true,
  showBufferList: true,
  notify: false,
  timestamps: true,
}

const KEY = 'irc:settings'

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    // storage unavailable or corrupt: use defaults
  }
  return { ...DEFAULTS }
}

class Settings {
  theme = $state<Theme>(DEFAULTS.theme)
  density = $state<Density>(DEFAULTS.density)
  keywords = $state<string[]>([])
  nickColors = $state<Record<string, string>>({})
  showMembers = $state(true)
  showBufferList = $state(true)
  notify = $state(false)
  timestamps = $state(true)

  constructor() {
    const s = load()
    this.theme = s.theme
    this.density = s.density
    this.keywords = s.keywords
    this.nickColors = s.nickColors
    this.showMembers = s.showMembers
    this.showBufferList = s.showBufferList
    this.notify = s.notify
    this.timestamps = s.timestamps
  }

  save(): void {
    const s: Stored = {
      theme: this.theme,
      density: this.density,
      keywords: [...this.keywords],
      nickColors: { ...this.nickColors },
      showMembers: this.showMembers,
      showBufferList: this.showBufferList,
      notify: this.notify,
      timestamps: this.timestamps,
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {
      // not persisted; the setting still applies for this page
    }
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
