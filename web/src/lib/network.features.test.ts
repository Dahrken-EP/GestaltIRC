import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from './irc/message'
import { NetworkState, type NetworkHooks } from './network.svelte'
import { settings } from './settings.svelte'

function setup(opts: { caps?: string[]; nick?: string } = {}) {
  const sent: string[] = []
  const hooks: NetworkHooks = { onMention: () => {} }
  const net = new NetworkState('id', 'u/net', opts.nick ?? 'me', (l) => void sent.push(l), hooks)
  net.nick = opts.nick ?? 'me'
  net.viewing = true
  net.setCaps(new Set(opts.caps ?? []))
  const feed = (...lines: string[]) => lines.forEach((l) => net.handleMessage(parse(l)!))
  const batch = (target: string, ...lines: string[]) =>
    net.handleBatch({ type: 'chathistory', params: [target], messages: lines.map((l) => parse(l)!) })
  return { net, sent, feed, batch }
}

const T1 = '@time=2030-01-01T00:00:01.000Z'
const T2 = '@time=2030-01-01T00:00:02.000Z'
const T3 = '@time=2030-01-01T00:00:03.000Z'
const iso = (s: string) => `timestamp=2030-01-01T00:00:0${s}.000Z`

beforeEach(() => {
  vi.useFakeTimers()
  settings.keywords = []
  settings.sendTyping = false
})
afterEach(() => vi.useRealTimers())

describe('read markers', () => {
  const caps = ['draft/read-marker', 'message-tags']

  it('takes the bouncer marker as the truth and recounts unread from it', () => {
    const { net, feed, batch } = setup({ caps })
    feed(':me!u@h JOIN #a')
    net.select('')
    batch('#a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :one`, `${T2};msgid=m2 :x!u@h PRIVMSG #a :two`, `${T3};msgid=m3 :x!u@h PRIVMSG #a :three`)
    const buf = net.find('#a')!
    // Before any marker, a buffer seen for the first time counts what is there as read.
    expect(buf.unread).toBe(0)

    // The marker says only the first two were read on another device, so one is news.
    feed(`:bouncer MARKREAD #a ${iso('2')}`)
    expect(buf.lastRead).toBe(Date.parse('2030-01-01T00:00:02.000Z'))
    expect(buf.unread).toBe(1)
  })

  it('may lower the read position the first time, because the bouncer is authoritative', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a')
    const buf = net.find('#a')!
    buf.lastRead = Date.now() // a guess made before the marker arrived
    feed(`:bouncer MARKREAD #a ${iso('1')}`)
    expect(buf.lastRead).toBe(Date.parse('2030-01-01T00:00:01.000Z'))
  })

  it('only moves forward after the first marker', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a')
    const buf = net.find('#a')!
    feed(`:bouncer MARKREAD #a ${iso('3')}`, `:bouncer MARKREAD #a ${iso('1')}`)
    expect(buf.lastRead).toBe(Date.parse('2030-01-01T00:00:03.000Z'))
  })

  it('keeps a marker for a buffer that is not open yet', () => {
    const { net, feed } = setup({ caps })
    feed(`:bouncer MARKREAD #later ${iso('2')}`)
    expect(net.find('#later')).toBeUndefined() // no clutter for buffers the user never opened
    feed(':me!u@h JOIN #later')
    expect(net.find('#later')!.lastRead).toBe(Date.parse('2030-01-01T00:00:02.000Z'))
  })

  it('a marker of * means nothing has been read', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a')
    feed(`:bouncer MARKREAD #a timestamp=*`)
    expect(net.find('#a')!.lastRead).toBe(0)
  })

  it('ignores a marker it cannot read', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a')
    const before = net.find('#a')!.lastRead
    feed(':bouncer MARKREAD #a timestamp=yesterday', ':bouncer MARKREAD')
    expect(net.find('#a')!.lastRead).toBe(before)
  })

  it('tells the bouncer where it has read to, once, after a short delay', () => {
    const { net, feed, sent } = setup({ caps })
    feed(':me!u@h JOIN #a', `${T2};msgid=m :x!u@h PRIVMSG #a :hi`)
    sent.length = 0
    net.select('#a')
    net.select('')
    net.select('#a')
    expect(sent.filter((l) => l.startsWith('MARKREAD'))).toEqual([]) // not yet
    vi.advanceTimersByTime(900)
    const marks = sent.filter((l) => l.startsWith('MARKREAD'))
    expect(marks).toEqual(['MARKREAD #a timestamp=2030-01-01T00:00:02.000Z'])
  })

  it('does not send markers without the capability or for the status buffer', () => {
    const { net, feed, sent } = setup({ caps: ['message-tags'] })
    feed(':me!u@h JOIN #a', `${T2};msgid=m :x!u@h PRIVMSG #a :hi`)
    net.select('#a')
    net.select('')
    vi.advanceTimersByTime(2000)
    expect(sent.some((l) => l.startsWith('MARKREAD'))).toBe(false)

    const withCap = setup({ caps })
    withCap.net.select('')
    vi.advanceTimersByTime(2000)
    expect(withCap.sent.some((l) => l.startsWith('MARKREAD'))).toBe(false)
  })

  it('a marker echoed back does not cause another marker to be sent', () => {
    const { net, feed, sent } = setup({ caps })
    feed(':me!u@h JOIN #a', `${T2};msgid=m :x!u@h PRIVMSG #a :hi`)
    net.select('#a')
    vi.advanceTimersByTime(900)
    const count = sent.filter((l) => l.startsWith('MARKREAD')).length
    feed(`:bouncer MARKREAD #a ${iso('2')}`)
    vi.advanceTimersByTime(2000)
    expect(sent.filter((l) => l.startsWith('MARKREAD')).length).toBe(count)
  })

  it('starts a new buffer with nothing unread only when read markers are not in use', () => {
    const without = setup()
    without.feed(':me!u@h JOIN #a')
    expect(without.net.find('#a')!.lastRead).toBeGreaterThan(0)
    const withMarkers = setup({ caps })
    withMarkers.feed(':me!u@h JOIN #a')
    expect(withMarkers.net.find('#a')!.lastRead).toBe(0)
  })
})

