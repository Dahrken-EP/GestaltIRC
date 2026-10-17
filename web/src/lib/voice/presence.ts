// Who is in a channel's voice room, said with one client-only tag on the channel. The
// room is the channel itself: no server keeps a list, and clients that do not know the
// tag ignore it.
//
//   join          sent to the channel when someone enters the room
//   leave         sent to the channel when they go
//   here:#chan    sent to the newcomer alone by each person already in the room
//   guests:A,B    sent to the channel by someone who brought guests (people without Gestalt, who joined by a
//                 link and talk through that person) to say who they are, and to a newcomer along with `here`.
//                 An empty list means they have none now.
//   hello         sent to the channel by someone already in the room who lost touch (their IRC
//                 connection dropped and came back), so people who do not have them answer

export const VOICE_TAG = '+gestalt/voice'

/** Most people in one voice room. Every pair holds a connection, so this bounds the work each browser does. */
export const MAX_VOICE = 10

export type Presence = { t: 'join' } | { t: 'leave' } | { t: 'hello' } | { t: 'here'; room: string } | { t: 'guests'; names: string[] }

/** Guests one person may bring to a room, and the longest name. */
export const MAX_GUEST_NAMES = 8
const GUEST_NAME_RE = /^[\p{L}\p{N} _.'-]{1,24}$/u

export function formatPresence(p: Presence): string {
  if (p.t === 'here') return `here:${p.room}`
  if (p.t === 'guests') return 'guests:' + p.names.join(',')
  return p.t
}

/** Reads a tag value. Anything else, from anyone, is ignored. */
export function parsePresence(value: string): Presence | null {
  if (value === 'join') return { t: 'join' }
  if (value === 'leave') return { t: 'leave' }
  if (value === 'hello') return { t: 'hello' }
  if (value.startsWith('guests:')) {
    const names = value.slice(7).split(',').filter(Boolean)
    if (names.length > MAX_GUEST_NAMES || !names.every((n) => GUEST_NAME_RE.test(n) && n.trim() === n)) return null
    return { t: 'guests', names }
  }
  if (value.startsWith('here:')) {
    const room = value.slice(5)
    return isRoomName(room) ? { t: 'here', room } : null
  }
  return null
}

/** A channel name as it can appear in a room id: no spaces, commas or control characters. */
export function isRoomName(s: unknown): s is string {
  // eslint-disable-next-line no-control-regex
  return typeof s === 'string' && s.length >= 2 && s.length <= 64 && /^[#&+!][^\s,\u0000-\u001f\u007f]+$/.test(s)
}
