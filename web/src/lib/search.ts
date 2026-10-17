// Finding messages in the buffer on screen. A query is words that must all appear, in the
// text or in the sender's name, plus an optional `from:nick` to keep to one sender.

import type { ChatMessage } from './network.svelte'

export interface Query {
  words: string[]
  from: string
}

export function parseQuery(input: string): Query {
  const words: string[] = []
  let from = ''
  for (const part of input.toLowerCase().split(/\s+/)) {
    if (!part) continue
    if (part.startsWith('from:') && part.length > 5) from = part.slice(5)
    else words.push(part)
  }
  return { words, from }
}

/** True when there is anything to filter by. */
export function active(q: Query): boolean {
  return q.words.length > 0 || q.from !== ''
}

export function matches(msg: ChatMessage, q: Query): boolean {
  if (q.from && !msg.nick.toLowerCase().includes(q.from)) return false
  if (q.words.length === 0) return true
  const hay = (msg.nick + ' ' + msg.text).toLowerCase()
  return q.words.every((w) => hay.includes(w))
}

/** The messages that match. Nothing is dropped when the query is empty. */
export function filterMessages(list: ChatMessage[], input: string): ChatMessage[] {
  const q = parseQuery(input)
  return active(q) ? list.filter((m) => matches(m, q)) : list
}
