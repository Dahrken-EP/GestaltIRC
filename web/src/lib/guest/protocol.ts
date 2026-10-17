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
