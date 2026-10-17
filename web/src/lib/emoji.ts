// Emoji for the picker and for :shortcode: completion. The full list (Emojibase, MIT licence, see
// scripts/build-emoji.mjs) is its own chunk, fetched the first time something needs it, so the page that
// loads before then does not carry it.

export interface Emoji {
  char: string
  name: string
  /** Extra words that find it. */
  words: string
  group: string
  /** Names it can be typed as between colons, such as "thumbsup". */
  codes: string[]
}

interface Loaded {
  groups: string[]
  list: Emoji[]
  byCode: Map<string, string>
}

let loaded: Loaded | null = null
let loading: Promise<Loaded> | null = null

/** Fetches the emoji list once, and says when it is there. */
export function loadEmoji(): Promise<Loaded> {
  loading ??= import('./emoji-data.json').then((m) => {
    const data = m.default as { groups: string[]; emoji: Array<[string, string, string, number, string]> }
    const list: Emoji[] = data.emoji.map(([char, name, words, group, codes]) => ({
      char,
      name,
      words,
      group: data.groups[group]!,
      codes: codes ? codes.split(' ') : [],
    }))
    const byCode = new Map<string, string>()
    for (const e of list) for (const c of e.codes) byCode.set(c, e.char)
    loaded = { groups: data.groups, list, byCode }
    return loaded
  })
  return loading
}

/** The list if it has been fetched already, for code that cannot wait. */
export const emojiIfLoaded = (): Loaded | null => loaded

/** Emoji whose name or words contain every word typed, best matches first. */
export function searchEmoji(list: Emoji[], query: string, limit = 80): Emoji[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const scored: Array<[number, Emoji]> = []
  for (const e of list) {
    const name = e.name.toLowerCase()
    const words = e.words.toLowerCase()
    let score = 0
    let ok = true
    for (const t of terms) {
      if (name === t || e.codes.includes(t)) score += 10
      else if (name.split(' ').some((w) => w === t)) score += 6
      else if (name.startsWith(t)) score += 5
      else if (words.split(' ').some((w) => w === t)) score += 4
      else if (name.includes(t) || words.includes(t)) score += 2
      else {
        ok = false
        break
      }
    }
    if (ok) scored.push([score, e])
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, e]) => e)
}

const CODE_CHARS = /^[a-z0-9_+-]+$/i

/**
 * The :shortcode being typed at the caret: the text after a colon that starts the text or follows a space or
 * punctuation (not a letter or digit, so "10:30" and URLs are left alone), at least two characters, no closing colon.
 */
export function shortcodeQueryAt(text: string, caret: number): { start: number; query: string } | null {
  let i = caret
  while (i > 0 && /[a-z0-9_+-]/i.test(text[i - 1]!)) i--
  if (i === 0 || text[i - 1] !== ':') return null
  const start = i - 1
  const query = text.slice(i, caret)
  if (query.length < 2 || !CODE_CHARS.test(query)) return null
  if (start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1]!)) return null
  return { start, query }
}

export interface ShortcodeMatch {
  code: string
  char: string
}

/** Shortcodes that start with, then contain, what was typed, up to `limit`. */
export function matchShortcodes(byCode: Map<string, string>, query: string, limit = 8): ShortcodeMatch[] {
  const q = query.toLowerCase()
  const starts: ShortcodeMatch[] = []
  const contains: ShortcodeMatch[] = []
  for (const [code, char] of byCode) {
    if (code.startsWith(q)) starts.push({ code, char })
    else if (code.includes(q)) contains.push({ code, char })
  }
  const byLength = (a: ShortcodeMatch, b: ShortcodeMatch) => a.code.length - b.code.length || (a.code < b.code ? -1 : 1)
  return [...starts.sort(byLength), ...contains.sort(byLength)].slice(0, limit)
}

/** Replaces every :known_name: with its emoji; an unknown name, or a colon pair around spaces, stays as typed. */
export function expandShortcodes(byCode: Map<string, string>, text: string): string {
  return text.replace(/(?<![\p{L}\p{N}]):([a-z0-9_+-]{2,}):/giu, (all, name: string) => byCode.get(name.toLowerCase()) ?? all)
}

const RECENT_KEY = 'irc:emoji-recent'
const MAX_RECENT = 24

export function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

/** Puts `char` first among the recently used, and returns the new list. */
export function rememberEmoji(char: string): string[] {
  const next = [char, ...loadRecent().filter((c) => c !== char)].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // not remembered
  }
  return next
}
