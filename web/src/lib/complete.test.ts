import { describe, expect, it } from 'vitest'
import { applyCompletion, findCompletions, type Sources } from './complete'

const src: Sources = {
  nicks: ['alice', 'Alfred', 'bob'],
  channels: ['#general', '#go'],
  commands: ['join', 'me', 'msg'],
  chanTypes: '#&',
}

describe('findCompletions', () => {
  it('completes nicks ignoring case, sorted', () => {
    const c = findCompletions('al', 2, src)!
    expect(c.matches).toEqual(['alice', 'Alfred'].sort((a, b) => a.localeCompare(b)))
    expect(c.lineStart).toBe(true)
  })

  it('completes channels and commands', () => {
    expect(findCompletions('join #g', 7, src)!.matches).toEqual(['#general', '#go'])
    expect(findCompletions('/m', 2, src)!.matches).toEqual(['/me', '/msg'])
  })

  it('only completes commands at the start of the line', () => {
    expect(findCompletions('say /m', 6, src)).toBeNull()
  })

  it('returns null with no word or no match', () => {
    expect(findCompletions('hi ', 3, src)).toBeNull()
    expect(findCompletions('zzz', 3, src)).toBeNull()
  })

  it('works mid-line using the word before the caret', () => {
    const c = findCompletions('hello bo and more', 8, src)!
    expect([c.start, c.end, c.lineStart]).toEqual([6, 8, false])
  })
})

describe('applyCompletion', () => {
  it('adds ": " after a nick at line start and a space elsewhere', () => {
    const a = findCompletions('bo', 2, src)!
    expect(applyCompletion('bo', a, 'bob')).toEqual({ text: 'bob: ', caret: 5 })
    const b = findCompletions('hi bo', 5, src)!
    expect(applyCompletion('hi bo', b, 'bob')).toEqual({ text: 'hi bob ', caret: 7 })
  })

  it('uses a plain space after channels and commands', () => {
    const a = findCompletions('/jo', 3, src)!
    expect(applyCompletion('/jo', a, '/join').text).toBe('/join ')
    const b = findCompletions('#ge', 3, src)!
    expect(applyCompletion('#ge', b, '#general').text).toBe('#general ')
  })

  it('keeps the text after the caret', () => {
    const c = findCompletions('bo rest', 2, src)!
    expect(applyCompletion('bo rest', c, 'bob').text).toBe('bob: rest')
  })
})