describe('history and unread', () => {
  it('the first history of a buffer nobody has marked as read counts as read', () => {
    const { net, feed, batch } = setup({ caps: ['draft/read-marker'] })
    feed(':me!u@h JOIN #a') // asks for the latest messages
    batch('#a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :old one`, `${T2};msgid=m2 :x!u@h PRIVMSG #a :old two`)
    const buf = net.find('#a')!
    expect(buf.messages).toHaveLength(2)
    expect(buf.unread).toBe(0)
    expect(buf.lastRead).toBe(Date.parse('2030-01-01T00:00:02.000Z'))
  })

  it('what arrives after that first history is unread', () => {
    const { net, feed, batch } = setup({ caps: ['draft/read-marker'] })
    feed(':me!u@h JOIN #a')
    net.select('')
    batch('#a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :old`)
    feed(`${T2};msgid=m2 :x!u@h PRIVMSG #a :new`)
    expect(net.find('#a')!.unread).toBe(1)
  })

  it('a marker from the bouncer beats the first-history rule, even when it arrives later', () => {
    const { net, feed, batch } = setup({ caps: ['draft/read-marker'] })
    feed(':me!u@h JOIN #a')
    net.select('')
    // The replay of missed messages comes before the markers in the bouncer's attach burst.
    batch('#a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :one`, `${T2};msgid=m2 :x!u@h PRIVMSG #a :two`, `${T3};msgid=m3 :x!u@h PRIVMSG #a :three`)
    feed(`:bouncer MARKREAD #a ${iso('1')}`)
    expect(net.find('#a')!.unread).toBe(2)
  })

  it('a buffer with a marker is not touched by the first-history rule', () => {
    const { net, feed, batch } = setup({ caps: ['draft/read-marker'] })
    feed(':me!u@h JOIN #a')
    net.select('')
    feed(`:bouncer MARKREAD #a ${iso('1')}`) // markers arrive before our history request is answered
    batch('#a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :read`, `${T2};msgid=m2 :x!u@h PRIVMSG #a :unread`)
    expect(net.find('#a')!.unread).toBe(1)
  })

  it('a buffer with a saved position keeps it', () => {
    const { net, feed, batch } = setup({ caps: ['draft/read-marker'] })
    feed(':me!u@h JOIN #a')
    net.select('')
    const buf = net.find('#a')!
    buf.lastRead = Date.parse('2030-01-01T00:00:01.000Z')
    batch('#a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :read`, `${T2};msgid=m2 :x!u@h PRIVMSG #a :unread`)
    expect(buf.unread).toBe(1)
  })

  it('loading older messages counts only those newer than what was read', () => {
    const { net, feed, batch } = setup()
    feed(':me!u@h JOIN #a', `${T3};msgid=m3 :x!u@h PRIVMSG #a :newest`)
    const buf = net.find('#a')!
    buf.lastRead = Date.parse('2030-01-01T00:00:00.500Z')
    buf.recount()
    expect(buf.unread).toBe(1)
    net.loadOlder(buf)
    batch('#a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :older, still unread`)
    expect(buf.messages).toHaveLength(2)
    // m1 is newer than lastRead, so it is unread too: that is what the marker says.
    expect(buf.unread).toBe(2)
  })
})

describe('redaction', () => {
  const caps = ['draft/message-redaction']

  it('removes the message and puts the unread count right', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a')
    net.select('')
    feed(`${T1};msgid=m1 :x!u@h PRIVMSG #a :keep`, `${T2};msgid=m2 :x!u@h PRIVMSG #a :remove me`)
    const buf = net.find('#a')!
    buf.lastRead = 0
    buf.recount()
    expect(buf.unread).toBe(2)
    feed(':x!u@h REDACT #a m2 :oops')
    expect(buf.messages.map((m) => m.text)).toEqual(['keep'])
    expect(buf.unread).toBe(1)
  })

  it('also removes its reactions', () => {
    const { net, feed } = setup({ caps: [...caps, 'message-tags'] })
    feed(':me!u@h JOIN #a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :hi`, '@+draft/react=👍;+draft/reply=m1 :y!u@h TAGMSG #a')
    const buf = net.find('#a')!
    expect(buf.reactions.get('m1')?.get('👍')).toEqual(['y'])
    feed(':x!u@h REDACT #a m1')
    expect(buf.reactions.has('m1')).toBe(false)
  })

  it('finds a private message by the other person', () => {
    const { net, feed } = setup({ caps })
    feed(`${T1};msgid=p1 :bob!u@h PRIVMSG me :secret`)
    expect(net.find('bob')!.messages).toHaveLength(1)
    // bob redacts: the target is us, so the buffer is bob's
    feed(':bob!u@h REDACT me p1')
    expect(net.find('bob')!.messages).toHaveLength(0)
  })

  it('ignores an unknown msgid and a missing buffer', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :hi`)
    feed(':x!u@h REDACT #a nope', ':x!u@h REDACT #nowhere m1', ':x!u@h REDACT #a')
    expect(net.find('#a')!.messages).toHaveLength(1)
  })

  it('asks the network only when it can, and only for messages that have an id', () => {
    const withCap = setup({ caps })
    withCap.feed(':me!u@h JOIN #a', `${T1};msgid=m1 :me!u@h PRIVMSG #a :mine`, `${T2} :me!u@h PRIVMSG #a :no id`)
    const buf = withCap.net.find('#a')!
    withCap.sent.length = 0
    withCap.net.redact(buf, buf.messages[0]!)
    withCap.net.redact(buf, buf.messages[1]!)
    expect(withCap.sent).toEqual(['REDACT #a m1'])

    const without = setup()
    without.feed(':me!u@h JOIN #a', `${T1};msgid=m1 :me!u@h PRIVMSG #a :mine`)
    without.sent.length = 0
    without.net.redact(without.net.find('#a')!, without.net.find('#a')!.messages[0]!)
    expect(without.sent).toEqual([])
    expect(without.net.canRedact).toBe(false)
  })
})

describe('away status', () => {
  it('marks and clears a member, and keeps it across a nick change', () => {
    const { net, feed } = setup({ caps: ['away-notify'] })
    feed(':me!u@h JOIN #a', ':s 353 me = #a :me bob', ':s 366 me #a :end')
    const buf = net.find('#a')!
    feed(':bob!u@h AWAY :gone fishing')
    expect(buf.members.get('bob')!.away).toBe(true)
    feed(':bob!u@h NICK :robert')
    expect(buf.members.get('robert')!.away).toBe(true)
    feed(':robert!u@h AWAY')
    expect(buf.members.get('robert')!.away).toBe(false)
  })

  it('does not change anything for someone not in a channel', () => {
    const { net, feed } = setup({ caps: ['away-notify'] })
    feed(':me!u@h JOIN #a', ':ghost!u@h AWAY :x')
    expect(net.find('#a')!.members.size).toBe(0)
  })
})

describe('member objects change identity when they change', () => {
  // The member list redraws a row only when its object is replaced, so editing in place
  // would update this state and leave the screen stale.
  it('away', () => {
    const { net, feed } = setup({ caps: ['away-notify'] })
    feed(':me!u@h JOIN #a', ':s 353 me = #a :me bob', ':s 366 me #a :end')
    const before = net.find('#a')!.members.get('bob')!
    feed(':bob!u@h AWAY :gone')
    const after = net.find('#a')!.members.get('bob')!
    expect(after).not.toBe(before)
    expect(before.away).toBeUndefined()
    expect(after.away).toBe(true)
  })

  it('mode changes', () => {
    const { net, feed } = setup()
    feed(':me!u@h JOIN #a', ':s 353 me = #a :me bob', ':s 366 me #a :end')
    const before = net.find('#a')!.members.get('bob')!
    feed(':op!u@h MODE #a +o bob')
    const after = net.find('#a')!.members.get('bob')!
    expect(after).not.toBe(before)
    expect(before.prefix).toBe('')
    expect(after.prefix).toBe('@')
  })

  it('bumps the revision so the list notices', () => {
    const { net, feed } = setup({ caps: ['away-notify'] })
    feed(':me!u@h JOIN #a', ':s 353 me = #a :me bob', ':s 366 me #a :end')
    const rev = net.find('#a')!.membersRev
    feed(':bob!u@h AWAY :x')
    expect(net.find('#a')!.membersRev).toBeGreaterThan(rev)
  })
})

describe('typing', () => {
  const caps = ['message-tags']

  it('shows who is typing and clears on done', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a')
    feed('@+typing=active :bob!u@h TAGMSG #a')
    expect(net.find('#a')!.typing).toEqual(['bob'])
    feed('@+typing=done :bob!u@h TAGMSG #a')
    expect(net.find('#a')!.typing).toEqual([])
  })

  it('forgets typing that is never ended', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a', '@+typing=active :bob!u@h TAGMSG #a')
    vi.advanceTimersByTime(9000)
    expect(net.find('#a')!.typing).toEqual([])
  })

  it('a message from the typist clears the indicator', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a', '@+typing=active :bob!u@h TAGMSG #a', `${T1} :bob!u@h PRIVMSG #a :done typing`)
    expect(net.find('#a')!.typing).toEqual([])
  })

  it('leaving or quitting clears it', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a', ':s 353 me = #a :me bob carol', ':s 366 me #a :end')
    feed('@+typing=active :bob!u@h TAGMSG #a', '@+typing=active :carol!u@h TAGMSG #a')
    expect(net.find('#a')!.typing).toEqual(['bob', 'carol'])
    feed(':bob!u@h PART #a', ':carol!u@h QUIT :bye')
    expect(net.find('#a')!.typing).toEqual([])
  })

  it('ignores our own typing and typing in buffers we have not opened', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a', '@+typing=active :me!u@h TAGMSG #a', '@+typing=active :stranger!u@h TAGMSG me', '@+typing=active :x!u@h TAGMSG #nowhere')
    expect(net.find('#a')!.typing).toEqual([])
    expect(net.find('stranger')).toBeUndefined()
    expect(net.find('#nowhere')).toBeUndefined()
  })

  it('sends nothing unless the user turned it on', () => {
    const { net, feed, sent } = setup({ caps })
    feed(':me!u@h JOIN #a')
    sent.length = 0
    net.sendTyping(net.find('#a')!, 'active')
    expect(sent).toEqual([])
  })

  it('sends active at most every few seconds, and done only after active', () => {
    settings.sendTyping = true
    const { net, feed, sent } = setup({ caps })
    feed(':me!u@h JOIN #a')
    const buf = net.find('#a')!
    sent.length = 0
    net.sendTyping(buf, 'done')
    expect(sent).toEqual([]) // nothing to end
    net.sendTyping(buf, 'active')
    net.sendTyping(buf, 'active')
    expect(sent).toEqual(['@+typing=active TAGMSG #a'])
    vi.advanceTimersByTime(3500)
    net.sendTyping(buf, 'active')
    expect(sent).toHaveLength(2)
    net.sendTyping(buf, 'done')
    expect(sent.at(-1)).toBe('@+typing=done TAGMSG #a')
    net.sendTyping(buf, 'done')
    expect(sent).toHaveLength(3)
  })

  it('submitting a message ends our typing notice', () => {
    settings.sendTyping = true
    const { net, feed, sent } = setup({ caps })
    feed(':me!u@h JOIN #a')
    net.select('#a')
    net.sendTyping(net.find('#a')!, 'active')
    sent.length = 0
    net.submit('hello')
    expect(sent).toEqual(['PRIVMSG #a :hello', '@+typing=done TAGMSG #a'])
  })

  it('does not send typing without message-tags, or to the status buffer', () => {
    settings.sendTyping = true
    const { net, feed, sent } = setup()
    feed(':me!u@h JOIN #a')
    sent.length = 0
    net.sendTyping(net.find('#a')!, 'active')
    net.sendTyping(net.statusBuffer, 'active')
    expect(sent).toEqual([])
  })
})

