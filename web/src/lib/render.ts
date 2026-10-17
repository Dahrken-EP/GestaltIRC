// Turns message text into safe tokens. Nothing here produces HTML. Components
// render each token as a text node or a fixed element, so message text can
// never inject markup.

export interface Style {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  mono?: boolean
}

export type Token =
  | ({ type: 'text'; text: string } & Style)
  | ({ type: 'link'; text: string; href: string } & Style)
  | ({ type: 'channel'; text: string } & Style)
  | ({ type: 'mention'; text: string } & Style)

const NICK_CHARS = 'A-Za-z0-9_\\-\\[\\]\\\\`^{}|'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when `text` mentions any of `words` as a whole word, ignoring case.
 * A word boundary is any character that cannot appear in a nick.
 */
export function mentions(text: string, words: string[]): boolean {
  return mentionRegex(words)?.test(text) ?? false
}

function mentionRegex(words: string[], flags = 'i'): RegExp | null {
  const list = words.filter(Boolean).map(escapeRegExp)
  if (!list.length) return null
  return new RegExp(`(?<![${NICK_CHARS}])(?:${list.join('|')})(?![${NICK_CHARS}])`, flags)
}

/** Splits text by IRC formatting codes. Colour codes are removed; the rest set a style. */
export function splitFormatting(text: string): { text: string; style: Style }[] {
  const out: { text: string; style: Style }[] = []
  let style: Style = {}
  let buf = ''
  const flush = () => {
    if (buf) out.push({ text: buf, style: { ...style } })
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    switch (c) {
      case '\x02':
        flush()
        style.bold = !style.bold
        break
      case '\x1d':
        flush()
        style.italic = !style.italic
        break
      case '\x1f':
        flush()
        style.underline = !style.underline
        break
      case '\x1e':
        flush()
        style.strike = !style.strike
        break
      case '\x11':
        flush()
        style.mono = !style.mono
        break
      case '\x16': // reverse video: dropped
        break
      case '\x0f':
        flush()
        style = {}
        break
      case '\x03': {
        // \x03 [fg [, bg]] with one or two digits each
        const m = /^\d{1,2}(?:,\d{1,2})?/.exec(text.slice(i + 1))
        if (m) i += m[0].length
        break
      }
      case '\x04': {
        // hex colour: \x04 RRGGBB [, RRGGBB]
        const m = /^[0-9a-fA-F]{6}(?:,[0-9a-fA-F]{6})?/.exec(text.slice(i + 1))
        if (m) i += m[0].length
        break
      }
      default:
        buf += c
    }
  }
  flush()
  return out
}

const URL_RE = /https?:\/\/[^\s<>"'\x00-\x1f]+/gi
/**
 * An address typed without http:// or https://, such as example.com or www.site.org/page. It must end in a well-known
 * top-level domain, so that file names and abbreviations are left alone, and must not follow an @ (an email address) or
 * part of a word or path.
 */
const TLDS =
  'com|net|org|io|dev|app|co|info|biz|edu|gov|me|tv|gg|xyz|ai|ly|to|eu|us|uk|de|fr|nl|se|no|fi|dk|pl|es|it|ch|at|be|cz|ru|ua|jp|cn|kr|in|au|nz|ca|br|mx|ar|za|cc|ws|fm|im|so|sh|online|site|tech|club|cloud|social|chat|live|news|blog|wiki|page'
const BARE_RE = new RegExp(
  `(?<![\\w@./:%+-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})(?![\\w@-])(?::\\d{1,5})?(?:[/?#][^\\s<>"'\\x00-\\x1f]*)?`,
  'gi',
)
const CHANNEL_RE = /(?<![\w#&])[#&][^\s,\x07:]{1,50}/g

function trimUrl(url: string): string {
  // Sentence punctuation after a link is not part of it. A closing bracket stays
  // only when the link has the matching opener.
  for (;;) {
    const last = url[url.length - 1]
    if (last && '.,;:!?\'"'.includes(last)) url = url.slice(0, -1)
    else if (last === ')' && !url.includes('(')) url = url.slice(0, -1)
    else if (last === ']' && !url.includes('[')) url = url.slice(0, -1)
    else return url
  }
}

/** Only http and https links are ever made clickable. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * Tokenises message text. `words` are the nick and keywords that count as
 * mentions. The result is in order and covers the whole text.
 */
export function tokenize(text: string, words: string[] = []): Token[] {
  const tokens: Token[] = []
  const mention = mentionRegex(words, 'gi')

  for (const part of splitFormatting(text)) {
    // Mark spans to pull out of the plain text: links first, then channels and mentions.
    const spans: { start: number; end: number; token: Token }[] = []
    const overlaps = (s: number, e: number) => spans.some((x) => s < x.end && e > x.start)

    for (const m of part.text.matchAll(URL_RE)) {
      const raw = trimUrl(m[0])
      const href = safeHref(raw)
      if (href) spans.push({ start: m.index, end: m.index + raw.length, token: { type: 'link', text: raw, href, ...part.style } })
    }
    for (const m of part.text.matchAll(BARE_RE)) {
      const raw = trimUrl(m[0])
      // A trailing dot or comma is sentence punctuation, which trimUrl took off; the address must still end in a domain.
      const href = safeHref('https://' + raw)
      if (href && raw.includes('.') && !overlaps(m.index, m.index + raw.length)) {
        spans.push({ start: m.index, end: m.index + raw.length, token: { type: 'link', text: raw, href, ...part.style } })
      }
    }
    for (const m of part.text.matchAll(CHANNEL_RE)) {
      if (!overlaps(m.index, m.index + m[0].length))
        spans.push({ start: m.index, end: m.index + m[0].length, token: { type: 'channel', text: m[0], ...part.style } })
    }
    if (mention) {
      for (const m of part.text.matchAll(mention)) {
        if (!overlaps(m.index, m.index + m[0].length))
          spans.push({ start: m.index, end: m.index + m[0].length, token: { type: 'mention', text: m[0], ...part.style } })
      }
    }

    spans.sort((a, b) => a.start - b.start)
    let at = 0
    for (const s of spans) {
      if (s.start > at) tokens.push({ type: 'text', text: part.text.slice(at, s.start), ...part.style })
      tokens.push(s.token)
      at = s.end
    }
    if (at < part.text.length) tokens.push({ type: 'text', text: part.text.slice(at), ...part.style })
  }
  return tokens
}
