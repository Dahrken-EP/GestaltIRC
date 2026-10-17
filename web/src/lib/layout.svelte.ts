// How wide the columns are, and whether the server bar is hidden. Kept in this browser only: a wide monitor and
// a phone want different widths, so unlike the settings these do not follow the account.

export const NAV = { min: 140, max: 480, initial: 220 }
export const MEMBERS = { min: 120, max: 400, initial: 180 }

const KEY = 'irc:layout'

const clamp = (v: number, r: { min: number; max: number }) => Math.round(Math.min(r.max, Math.max(r.min, v)))

/** Reads what was saved, keeping only values that make sense. */
export function parseLayout(raw: unknown): { nav: number; members: number; railHidden: boolean } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const num = (v: unknown, r: { min: number; max: number; initial: number }) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, r) : r.initial
  return { nav: num(o.nav, NAV), members: num(o.members, MEMBERS), railHidden: o.railHidden === true }
}

class Layout {
  nav = $state(NAV.initial)
  members = $state(MEMBERS.initial)
  railHidden = $state(false)

  constructor() {
    try {
      const s = parseLayout(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
      this.nav = s.nav
      this.members = s.members
      this.railHidden = s.railHidden
    } catch {
      // storage unavailable or corrupt: defaults
    }
  }

  setNav(v: number): void {
    this.nav = clamp(v, NAV)
    this.save()
  }

  setMembers(v: number): void {
    this.members = clamp(v, MEMBERS)
    this.save()
  }

  setRailHidden(hidden: boolean): void {
    this.railHidden = hidden
    this.save()
  }

  reset(): void {
    this.nav = NAV.initial
    this.members = MEMBERS.initial
    this.save()
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ nav: this.nav, members: this.members, railHidden: this.railHidden }))
    } catch {
      // not remembered
    }
  }
}

export const layout = new Layout()
export { Layout }