describe('reactions', () => {
  const caps = ['message-tags']

  it('collects reactions and removes them again', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :hi`)
    feed('@+draft/react=👍;+draft/reply=m1 :bob!u@h TAGMSG #a', '@+draft/react=👍;+draft/reply=m1 :carol!u@h TAGMSG #a', '@+draft/react=🎉;+draft/reply=m1 :bob!u@h TAGMSG #a')
    const buf = net.find('#a')!
    expect(buf.reactions.get('m1')!.get('👍')).toEqual(['bob', 'carol'])
    expect(buf.reactions.get('m1')!.get('🎉')).toEqual(['bob'])
    feed('@+draft/unreact=👍;+draft/reply=m1 :bob!u@h TAGMSG #a', '@+draft/unreact=🎉;+draft/reply=m1 :bob!u@h TAGMSG #a')
    expect(buf.reactions.get('m1')!.get('👍')).toEqual(['carol'])
    expect(buf.reactions.get('m1')!.has('🎉')).toBe(false)
  })

  it('counts a person once per emoji, ignoring case', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a')
    const buf = net.find('#a')!
    buf.addReaction('m1', '👍', 'Bob')
    buf.addReaction('m1', '👍', 'bob')
    expect(buf.reactions.get('m1')!.get('👍')).toEqual(['Bob'])
  })

  it('sends a reaction with the right tags and shows it at once, then toggles it off', () => {
    const { net, feed, sent } = setup({ caps })
    feed(':me!u@h JOIN #a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :hi`)
    const buf = net.find('#a')!
    const msg = buf.messages[0]!
    sent.length = 0

    net.react(buf, msg, '👍')
    expect(sent).toEqual(['@+draft/react=👍;+draft/reply=m1 TAGMSG #a'])
    expect(buf.hasReacted('m1', '👍', 'me')).toBe(true)

    net.react(buf, msg, '👍')
    expect(sent.at(-1)).toBe('@+draft/unreact=👍;+draft/reply=m1 TAGMSG #a')
    expect(buf.hasReacted('m1', '👍', 'me')).toBe(false)
  })

  it('an echoed reaction changes nothing', () => {
    const { net, feed } = setup({ caps })
    feed(':me!u@h JOIN #a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :hi`)
    const buf = net.find('#a')!
    net.react(buf, buf.messages[0]!, '👍')
    feed('@+draft/react=👍;+draft/reply=m1 :me!u@h TAGMSG #a')
    expect(buf.reactions.get('m1')!.get('👍')).toEqual(['me'])
  })

  it('does nothing for a message without an id, or without message-tags', () => {
    const a = setup({ caps })
    a.feed(':me!u@h JOIN #a', `${T1} :x!u@h PRIVMSG #a :no id`)
    a.sent.length = 0
    a.net.react(a.net.find('#a')!, a.net.find('#a')!.messages[0]!, '👍')
    expect(a.sent).toEqual([])

    const b = setup()
    b.feed(':me!u@h JOIN #a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :hi`)
    b.sent.length = 0
    b.net.react(b.net.find('#a')!, b.net.find('#a')!.messages[0]!, '👍')
    expect(b.sent).toEqual([])
  })

  it('a reaction that arrives while its buffer is closed is dropped', () => {
    const { net, feed } = setup({ caps })
    feed('@+draft/react=👍;+draft/reply=m1 :bob!u@h TAGMSG #closed')
    expect(net.find('#closed')).toBeUndefined()
  })
})

