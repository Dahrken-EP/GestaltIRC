import { describe, expect, it } from 'vitest'
import { filterMessages, parseQuery } from './search'
import type { ChatMessage } from './network.svelte'

const msg = (id: number, nick: string, text: string): ChatMessage =>
  ({ id, kind: 'msg', nick, text, time: id, self: false, mention: false }) as ChatMessage

const list = [msg(1, 'alice', 'Lunch at noon?'), msg(2, 'bob', 'yes, lunch is fine'), msg(3, 'alice', 'see you then')]

describe('parseQuery', () => {
  it('splits words and takes a from: filter', () => {
    expect(parseQuery('Lunch  from:Alice')).toEqual({ words: ['lunch'], from: 'alice' })
  })

  it('treats a bare "from:" as a word', () => {
    expect(parseQuery('from:')).toEqual({ words: ['from:'], from: '' })
  })
})

describe('filterMessages', () => {
  it('returns the same list for an empty query', () => {
    expect(filterMessages(list, '  ')).toBe(list)
  })

  it('needs every word, ignoring case', () => {
    expect(filterMessages(list, 'LUNCH fine').map((m) => m.id)).toEqual([2])
  })

  it('keeps to one sender with from:', () => {
    expect(filterMessages(list, 'from:alice').map((m) => m.id)).toEqual([1, 3])
    expect(filterMessages(list, 'from:alice lunch').map((m) => m.id)).toEqual([1])
  })

  it('finds a sender by name as a word', () => {
    expect(filterMessages(list, 'bob').map((m) => m.id)).toEqual([2])
  })

  it('finds nothing when nothing matches', () => {
    expect(filterMessages(list, 'zebra')).toEqual([])
  })
})
