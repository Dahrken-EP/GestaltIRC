import { describe, expect, it } from 'vitest'
import { parseFromWorker } from './protocol'

describe('parseFromWorker', () => {
  it('reads each message', () => {
    expect(parseFromWorker({ t: 'ready', ok: true })).toEqual({ t: 'ready', ok: true })
    expect(parseFromWorker({ t: 'pong', n: 3 })).toEqual({ t: 'pong', n: 3 })
    expect(parseFromWorker({ t: 'log', text: 'hi' })).toEqual({ t: 'log', text: 'hi' })
    expect(parseFromWorker({ t: 'error', text: 'oops' })).toEqual({ t: 'error', text: 'oops' })
    expect(parseFromWorker({ t: 'on', event: 'TEXT' })).toEqual({ t: 'on', event: 'TEXT' })
    expect(parseFromWorker({ t: 'alias', name: 'greet' })).toEqual({ t: 'alias', name: 'greet' })
    expect(parseFromWorker({ t: 'send', line: '/msg a b', buffer: '#c', network: 'n' })).toEqual({ t: 'send', line: '/msg a b', buffer: '#c', network: 'n' })
    expect(parseFromWorker({ t: 'print', text: 'x', buffer: '', network: '' })).toEqual({ t: 'print', text: 'x', buffer: '', network: '' })
    expect(parseFromWorker({ t: 'timer', id: 1, ms: 500, repeat: false })).toEqual({ t: 'timer', id: 1, ms: 500, repeat: false })
    expect(parseFromWorker({ t: 'clear', id: 1 })).toEqual({ t: 'clear', id: 1 })
    expect(parseFromWorker({ t: 'store', key: 'k', value: '"v"' })).toEqual({ t: 'store', key: 'k', value: '"v"' })
    expect(parseFromWorker({ t: 'store', key: 'k', value: null })).toEqual({ t: 'store', key: 'k', value: null })
    expect(parseFromWorker({ t: 'dialog', id: 1, kind: 'prompt', text: 'Name?', value: 'x' })).toEqual({ t: 'dialog', id: 1, kind: 'prompt', text: 'Name?', value: 'x' })
  })

  it('refuses a dialog that is not exactly the shape', () => {
    const ok = { t: 'dialog', id: 1, kind: 'alert', text: 'hi', value: '' }
    expect(parseFromWorker(ok)).not.toBeNull()
    for (const bad of [{ id: 0 }, { id: 1.5 }, { kind: 'html' }, { kind: 'confirm', text: 5 }, { text: 'x'.repeat(1001) }, { value: 'x'.repeat(201) }, { value: null }])
      expect(parseFromWorker({ ...ok, ...bad }), JSON.stringify(bad)).toBeNull()
  })

  it('drops fields that are not part of the message', () => {
    expect(parseFromWorker({ t: 'pong', n: 1, evil: () => 1 })).toEqual({ t: 'pong', n: 1 })
  })

  it('raises a timer below the minimum and refuses nonsense', () => {
    expect(parseFromWorker({ t: 'timer', id: 1, ms: 1, repeat: true })).toMatchObject({ ms: 100 })
    expect(parseFromWorker({ t: 'timer', id: 1, ms: -5, repeat: true })).toBeNull()
    expect(parseFromWorker({ t: 'timer', id: 1, ms: NaN, repeat: true })).toBeNull()
    expect(parseFromWorker({ t: 'timer', id: 0, ms: 500, repeat: true })).toBeNull()
    expect(parseFromWorker({ t: 'timer', id: 1.5, ms: 500, repeat: true })).toBeNull()
    expect(parseFromWorker({ t: 'timer', id: 1, ms: 1e12, repeat: true })).toBeNull()
    expect(parseFromWorker({ t: 'timer', id: 1, ms: 500, repeat: 'yes' })).toBeNull()
  })

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['no type', {}],
    ['unknown type', { t: 'eval', code: 'x' }],
    ['ready without ok', { t: 'ready' }],
    ['pong with a string', { t: 'pong', n: '1' }],
    ['log with a number', { t: 'log', text: 5 }],
    ['log too long', { t: 'log', text: 'x'.repeat(5000) }],
    ['unknown event', { t: 'on', event: 'PRIVMSG' }],
    ['lower-case event', { t: 'on', event: 'text' }],
    ['alias with a slash', { t: 'alias', name: '/greet' }],
    ['alias with upper case', { t: 'alias', name: 'Greet' }],
    ['alias too long', { t: 'alias', name: 'a'.repeat(30) }],
    ['empty send', { t: 'send', line: '  ', buffer: '', network: '' }],
    ['long send', { t: 'send', line: 'x'.repeat(2000), buffer: '', network: '' }],
    ['send with no buffer', { t: 'send', line: 'x', network: '' }],
    ['send with no network', { t: 'send', line: 'x', buffer: '' }],
    ['print with an object', { t: 'print', text: {}, buffer: '', network: '' }],
    ['store with an empty key', { t: 'store', key: '', value: 'x' }],
    ['store with a long key', { t: 'store', key: 'k'.repeat(65), value: 'x' }],
    ['store with a huge value', { t: 'store', key: 'k', value: 'x'.repeat(9000) }],
    ['store with an object', { t: 'store', key: 'k', value: {} }],
    ['clear with a string id', { t: 'clear', id: 'a' }],
  ])('rejects %s', (_n, m) => {
    expect(parseFromWorker(m)).toBeNull()
  })
})
