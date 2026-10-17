import { beforeEach, describe, expect, it } from 'vitest'
import { app } from './app.svelte'
import { parse } from './irc/message'
import { NetworkState } from './network.svelte'
import { settings } from './settings.svelte'

function network(id: string, label: string): NetworkState {
  const net = new NetworkState(id, `u/${label}`, 'me', () => {}, { onMention: () => {} })
  net.nick = 'me'
  net.label = label
  return net
}

// Messages dated in the future, so they are newer than anything the buffer has been read to.
const T = '@time=2030-01-01T00:00:00.000Z '
const feed = (net: NetworkState, ...lines: string[]) => lines.forEach((l) => net.handleMessage(parse(T + l)!))

beforeEach(() => {
  settings.keywords = []
  app.networks = []
  app.activeId = ''
})

describe('the quick switcher list', () => {
  it('lists every buffer of every network with its counts', () => {
    const a = network('a', 'Alpha')
    const b = network('b', 'Beta')
    app.networks = [a, b]
    app.activate('a')
    feed(a, ':me!u@h JOIN #one', ':bob!u@h PRIVMSG me :hi')
    feed(b, ':me!u@h JOIN #two')
    const names = app.entries.map((e) => `${e.network}:${e.name}`)
    expect(names).toEqual(expect.arrayContaining(['Alpha:Alpha', 'Alpha:#one', 'Alpha:bob', 'Beta:#two']))
    expect(app.entries.find((e) => e.name === 'bob')!.unread).toBe(1)
  })
})

describe('next unread', () => {
  it('does nothing when everything has been read', () => {
    const a = network('a', 'Alpha')
    app.networks = [a]
    app.activate('a')
    expect(app.nextUnread()).toBe(false)
  })

  it('goes to a buffer with unread messages, on any network, and then stops', () => {
    const a = network('a', 'Alpha')
    const b = network('b', 'Beta')
    app.networks = [a, b]
    app.activate('a')
    feed(b, ':bob!u@h PRIVMSG me :hello there')
    expect(app.nextUnread()).toBe(true)
    expect(app.activeId).toBe('b')
    expect(b.active.name).toBe('bob')
    expect(app.nextUnread()).toBe(false)
  })

  it('moves on to the next one after the buffer on screen', () => {
    const a = network('a', 'Alpha')
    app.networks = [a]
    app.activate('a')
    feed(a, ':x!u@h PRIVMSG me :one', ':y!u@h PRIVMSG me :two')
    app.nextUnread()
    const first = a.active.name
    app.nextUnread()
    expect(a.active.name).not.toBe(first)
    expect(['x', 'y']).toContain(a.active.name)
  })

  it('prefers a buffer where someone mentioned you', () => {
    const a = network('a', 'Alpha')
    app.networks = [a]
    app.activate('a')
    feed(a, ':me!u@h JOIN #quiet', ':me!u@h JOIN #loud', ':bob!u@h PRIVMSG #quiet :chatter')
    feed(a, ':bob!u@h PRIVMSG #loud :me: look at this')
    a.select('')
    expect(app.nextUnread()).toBe(true)
    expect(a.active.name).toBe('#loud')
  })
})