describe('replies', () => {
  it('reads the reply tag from an incoming message', () => {
    const { net, feed } = setup({ caps: ['message-tags'] })
    feed(':me!u@h JOIN #a', `${T1};msgid=m1 :x!u@h PRIVMSG #a :question`, `${T2};msgid=m2;+draft/reply=m1 :y!u@h PRIVMSG #a :answer`)
    const buf = net.find('#a')!
    expect(buf.messages[1]!.replyTo).toBe('m1')
    expect(buf.byMsgId('m1')!.text).toBe('question')
    expect(buf.messages[0]!.replyTo).toBeUndefined()
  })

  it('sends a plain message with the reply tag, but not commands', () => {
    const { net, feed, sent } = setup({ caps: ['message-tags'] })
    feed(':me!u@h JOIN #a')
    net.select('#a')
    sent.length = 0
    net.submit('my answer', 'm1')
    net.submit('/me waves', 'm1')
    net.submit('/topic new', 'm1')
    expect(sent).toEqual([
      '@+draft/reply=m1 PRIVMSG #a :my answer',
      '@+draft/reply=m1 PRIVMSG #a :\x01ACTION waves\x01',
      'TOPIC #a :new',
    ])
  })

  it('sends no tag when the connection cannot carry tags', () => {
    const { net, feed, sent } = setup()
    feed(':me!u@h JOIN #a')
    net.select('#a')
    sent.length = 0
    net.submit('answer', 'm1')
    expect(sent).toEqual(['PRIVMSG #a :answer'])
  })

  it('keeps long messages split into several lines, each tagged', () => {
    const { net, feed, sent } = setup({ caps: ['message-tags'] })
    feed(':me!u@h JOIN #a')
    net.select('#a')
    sent.length = 0
    net.submit('word '.repeat(200), 'm1')
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every((l) => l.startsWith('@+draft/reply=m1 PRIVMSG #a :word'))).toBe(true)
  })
})

describe('opening a buffer that does not exist yet', () => {
  it('switches to it when it appears', () => {
    const { net, feed } = setup()
    net.wantOpen = '#late'
    feed(':me!u@h JOIN #early')
    expect(net.activeKey).toBe('')
    feed(':me!u@h JOIN #late')
    expect(net.activeKey).toBe('#late')
    expect(net.wantOpen).toBe('')
  })
})
