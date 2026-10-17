// Tab completion for the input bar.

export interface Sources {
  nicks: string[]
  channels: string[]
  commands: string[]
  chanTypes: string
}

export interface Completion {
  /** Start and end of the word being completed. */
  start: number
  end: number
  matches: string[]
  /** True when the word starts the line, so a nick gets ": " after it. */
  lineStart: boolean
}

/** Finds the word before `caret` and the names that complete it, or null if none. */
export function findCompletions(text: string, caret: number, src: Sources): Completion | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--
  const word = text.slice(start, caret)
  if (!word) return null
  const lower = word.toLowerCase()
  const prefixOf = (list: string[], strip = 0) =>
    list.filter((x) => x.toLowerCase().startsWith(lower.slice(strip)) && x.toLowerCase() !== lower.slice(strip))

  let matches: string[]
  if (start === 0 && word.startsWith('/')) {
    matches = src.commands.filter((c) => ('/' + c).startsWith(lower)).map((c) => '/' + c)
  } else if (src.chanTypes.includes(word[0]!)) {
    matches = src.channels.filter((c) => c.toLowerCase().startsWith(lower))
  } else {
    matches = prefixOf(src.nicks)
  }
  if (!matches.length) return null
  matches.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return { start, end: caret, matches, lineStart: start === 0 }
}

/** Replaces the word with `match`. Returns the new text and caret. */
export function applyCompletion(text: string, c: Completion, match: string): { text: string; caret: number } {
  const isNick = !/^[/#&]/.test(match)
  const suffix = isNick && c.lineStart ? ': ' : ' '
  const rest = text.slice(c.end).replace(/^ /, '')
  const out = text.slice(0, c.start) + match + suffix + rest
  return { text: out, caret: c.start + match.length + suffix.length }
}
