// What the bouncer tells a host's browser about guests who came by one of their links. It arrives as a TAGMSG from
// the guest's made-up nick, whose host is always GUEST_HOST. The bouncer drops any line of this kind that comes
// from the IRC network, so only its own can carry the tag.

export const GUEST_TAG = '+gestalt/guest'
export const GUEST_HOST = 'guest.invalid'
export const GUEST_NICK_PREFIX = 'g-'

export type GuestEvent = { t: 'join'; inviteId: string; name: string } | { t: 'leave'; inviteId: string }

/** True for a prefix the bouncer made for a guest. */
export function isGuestPrefix(prefix: string): boolean {
  return prefix.endsWith('@' + GUEST_HOST) && prefix.includes('!')
}

/** Reads a tag value: "join.<id>.<name>" (the name with % and . written as %25 and %2E) or "leave.<id>". */
export function parseGuestEvent(value: string): GuestEvent | null {
  const [t, id, ...rest] = value.split('.')
  if (!id || !/^[A-Za-z0-9_-]{4,16}$/.test(id)) return null
  if (t === 'leave' && rest.length === 0) return { t: 'leave', inviteId: id }
  if (t === 'join' && rest.length === 1 && rest[0]) {
    let name: string
    try {
      name = decodeURIComponent(rest[0])
    } catch {
      return null
    }
    // Shown in a window the user trusts, so nothing but plain text of a sensible length gets in.
    name = name.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 24)
    return name ? { t: 'join', inviteId: id, name } : null
  }
  return null
}

/** How a guest is named on screen. */
export const guestLabel = (name: string) => `${name} (guest)`

/** The tag the host sends a guest to say who is in the room. */
export const ROSTER_TAG = '+gestalt/roster'

export interface RosterEntry {
  name: string
  /** Here by a link. */
  guest: boolean
  /** The person who made the link and is relaying the room. */
  host: boolean
  speaking: boolean
}

const MAX_ROSTER = 24

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** The roster as a tag value: base64url of a short JSON list. */
export function encodeRoster(entries: RosterEntry[]): string {
  const list = entries.slice(0, MAX_ROSTER).map((e) => ({ n: e.name.slice(0, 40), ...(e.guest ? { g: 1 } : {}), ...(e.host ? { h: 1 } : {}), ...(e.speaking ? { s: 1 } : {}) }))
  return toBase64Url(new TextEncoder().encode(JSON.stringify(list)))
}

/** Reads a roster. Anything that is not a list of names comes out as nothing. */
export function parseRoster(value: string): RosterEntry[] {
  try {
    const list: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(value)))
    if (!Array.isArray(list)) return []
    const out: RosterEntry[] = []
    for (const e of list.slice(0, MAX_ROSTER)) {
      if (!e || typeof e !== 'object' || typeof (e as { n?: unknown }).n !== 'string') continue
      const o = e as { n: string; g?: unknown; h?: unknown; s?: unknown }
      const name = o.n.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 24)
      if (name) out.push({ name, guest: o.g === 1, host: o.h === 1, speaking: o.s === 1 })
    }
    return out
  } catch {
    return []
  }
}
