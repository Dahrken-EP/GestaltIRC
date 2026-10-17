// What two browsers say to each other over a direct connection. The first channel
// ("chat") carries small JSON control messages: chat lines, and offers and answers
// for files. Each file then travels on a channel of its own. Everything the other
// side sends is untrusted, so each message is checked field by field.

/** Longest chat line accepted, in characters. */
export const MAX_CHAT_CHARS = 4000
/** Largest file accepted. A received file is held in memory until it is saved. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024
/** Size of each piece of a file on the wire. */
export const CHUNK_BYTES = 64 * 1024
/** Longest control message read at all, in characters. */
const MAX_CONTROL_CHARS = 20_000
/** Longest file name kept. */
const MAX_NAME_CHARS = 120

export type Control =
  | { t: 'chat'; id: string; text: string }
  | { t: 'file-offer'; id: string; name: string; size: number; mime: string }
  | { t: 'file-accept'; id: string }
  | { t: 'file-reject'; id: string }
  | { t: 'file-cancel'; id: string }
  | { t: 'file-done'; id: string; ok: boolean }
  /** The other person closed the chat. Sent on the connection itself, which is faster than the IRC network. */
  | { t: 'bye'; id: string }

export const isId = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9]{6,16}$/.test(s)

/** A random id for a chat line or a file. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}

/** Reads a control message. Returns null for anything that is not exactly one of the known shapes. */
export function parseControl(text: string): Control | null {
  if (text.length > MAX_CONTROL_CHARS) return null
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const m = o as Record<string, unknown>
  if (!isId(m.id)) return null
  switch (m.t) {
    case 'chat':
      if (typeof m.text !== 'string' || m.text.length === 0 || m.text.length > MAX_CHAT_CHARS) return null
      return { t: 'chat', id: m.id, text: m.text }
    case 'file-offer':
      if (typeof m.name !== 'string' || typeof m.mime !== 'string') return null
      if (!Number.isSafeInteger(m.size) || (m.size as number) < 0 || (m.size as number) > MAX_FILE_BYTES) return null
      return { t: 'file-offer', id: m.id, name: sanitizeFileName(m.name), size: m.size as number, mime: safeMime(m.mime) }
    case 'file-accept':
    case 'file-reject':
    case 'file-cancel':
    case 'bye':
      return { t: m.t, id: m.id }
    case 'file-done':
      return typeof m.ok === 'boolean' ? { t: 'file-done', id: m.id, ok: m.ok } : null
    default:
      return null
  }
}

/**
 * A file name that is safe to show and to offer to the file system: no folders,
 * no control characters, and not one of the names Windows reserves. The sender
 * chose it, so it is not trusted for anything.
 */
export function sanitizeFileName(name: string): string {
  // Anything before the last slash or backslash is a path, not a name.
  let n = name.split(/[\\/]/).pop() ?? ''
  n = n
    // Controls, and the characters that mean something to a file system or a shell.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, '_')
    // The bidirectional overrides that can make "exe.txt" look like "txt.exe".
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n
  if (n.length > MAX_NAME_CHARS) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : ''
    n = n.slice(0, MAX_NAME_CHARS - ext.length) + ext
  }
  return n || 'file'
}

/** A media type for display, or a plain default. It never decides how a file is handled. */
export function safeMime(mime: string): string {
  return /^[a-z0-9][a-z0-9.+-]{0,40}\/[a-z0-9][a-z0-9.+-]{0,60}$/i.test(mime) ? mime.toLowerCase() : 'application/octet-stream'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}
